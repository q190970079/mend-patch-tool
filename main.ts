// mend: one patch tool for every AI edit format (SPEC.md). Node 22, standard library only.
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): that hand-over is kept as the kit ships it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split the way section 3 reads it: its own break, its lines, whether it ends with a break. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

/** Section 5 tiers: 0 exact, 1 trailing blanks ignored, 2 leading and trailing blanks ignored. */
const normLine = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function matchAt(fileLines: string[], o: string[], pos: number, tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) {
    if (normLine(fileLines[pos + k]!, tier) !== normLine(o[k]!, tier)) return false;
  }
  return true;
}

function occurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i += 1) {
    if (matchAt(fileLines, o, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier (0 only when strict) at which o occurs at or after `from`, with every position there. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(fileLines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk, chunk or block: context, old, new or a no-newline marker. */
interface BodyEntry {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  fromEmpty?: boolean;
}

const oldOf = (body: BodyEntry[]): string[] => body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
const newCount = (body: BodyEntry[]): number => body.filter((e) => e.kind === ' ' || e.kind === '+').length;

/** The lines N becomes once matched at `pos`: context lines are the file's own, tier 2 re-indents the rest. */
function buildReplacement(fileLines: string[], pos: number, o: string[], body: BodyEntry[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(o[0]!);
  }
  let oi = pos;
  for (const e of body) {
    if (e.kind === ' ') {
      out.push(fileLines[oi]!);
      oi += 1;
    } else if (e.kind === '-') {
      oi += 1;
    } else if (e.kind === '+') {
      let line = e.text;
      if (tier === 2 && line.trim() !== '') {
        line = line.startsWith(p) ? f + line.slice(p.length) : line;
      }
      out.push(line);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfter(body: BodyEntry[]): boolean {
  let last = -1;
  body.forEach((e, i) => {
    if (e.kind === ' ' || e.kind === '+') last = i;
  });
  return last >= 0 && body.slice(last + 1).some((e) => e.kind === '\\');
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(parts));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: unified diffs. */
interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: Hunk | null = null;
  const newSection = (): USection => {
    const s: USection = { diffOld: null, diffNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isNew: false, isDel: false, hasPair: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  const endHunk = (): void => {
    if (hunk === null || cur === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.fromEmpty) hunk.body.pop();
    cur.hunks.push(hunk);
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
        continue;
      }
      if (line === '') {
        hunk.body.push({ kind: ' ', text: '', fromEmpty: true });
        i += 1;
        continue;
      }
      const c = line[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk.body.push({ kind: c as BodyEntry['kind'], text: line.slice(1) });
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number.parseInt(m[1]!, 10), body: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const s = cur === null || cur.hasPair || cur.hunks.length > 0 ? newSection() : cur;
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(next);
        s.hasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i += 1;
  }
  endHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renameFrom ?? s.diffOld;
  const newP = s.pairNew ?? s.renameTo ?? s.diffNew;
  const isCreate = s.isNew || s.pairOld === '/dev/null';
  const isDelete = s.isDel || s.pairNew === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const entries: BodyEntry[] = [];
      for (const h of s.hunks) entries.push(...h.body);
      const plus = entries.filter((e) => e.kind === '+');
      let final = true;
      if (plus.length > 0) {
        const at = entries.lastIndexOf(plus[plus.length - 1]!);
        if (entries[at + 1]?.kind === '\\') final = false;
      }
      const out = plus.map((e) => e.text);
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (n !== o && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const parts = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const oldLines = oldOf(h.body);
      if (oldLines.length === 0) {
        const ins = h.body.filter((e) => e.kind === '+').map((e) => e.text);
        const pos = Math.max(0, Math.min(h.a + d, parts.lines.length));
        const atEnd = pos === parts.lines.length;
        parts.lines.splice(pos, 0, ...ins);
        if (atEnd) parts.final = !backslashAfter(h.body);
      } else {
        const found = findTier(parts.lines, oldLines, strict);
        if (found === null) throw new Fail('no-match', o);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const cand of found.positions) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const atEnd = pos + oldLines.length === parts.lines.length;
        const repl = buildReplacement(parts.lines, pos, oldLines, h.body, found.tier);
        parts.lines.splice(pos, oldLines.length, ...repl);
        if (atEnd) parts.final = !backslashAfter(h.body);
      }
      d += newCount(h.body) - oldLines.length;
    }
    const content = joinFile(parts);
    if (n !== o) {
      tree.now.set(o, null);
      tree.now.set(n, content);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, content);
    }
  };
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let k = at - 1; k >= searchFrom; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    prevPath = path;
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b): Edit => {
    return (tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const parts = splitFile(before);
      const found = findTier(parts.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.positions[0]!;
      const body: BodyEntry[] = [
        ...b.oldLines.map((text): BodyEntry => ({ kind: '-', text })),
        ...b.newLines.map((text): BodyEntry => ({ kind: '+', text })),
      ];
      const repl = buildReplacement(parts.lines, pos, b.oldLines, body, found.tier);
      parts.lines.splice(pos, b.oldLines.length, ...repl);
      tree.now.set(b.path, joinFile(parts));
    };
  });
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V_HEADS: [string, VSection['kind'], number][] = [
  ['*** Add File:', 'add', 13],
  ['*** Delete File:', 'delete', 16],
  ['*** Update File:', 'update', 16],
];

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: VSection['kind'];
    path: string;
    line: number;
    raw: { text: string; line: number }[];
  }
  const raws: Raw[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = V_HEADS.find(([pre]) => line.startsWith(pre));
    if (head === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const raw: Raw = { kind: head[1], path: line.slice(head[2]).trim(), line: i + 1, raw: [] };
    i += 1;
    while (i < last && !V_HEADS.some(([pre]) => lines[i]!.startsWith(pre))) {
      raw.raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    raws.push(raw);
  }
  const sections: VSection[] = raws.map((r) => {
    const body = [...r.raw];
    // Blank lines at the end of a section are not part of it (section 8): a line of only
    // whitespace counts, so a trailing single-space context line is dropped here too.
    while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
    if (r.kind === 'add') {
      const content: string[] = [];
      for (const { text, line } of body) {
        if (text.startsWith('+')) content.push(text.slice(1));
        else if (text === '') content.push('');
        else throw new Exit2(`error: parse ${line}`);
      }
      return { kind: 'add', path: r.path, line: r.line, content, moveTo: null, chunks: [] };
    }
    if (r.kind === 'delete') {
      for (const { text, line } of body) {
        if (text.trim() !== '') throw new Exit2(`error: parse ${line}`);
      }
      return { kind: 'delete', path: r.path, line: r.line, content: [], moveTo: null, chunks: [] };
    }
    let moveTo: string | null = null;
    let rest = body;
    if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to:')) {
      moveTo = rest[0]!.text.slice(12).trim();
      rest = rest.slice(1);
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    const close = (): void => {
      if (chunk !== null) chunks.push(chunk);
      chunk = null;
    };
    for (const { text, line } of rest) {
      if (text.startsWith('@@')) {
        close();
        const anchor = text.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      } else if (text === '*** End of File') {
        if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
        chunk.eof = true;
        close();
      } else if (text.startsWith('*** Move to:')) {
        throw new Exit2(`error: parse ${line}`);
      } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
        if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
        chunk.body.push(text === '' ? { kind: ' ', text: '', fromEmpty: true } : { kind: text[0] as BodyEntry['kind'], text: text.slice(1) });
      } else {
        throw new Exit2(`error: parse ${line}`);
      }
    }
    close();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.line}`);
    return { kind: 'update', path: r.path, line: r.line, content: [], moveTo, chunks };
  });
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.content.length === 0 ? '' : s.content.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const parts = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < parts.lines.length; k += 1) {
            if (normLine(parts.lines[k]!, tier) === normLine(chunk.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', s.path);
        cursor = foundAt + 1;
      }
      const oldLines = oldOf(chunk.body);
      if (oldLines.length === 0) {
        const ins = chunk.body.filter((e) => e.kind === '+').map((e) => e.text);
        const pos = chunk.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        parts.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        let found: { tier: number; positions: number[] } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          let positions = occurrences(parts.lines, oldLines, tier, cursor);
          if (chunk.eof) positions = positions.filter((pos) => pos + oldLines.length === parts.lines.length);
          if (positions.length > 0) {
            found = { tier, positions };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.positions[0]!;
        const repl = buildReplacement(parts.lines, pos, oldLines, chunk.body, found.tier);
        parts.lines.splice(pos, oldLines.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const content = joinFile(parts);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, content);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, content);
    }
  };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (claimed.has(o) || claimed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      claimed.add(o);
      claimed.add(n);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
