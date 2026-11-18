// Git smart HTTP: info/refs advertisements, upload-pack (v2 + v0), receive-pack (v0).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applyPush,
  decodePktLines,
  encodePktLine,
  planFetch,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  PKT_LINE_MAX,
  type PushCommand,
} from './gitproto.ts';
import {
  hashObject,
  isObjectId,
  parseTag,
  VIEWER,
  ZERO_OID,
  type Repo,
  type GitObject,
} from './store.ts';

export interface GitHttpContext {
  repo: Repo;
  req: IncomingMessage;
  res: ServerResponse;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let target = parseTag(object.data).object;
  for (;;) {
    const next = repo.objects.get(target);
    if (!next || next.type !== 'tag') return target;
    target = parseTag(next.data).object;
  }
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0';

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktFlush()];
  const tip = headTip(repo);
  if (tip === null) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(encodePktLine(`${tip} HEAD\u0000${caps}\n`));
    for (const ref of sortedRefs(repo)) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktFlush()];
  const tip = headTip(repo);
  if (tip === null) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(encodePktLine(`${tip} HEAD\u0000${caps}\n`));
    for (const ref of sortedRefs(repo)) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(ctx: GitHttpContext, service: string): void {
  const { req, res, repo } = ctx;
  if (service === 'git-upload-pack') {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v0UploadAdvertisement(repo));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', v0ReceiveAdvertisement(repo));
    return;
  }
  sendJson(res, 400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function parseV2Args(lines: string[]): { command: string; args: FetchArgs } {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, prefixes: [], peel: false, symrefs: false, unborn: false };
  let command = '';
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
  }
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const tip = headTip(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const emit = (line: string): void => {
    parts.push(encodePktLine(line));
  };
  if (tip !== null) {
    if (args.symrefs && keep('HEAD')) emit(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const peeled = peeledOid(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      emit(`${line}\n`);
    }
  } else if (args.unborn) {
    // Only when the client asked for unborn refs (it does not, with our advertisement).
    if (keep(`refs/heads/${repo.defaultBranch}`)) emit(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = PKT_LINE_MAX - 4 - 1; // pkt-line header + band byte
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(encodePktLine(payload));
  }
  return out;
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo.objects, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section is sent only when the client sent
  // 'have' lines. A fresh clone (no haves) expects the response to open with
  // 'shallow-info' or 'packfile' — real git omits the section there, and git's
  // client fails with "expected 'packfile', received 'acknowledgments'" otherwise.
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo.objects, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(encodePktLine('NAK\n'));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(ctx: GitHttpContext, body: Buffer): void {
  const { req, res, repo } = ctx;
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) {
    sendJson(res, 400, { message: 'empty upload-pack request' });
    return;
  }
  if (isV2) {
    const { command, args } = parseV2Args(lines);
    if (command === 'ls-refs') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
      return;
    }
    if (command === 'fetch') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, args));
      return;
    }
    sendJson(res, 400, { message: `unknown upload-pack command ${command}` });
    return;
  }
  // v0: wants (with optional caps on the first), shallow/deepen, flush, haves, done, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, prefixes: [], peel: false, symrefs: false, unborn: false };
  let seenFlush = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      args.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    void seenFlush;
  }
  void seenFlush;
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, args));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export function handleReceivePack(ctx: GitHttpContext, body: Buffer): void {
  const { res, repo } = ctx;
  const { packets, restOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const main = nul < 0 ? text : text.slice(0, nul);
    const parts = main.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  if (!sawFlush || commands.length === 0) {
    sendJson(res, 400, { message: 'malformed receive-pack request' });
    return;
  }

  // The pack follows the flush pkt-line.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(restOffset);
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        const check = hashObject(object.type, object.data);
        if (check !== oid) throw new Error(`object ${oid} does not recompute`);
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  let results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    results = applyPush(repo.objects, repo.refs, commands);
  } else {
    results = commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' }));
  }

  // report-status inside sideband band 1, pkt-framed.
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportBody = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  const banded = encodePktLine(Buffer.concat([Buffer.from([1]), reportBody]));
  const parts = [banded, pktFlush()];
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

export function viewerLogin(): string {
  return VIEWER.login;
}
