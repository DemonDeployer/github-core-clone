// contents.ts — git tree manipulation for the REST contents API and squash merges.
// All operations run on the shared ObjectStore; commits use the viewer's identity and the
// fixed scenario epoch so bytes are deterministic.

import {
  parseCommit,
  buildCommit,
  parseTree,
  buildTree,
} from './git.ts';
import { store as globalStore, NOW_ISO, NOW_EPOCH, VIEWER, type Repo, type Store } from './store.ts';

const AUTHOR = `${VIEWER.name} <${VIEWER.email}> ${NOW_EPOCH} +0000`;

/** Split a repo path into segments; '' -> []. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((seg) => seg.length > 0);
}

/** The tree oid at a ref (branch name, full ref, or 40-hex oid), or undefined when unborn. */
export function treeAtRef(store: Store, repo: Repo, ref?: string): string | undefined {
  const tip = refTip(store, repo, ref);
  if (tip === undefined) return undefined;
  const obj = store.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** The commit oid a ref resolves to (branch name, full ref, or 40-hex oid). */
export function refTip(store: Store, repo: Repo, ref?: string): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (/^[0-9a-f]{40}$/.test(ref)) return store.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

/** Walk a tree by path segments. Returns the entry or undefined. */
export function readPath(
  store: Store,
  treeOid: string | undefined,
  segments: readonly string[],
): { mode: string; name: string; oid: string } | undefined {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    if (current === undefined) return undefined;
    const obj = store.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === segments[depth]);
    if (entry === undefined) return undefined;
    if (depth === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Entries of the directory at `path` ('' = root), or undefined when the path is not a tree. */
export function listDir(
  store: Store,
  treeOid: string | undefined,
  segments: readonly string[],
): Array<{ mode: string; name: string; oid: string }> | undefined {
  if (segments.length === 0) {
    if (treeOid === undefined) return [];
    const obj = store.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }
  const entry = readPath(store, treeOid, segments);
  if (entry === undefined || entry.mode !== '40000') return undefined;
  const obj = store.objects.get(entry.oid);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  return parseTree(obj.data);
}

/**
 * Rebuild the tree chain for `segments`, setting the leaf to `blobOid` (create/update) or
 * removing it (blobOid === null). Creates intermediate trees as needed. Returns the new
 * root tree oid.
 */
export function updateTree(
  store: Store,
  treeOid: string | undefined,
  segments: readonly string[],
  blobOid: string | null,
): string {
  const entries = treeOid === undefined ? [] : parseTree(store.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const seg = segments[0] as string;
  const idx = entries.findIndex((e) => e.name === seg);
  if (segments.length === 1) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: seg, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: seg, oid: blobOid });
    }
  } else {
    const childOid = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as { oid: string }).oid : undefined;
    const newChild = updateTree(store, childOid, segments.slice(1), blobOid);
    if (idx >= 0) {
      entries[idx] = { mode: '40000', name: seg, oid: newChild };
    } else {
      entries.push({ mode: '40000', name: seg, oid: newChild });
    }
  }
  return store.objects.put('tree', buildTree(entries));
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(
  store: Store,
  treeOid: string | undefined,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  if (treeOid === undefined) return out;
  const obj = store.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(store, entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Line counts for a blob diff (multiset difference, good enough for the fixtures). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (data: Buffer | null): string[] => {
    if (data === null) return [];
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldData);
  const newLines = linesOf(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

export interface TreeDiffEntry {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  oldSha: string | null;
}

/** Diff two trees (base -> head) into the REST pull-file shape. */
export function diffTrees(store: Store, baseTree: string | undefined, headTree: string | undefined): TreeDiffEntry[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldData = store.objects.get(b.oid)?.data ?? null;
      const { deletions } = lineDiff(oldData, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.oid, oldSha: b.oid });
    } else if (b === undefined && h !== undefined) {
      const newData = store.objects.get(h.oid)?.data ?? null;
      const { additions } = lineDiff(null, newData);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.oid, oldSha: null });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldData = store.objects.get(b.oid)?.data ?? null;
      const newData = store.objects.get(h.oid)?.data ?? null;
      const { additions, deletions } = lineDiff(oldData, newData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.oid, oldSha: b.oid });
    }
  }
  return out;
}

