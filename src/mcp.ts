// Model Context Protocol over Streamable HTTP (revision 2026-07-28, modern era).
// JSON-RPC 2.0, one JSON body per POST. No session, no SSE stream: every request is answered
// by one JSON body. Tools share the REST store.

import { issueJson, pullJson, repoJson, threeWayMerge, type RestContext } from './rest.ts';
import { buildCommit, hashObject, REST_EPOCH_SEC, VIEWER, VIEWER_IDENTITY, type Issue, type Pull, type Repo, type Store } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';

export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

/** The tools, in a fixed order: two tools/list calls must be byte-identical. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function textResult(value: unknown): McpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function restCtx(store: Store, origin: string): RestContext {
  return {
    store,
    req: null as unknown as RestContext['req'],
    res: null as unknown as RestContext['res'],
    segments: [],
    query: new URLSearchParams(),
    origin,
  };
}

function getRepoOrError(store: Store, args: Record<string, unknown>): Repo | McpToolResult {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (owner !== VIEWER.login) return errorResult(`repository ${owner}/${repoName} not found`);
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
  return repo;
}

function callTool(store: Store, origin: string, name: string, args: Record<string, unknown>): McpToolResult {
  const ctx = restCtx(store, origin);
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return errorResult(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return errorResult(`missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return errorResult('name is invalid');
      const repo = store.createRepo(repoName, asString(args.description), args.private === true);
      if (repo === null) return errorResult('Repository already exists');
      return textResult(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      return textResult(repoJson(ctx, repo));
    }
    case 'list_repos': {
      return textResult(store.listViewerRepos().map((repo) => repoJson(ctx, repo)));
    }
    case 'create_issue': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      const title = asString(args.title);
      if (title === '') return errorResult('title is required');
      repo.issueSeq += 1;
      const issue: Issue = {
        id: store.nextObjectId(),
        number: repo.issueSeq,
        title,
        body: asString(args.body),
        state: 'open',
        labels: [],
        seq: store.nextSeq(),
      };
      repo.issues.set(issue.number, issue);
      return textResult(issueJson(ctx, repo, issue));
    }
    case 'get_issue': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      const issue = repo.issues.get(asNumber(args.issue_number) ?? -1);
      if (!issue) return errorResult('issue not found');
      return textResult(issueJson(ctx, repo, issue));
    }
    case 'list_issues': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      const state = asString(args.state) || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return textResult(issues.map((issue) => issueJson(ctx, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      const head = asString(args.head);
      const base = asString(args.base);
      const title = asString(args.title);
      if (!repo.refs.has(`refs/heads/${head}`)) return errorResult(`head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return errorResult(`base branch "${base}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.head === head && existing.base === base && existing.state === 'open') {
          return errorResult('A pull request already exists for this head and base');
        }
      }
      repo.pullSeq += 1;
      const pull: Pull = {
        id: store.nextObjectId(),
        number: repo.pullSeq,
        title,
        body: asString(args.body),
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: '',
        mergeCommitSha: '',
        seq: store.nextSeq(),
      };
      repo.pulls.set(pull.number, pull);
      return textResult(pullJson(ctx, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepoOrError(store, args);
      if ('content' in repo) return repo;
      const pull = repo.pulls.get(asNumber(args.pull_number) ?? -1);
      if (!pull) return errorResult('pull request not found');
      if (pull.state !== 'open') return errorResult('pull request is not open');
      const merged = threeWayMerge(repo, pull);
      if (merged.conflict || merged.treeOid === null) return errorResult('merge conflict');
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
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeCommitSha = commitSha;
      return textResult(pullJson(ctx, repo, pull));
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: string | number | null, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Handle one parsed JSON-RPC request body (already known to be a JSON object). */
export function handleMcp(store: Store, origin: string, request: McpRequest): McpResponse {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'DiscoverResult',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_VERSION;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (!tool) {
      return rpcError(id, -32602, `unknown tool ${toolName}`);
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
    }
    const result = callTool(store, origin, toolName, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
