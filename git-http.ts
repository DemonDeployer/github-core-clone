// git-http.ts — the git smart-HTTP surface: info/refs advertisements (v0/v2),
// upload-pack (ls-refs, fetch v2, fetch v0) and receive-pack (v0, report-status).

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isObjectId,
  commitGenerations,
  peelToCommit,
  parseCommit,
  parseTree,
  parseTag,
  writePack,
  readPack,
  verifyPackChecksum,
  pktLine,
  pktLines,
  pktFlush,
  pktDelim,
  decodePktLines,
  splitReceivePackBody,
  isAncestor,
  type GitObject,
} from './git.ts';
import { store as globalStore, type Repo, type Store } from './store.ts';

export const AGENT = 'forge/1.0';

const V2_CAPS = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];

// ---------------------------------------------------------------------------
// pack cache
// ---------------------------------------------------------------------------
//
// writePack is deterministic for a given oid list, and the object store is
// append-only and content-addressed: ObjectStore.put/putObject only ever
// store an absent key, never overwrite or delete one. A pack built for an
// oid list is therefore byte-identical forever, so it is safe to cache it
// keyed by the oid list with no invalidation at all. The fetch workloads
// repeat the same request (50 depth-1 clones of one tip; repeated fetches
// of the same history), so the cache turns every repeat into a Map lookup.
// Bounded: only packs <= 256 KiB are kept, at most 256 entries, oldest
// evicted first. The key is a sha1 of the joined oid list so a full-history
// list (hundreds of oids) stays a short fixed-size key.

const PACK_CACHE_MAX_ENTRIES = 256;
const PACK_CACHE_MAX_BYTES = 256 * 1024;
const packCache = new Map<string, Buffer>();

function cachedWritePack(store: Store['objects'], oids: readonly string[]): Buffer {
  const key = createHash('sha1').update(oids.join(',')).digest('hex');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(store, oids);
  if (pack.length <= PACK_CACHE_MAX_BYTES) {
    if (packCache.size >= PACK_CACHE_MAX_ENTRIES) {
      const oldest = packCache.keys().next();
      if (!oldest.done) packCache.delete(oldest.value);
    }
    packCache.set(key, pack);
  }
  return pack;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The peeled commit oid of an annotated tag ref, or undefined. */
function peeledOid(repo: Repo, ref: string, store: Store): string | undefined {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return undefined;
  const obj = store.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return peelToCommit(store.objects, oid);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** v0 ref advertisement body (with the "# service=..." preamble). */
export function buildV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', store: Store): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'
      : 'multi_ack thin-pack side-band-64k ofs-delta shallow agent=forge/1.0';
  const headRef = `refs/heads/${repo.default_branch}`;
  const headTip = repo.refs.get(headRef);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${headRef}\n`));
  } else {
    const firstOid = headTip ?? (repo.refs.get(names[0]) as string);
    parts.push(pktLine(`${firstOid} HEAD\0${caps} symref=HEAD:${headRef}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOid(repo, name, store);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** Protocol v2 capability advertisement (no refs; ls-refs serves those). */
/** The v2 capability advertisement: constant bytes, built once. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const lines: Array<string | 'flush'> = ['version 2\n', ...V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
  return pktLines(lines);
})();

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, args: LsRefsArgs, store: Store): Buffer {
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.default_branch}`;
  const headTip = repo.refs.get(headRef);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD symref-target:${headRef}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, name, store);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const items: Array<string | 'flush'> = [...lines, 'flush'];
  return pktLines(items);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Object ids to pack. */
  oids: string[];
  /** Commits at the depth cutoff (the new shallow boundary). */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves the server recognises (for ACK). */
  ackedHaves: string[];
}

export function planFetch(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const gens = commitGenerations(store.objects, wants, depth);
  const included = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [...wants];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const gen = gens.get(oid) ?? gens.get(peelToCommit(store.objects, oid));
      if (depth !== null && gen !== undefined && gen >= depth) continue;
      included.add(oid);
      const commit = parseCommit(obj.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      included.add(oid);
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'blob') {
      included.add(oid);
    } else if (obj.type === 'tag') {
      included.add(oid);
      queue.push(parseTag(obj.data).object);
    }
  }
  // Subtract what the client already holds. A have that is itself an old shallow boundary
  // is held WITHOUT its parents (a shallow clone never received them), so the closure walk
  // stops descending past old shallow boundaries — their trees and blobs are held, their
  // parents are not.
  const boundarySet = new Set(oldShallow);
  const held = new Set<string>();
  for (const have of haves) {
    const walk: string[] = [have];
    const walked = new Set<string>();
    while (walk.length) {
      const oid = walk.shift() as string;
      if (walked.has(oid)) continue;
      walked.add(oid);
      const obj = store.objects.get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        walk.push(commit.tree);
        if (!boundarySet.has(oid)) walk.push(...commit.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) walk.push(entry.oid);
      } else if (obj.type === 'tag') {
        walk.push(parseTag(obj.data).object);
      }
    }
  }
  const oids = [...included].filter((oid) => !held.has(oid));
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of gens.entries()) {
      if (gen === depth - 1 && included.has(oid)) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    const gen = gens.get(boundary) ?? gens.get(peelToCommit(store.objects, boundary));
    if (gen === undefined) continue;
    if (depth === null || gen < depth - 1) unshallow.push(boundary);
  }
  const ackedHaves = haves.filter((have) => store.objects.has(have));
  return { oids, shallow, unshallow, ackedHaves };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // An empty pack is still sent as one sideband packet carrying the 32-byte empty pack.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return Buffer.concat(parts);
}

