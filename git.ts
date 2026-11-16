// git.ts — git object store, packfiles, pkt-line framing, and the smart-HTTP protocol
// (upload-pack v2 + receive-pack v0). Node stdlib only. No deltas are ever emitted;
// incoming packs (plain or delta) are fully decoded.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a loose object: sha1("<type> <len>\0<data>"). */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// object store (in-memory, content-addressed)
// ---------------------------------------------------------------------------

export class ObjectStore {
  private readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get size(): number {
    return this.objects.size;
  }
}

// ---------------------------------------------------------------------------
// commit / tree / tag parsing and building
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.author}\ncommitter ${info.committer}\n\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(
    `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`,
    'utf8',
  );
}

/** Peel a tag object to its target commit (following tag chains). Returns the commit oid or the input. */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/** All object ids reachable from `roots` (commits, trees, blobs, tags), in BFS order. */
export function reachable(store: ObjectStore, roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined) continue;
    out.push(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `oid` by following commit parents (tags peeled). */
export function isAncestor(store: ObjectStore, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const target = peelToCommit(store, ancestor);
  let current = peelToCommit(store, oid);
  const seen = new Set<string>();
  const queue: string[] = [current];
  while (queue.length) {
    current = queue.shift() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** Commits reachable from `roots` with their generation (distance from the nearest root).
 *  When `maxDepth` is given, parents at generation >= maxDepth are not expanded, so a
 *  depth-limited fetch does not walk history it will never include. */
export function commitGenerations(
  store: ObjectStore,
  roots: readonly string[],
  maxDepth?: number | null,
): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid: peelToCommit(store, oid), depth: 0 }));
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const known = generations.get(oid);
    if (known !== undefined && known <= depth) continue;
    generations.set(oid, depth);
    if (maxDepth !== undefined && maxDepth !== null && depth >= maxDepth) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return generations;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

/** Encode objects as a packfile v2 with no deltas. */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (obj === undefined) continue;
    parts.push(encodePackObject(obj.type, obj.data));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

function encodePackObject(type: GitObjectType, data: Buffer): Buffer {
  const typeCode = TYPE_CODES[type];
  const size = data.length;
  // First byte: (size & 0x0f) | (type << 4) | (continuation bit if more size bytes follow).
  const sizeBytes: number[] = [];
  let remaining = size;
  sizeBytes.push(remaining & 0x0f);
  remaining >>= 4;
  while (remaining > 0) {
    sizeBytes.push(remaining & 0x7f);
    remaining >>= 7;
  }
  const headerLen = sizeBytes.length;
  const header = Buffer.alloc(headerLen);
  for (let i = 0; i < headerLen; i += 1) {
    let byte = sizeBytes[i] as number;
    if (i === 0) byte |= typeCode << 4;
    if (i < headerLen - 1) byte |= 0x80;
    header[i] = byte;
  }
  return Buffer.concat([header, deflateSync(data)]);
}

interface PackObjectHeader {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  size: number;
  headerLength: number;
  baseOffset?: number;
  baseOid?: string;
}

function readPackObjectHeader(pack: Buffer, offset: number): PackObjectHeader {
  let byte = pack[offset] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let length = 1;
  while ((byte & 0x80) !== 0) {
    byte = pack[offset + length] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    length += 1;
  }
  if (typeCode === 6) {
    // OFS_DELTA: variable-length negative offset.
    let offByte = pack[offset + length] as number;
    let baseOffset = offByte & 0x7f;
    length += 1;
    while ((offByte & 0x80) !== 0) {
      offByte = pack[offset + length] as number;
      baseOffset = ((baseOffset + 1) << 7) | (offByte & 0x7f);
      length += 1;
    }
    return { type: 'ofs-delta', size, headerLength: length, baseOffset };
  }
  if (typeCode === 7) {
    const baseOid = pack.subarray(offset + length, offset + length + 20).toString('hex');
    return { type: 'ref-delta', size, headerLength: length + 20, baseOid };
  }
  return { type: CODE_TYPES[typeCode] as GitObjectType, size, headerLength: length };
}

