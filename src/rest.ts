// GitHub REST v3 surface (/api/v3).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  flattenTree,
  hashObject,
  isObjectId,
  lineDiffCounts,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  REST_EPOCH_SEC,
  VIEWER,
  VIEWER_IDENTITY,
  type FileDiff,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments under /api/v3 (decoded). */
  segments: string[];
  query: URLSearchParams;
  /** Absolute origin of this request (for Link headers). */
  origin: string;
}

const FIXED_TS = '2025-01-01T00:00:00Z';

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function repoUrl(origin: string, repo: Repo): string {
  return `${origin}/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const url = repoUrl(ctx.origin, repo);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', node_id: globalId('User', VIEWER.id) },
    private: repo.private,
    html_url: url,
    description: repo.description,
    fork: false,
    url,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    git_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id), type: 'User', site_admin: false };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const url = `${repoUrl(ctx.origin, repo)}/issues/${issue.number}`;
  const comments = repo.comments.get(issue.number) ?? [];
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    url,
    html_url: url,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: comments.length,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    author_association: 'OWNER',
  };
}

function refJson(repo: Repo, branch: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    user: userJson(),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

export function mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const merged = threeWayMerge(repo, pull);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

export function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const url = `${repoUrl(ctx.origin, repo)}/pulls/${pull.number}`;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url,
    html_url: url,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: pull.state === 'closed' ? FIXED_TS : null,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    merged: pull.merged,
    mergeable: mergeableOf(repo, pull) === 'MERGEABLE',
    mergeable_state: mergeableOf(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: pull.merged ? userJson() : null,
    draft: false,
    head: refJson(repo, pull.head, headSha),
    base: refJson(repo, pull.base, baseSha),
  };
}

/** Resolve a ref name / sha / tag to a commit oid, or null. */
export function resolveRefToCommit(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (!object) return null;
    if (object.type === 'commit') return ref;
    if (object.type === 'tag') {
      let target = object.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})/m.exec(target);
      if (!m) return null;
      const oid = m[1]!;
      const next = repo.objects.get(oid);
      return next && next.type === 'commit' ? oid : null;
    }
    return null;
  }
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) {
    const object = repo.objects.get(direct);
    if (object?.type === 'commit') return direct;
    if (object?.type === 'tag') return resolveRefToCommit(repo, direct);
    return direct;
  }
  return null;
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Three-way merge of a pull request onto its base tip. */
export function threeWayMerge(repo: Repo, pull: Pull): { conflict: boolean; treeOid: string | null } {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return { conflict: true, treeOid: null };
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const headTree = treeOfCommit(repo, headTip);
  const baseTipTree = treeOfCommit(repo, baseTip);
  if (!headTree || !baseTipTree) return { conflict: true, treeOid: null };
  const flatBase = baseTree ? flattenTree(repo.objects, baseTree) : new Map<string, { mode: string; oid: string }>();
  const flatHead = flattenTree(repo.objects, headTree);
  const flatTip = flattenTree(repo.objects, baseTipTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  let conflict = false;
  const paths = new Set([...flatBase.keys(), ...flatHead.keys(), ...flatTip.keys()]);
  for (const path of paths) {
    const b = flatBase.get(path);
    const h = flatHead.get(path);
    const t = flatTip.get(path);
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (hOid === bOid) {
      if (t) merged.set(path, t);
    } else if (tOid === bOid) {
      if (h) merged.set(path, h);
    } else if (hOid === tOid) {
      if (h) merged.set(path, h);
    } else {
      conflict = true;
    }
  }
  if (conflict) return { conflict: true, treeOid: null };
  return { conflict: false, treeOid: buildTreeFromFlat(repo.objects, merged) };
}

/** The files a pull request changes (merge-base tree vs head tree), with line counts. */
export function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const headTree = treeOfCommit(repo, headTip);
  if (!headTree) return [];
  const diffs: FileDiff[] = diffTrees(repo.objects, baseTree, headTree);
  return diffs.map((diff) => {
    const oldText = diff.oldOid ? blobText(repo, diff.oldOid) : '';
    const newText = diff.newOid ? blobText(repo, diff.newOid) : '';
    const counts = diff.status === 'added'
      ? { additions: newText === '' ? 0 : newText.split('\n').length, deletions: 0 }
      : diff.status === 'removed'
        ? { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length }
        : lineDiffCounts(oldText, newText);
    return { filename: diff.path, status: diff.status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions };
  });
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** Create one commit on `branch` setting `path` to `content`; returns commit + blob shas. */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; createdBranch: boolean } {
  const refName = `refs/heads/${branch}`;
  let parent = repo.refs.get(refName) ?? null;
  let createdBranch = false;
  if (parent === null) {
    // A new branch starts from the default branch's tip (or nothing when unborn).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    parent = defaultTip ?? null;
    createdBranch = true;
  }
  const parentTree = parent ? treeOfCommit(repo, parent) : null;
  const flat = parentTree ? flattenTree(repo.objects, parentTree) : new Map<string, { mode: string; oid: string }>();
  const blobSha = hashObject('blob', content);
  if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
  flat.set(path, { mode: '100644', oid: blobSha });
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  repo.commitSeq += 1;
  const commit = buildCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    message: `${message}\n`,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: REST_EPOCH_SEC + repo.commitSeq,
  });
  const commitSha = hashObject('commit', commit);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commit });
  repo.refs.set(refName, commitSha);
  return { commitSha, blobSha, createdBranch };
}

/** Delete `path` from `branch`'s tip; returns the new commit sha, or null when absent. */
export function deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName) ?? null;
  if (parent === null) return null;
  const parentTree = treeOfCommit(repo, parent);
  if (!parentTree) return null;
  const flat = flattenTree(repo.objects, parentTree);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  repo.commitSeq += 1;
  const commit = buildCommit({
    tree: treeOid,
    parents: [parent],
    message: `${message}\n`,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: REST_EPOCH_SEC + repo.commitSeq,
  });
  const commitSha = hashObject('commit', commit);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commit });
  repo.refs.set(refName, commitSha);
  return commitSha;
}

// ---------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------

type Handler = (ctx: RestContext, params: Record<string, string>, body: unknown) => void;

function json(ctx: RestContext, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  ctx.res.end(text);
}

function err(ctx: RestContext, status: number, message: string): void {
  json(ctx, status, { message });
}

function notFound(ctx: RestContext, what = 'Not Found'): void {
  err(ctx, 404, what);
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(ctx: RestContext, path: string, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${ctx.origin}${path}?${q.toString()}`;
  };
  if (page < lastPage) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(lastPage)}>; rel="last"`);
  return { page: pageItems, headers: { link: links.join(', ') } };
}

function requireRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function bodyBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------

const handlers: Array<{ method: string; pattern: RegExp; fn: Handler }> = [];

function route(method: string, pattern: string, fn: Handler): void {
  const regex = new RegExp(`^${pattern}$`);
  handlers.push({ method, pattern: regex, fn });
}

// GET /api/v3/meta
route('GET', '/meta', (ctx) => {
  json(ctx, 200, { installed_version: '1.0.0' });
});

// GET /api/v3/user
route('GET', '/user', (ctx) => {
  json(ctx, 200, {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  });
});

// GET /api/v3/user/repos
route('GET', '/user/repos', (ctx) => {
  const repos = ctx.store.listViewerRepos();
  const { page, headers } = paginate(ctx, '/api/v3/user/repos', repos);
  json(ctx, 200, page.map((repo) => repoJson(ctx, repo)), headers);
});

// POST /api/v3/user/repos
route('POST', '/user/repos', (ctx, _params, body) => {
  const b = parseBody(body);
  const name = bodyString(b, 'name');
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    err(ctx, 422, 'name is invalid');
    return;
  }
  const repo = ctx.store.createRepo(name, bodyString(b, 'description'), bodyBoolean(b, 'private', false));
  if (repo === null) {
    err(ctx, 422, 'Repository already exists');
    return;
  }
  json(ctx, 201, repoJson(ctx, repo));
});

// GET /api/v3/repos/{o}/{r}
route('GET', '/repos/([^/]+)/([^/]+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  json(ctx, 200, repoJson(ctx, repo));
});

// PATCH /api/v3/repos/{o}/{r}
route('PATCH', '/repos/([^/]+)/([^/]+)', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.private === 'boolean') repo.private = b.private;
  json(ctx, 200, repoJson(ctx, repo));
});

// DELETE /api/v3/repos/{o}/{r}
route('DELETE', '/repos/([^/]+)/([^/]+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  ctx.store.deleteRepo(params.owner!, params.repo!);
  ctx.res.writeHead(204);
  ctx.res.end();
});

// POST /api/v3/repos/{o}/{r}/git/refs
route('POST', '/repos/([^/]+)/([^/]+)/git/refs', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const ref = bodyString(b, 'ref');
  const sha = bodyString(b, 'sha');
  if (!ref.startsWith('refs/') || !isObjectId(sha)) {
    err(ctx, 422, 'ref and sha are required');
    return;
  }
  if (repo.refs.has(ref)) {
    err(ctx, 422, 'Reference already exists');
    return;
  }
  const object = repo.objects.get(sha);
  if (!object) {
    err(ctx, 422, 'object not found');
    return;
  }
  repo.refs.set(ref, sha);
  json(ctx, 201, { ref, object: { sha, type: object.type, url: '' } });
});

// GET /api/v3/repos/{o}/{r}/git/refs/{ref...}
route('GET', '/repos/([^/]+)/([^/]+)/git/refs/(.+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const refName = `refs/${params.ref!}`;
  const oid = repo.refs.get(refName);
  if (oid === undefined) return notFound(ctx);
  const object = repo.objects.get(oid);
  json(ctx, 200, { ref: refName, node_id: '', url: '', object: { sha: oid, type: object?.type ?? 'commit', url: '' } });
});

// GET /api/v3/repos/{o}/{r}/branches
route('GET', '/repos/([^/]+)/([^/]+)/branches', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const branches: Array<Record<string, unknown>> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort()) {
    if (!name.startsWith('refs/heads/')) continue;
    branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false });
  }
  json(ctx, 200, branches);
});

// GET /api/v3/repos/{o}/{r}/branches/{branch}
route('GET', '/repos/([^/]+)/([^/]+)/branches/([^/]+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const oid = repo.refs.get(`refs/heads/${params.branch!}`);
  if (oid === undefined) return notFound(ctx);
  json(ctx, 200, { name: params.branch, commit: { sha: oid, url: '' }, protected: false });
});

// GET /api/v3/repos/{o}/{r}/commits
route('GET', '/repos/([^/]+)/([^/]+)/commits', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const shaParam = ctx.query.get('sha');
  const tip = shaParam ? resolveRefToCommit(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (tip === null) {
    json(ctx, 200, []);
    return;
  }
  const commits = listCommits(repo.objects, tip).map((oid) => {
    const commit = parseCommit(repo.objects.get(oid)!.data);
    return {
      sha: oid,
      node_id: globalId('Commit', oid),
      commit: { message: commit.message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email }, tree: { sha: commit.tree } },
      author: userJson(),
      committer: userJson(),
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  json(ctx, 200, commits);
});

// GET /api/v3/repos/{o}/{r}/commits/{sha}
route('GET', '/repos/([^/]+)/([^/]+)/commits/([0-9a-f]{40})', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const object = repo.objects.get(params.sha!);
  if (!object || object.type !== 'commit') return notFound(ctx);
  const commit = parseCommit(object.data);
  json(ctx, 200, {
    sha: params.sha,
    commit: { message: commit.message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email }, tree: { sha: commit.tree } },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  });
});

function contentEntry(ctx: RestContext, repo: Repo, path: string, name: string, mode: string, oid: string, isDir: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name,
    path,
    sha: oid,
    type: isDir ? 'dir' : 'file',
    url: `${repoUrl(ctx.origin, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    html_url: '',
    git_url: '',
    download_url: isDir ? null : '',
  };
  if (!isDir) {
    const object = repo.objects.get(oid);
    base.size = object ? object.data.length : 0;
    base.encoding = 'base64';
    base.content = object ? object.data.toString('base64') : '';
  }
  return base;
}