/** Paths whose blob differs between two trees. */
export function diffPaths(store: Store, baseTree: string | undefined, headTree: string | undefined): Set<string> {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const out = new Set<string>();
  for (const [path, b] of base) {
    const h = head.get(path);
    if (h === undefined || h.oid !== b.oid) out.add(path);
  }
  for (const path of head.keys()) if (!base.has(path)) out.add(path);
  return out;
}

/** Apply path -> blob (null = delete) changes onto a tree; returns the new root tree oid. */
export function applyChanges(
  store: Store,
  baseTree: string | undefined,
  changes: Map<string, Buffer | null>,
): string {
  let tree = baseTree;
  for (const [path, content] of changes) {
    const blobOid = content === null ? null : store.objects.put('blob', content);
    tree = updateTree(store, tree, splitPath(path), blobOid);
  }
  return tree as string;
}

/** Build + store a commit, point `ref` at it, and return its sha. */
export function makeCommit(
  store: Store,
  repo: Repo,
  ref: string,
  message: string,
  treeOid: string,
  parents: string[],
): string {
  const commit = buildCommit({ tree: treeOid, parents, author: AUTHOR, committer: AUTHOR, message });
  const sha = store.objects.put('commit', commit);
  repo.refs.set(ref, sha);
  repo.pushed_at = NOW_ISO;
  return sha;
}

export type PutContentResult =
  | { ok: true; created: boolean; blobSha: string; commitSha: string }
  | { ok: false; status: 404 | 409; message: string };

/**
 * The REST PUT /contents flow. `branch` defaults to the repo default branch. When the branch
 * does not exist yet, the new commit's parent is the default branch tip (the MCP setup fallback
 * creates a head branch this way); on an unborn repo there is no parent.
 */
export function putContent(
  store: Store,
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch?: string,
  expectedSha?: string,
): PutContentResult {
  const branchName = branch ?? repo.default_branch;
  const ref = `refs/heads/${branchName}`;
  const segments = splitPath(path);
  if (segments.length === 0) return { ok: false, status: 404, message: 'Not Found' };
  const tip = repo.refs.get(ref);
  let parents: string[] = [];
  if (tip !== undefined) {
    parents = [tip];
  } else {
    const defaultTip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    if (defaultTip !== undefined) parents = [defaultTip];
  }
  const currentTree = parents.length > 0 ? parseCommit(store.objects.get(parents[0] as string)?.data ?? Buffer.alloc(0)).tree : undefined;
  const existing = currentTree === undefined ? undefined : readPath(store, currentTree, segments);
  if (existing !== undefined && expectedSha !== undefined && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  if (existing === undefined && expectedSha !== undefined) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const blobSha = store.objects.put('blob', content);
  const newTree = updateTree(store, currentTree, segments, blobSha);
  const commitSha = makeCommit(store, repo, ref, message, newTree, parents);
  return { ok: true, created: existing === undefined, blobSha, commitSha };
}

export type DeleteContentResult =
  | { ok: true; commitSha: string }
  | { ok: false; status: 404 | 409; message: string };

/** The REST DELETE /contents flow. */
export function deleteContent(
  store: Store,
  repo: Repo,
  path: string,
  message: string,
  branch?: string,
  expectedSha?: string,
): DeleteContentResult {
  const branchName = branch ?? repo.default_branch;
  const ref = `refs/heads/${branchName}`;
  const segments = splitPath(path);
  if (segments.length === 0) return { ok: false, status: 404, message: 'Not Found' };
  const tip = repo.refs.get(ref);
  if (tip === undefined) return { ok: false, status: 404, message: 'Not Found' };
  const currentTree = parseCommit(store.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const existing = readPath(store, currentTree, segments);
  if (existing === undefined) return { ok: false, status: 404, message: 'Not Found' };
  if (expectedSha !== undefined && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const newTree = updateTree(store, currentTree, segments, null);
  const commitSha = makeCommit(store, repo, ref, message, newTree, [tip]);
  return { ok: true, commitSha };
}

export { globalStore };
