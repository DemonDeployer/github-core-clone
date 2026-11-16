// ops.ts — the shared issue / pull request / comment operations. REST, GraphQL and MCP
// are thin adapters over these, so a mutation made on one surface is immediately visible
// on the others (the suite re-verifies every mutation over REST).

import { parseCommit, peelToCommit } from './git.ts';
import { NOW_ISO, type Issue, type IssueComment, type Pull, type Repo, type Store, type Label } from './store.ts';
import {
  treeAtRef,
  flattenTree,
  diffTrees,
  diffPaths,
  applyChanges,
  makeCommit,
  type TreeDiffEntry,
} from './contents.ts';

export type OpError = { error: string; status: number };

export function isOpError(value: unknown): value is OpError {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value;
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

/** Create an issue. Unknown label names are a 422 (GitHub behaviour, asserted by the suite). */
export function createIssueOp(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): Issue | OpError {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `Label does not exist: ${name}`, status: 422 };
    labels.push(label);
  }
  return store.newIssue(repo, title, body, labels);
}

export function closeIssueOp(store: Store, repo: Repo, number: number): Issue | OpError {
  const issue = repo.issues.get(number);
  if (issue === undefined) return { error: 'Not Found', status: 404 };
  issue.state = 'closed';
  issue.closed_at = NOW_ISO;
  issue.updated_at = NOW_ISO;
  void store;
  return issue;
}

export function addCommentOp(
  store: Store,
  repo: Repo,
  issueNumber: number,
  body: string,
): IssueComment | OpError {
  const issue = repo.issues.get(issueNumber);
  if (issue === undefined) return { error: 'Not Found', status: 404 };
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment = {
    id,
    node_id: `C_${repo.id}_${issueNumber}_${id}`,
    body,
    user: issue.user,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
  };
  issue.comments.push(comment);
  void store;
  return comment;
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

export function createPullOp(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | OpError {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined) return { error: `Head branch does not exist: ${headRef}`, status: 422 };
  if (baseTip === undefined) return { error: `Base branch does not exist: ${baseRef}`, status: 422 };
  const headCommit = peelToCommit(store.objects, headTip);
  const baseCommit = peelToCommit(store.objects, baseTip);
  const headObj = store.objects.get(headCommit);
  const baseObj = store.objects.get(baseCommit);
  if (headObj === undefined || baseObj === undefined) return { error: 'Commit not found', status: 422 };
  const headTree = parseCommit(headObj.data).tree;
  const baseTree = parseCommit(baseObj.data).tree;
  const files = diffTrees(store, baseTree, headTree).map((f: TreeDiffEntry) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    sha: f.sha,
  }));
  return store.newPull(repo, title, body, headRef, headCommit, baseRef, baseCommit, files, headTree, baseTree);
}

/** The paths the PR changes (base tree at creation -> head tree at creation). */
function pullChangedPaths(store: Store, pull: Pull): Map<string, Buffer | null> {
  const head = flattenTree(store, pull.headTree);
  const base = flattenTree(store, pull.baseTree);
  const out = new Map<string, Buffer | null>();
  for (const [path, h] of head) {
    const b = base.get(path);
    if (b === undefined || b.oid !== h.oid) {
      out.set(path, store.objects.get(h.oid)?.data ?? null);
    }
  }
  for (const path of base.keys()) {
    if (!head.has(path)) out.set(path, null);
  }
  return out;
}

/** True when the PR can still merge cleanly onto the current base tip. */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const currentBaseTree = treeAtRef(store, repo, pull.baseRef);
  if (currentBaseTree === undefined) return false;
  const baseChanged = diffPaths(store, pull.baseTree, currentBaseTree);
  if (baseChanged.size === 0) return true;
  const head = flattenTree(store, pull.headTree);
  const base = flattenTree(store, pull.baseTree);
  const current = flattenTree(store, currentBaseTree);
  for (const path of baseChanged) {
    const headEntry = head.get(path);
    const currentEntry = current.get(path);
    const headOid = headEntry?.oid ?? null;
    const currentOid = currentEntry?.oid ?? null;
    // A path the PR did not touch never conflicts; a path both sides changed to the same
    // blob also merges cleanly.
    const prTouched = (base.get(path)?.oid ?? null) !== headOid;
    if (prTouched && headOid !== currentOid) return false;
  }
  return true;
}

export type MergeResult =
  | { ok: true; merged: true; sha: string; message: string }
  | { ok: false; status: 404 | 405; message: string };

/** Squash-merge a pull request onto its base branch. */
export function mergePullOp(store: Store, repo: Repo, number: number): MergeResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return { ok: false, status: 404, message: 'Not Found' };
  if (pull.merged) {
    return { ok: true, merged: true, sha: pull.merge_commit_sha as string, message: 'Pull request successfully merged' };
  }
  if (pull.state === 'closed') return { ok: false, status: 405, message: 'Pull request is closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { ok: false, status: 404, message: 'Base branch not found' };
  if (!pullMergeable(store, repo, pull)) {
    return { ok: false, status: 405, message: 'Merge conflict' };
  }
  const currentBaseTree = treeAtRef(store, repo, pull.baseRef) as string;
  const changes = pullChangedPaths(store, pull);
  const newTree = applyChanges(store, currentBaseTree, changes);
  const baseCommit = peelToCommit(store.objects, baseTip);
  const mergeSha = makeCommit(
    store,
    repo,
    `refs/heads/${pull.baseRef}`,
    `Merge pull request #${pull.number} from ${pull.headRef}`,
    newTree,
    [baseCommit],
  );
  pull.merged = true;
  pull.merged_at = NOW_ISO;
  pull.merge_commit_sha = mergeSha;
  pull.state = 'closed';
  pull.closed_at = NOW_ISO;
  pull.updated_at = NOW_ISO;
  return { ok: true, merged: true, sha: mergeSha, message: 'Pull request successfully merged' };
}

/** GraphQL mergeable state for a pull request. */
export function mergeableState(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  return pullMergeable(store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
}

/** Commits reachable from a ref tip, newest-first (DFS pre-order, parents after children). */
export function listCommits(store: Store, repo: Repo, ref?: string): Array<{ sha: string; message: string }> {
  const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.default_branch}`) : (() => {
    if (/^[0-9a-f]{40}$/.test(ref)) return store.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  })();
  if (tip === undefined) return [];
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack: string[] = [peelToCommit(store.objects, tip)];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, message: commit.message });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}