// PUT /api/v3/repos/{o}/{r}/contents/{path}
route('PUT', '/repos/([^/]+)/([^/]+)/contents/(.+)', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const path = params.path!;
  const contentB64 = bodyString(b, 'content');
  if (contentB64 === '') {
    err(ctx, 422, 'content is required');
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    err(ctx, 422, 'content is not valid base64');
    return;
  }
  const branch = bodyString(b, 'branch') || repo.defaultBranch;
  const message = bodyString(b, 'message') || `Update ${path}`;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const currentTree = tip ? treeOfCommit(repo, tip) : null;
  const flat = currentTree ? flattenTree(repo.objects, currentTree) : new Map<string, { mode: string; oid: string }>();
  const existing = flat.get(path);
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    const sha = bodyString(b, 'sha');
    if (sha !== existing.oid) {
      err(ctx, 409, 'sha does not match the current blob');
      return;
    }
  }
  const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
  json(ctx, isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: commitSha, message },
  });
});

// GET /api/v3/repos/{o}/{r}/contents/{path}
route('GET', '/repos/([^/]+)/([^/]+)/contents/(.+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const path = params.path!;
  const refParam = ctx.query.get('ref');
  const tip = refParam ? resolveRefToCommit(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (tip === null) return notFound(ctx);
  const treeOid = treeOfCommit(repo, tip);
  if (!treeOid) return notFound(ctx);
  const flat = flattenTree(repo.objects, treeOid);
  const entry = flat.get(path);
  if (entry) {
    json(ctx, 200, contentEntry(ctx, repo, path, path.split('/').pop()!, entry.mode, entry.oid, false));
    return;
  }
  // A directory: every entry directly under it.
  const prefix = `${path}/`;
  const children = new Map<string, { mode: string; oid: string; isDir: boolean }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { mode: entry.mode, oid: entry.oid, isDir: false });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        const dirOid = treeOidAtPath(repo, treeOid, `${path}/${dirName}`);
        if (dirOid !== null) children.set(dirName, { mode: '40000', oid: dirOid, isDir: true });
      }
    }
  }
  if (children.size === 0) return notFound(ctx);
  const listing = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, child]) => contentEntry(ctx, repo, `${path}/${name}`, name, child.mode, child.oid, child.isDir));
  json(ctx, 200, listing);
});