/**
 * Inflate one zlib stream and report exactly how many input bytes it consumed.
 * inflateSync stops at the stream end and ignores trailing bytes; with {info: true}
 * the engine's bytesWritten is the consumed count, so one call locates the stream end
 * (the typings do not cover the info form, hence the cast).
 */
function inflateWithInfo(data: Buffer): { buffer: Buffer; bytesConsumed: number } {
  const inflateInfo = inflateSync as unknown as (
    buf: Buffer,
    options: { info: true },
  ) => { buffer: Buffer; engine: { bytesWritten: number } };
  const result = inflateInfo(data, { info: true });
  return { buffer: result.buffer, bytesConsumed: result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize) throw new Error(`delta result size ${out.length} does not match ${resultSize}`);
  return out;
}

export interface DecodedPack {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Decode a packfile (plain objects and OFS/REF deltas), resolving deltas against the pack itself. */
export function readPack(pack: Buffer): DecodedPack {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const deltas: Array<{ oid: string; base: string | number; data: Buffer; type: 'ofs-delta' | 'ref-delta' }> = [];
  let deltaCount = 0;
  let offset = 12;
  const offsetToOid = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const header = readPackObjectHeader(pack, offset);
    offset += header.headerLength;
    const dataStart = offset;
    // One inflation per object: the stream ends where the inflater stops, and
    // bytesWritten says exactly how many input bytes that took.
    const { buffer: inflated, bytesConsumed } = inflateWithInfo(pack.subarray(dataStart));
    if (inflated.length !== header.size) throw new Error('packed object inflated to the wrong size');
    offset = dataStart + bytesConsumed;
    if (header.type === 'ofs-delta' || header.type === 'ref-delta') {
      deltaCount += 1;
      const base = header.type === 'ofs-delta' ? start - (header.baseOffset as number) : (header.baseOid as string);
      // The delta's own oid is unknown until resolved; store by index order and resolve after.
      deltas.push({ oid: '', base, data: inflated, type: header.type });
      // Record the placeholder so later deltas can chain by offset.
      offsetToOid.set(start, `__delta_${deltas.length - 1}`);
    } else {
      const oid = objectId(header.type, inflated);
      objects.set(oid, { type: header.type, data: inflated });
      offsetToOid.set(start, oid);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolve.
  const pending = new Map<number, { base: string | number; data: Buffer }>();
  deltas.forEach((delta, index) => pending.set(index, { base: delta.base, data: delta.data }));
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const [index, delta] of [...pending.entries()]) {
      const baseOid = typeof delta.base === 'number' ? offsetToOid.get(delta.base) : delta.base;
      if (baseOid === undefined || baseOid.startsWith('__delta_')) continue;
      const base = objects.get(baseOid);
      if (base === undefined) continue;
      const resolved = applyDelta(base.data, delta.data);
      const oid = objectId(base.type, resolved);
      objects.set(oid, { type: base.type, data: resolved });
      // Any delta that used this one by offset now resolves via the offset map.
      for (const [off, val] of offsetToOid.entries()) {
        if (val === `__delta_${index}`) offsetToOid.set(off, oid);
      }
      pending.delete(index);
      progress = true;
    }
  }
  if (pending.size) throw new Error(`${pending.size} delta(s) could not resolve to a base object`);
  return { objects, deltaCount };
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const body = pack.subarray(0, pack.length - 20);
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return sha1(body) === expected;
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush);
    else if (item === 'delim') parts.push(pktDelim);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode every pkt-line in a buffer. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return packets;
}

/** Split a receive-pack body into its command packets and the trailing raw pack bytes. */
export function splitReceivePackBody(buf: Buffer): { packets: Packet[]; packStart: number } {
  let pos = 0;
  const packets: Packet[] = [];
  while (pos + 4 <= buf.length) {
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, packStart: pos + 4 };
    }
    if (head === '0001' || head === '0002') {
      packets.push(head === '0001' ? { kind: 'delim' } : { kind: 'response-end' });
      pos += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  throw new Error('receive-pack body has no flush packet');
}
