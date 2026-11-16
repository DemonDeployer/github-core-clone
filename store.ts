// store.ts — the forge's in-memory store: repositories, git refs, issues, pull requests,
// labels and comments. One store shared by REST, GraphQL and MCP. Everything deterministic:
// fixed timestamps, sequential ids, no wall clock, no randomness.

import { ObjectStore, ZERO_OID, peelToCommit } from './git.ts';
import { buildScenario, type Scenario, type ScenarioUser } from './scenario.ts';

/** Fixed timestamp for every created_at/updated_at (2025-01-01T00:00:00Z, the scenario epoch). */
export const NOW_ISO = '2025-01-01T00:00:00Z';
export const NOW_EPOCH = 1735689600;

export const scenario: Scenario = buildScenario();
export const VIEWER: ScenarioUser = scenario.viewer;
export const STRANGER: ScenarioUser = scenario.stranger;
export const ORG: string = scenario.org;

export interface UserView {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: string;
  name: string;
  email: string;
}

export function userView(user: ScenarioUser): UserView {
  return {
    login: user.login,
    id: user.id,
    avatar_url: `https://example.invalid/avatars/${user.login}`,
    html_url: `https://example.invalid/${user.login}`,
    type: 'User',
    name: user.name,
    email: user.email,
  };
}

export function userByLogin(login: string): ScenarioUser | undefined {
  return scenario.users.find((user) => user.login === login);
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface IssueComment {
  id: number;
  node_id: string;
  body: string;
  user: UserView;
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: UserView;
  labels: Label[];
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

export interface Pull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: UserView;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  /** Tree diff captured at creation: path -> { status, blobOid (new), oldBlobOid }. */
  files: PullFile[];
  /** The head tree oid at creation (for merge content). */
  headTree: string;
  /** The base tree oid at creation. */
  baseTree: string;
}

export interface Repo {
  id: number;
  node_id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  /** Git refs: full refname -> oid. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue+pull number counter (GitHub uses one counter per repo). */
  nextNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  /** Head commit sha of the default branch at the time of the last contents commit (for GET /commits). */
  commits: Array<{ sha: string; message: string; branch: string; author: string; date: string }>;
}

export class Store {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo | { error: 'exists' } {
    if (this.repos.has(this.repoKey(owner, name))) return { error: 'exists' };
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      node_id: `R_${id}`,
      owner,
      name,
      full_name: `${owner}/${name}`,
      description: options.description ?? '',
      private: options.private ?? false,
      default_branch: 'main',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      pushed_at: NOW_ISO,
      html_url: `https://example.invalid/${owner}/${name}`,
      url: `/api/v3/repos/${owner}/${name}`,
      clone_url: `https://example.invalid/${owner}/${name}.git`,
      git_url: `git://example.invalid/${owner}/${name}.git`,
      ssh_url: `git@example.invalid:${owner}/${name}.git`,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      commits: [],
    };
    // GitHub's default labels exist on every new repository.
    for (const labelName of scenario.labels) {
      const label = this.newLabel(repo, labelName, 'ffffff', '');
      repo.labels.set(labelName, label);
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  newLabel(repo: Repo, name: string, color: string, description: string): Label {
    const id = repo.nextLabelId;
    repo.nextLabelId += 1;
    return {
      id,
      node_id: `L_${repo.id}_${id}`,
      name,
      color,
      description,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    };
  }

  newIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    const issue: Issue = {
      id,
      node_id: `I_${repo.id}_${number}`,
      number,
      title,
      body,
      state: 'open',
      user: userView(VIEWER),
      labels: [...labels],
      comments: [],
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      closed_at: null,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  newPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
    files: PullFile[],
    headTree: string,
    baseTree: string,
  ): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextPullId;
    this.nextPullId += 1;
    const pull: Pull = {
      id,
      node_id: `PR_${repo.id}_${number}`,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      user: userView(VIEWER),
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      closed_at: null,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}`,
      files,
      headTree,
      baseTree,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** All repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Find a repo, issue or pull by its GraphQL node id. */
  byNodeId(nodeId: string): { kind: 'repo'; repo: Repo } | { kind: 'issue'; repo: Repo; issue: Issue } | { kind: 'pull'; repo: Repo; pull: Pull } | null {
    if (nodeId.startsWith('R_')) {
      const id = Number(nodeId.slice(2));
      for (const repo of this.repos.values()) if (repo.id === id) return { kind: 'repo', repo };
      return null;
    }
    if (nodeId.startsWith('I_')) {
      const rest = nodeId.slice(2);
      const sep = rest.indexOf('_');
      const repoId = Number(rest.slice(0, sep));
      const number = Number(rest.slice(sep + 1));
      for (const repo of this.repos.values()) {
        if (repo.id === repoId) {
          const issue = repo.issues.get(number);
          return issue ? { kind: 'issue', repo, issue } : null;
        }
      }
      return null;
    }
    if (nodeId.startsWith('PR_')) {
      const rest = nodeId.slice(3);
      const sep = rest.indexOf('_');
      const repoId = Number(rest.slice(0, sep));
      const number = Number(rest.slice(sep + 1));
      for (const repo of this.repos.values()) {
        if (repo.id === repoId) {
          const pull = repo.pulls.get(number);
          return pull ? { kind: 'pull', repo, pull } : null;
        }
      }
      return null;
    }
    return null;
  }

  /** The commit a ref points at (tags peeled). */
  refCommit(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    return peelToCommit(this.objects, oid);
  }

  /** HEAD's target ref (the default branch). */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.default_branch}`;
  }

  /** The default branch tip, or undefined for an empty repo. */
  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }
}

/** A single shared store for the process. */
export const store = new Store();

export function zeroOid(): string {
  return ZERO_OID;
}