/** The tree oid at a repo-relative directory path, or null. */
function treeOidAtPath(repo: Repo, rootTreeOid: string, path: string): string | null {
  let current = rootTreeOid;
  for (const segment of path.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// DELETE /api/v3/repos/{o}/{r}/contents/{path}
route('DELETE', '/repos/([^/]+)/([^/]+)/contents/(.+)', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const path = params.path!;
  const branch = bodyString(b, 'branch') || repo.defaultBranch;
  const message = bodyString(b, 'message') || `Delete ${path}`;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const currentTree = tip ? treeOfCommit(repo, tip) : null;
  const flat = currentTree ? flattenTree(repo.objects, currentTree) : new Map<string, { mode: string; oid: string }>();
  const existing = flat.get(path);
  if (!existing) return notFound(ctx);
  const sha = bodyString(b, 'sha');
  if (sha !== '' && sha !== existing.oid) {
    err(ctx, 409, 'sha does not match the current blob');
    return;
  }
  const commitSha = deleteFile(repo, branch, path, message);
  if (commitSha === null) return notFound(ctx);
  json(ctx, 200, { commit: { sha: commitSha, message } });
});

// POST /api/v3/repos/{o}/{r}/labels
route('POST', '/repos/([^/]+)/([^/]+)/labels', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const name = bodyString(b, 'name');
  const color = bodyString(b, 'color') || 'ededed';
  if (name === '') {
    err(ctx, 422, 'name is required');
    return;
  }
  if (repo.labels.has(name)) {
    err(ctx, 422, 'Label already exists');
    return;
  }
  const label: Label = { name, color: color.replace(/^#/, ''), description: bodyString(b, 'description') };
  repo.labels.set(name, label);
  json(ctx, 201, labelJson(label));
});

// GET /api/v3/repos/{o}/{r}/labels
route('GET', '/repos/([^/]+)/([^/]+)/labels', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  json(ctx, 200, [...repo.labels.values()].map(labelJson));
});

// POST /api/v3/repos/{o}/{r}/issues
route('POST', '/repos/([^/]+)/([^/]+)/issues', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const title = bodyString(b, 'title');
  if (title === '') {
    err(ctx, 422, 'title is required');
    return;
  }
  const rawLabels = Array.isArray(b.labels) ? b.labels : [];
  const labels: string[] = [];
  for (const entry of rawLabels) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>).name ?? '') : '';
    if (name === '') continue;
    if (!repo.labels.has(name)) {
      err(ctx, 422, `Label "${name}" does not exist`);
      return;
    }
    labels.push(name);
  }
  repo.issueSeq += 1;
  const issue: Issue = {
    id: ctx.store.nextObjectId(),
    number: repo.issueSeq,
    title,
    body: bodyString(b, 'body'),
    state: 'open',
    labels,
    seq: ctx.store.nextSeq(),
  };
  repo.issues.set(issue.number, issue);
  json(ctx, 201, issueJson(ctx, repo, issue));
});

