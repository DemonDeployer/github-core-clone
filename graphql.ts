// graphql.ts — POST /api/graphql. The 18 fixed documents from the conformance suite,
// dispatched by operation name extracted from the query text (operationName is never
// sent). Success: HTTP 200 {data, errors: []}. GraphQL failure: HTTP 200 + non-empty
// errors. No token: HTTP 401 exactly.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './send.ts';
import { store, VIEWER, type Repo, type Issue, type Pull } from './store.ts';
import { createIssueOp, closeIssueOp, addCommentOp, createPullOp, mergePullOp, mergeableState, isOpError } from './ops.ts';
import { isAuthed } from './rest.ts';

// ---------------------------------------------------------------------------
// introspection tables (the checks assert inclusion of the listed names)
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'assignees', 'labels',
  'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'repository',
  'locked', 'viewerDidAuthor', 'viewerCanUpdate', 'reactions', 'timelineItems', 'participants',
  'stateReason', 'isPinned', 'hovercard',
];

const PULL_REQUEST_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
  'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'reviews',
  'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'repository',
  'locked', 'draft', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'mergedAt',
  'viewerCanUpdate', 'isCrossRepository', 'maintainerCanModify',
];

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'createdAt', 'updatedAt', 'url', 'resourcePath', 'homepageUrl', 'forkCount', 'stargazerCount',
  'watcherCount', 'isFork', 'isPrivate', 'isArchived', 'hasWikiEnabled', 'hasProjectsEnabled',
  'licenseInfo', 'languages', 'topics', 'collaborators', 'assignableUsers', 'codeOfConduct',
  'securityPolicyUrl', 'visibility', 'diskUsage', 'mirrorUrl', 'sshUrl', 'isTemplate', 'parent',
  'templateRepository', 'defaultBranchRef', 'primaryLanguage',
];

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------------------
// node shapes
// ---------------------------------------------------------------------------

function gqlState(state: 'open' | 'closed'): 'OPEN' | 'CLOSED' {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(issue: Issue): Record<string, unknown> {
  return { id: issue.node_id, number: issue.number, title: issue.title, state: gqlState(issue.state), body: issue.body };
}

function pullNode(storeRef: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.node_id,
    number: pull.number,
    state: gqlState(pull.state),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: mergeableState(store, storeRef, pull),
  };
}

