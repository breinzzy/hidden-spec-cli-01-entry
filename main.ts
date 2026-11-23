// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md v1 in full: invocation, output/exit codes, safe paths,
// format detection, three-tier line matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits, and all-or-nothing application.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

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

// ---- files: split / join (SPEC section 3) ----

interface SplitFile {
  br: string;
  lines: string[];
  ends: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// ---- line matching (SPEC section 5) ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0]! : '';
}
function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEqualAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
function findOccurrences(fileLines: string[], o: string[], tier: number, start: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const s = Math.max(0, start);
  for (let i = s; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEqualAtTier(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}
function findTier(fileLines: string[], o: string[], start: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, o, t, start);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Re-indent one non-context N line at tier 2 (SPEC section 5). */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (p === '' || line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

type Op = { kind: 'ctx' | 'del' | 'add'; text: string };
function opsOld(ops: Op[]): string[] {
  return ops.filter((o) => o.kind === 'ctx' || o.kind === 'del').map((o) => o.text);
}
function opsNew(ops: Op[]): string[] {
  return ops.filter((o) => o.kind === 'ctx' || o.kind === 'add').map((o) => o.text);
}

/**
 * Build the replacement lines for a matched occurrence at `pos`.
 * Context lines are written as the file's own matched lines; other N lines
 * are re-indented at tier 2.
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const o = opsOld(ops);
  const f = o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      out.push(reindent(op.text, tier, f, p));
    }
  }
  return out;
}

// Moves recorded by successful move edits, for the R output lines.
let recordedMoves: { old: string; next: string }[] = [];

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---- JSON edits (SPEC section 9) ----

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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- shared apply helpers ----

/** Apply one hunk/chunk's ops to `cur` lines at a chosen occurrence. */
function applyOpsAt(cur: string[], pos: number, ops: Op[], tier: number): string[] {
  const oLen = opsOld(ops).length;
  const repl = buildReplacement(ops, cur, pos, tier);
  return [...cur.slice(0, pos), ...repl, ...cur.slice(pos + oLen)];
}

/** Does a `\` body item immediately follow the last ctx/add body item? */
function hasBackslashAfterLastCtxAdd(body: { kind: string }[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'backslash';
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  body: { kind: 'ctx' | 'del' | 'add' | 'backslash'; text: string; emptyPatch?: boolean }[];
  ops: Op[];
  headerLine: number;
}

function parseDiffPath(line: string): string | null {
  // line starts with '--- ' or '+++ ': text after the four characters, up to
  // the first tab, surrounding spaces removed; /dev/null means no file.
  let t = line.slice(4).split('\t')[0]!;
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Section {
    oldPath: string | null | undefined;
    newPath: string | null | undefined;
    pairSeen: boolean;
    renameOld: string | undefined;
    renameNew: string | undefined;
    diffOld: string | undefined;
    diffNew: string | undefined;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
    startLine: number;
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false; // true once the current section has seen a hunk
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
  const diffRe = /^diff --git a\/([^ ]+) b\/([^ ]+)[ \t]*$/;

  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inBody = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // New section via diff --git (ends any body).
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        oldPath: undefined, newPath: undefined, pairSeen: false,
        renameOld: undefined, renameNew: undefined,
        diffOld: m[1]!, diffNew: m[2]!,
        isCreate: false, isDelete: false, hunks: [], startLine: i + 1,
      });
      i += 1;
      continue;
    }
    // New section via --- / +++ pair (when not inside a hunk body). It is a
    // new section when there is no current section, the current one already
    // has hunks, or the current one already has its --- / +++ pair: a pair
    // in a section's header belongs to that section, a second pair does not.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (cur === null || inBody || cur.pairSeen)) {
      // If we are in the middle of a hunk body this is handled by the body
      // loop below, never here: body parsing consumes its lines first.
      startSection({
        oldPath: undefined, newPath: undefined, pairSeen: false,
        renameOld: undefined, renameNew: undefined,
        diffOld: undefined, diffNew: undefined,
        isCreate: false, isDelete: false, hunks: [], startLine: i + 1,
      });
      // Fall through to header handling for this --- line.
    }
    if (cur === null) {
      // Outside any section: a hunk header here is an error; anything else
      // is ignored prose.
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // Inside a section.
    if (!inBody) {
      // Header phase.
      if (line.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = parseDiffPath(line);
        cur.newPath = parseDiffPath(nxt);
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = parseDiffPath(line);
        cur.pairSeen = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        // Hunk header: fall through to hunk parsing below.
      } else {
        // index / modes / any other header line: ignored.
        i += 1;
        continue;
      }
    }
    // Hunk header (in header phase or after earlier hunks).
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]!);
      const headerLine = i + 1;
      i += 1;
      // Collect the body.
      const body: Hunk['body'] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', emptyPatch: true });
          i += 1;
          continue;
        }
        const ch = bl[0]!;
        if (ch === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          i += 1;
        } else if (ch === '-') {
          body.push({ kind: 'del', text: bl.slice(1) });
          i += 1;
        } else if (ch === '+') {
          body.push({ kind: 'add', text: bl.slice(1) });
          i += 1;
        } else if (ch === '\\') {
          body.push({ kind: 'backslash', text: bl.slice(1) });
          i += 1;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it: only patch
      // lines that were empty (not ' ' context lines for an empty file
      // line) are trimmed.
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && last.emptyPatch === true) body.pop();
        else break;
      }
      const ops: Op[] = body.filter((b) => b.kind !== 'backslash').map((b) => ({ kind: b.kind as 'ctx' | 'del' | 'add', text: b.text }));
      cur.hunks.push({ a, body, ops, headerLine });
      inBody = true;
      continue;
    }
    // Outside bodies, other lines are ignored (prose, code fences).
    i += 1;
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    // ---/+++ names a side when present (null is /dev/null, a real value);
    // otherwise rename from/to, otherwise the diff --git paths.
    const oldPath: string | null | undefined =
      s.oldPath !== undefined ? s.oldPath : (s.renameOld !== undefined ? s.renameOld : s.diffOld);
    const newPath: string | null | undefined =
      s.newPath !== undefined ? s.newPath : (s.renameNew !== undefined ? s.renameNew : s.diffNew);
    if (oldPath === undefined && newPath === undefined) {
      // A section naming no path at all carries no edit.
      continue;
    }
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    if (isCreate) {
      const p = (newPath !== undefined && newPath !== null ? newPath : oldPath) as string;
      if (typeof p !== 'string') continue;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const added: string[] = [];
        for (const h of hunks) for (const op of h.ops) if (op.kind === 'add') added.push(op.text);
        let ends = true;
        if (added.length > 0) {
          // Last '+' line overall: find its hunk and check for a '\' after it.
          let lastH: Hunk | undefined;
          for (const h of hunks) if (h.ops.some((o) => o.kind === 'add')) lastH = h;
          if (lastH !== undefined) ends = !hasBackslashAfterLastCtxAdd(lastH.body);
        }
        tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (ends ? '\n' : ''));
      });
      continue;
    }
    if (isDelete) {
      const p = (oldPath !== undefined && oldPath !== null ? oldPath : newPath) as string;
      if (typeof p !== 'string') continue;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const oldS = oldPath as string;
    const newS = newPath as string;
    if (typeof oldS !== 'string' || typeof newS !== 'string') continue;
    if (oldS !== newS) {
      // Move.
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(oldS)) throw new Fail('unsafe', oldS);
        if (!safe(newS)) throw new Fail('unsafe', newS);
        const before = tree.get(oldS);
        if (before === null) throw new Fail('missing', oldS);
        if (tree.get(newS) !== null) throw new Fail('exists', newS);
        const out = applyUnifiedHunks(before, hunks, strict, oldS);
        tree.now.set(oldS, null);
        tree.now.set(newS, out);
        recordedMoves.push({ old: oldS, next: newS });
      });
      continue;
    }
    // Change of one path.
    const p = oldS;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyUnifiedHunks(before, hunks, strict, p);
      tree.now.set(p, out);
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function applyUnifiedHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const sf = splitFile(before);
  let cur = [...sf.lines];
  let ends = sf.ends;
  let d = 0;
  for (const h of hunks) {
    const o = opsOld(h.ops);
    const n = opsNew(h.ops);
    const lenBefore = cur.length;
    if (o.length > 0) {
      const found = findTier(cur, o, 0, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === lenBefore;
      cur = applyOpsAt(cur, best, h.ops, found.tier);
      if (runsToEnd) {
        const hasLast = h.ops.some((op) => op.kind === 'ctx' || op.kind === 'add');
        ends = hasLast ? !hasBackslashAfterLastCtxAdd(h.body) : true;
      }
      d += n.length - o.length;
    } else {
      const insertPos = Math.min(Math.max(h.a + d, 0), lenBefore);
      const repl = n;
      cur = [...cur.slice(0, insertPos), ...repl, ...cur.slice(insertPos)];
      // SPEC section 6, literally: an insertion at the end ends with a line
      // break unless a `\` line follows the hunk's last context or `+`
      // line (with no such line there is none, so the break is on).
      if (insertPos === lenBefore) {
        ends = !hasBackslashAfterLastCtxAdd(h.body);
      }
      d += n.length;
    }
  }
  return joinFile(cur, sf.br, ends);
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
    searchLine: number;
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    let endIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          endIdx = j;
          break;
        }
      }
    }
    if (eqIdx < 0 || endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Path: nearest line before SEARCH, after the previous block, that is
    // not blank and does not start with three backticks (trimmed).
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eqIdx),
      newLines: lines.slice(eqIdx + 1, endIdx),
      searchLine: searchIdx + 1,
    });
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const sf = splitFile(before);
    const found = findTier(sf.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const f = leadingWs(sf.lines[pos]!);
    const pp = leadingWs(b.oldLines[0]!);
    const repl = b.newLines.map((l) => reindent(l, found.tier, f, pp));
    const out = [...sf.lines.slice(0, pos), ...repl, ...sf.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile(out, sf.br, sf.ends));
  });
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: { kind: 'ctx' | 'del' | 'add'; text: string }[];
  ops: Op[];
  isEof: boolean;
}

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
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Section {
    kind: 'add' | 'delete' | 'update';
    path: string;
    moveTo: string | null;
    addLines: string[];
    chunks: V4aChunk[];
    updateLine: number;
  }
  const sections: Section[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i += 1;
    // Collect content until the next section start or End Patch.
    const contentStart = i;
    while (i < last && !isSectionStart(lines[i]!)) i += 1;
    const raw = lines.slice(contentStart, i);
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: Section = { kind, path, moveTo: null, addLines: [], chunks: [], updateLine: startLine };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') sec.addLines.push('');
        else if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
    } else {
      // Update: optional Move to first, then chunks.
      let j = 0;
      if (j < raw.length && raw[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = raw[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let curChunk: V4aChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk !== null) {
          sec.chunks.push(curChunk);
          curChunk = null;
        }
      };
      const ensureChunk = (): V4aChunk => {
        if (curChunk === null) curChunk = { anchor: null, body: [], ops: [], isEof: false };
        return curChunk;
      };
      for (; j < raw.length; j += 1) {
        const l = raw[j]!;
        const lineNo = contentStart + j + 1;
        if (l.startsWith('@@')) {
          if (curChunk !== null && (curChunk.body.length > 0 || curChunk.anchor !== null || curChunk.isEof)) pushChunk();
          const c = ensureChunk();
          c.anchor = l.slice(2).trim();
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          const c = ensureChunk();
          c.isEof = true;
          pushChunk();
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          const c = ensureChunk();
          if (l === '') c.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) c.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) c.body.push({ kind: 'del', text: l.slice(1) });
          else c.body.push({ kind: 'add', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      pushChunk();
      // A chunk with no body, no anchor and no EOF marker is not a chunk.
      sec.chunks = sec.chunks.filter((c) => c.body.length > 0 || (c.anchor !== null && c.anchor !== '') || c.isEof);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      for (const c of sec.chunks) c.ops = c.body.map((b) => ({ kind: b.kind, text: b.text }));
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const sf = splitFile(before);
    let cur = [...sf.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const anchor = chunk.anchor;
      if (anchor !== null && anchor !== '') {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = findOccurrences(cur, [anchor], t, cursor);
          if (occ.length > 0) {
            foundAt = occ[0]!;
            break;
          }
        }
        if (foundAt === null) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const o = opsOld(chunk.ops);
      const n = opsNew(chunk.ops);
      if (o.length > 0) {
        const found = findTier(cur, o, cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        let pos: number;
        if (chunk.isEof) {
          const eofOcc = found.occ.filter((q) => q + o.length === cur.length);
          if (eofOcc.length === 0) throw new Fail('no-match', p);
          pos = eofOcc[0]!;
        } else {
          pos = found.occ[0]!;
        }
        cur = applyOpsAt(cur, pos, chunk.ops, found.tier);
        cursor = pos + n.length;
      } else {
        const insertPos = chunk.isEof ? cur.length : cursor;
        cur = [...cur.slice(0, insertPos), ...n, ...cur.slice(insertPos)];
        cursor = insertPos + n.length;
      }
    }
    const out = joinFile(cur, sf.br, sf.ends);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      recordedMoves.push({ old: p, next: sec.moveTo });
    } else {
      tree.now.set(p, out);
    }
  });
}

// ---- run (SPEC sections 1, 2, 10) ----

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
  recordedMoves = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = recordedMoves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      recordedMoves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, byte order of the path (R sorts by <new>).
  interface Row {
    sortKey: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedNew = new Set<string>();
  const movedOld = new Set<string>();
  for (const m of recordedMoves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.now.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ sortKey: m.next, line: `R ${m.old} -> ${m.next}` });
      movedNew.add(m.next);
      movedOld.add(m.old);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedNew.has(p) || movedOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