// GET /api/v3/repos/{o}/{r}/issues
route('GET', '/repos/([^/]+)/([^/]+)/issues', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const dir = direction === 'asc' ? 1 : -1;
  if (sort === 'created' || sort === 'updated' || sort === 'comments') {
    issues.sort((a, b) => (a.seq - b.seq) * dir);
  }
  const { page, headers } = paginate(ctx, `/api/v3/repos/${params.owner}/${params.repo}/issues`, issues);
  json(ctx, 200, page.map((issue) => issueJson(ctx, repo, issue)), headers);
});

// GET /api/v3/repos/{o}/{r}/issues/{n}
route('GET', '/repos/([^/]+)/([^/]+)/issues/(\\d+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const issue = repo.issues.get(Number(params.number));
  if (!issue) return notFound(ctx);
  json(ctx, 200, issueJson(ctx, repo, issue));
});

// PATCH /api/v3/repos/{o}/{r}/issues/{n}
route('PATCH', '/repos/([^/]+)/([^/]+)/issues/(\\d+)', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const issue = repo.issues.get(Number(params.number));
  if (!issue) return notFound(ctx);
  const b = parseBody(body);
  if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  json(ctx, 200, issueJson(ctx, repo, issue));
});

// POST /api/v3/repos/{o}/{r}/issues/{n}/comments
route('POST', '/repos/([^/]+)/([^/]+)/issues/(\\d+)/comments', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const issue = repo.issues.get(Number(params.number));
  if (!issue) return notFound(ctx);
  const b = parseBody(body);
  const text = bodyString(b, 'body');
  if (text === '') {
    err(ctx, 422, 'body is required');
    return;
  }
  repo.commentSeq += 1;
  const comment = { id: ctx.store.nextObjectId(), body: text, seq: ctx.store.nextSeq() };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  json(ctx, 201, {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    url: `${repoUrl(ctx.origin, repo)}/issues/${issue.number}/comments/${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  });
});

// GET /api/v3/repos/{o}/{r}/issues/{n}/comments
route('GET', '/repos/([^/]+)/([^/]+)/issues/(\\d+)/comments', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const issue = repo.issues.get(Number(params.number));
  if (!issue) return notFound(ctx);
  const list = repo.comments.get(issue.number) ?? [];
  json(ctx, 200, list.map((comment) => ({
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    url: `${repoUrl(ctx.origin, repo)}/issues/${issue.number}/comments/${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  })));
});