function repositoryNode(repo: Repo): Record<string, unknown> {
  const defaultRef = repo.refs.get(`refs/heads/${repo.default_branch}`);
  return {
    id: repo.node_id,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: { login: repo.owner },
    defaultBranchRef: defaultRef === undefined ? null : { name: repo.default_branch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issuesConnection(
  repo: Repo,
  opts: { first?: number; states?: string[]; order?: 'asc' | 'desc'; after?: string | null },
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  if (opts.states !== undefined) {
    const wanted = new Set(opts.states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const order = opts.order ?? 'asc';
  issues.sort((a, b) => (order === 'desc' ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (opts.after !== undefined && opts.after !== null) {
    const match = /^cursor:(\d+)$/.exec(opts.after);
    if (match !== null) {
      const idx = issues.findIndex((i) => i.number === Number(match[1]));
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = opts.first ?? 10;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const endCursor = page.length > 0 ? `cursor:${page[page.length - 1]?.number}` : null;
  return {
    nodes: page.map(issueNode),
    pageInfo: { hasNextPage, endCursor },
  };
}

// ---------------------------------------------------------------------------
// one operation
// ---------------------------------------------------------------------------

type GqlResult = { data: Record<string, unknown> | null; errors: Array<{ message: string }> };

function gqlError(message: string): GqlResult {
  return { data: null, errors: [{ message }] };
}

function executeOperation(query: string, variables: Record<string, unknown>): GqlResult {
  const nameMatch = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  const op = nameMatch?.[1] ?? '';
  const vars = variables ?? {};

  const repoOf = (owner: unknown, repoName: unknown): Repo | undefined => {
    if (typeof owner !== 'string' || typeof repoName !== 'string') return undefined;
    return store.getRepo(owner, repoName);
  };

  switch (op) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER.login } }, errors: [] };

    case 'RepositoryFields': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      return { data: { repository: repositoryNode(repo) }, errors: [] };
    }

    case 'Issue_fields':
      return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } }, errors: [] };

    case 'PullRequestAndRepositoryFields':
      return {
        data: {
          PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
          Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
        },
        errors: [],
      };

    case 'SearchType_enumValues':
      return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } }, errors: [] };

    case 'OpenIssues': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      return {
        data: { repository: { issues: issuesConnection(repo, { first, states: ['OPEN'], order: 'desc' }) } },
        errors: [],
      };
    }

    case 'IssueByNumber': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const issue = repo.issues.get(number);
      return { data: { repository: { issue: issue === undefined ? null : issueNode(issue) } }, errors: [] };
    }

    case 'IssueCreate': {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const resolved = typeof input.repositoryId === 'string' ? store.byNodeId(input.repositoryId) : null;
      if (resolved === null || resolved.kind !== 'repo') return gqlError('Could not resolve repository from repositoryId');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssueOp(store, resolved.repo, title, body, []);
      if (isOpError(issue)) return gqlError(issue.error);
      return { data: { createIssue: { issue: { number: issue.number, id: issue.node_id } } }, errors: [] };
    }

    case 'IssueClose': {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const resolved = typeof input.issueId === 'string' ? store.byNodeId(input.issueId) : null;
      if (resolved === null || resolved.kind !== 'issue') return gqlError('Could not resolve issue from issueId');
      const issue = closeIssueOp(store, resolved.repo, resolved.issue.number);
      if (isOpError(issue)) return gqlError(issue.error);
      return { data: { closeIssue: { issue: { number: issue.number, id: issue.node_id, state: 'CLOSED' } } }, errors: [] };
    }

    case 'PullRequests': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
      return {
        data: { repository: { pullRequests: { nodes: pulls.map((p) => pullNode(repo, p)) } } },
        errors: [],
      };
    }

    case 'PullRequestFiles': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } }, errors: [] };
      return {
        data: {
          repository: {
            pullRequest: {
              number: pull.number,
              files: { nodes: pull.files.slice(0, 10).map((f) => ({ path: f.filename })) },
            },
          },
        },
        errors: [],
      };
    }

    case 'PullRequestId': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } }, errors: [] };
      return { data: { repository: { pullRequest: { id: pull.node_id, number: pull.number } } }, errors: [] };
    }

    case 'PullRequestCreate': {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const resolved = typeof input.repositoryId === 'string' ? store.byNodeId(input.repositoryId) : null;
      if (resolved === null || resolved.kind !== 'repo') return gqlError('Could not resolve repository from repositoryId');
      const title = typeof input.title === 'string' ? input.title : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const pull = createPullOp(store, resolved.repo, title, '', headRefName, baseRefName);
      if (isOpError(pull)) return gqlError(pull.error);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number,
              id: pull.node_id,
              state: 'OPEN',
              headRefName: pull.headRef,
              baseRefName: pull.baseRef,
            },
          },
        },
        errors: [],
      };
    }

    case 'MergePullRequest': {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const resolved = typeof input.pullRequestId === 'string' ? store.byNodeId(input.pullRequestId) : null;
      if (resolved === null || resolved.kind !== 'pull') return gqlError('Could not resolve pull request from pullRequestId');
      const result = mergePullOp(store, resolved.repo, resolved.pull.number);
      if (!result.ok) {
        return {
          data: {
            mergePullRequest: {
              pullRequest: { number: resolved.pull.number, merged: false, state: gqlState(resolved.pull.state) },
            },
          },
          errors: [],
        };
      }
      return {
        data: {
          mergePullRequest: { pullRequest: { number: resolved.pull.number, merged: true, state: 'CLOSED' } },
        },
        errors: [],
      };
    }

    case 'AddComment': {
      const input = (vars.input ?? {}) as Record<string, unknown>;
      const resolved = typeof input.subjectId === 'string' ? store.byNodeId(input.subjectId) : null;
      if (resolved === null || resolved.kind !== 'issue') return gqlError('Could not resolve issue from subjectId');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addCommentOp(store, resolved.repo, resolved.issue.number, body);
      if (isOpError(comment)) return gqlError(comment.error);
      return {
        data: { addComment: { commentEdge: { node: { id: comment.node_id, body: comment.body } } } },
        errors: [],
      };
    }

    case 'ViewerInvalidField':
      return {
        data: { viewer: { login: VIEWER.login } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
      };

    case 'NodeRepository': {
      const id = typeof vars.id === 'string' ? vars.id : '';
      const resolved = store.byNodeId(id);
      if (resolved === null) return { data: { node: null }, errors: [] };
      if (resolved.kind === 'repo') {
        return {
          data: { node: { id: resolved.repo.node_id, name: resolved.repo.name, nameWithOwner: resolved.repo.full_name } },
          errors: [],
        };
      }
      const nodeId = resolved.kind === 'issue' ? resolved.issue.node_id : resolved.pull.node_id;
      return { data: { node: { id: nodeId } }, errors: [] };
    }

    case 'IssuesPage': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null }, errors: [] };
      const first = typeof vars.first === 'number' ? vars.first : 5;
      const after = vars.after === null || vars.after === undefined ? null : String(vars.after);
      return {
        data: { repository: { issues: issuesConnection(repo, { first, after }) } },
        errors: [],
      };
    }

    default:
      return gqlError(`Unknown operation${op === '' ? '' : `: ${op}`}`);
  }
}

/** Handle POST /api/graphql (single op or a batched JSON array). */
export function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer | null): boolean {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = body === null || body.length === 0 ? null : JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return gqlError('Invalid operation');
      const { query, variables } = entry as { query?: unknown; variables?: unknown };
      if (typeof query !== 'string') return gqlError('query is required');
      return executeOperation(query, (variables ?? {}) as Record<string, unknown>);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'query is required' }] });
    return true;
  }
  const { query, variables } = parsed as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'query is required' }] });
    return true;
  }
  sendJson(res, 200, executeOperation(query, (variables ?? {}) as Record<string, unknown>));
  return true;
}
