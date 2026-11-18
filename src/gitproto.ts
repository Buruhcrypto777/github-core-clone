// Git wire protocol: pkt-lines, packfile read/write, fetch computation, receive-pack.
// Node stdlib only (node:zlib, node:crypto). No deltas are ever written; deltas are resolved on read.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  typeCodeOf,
  typeOfCode,
  collectReachable,
  type GitObject,
  type GitObjectType,
  type ObjectMap,
  ZERO_OID,
} from './store.ts';

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; returns packets and the offset where framing stopped. */
export function decodePktLines(buffer: Buffer): { packets: Packet[]; restOffset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, restOffset: offset };
}

/** The data-packet texts of a buffer, in order. */
export function pktLinesText(buffer: Buffer): string[] {
  const { packets } = decodePktLines(buffer);
  const out: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = typeCodeOf(type);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta expects a different base size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA. `resolveBase` supplies bases a
 * thin pack leaves out. Every object's id is recomputed; a mismatch throws.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!typeOfCode(typeCode)) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { resolved?: { type: GitObjectType; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = typeOfCode(entry.typeCode)!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    (entry as unknown as { resolved?: unknown }).resolved = result;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send (in pack order). */
  objects: GitObject[];
  /** New shallow boundary commits (depth cut). */
  shallow: string[];
  /** Previously-shallow commits that are no longer shallow. */
  unshallow: string[];
}

/**
 * Compute what a fetch sends. `wants` are commit/tag oids, `haves` are commits the client holds,
 * `depth` limits history (1 = wants only), `oldShallow` is the client's current boundary.
 * Objects reachable from haves are never re-sent; boundary commits' parents are not sent.
 */
export function planFetch(
  objects: ObjectMap,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  // Included commits: BFS from wants, following parents up to depth-1 steps (depth null = all).
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      // A wanted tag: the tag object itself plus its target chain.
      included.add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, dist: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(oid);
      queue.push({ oid: parseTag(object.data).object, dist });
      continue;
    }
    if (object.type !== 'commit') continue;
    included.add(oid);
    if (depth !== null && dist >= depth - 1) {
      boundary.add(oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  // Everything reachable from the included commits (their trees and blobs), minus what the
  // client already holds. The client's haves do NOT imply their ancestors when the client is
  // shallow: the old shallow boundaries cut the held closure (their parents are not held).
  const held = collectReachable(objects, haves, new Set(oldShallow));
  const send = new Set<string>();
  const expandQueue: string[] = [...included];
  while (expandQueue.length > 0) {
    const oid = expandQueue.pop()!;
    if (send.has(oid) || held.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      expandQueue.push(commit.tree);
      // Parents are only expanded when they are themselves included (depth cut stops at boundary).
      for (const parent of commit.parents) if (included.has(parent)) expandQueue.push(parent);
    } else if (object.type === 'tag') {
      expandQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        expandQueue.push(entry.oid);
      }
    }
  }

  // Pack order: commits first (in BFS discovery order), then trees, then blobs — any order is valid.
  const ordered: GitObject[] = [];
  const byType = (type: GitObjectType): GitObject[] => {
    const list: GitObject[] = [];
    for (const oid of send) {
      const object = objects.get(oid);
      if (object && object.type === type) list.push(object);
    }
    return list;
  };
  ordered.push(...byType('commit'), ...byType('tag'), ...byType('tree'), ...byType('blob'));

  const shallow = depth === null ? [] : [...boundary];
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects: ordered, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushRefResult {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack command list to a repo's refs (objects already stored).
 * Fast-forward only; per-ref results. Returns the per-ref outcomes in command order.
 */
export function applyPush(objects: ObjectMap, refs: Map<string, string>, commands: readonly PushCommand[]): PushRefResult[] {
  const results: PushRefResult[] = [];
  for (const command of commands) {
    const current = refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.oldOid === command.newOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Fast-forward: new must descend from old (for commits); tags may only move by delete+create.
    const newObject = objects.get(command.newOid);
    const oldObject = objects.get(command.oldOid);
    let ff = false;
    if (newObject && newObject.type === 'commit' && oldObject && oldObject.type === 'commit') {
      ff = isAncestorOf(objects, command.oldOid, command.newOid);
    } else if (newObject && newObject.type === 'tag' && oldObject && oldObject.type === 'tag') {
      ff = false;
    } else {
      ff = false;
    }
    if (!ff) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return results;
}

/** Ancestor check that also follows tag objects to their targets. */
function isAncestorOf(objects: ObjectMap, ancestor: string, descendant: string): boolean {
  const resolve = (oid: string): string => {
    const object = objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return oid;
  };
  const a = resolve(ancestor);
  const d = resolve(descendant);
  if (a === d) return true;
  const seen = new Set<string>();
  const queue = [d];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === a) return true;
      queue.push(parent);
    }
  }
  return false;
}