// POST /api/v3/repos/{o}/{r}/pulls
route('POST', '/repos/([^/]+)/([^/]+)/pulls', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const b = parseBody(body);
  const title = bodyString(b, 'title');
  const head = bodyString(b, 'head');
  const base = bodyString(b, 'base');
  if (title === '' || head === '' || base === '') {
    err(ctx, 422, 'title, head and base are required');
    return;
  }
  if (!repo.refs.has(`refs/heads/${head}`)) {
    err(ctx, 422, `head branch "${head}" does not exist`);
    return;
  }
  if (!repo.refs.has(`refs/heads/${base}`)) {
    err(ctx, 422, `base branch "${base}" does not exist`);
    return;
  }
  if (head === base) {
    err(ctx, 422, 'head and base are the same branch');
    return;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.head === head && existing.base === base && existing.state === 'open') {
      err(ctx, 422, 'A pull request already exists for this head and base');
      return;
    }
  }
  repo.pullSeq += 1;
  const pull: Pull = {
    id: ctx.store.nextObjectId(),
    number: repo.pullSeq,
    title,
    body: bodyString(b, 'body'),
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: ctx.store.nextSeq(),
  };
  repo.pulls.set(pull.number, pull);
  json(ctx, 201, pullJson(ctx, repo, pull));
});

