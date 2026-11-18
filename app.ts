// The entry's HTTP server: routing, auth, the request-id header, body reading.
// One process, in-memory store, Node stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './src/store.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp, type McpRequest } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

const EMPTY_BUFFER = Buffer.alloc(0);

/** Split req.url into its raw path and query string without building a URL object. */
function splitUrl(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = q < 0 ? '' : rawUrl.slice(q + 1);
  // new URL() normalizes dot segments, duplicate slashes and %2e; the fast path below
  // is byte-identical for the clean paths clients send, and anything odd falls back to it.
  if (!rawPath.includes('/.') && !rawPath.includes('//') && !rawPath.includes('%2e') && !rawPath.includes('%2E')) {
    return { path: rawPath === '' ? '/' : rawPath, query };
  }
  try {
    return { path: new URL(rawUrl, 'http://entry').pathname, query };
  } catch {
    return { path: '/', query };
  }
}

const EXPECTED_AUTH = TOKEN === '' ? '' : `Bearer ${TOKEN}`;

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === EXPECTED_AUTH;
}

/**
 * Read a request body with plain 'data'/'end' listeners instead of `for await`
 * over the stream. The async-iterator protocol (iterator object + a promise per
 * chunk) costs several microseconds per POST; the bench sends ~1500 POSTs per
 * trial, almost all single-chunk. Semantics are identical to the old version:
 * resolves with the full body, rejects on oversize (handled as 413 upstream)
 * or on stream error/abort.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('close', () => {
      // Aborted mid-body: 'end' will never fire. A normally completed request
      // has req.complete true (and 'end' already settled the promise).
      if (!settled && !req.complete) fail(new Error('request aborted'));
    });
  });
}

function decodeSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map((segment) => {
    if (!segment.includes('%')) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // The peer is gone; nothing to write to.
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Every reply carries a non-empty X-GitHub-Request-Id (set once; writeHead sends it).
  const requestId = `req-${++requestCounter}`;
  res.setHeader('x-github-request-id', requestId);

  const { path, query: queryString } = splitUrl(req.url ?? '/');
  const method = req.method ?? 'GET';
  const segments = decodeSegments(path);
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

  // The env's boot check calls this twice: 200 {"ok": true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root, as the starter answers it: 200 with the token's scopes, no auth.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Read the body first (even for refusals) so keep-alive connections stay clean.
  // Requests that cannot carry a body skip the stream machinery entirely; anything
  // with a declared body is still read in full.
  const contentLength = req.headers['content-length'];
  const hasBody =
    method === 'POST' || method === 'PUT' || method === 'PATCH' ||
    (contentLength !== undefined && contentLength !== '0') ||
    req.headers['transfer-encoding'] !== undefined;
  let body: Buffer = EMPTY_BUFFER;
  if (hasBody) {
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 413, { message: 'request body too large' });
      return;
    }
  }
  const query = new URLSearchParams(queryString);

  // MCP close: DELETE /mcp (best-effort, no session is kept).
  if (path === '/mcp' && method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }

  // MCP endpoint.
  if (path === '/mcp' && method === 'POST') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const answer = handleMcp(store, origin, parsed as McpRequest);
    if (answer.body === null) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  // GraphQL endpoint.
  if (path === '/api/graphql' && method === 'POST') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        const result = executeGraphQL(store, String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, (item.operationName as string | null) ?? null);
        return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
      });
      sendJson(res, 200, results);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      sendJson(res, 400, { errors: [{ message: 'request body must be a JSON object' }] });
      return;
    }
    const item = parsed as Record<string, unknown>;
    const result = executeGraphQL(store, String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, (item.operationName as string | null) ?? null);
    sendJson(res, 200, result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let jsonBody: unknown = {};
    if (body.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
      try {
        jsonBody = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'request body is not valid JSON' });
        return;
      }
    }
    const ctx: RestContext = { store, req, res, segments: segments.slice(2), query, origin };
    const handled = handleRest(ctx, jsonBody);
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const rest = segments.slice(2);
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const gitCtx = { repo, req, res };
    if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
      const service = query.get('service') ?? '';
      handleInfoRefs(gitCtx, service);
      return;
    }
    if (method === 'POST' && rest[0] === 'git-upload-pack') {
      handleUploadPack(gitCtx, body);
      return;
    }
    if (method === 'POST' && rest[0] === 'git-receive-pack') {
      handleReceivePack(gitCtx, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Anything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
