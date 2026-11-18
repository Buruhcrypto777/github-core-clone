// In-memory store + git object model for the forge.
// Determinism: no wall clock, no Math.random anywhere in here. Commit timestamps for
// REST-created commits come from a monotonic sequence off a fixed epoch.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** The viewer the trial token names (wire.ts SCENARIO_SEED is a kit constant, so the login is fixed). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const VIEWER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

/** Fixed epoch for REST-created commits; each commit adds its sequence, so bytes are reproducible. */
export const REST_EPOCH_SEC = 1700000000;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function typeCodeOf(type: GitObjectType): number {
  return TYPE_CODE[type];
}

export function typeOfCode(code: number): GitObjectType | null {
  return CODE_TYPE[code] ?? null;
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\u0000`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  // The API presents the message without the raw object's trailing newline(s).
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8').replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? REST_EPOCH_SEC;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? VIEWER_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? VIEWER_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// object graph helpers (operate on a repo's object map)
// ---------------------------------------------------------------------------------------------

export type ObjectMap = Map<string, GitObject>;

/** Everything reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
/** An empty cut set, shared so callers do not allocate one per call. */
const EMPTY_CUT: ReadonlySet<string> = new Set<string>();

export function collectReachable(
  objects: ObjectMap,
  roots: Iterable<string>,
  /** Commits in `cut` contribute their tree but not their parents (a shallow client's boundary). */
  cut: ReadonlySet<string> = EMPTY_CUT,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(objects: ObjectMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the common ancestor closest to both (first found by BFS from both). */
export function mergeBase(objects: ObjectMap, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, d] = queueA.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, d + 1]);
  }
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, d] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined) {
      const score = da + d;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, d + 1]);
  }
  return best;
}

/** All commits reachable from `tip`, newest-first (BFS by generation, parents after children). */
export function listCommits(objects: ObjectMap, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Flatten a tree to path -> {mode, oid}. */
export function flattenTree(objects: ObjectMap, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, base: string): void => {
    const object = objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build (and store) a tree from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(objects: ObjectMap, flat: Map<string, { mode: string; oid: string }>): string {
  const put = (type: GitObjectType, data: Buffer): string => {
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
    return oid;
  };
  const buildLevel = (paths: Array<{ segments: string[]; mode: string; oid: string }>): string => {
    const dirs = new Map<string, Array<{ segments: string[]; mode: string; oid: string }>>();
    const entries: TreeEntry[] = [];
    for (const item of paths) {
      if (item.segments.length === 1) {
        entries.push({ mode: item.mode, name: item.segments[0]!, oid: item.oid });
      } else {
        const head = item.segments[0]!;
        const rest = dirs.get(head) ?? [];
        rest.push({ segments: item.segments.slice(1), mode: item.mode, oid: item.oid });
        dirs.set(head, rest);
      }
    }
    for (const [name, children] of dirs) {
      entries.push({ mode: '40000', name, oid: buildLevel(children) });
    }
    return put('tree', buildTree(entries));
  };
  const items = [...flat.entries()].map(([path, entry]) => ({ segments: path.split('/'), mode: entry.mode, oid: entry.oid }));
  return buildLevel(items);
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (by oid) via their flattened maps. */
export function diffTrees(objects: ObjectMap, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = baseTreeOid ? flattenTree(objects, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const head = headTreeOid ? flattenTree(objects, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Line counts for a changed file. A bounded LCS; falls back to set counting on huge inputs. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length === 0 && newLines.length === 0) return { additions: 0, deletions: 0 };
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return { additions, deletions };
  }
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: ObjectMap;
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>;
  pullSeq: number;
  comments: Map<number, IssueComment[]>;
  commentSeq: number;
  commitSeq: number;
  /** Serialized single-issue responses, keyed by issue number (see rest.ts issueJsonText). */
  issueTextCache: Map<number, { key: string; text: string }>;
  /** Memoized fetch (upload-pack) responses, keyed by fetchCacheKey (see githttp.ts). */
  fetchCache: Map<string, Buffer>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 5000;
  private objectIdSeq = 100000;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextObjectId(): number {
    this.objectIdSeq += 1;
    return this.objectIdSeq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const repo: Repo = {
      id: this.repoIdSeq,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 0,
      labels: new Map(),
      pulls: new Map(),
      pullSeq: 0,
      comments: new Map(),
      commentSeq: 0,
      commitSeq: 0,
      issueTextCache: new Map(),
      fetchCache: new Map(),
    };
    this.repoIdSeq += 1;
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** The default branch's tip commit oid, or null when the repo is unborn. */
  headTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
}