// GET /api/v3/repos/{o}/{r}/pulls
route('GET', '/repos/([^/]+)/([^/]+)/pulls', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, headers } = paginate(ctx, `/api/v3/repos/${params.owner}/${params.repo}/pulls`, pulls);
  json(ctx, 200, page.map((pull) => pullJson(ctx, repo, pull)), headers);
});

// GET /api/v3/repos/{o}/{r}/pulls/{n}
route('GET', '/repos/([^/]+)/([^/]+)/pulls/(\\d+)', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const pull = repo.pulls.get(Number(params.number));
  if (!pull) return notFound(ctx);
  json(ctx, 200, pullJson(ctx, repo, pull));
});

// GET /api/v3/repos/{o}/{r}/pulls/{n}/files
route('GET', '/repos/([^/]+)/([^/]+)/pulls/(\\d+)/files', (ctx, params) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const pull = repo.pulls.get(Number(params.number));
  if (!pull) return notFound(ctx);
  json(ctx, 200, pullFiles(repo, pull));
});

// PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge
route('PUT', '/repos/([^/]+)/([^/]+)/pulls/(\\d+)/merge', (ctx, params, body) => {
  const repo = requireRepo(ctx, params.owner!, params.repo!);
  if (!repo) return notFound(ctx);
  const pull = repo.pulls.get(Number(params.number));
  if (!pull) return notFound(ctx);
  if (pull.state !== 'open') {
    err(ctx, 405, 'Pull request is already closed');
    return;
  }
  const b = parseBody(body);
  const method = bodyString(b, 'merge_method') || 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    err(ctx, 422, `unknown merge method ${method}`);
    return;
  }
  const merged = threeWayMerge(repo, pull);
  if (merged.conflict || merged.treeOid === null) {
    err(ctx, 405, 'Merge conflict');
    return;
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
  repo.commitSeq += 1;
  const commit = buildCommit({
    tree: merged.treeOid,
    parents: [baseTip],
    message: `${pull.title}\n`,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: REST_EPOCH_SEC + repo.commitSeq,
  });
  const commitSha = hashObject('commit', commit);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TS;
  pull.mergeCommitSha = commitSha;
  json(ctx, 200, { sha: commitSha, merged: true, message: `Pull request #${pull.number} merged` });
});

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Dispatch one /api/v3 request. Returns true when a route matched (even on error answers).
 * Route patterns use named capture groups owner/repo/number/path/ref via positional names.
 */
export function handleRest(ctx: RestContext, body: unknown): boolean {
  const path = `/${ctx.segments.join('/')}`;
  const method = ctx.req.method ?? 'GET';
  for (const handler of handlers) {
    if (handler.method !== method) continue;
    const match = handler.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    // Positional captures, named by the route's shape: owner, repo, then number/path/ref.
    // Note: RegExp#source escapes '/' as '\/', so normalize before the shape checks.
    const source = handler.pattern.source.replace(/\\\//g, '/');
    const groups = match.slice(1);
    if (groups.length > 0 && source.includes('repos')) {
      params.owner = decodeURIComponent(groups[0] ?? '');
      params.repo = decodeURIComponent(groups[1] ?? '');
      const rest = groups.slice(2);
      if (rest.length > 0) {
        if (source.includes('issues/(\\d+)/comments') || source.includes('issues/(\\d+)')) {
          params.number = rest[0] ?? '';
        } else if (source.includes('pulls/(\\d+)')) {
          params.number = rest[0] ?? '';
        } else if (source.includes('branches/([^/]+)')) {
          params.branch = decodeURIComponent(rest[0] ?? '');
        } else if (source.includes('contents/(.+)')) {
          params.path = rest[0] ?? '';
        } else if (source.includes('git/refs/(.+)')) {
          params.ref = rest[0] ?? '';
        } else if (source.includes('commits/([0-9a-f]')) {
          params.sha = rest[0] ?? '';
        }
      }
    }
    try {
      handler.fn(ctx, params, body);
    } catch (err) {
      json(ctx, 500, { message: err instanceof Error ? err.message : 'internal error' });
    }
    return true;
  }
  return false;
}