/** The v2 fetch response for one request. */
export function handleFetchV2(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): Buffer {
  const plan = planFetch(store, wants, haves, oldShallow, depth);
  const pack = cachedWritePack(store.objects, plan.oids);
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  if (plan.ackedHaves.length) {
    for (const have of plan.ackedHaves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim);
  // shallow-info section
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  // packfile section
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, then the sideband pack. */
export function handleFetchV0(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): Buffer {
  const plan = planFetch(store, wants, haves, oldShallow, depth);
  const pack = cachedWritePack(store.objects, plan.oids);
  const parts: Buffer[] = [];
  if (plan.ackedHaves.length) {
    for (const have of plan.ackedHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Handle a receive-pack POST body. Returns the sideband-framed report-status stream.
 * Applies only the commands that validate; reports ok/ng per ref.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const report: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    const { packets, packStart } = splitReceivePackBody(body);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul === -1 ? text : text.slice(0, nul)).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    // Unpack the pack (if any) first.
    const packBytes = body.subarray(packStart);
    if (packBytes.length > 0) {
      if (!verifyPackChecksum(packBytes)) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        try {
          const decoded = readPack(packBytes);
          for (const [oid, obj] of decoded.objects) store.objects.putObject(oid, obj.type, obj.data);
        } catch {
          unpackOk = false;
          unpackDetail = 'unpacker error';
        }
      }
    }
    if (unpackOk) {
      for (const command of commands) {
        const result = applyPushCommand(store, repo, command);
        report.push(result);
      }
    } else {
      for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
  } catch {
    // Malformed body: report an unpack failure rather than crashing.
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const line of report) {
    lines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  const reportBody = pktLines(lines);
  // Frame the report inside sideband band 1.
  const framed = pktLine(Buffer.concat([Buffer.from([1]), reportBody]));
  return Buffer.concat([framed, pktFlush]);
}

function applyPushCommand(store: Store, repo: Repo, command: PushCommand): PushReportLine {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): PushReportLine => ({ ref, ok: false, reason });
  if (!ref.startsWith('refs/')) return fail('invalid ref');
  if (!isObjectId(oldOid) || !isObjectId(newOid)) return fail('invalid object id');
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (oldOid === ZERO_OID) return fail('invalid delete');
    if (current === undefined) return fail('remote ref does not exist');
    if (current !== oldOid) return fail('remote ref update failed');
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  // Create or update: the new object must be present.
  if (!store.objects.has(newOid)) return fail('unpacker error');
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return fail('already exists');
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return fail('remote ref does not exist');
  if (current !== oldOid) return fail('remote ref update failed');
  if (oldOid === newOid) return { ref, ok: true, reason: '' };
  // Fast-forward check (tags peel to their commit).
  const newCommit = peelToCommit(store.objects, newOid);
  const newObj = store.objects.get(newCommit);
  if (newObj !== undefined && newObj.type === 'commit') {
    if (!isAncestor(store.objects, oldOid, newCommit)) return fail('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

/** Parse a v2 upload-pack request body into its command and arguments. */
export function parseUploadPackV2(body: Buffer): { command: string; wants: string[]; haves: string[]; shallow: string[]; depth: number | null; prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean } {
  const packets = decodePktLines(body);
  let command = '';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
  }
  return { command, wants, haves, shallow, depth, prefixes, peel, symrefs, unborn };
}

/** Parse a v0 upload-pack request body (want/have/done/deepen lines). */
export function parseUploadPackV0(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    // The first want line may carry capabilities after a space; the oid is the second token.
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  return { wants, haves, shallow, depth };
}

export { globalStore };
