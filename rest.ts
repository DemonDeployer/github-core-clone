// rest.ts — the GitHub REST v3 surface (/api/v3). All state lives in the shared store;
// every reply is application/json with a non-empty X-GitHub-Request-Id (send.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendNoContent, sendError } from './send.ts';
import {
  store,
  VIEWER,
  NOW_ISO,
  userView,
  userByLogin,
  type Repo,
  type Issue,
  type Pull,
  type Label,
} from './store.ts';
import { putContent, deleteContent, readPath, listDir, treeAtRef, splitPath } from './contents.ts';
import { createIssueOp, closeIssueOp, addCommentOp, createPullOp, mergePullOp, listCommits, isOpError } from './ops.ts';

const SCOPES = { 'x-oauth-scopes': 'repo, read:org' };

/** Any non-empty Bearer token authenticates as the scenario viewer. */
export function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7).trim().length > 0;
}

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function parseJsonBody(body: Buffer | null): { ok: true; value: JsonValue } | { ok: false } {
  if (body === null || body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function asObject(value: JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

export function repoView(repo: Repo): Record<string, unknown> {
  const owner = userByLogin(repo.owner) ?? VIEWER;
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    owner: userView(owner),
    private: repo.private,
    html_url: repo.html_url,
    description: repo.description,
    fork: false,
    url: repo.url,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: repo.git_url,
    ssh_url: repo.ssh_url,
    clone_url: repo.clone_url,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.node_id,
    url: label.url,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    url: issue.url,
    html_url: issue.html_url,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: issue.user,
    labels: issue.labels.map(labelView),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullView(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.node_id,
    url: pull.url,
    html_url: pull.html_url,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    user: pull.user,
    state: pull.state,
    locked: false,
    title2: pull.title,
    head: {
      label: `${pull.user.login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: pull.user,
      repo: null,
    },
    base: {
      label: `${pull.user.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: pull.user,
      repo: null,
    },
    merged: pull.merged,
    mergeable: null,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    closed_at: pull.closed_at,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    draft: false,
  };
}

function commentView(comment: { id: number; node_id: string; body: string; user: unknown; created_at: string; updated_at: string; html_url: string; url: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.node_id,
    url: comment.url,
    html_url: comment.html_url,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

// ---------------------------------------------------------------------------
// repo resolution: missing repo -> 404; private repo + no token -> 401 (never 403).
// ---------------------------------------------------------------------------

type RepoResolution = { repo: Repo } | { status: 404 | 401 };

function resolveRepo(owner: string, name: string, authed: boolean): RepoResolution {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { status: 404 };
  if (repo.private && !authed) return { status: 401 };
  return { repo };
}

/** For mutations: auth first (401), then existence (404). */
function resolveRepoForWrite(owner: string, name: string, authed: boolean): RepoResolution {
  if (!authed) return { status: 401 };
  return resolveRepo(owner, name, true);
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found', SCOPES);
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const pageNum = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  if (start + perPage < items.length) links.push(`<${baseUrl}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
  if (pageNum > 1) links.push(`<${baseUrl}?per_page=${perPage}&page=${pageNum - 1}>; rel="prev"`);
  links.push(`<${baseUrl}?per_page=${perPage}&page=1>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  links.push(`<${baseUrl}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
  return { page, link: links.join(', ') };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/**
 * Handle a request under /api/v3. Always answers (unknown routes get a JSON 404).
 * Returns true (the caller routes /api/v3 here and nowhere else).
 */
export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer | null): boolean {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s.length > 0).map((s) => {
    // Most segments carry no escapes: decoding only when one is present
    // keeps the common path allocation-free and byte-identical.
    if (!s.includes('%')) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const authed = isAuthed(req);

  // GET /api/v3/ — root. No auth required; x-oauth-scopes must be present.
  if (rest.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found', SCOPES), true;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, SCOPES);
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found', SCOPES), true;
    sendJson(res, 200, { installed_version: '1.0.0' }, SCOPES);
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found', SCOPES), true;
    if (!authed) return sendError(res, 401, 'Requires authentication', SCOPES), true;
    sendJson(res, 200, userView(VIEWER), SCOPES);
    return true;
  }

  // /api/v3/user/repos — list (GET) / create (POST)
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      if (!authed) return sendError(res, 401, 'Requires authentication', SCOPES), true;
      const host = req.headers.host ?? 'localhost';
      const { page, link } = paginate(store.reposOf(VIEWER.login), url.searchParams, `http://${host}/api/v3/user/repos`);
      sendJson(res, 200, page.map(repoView), { ...SCOPES, link });
      return true;
    }
    if (method === 'POST') {
      if (!authed) return sendError(res, 401, 'Requires authentication', SCOPES), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      const name = str(input.name);
      if (name === '') return sendError(res, 400, 'name is required', SCOPES), true;
      const created = store.createRepo(VIEWER.login, name, {
        description: str(input.description),
        private: typeof input.private === 'boolean' ? input.private : false,
      });
      if (typeof created === 'object' && 'error' in created) {
        return sendError(res, 422, `A repository named ${VIEWER.login}/${name} already exists`, SCOPES), true;
      }
      sendJson(res, 201, repoView(created as Repo), SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    return handleRepoRoute(req, res, url, body, method, owner, name, tail, authed);
  }

  // Unknown /api/v3 route.
  sendError(res, 404, 'Not Found', SCOPES);
  return true;
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer | null,
  method: string,
  owner: string,
  name: string,
  tail: string[],
  authed: boolean,
): boolean {
  // The repo itself: GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      sendJson(res, 200, repoView(resolved.repo), SCOPES);
      return true;
    }
    if (method === 'PATCH' || method === 'DELETE') {
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        sendNoContent(res, 204, SCOPES);
        return true;
      }
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      if (typeof input.description === 'string') resolved.repo.description = input.description;
      if (typeof input.private === 'boolean') resolved.repo.private = input.private;
      resolved.repo.updated_at = NOW_ISO;
      sendJson(res, 200, repoView(resolved.repo), SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  const [section, ...rest] = tail as [string, ...string[]];

  // ---- branches ----
  if (section === 'branches' && rest.length === 0 && method === 'GET') {
    const resolved = resolveRepo(owner, name, authed);
    if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
    const branches = [...resolved.repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: resolved.repo.refs.get(ref) as string }, protected: false }));
    sendJson(res, 200, branches, SCOPES);
    return true;
  }

  // ---- commits ----
  if (section === 'commits' && rest.length === 0 && method === 'GET') {
    const resolved = resolveRepo(owner, name, authed);
    if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
    const shaParam = url.searchParams.get('sha') ?? undefined;
    const commits = listCommits(store, resolved.repo, shaParam).map((c) => ({
      sha: c.sha,
      commit: {
        message: c.message,
        author: { name: VIEWER.name, email: VIEWER.email, date: resolved.repo.created_at },
        committer: { name: VIEWER.name, email: VIEWER.email, date: resolved.repo.created_at },
      },
    }));
    sendJson(res, 200, commits, SCOPES);
    return true;
  }

  // ---- git/refs ----
  if (section === 'git' && rest.length >= 1 && rest[0] === 'refs') {
    if (method === 'POST' && rest.length === 1) {
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (!ref.startsWith('refs/')) return sendError(res, 422, 'Invalid ref', SCOPES), true;
      if (!/^[0-9a-f]{40}$/.test(sha) || !store.objects.has(sha)) {
        return sendError(res, 422, 'Object does not exist', SCOPES), true;
      }
      if (resolved.repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists', SCOPES), true;
      resolved.repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } }, SCOPES);
      return true;
    }
    if (method === 'GET' && rest.length >= 2) {
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const ref = `refs/${rest.join('/')}`;
      const sha = resolved.repo.refs.get(ref);
      if (sha === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
      sendJson(res, 200, { ref, object: { sha } }, SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  // ---- contents ----
  if (section === 'contents') {
    const filePath = rest.join('/');
    if (method === 'GET') {
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const ref = url.searchParams.get('ref') ?? undefined;
      const tree = treeAtRef(store, resolved.repo, ref);
      if (tree === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
      const segments = splitPath(filePath);
      if (segments.length === 0) {
        const entries = listDir(store, tree, []) ?? [];
        sendJson(res, 200, entries.map((e) => dirEntry(resolved.repo, '', e)), SCOPES);
        return true;
      }
      const entry = readPath(store, tree, segments);
      if (entry === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
      if (entry.mode === '40000') {
        const entries = listDir(store, tree, segments) ?? [];
        sendJson(res, 200, entries.map((e) => dirEntry(resolved.repo, filePath, e)), SCOPES);
        return true;
      }
      const blob = store.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, fileEntry(resolved.repo, filePath, entry.oid, data), SCOPES);
      return true;
    }
    if (method === 'PUT') {
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      const contentB64 = str(input.content);
      if (contentB64 === '') return sendError(res, 400, 'content is required', SCOPES), true;
      const content = Buffer.from(contentB64, 'base64');
      const message = str(input.message) || `Update ${filePath}`;
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      const result = putContent(store, resolved.repo, filePath, content, message, branch, sha);
      if (!result.ok) return sendError(res, result.status, result.message, SCOPES), true;
      sendJson(
        res,
        result.created ? 201 : 200,
        {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: result.blobSha,
            size: content.length,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch ?? resolved.repo.default_branch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${result.blobSha}`,
            download_url: `https://example.invalid/${owner}/${name}/raw/${branch ?? resolved.repo.default_branch}/${filePath}`,
            type: 'file',
            encoding: 'base64',
          },
          commit: { sha: result.commitSha, message },
        },
        SCOPES,
      );
      return true;
    }
    if (method === 'DELETE') {
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      const message = str(input.message) || `Delete ${filePath}`;
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const result = deleteContent(store, resolved.repo, filePath, message, branch, sha);
      if (!result.ok) return sendError(res, result.status, result.message, SCOPES), true;
      sendJson(res, 200, { commit: { sha: result.commitSha, message } }, SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  // ---- labels ----
  if (section === 'labels') {
    if (method === 'POST' && rest.length === 0) {
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
      const input = asObject(parsed.value);
      const labelName = str(input.name);
      if (labelName === '') return sendError(res, 400, 'name is required', SCOPES), true;
      const existing = resolved.repo.labels.get(labelName);
      if (existing !== undefined) {
        sendJson(res, 201, labelView(existing), SCOPES);
        return true;
      }
      const label = store.newLabel(resolved.repo, labelName, str(input.color) || 'ededed', str(input.description));
      resolved.repo.labels.set(labelName, label);
      sendJson(res, 201, labelView(label), SCOPES);
      return true;
    }
    if (method === 'GET' && rest.length === 0) {
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      sendJson(res, 200, [...resolved.repo.labels.values()].map(labelView), SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  // ---- issues ----
  if (section === 'issues') {
    // POST /issues/{n}/comments and GET /issues/{n}/comments
    if (rest.length === 2 && rest[1] === 'comments') {
      const number = Number.parseInt(rest[0] as string, 10);
      if (method === 'POST') {
        const resolved = resolveRepoForWrite(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
        const input = asObject(parsed.value);
        const commentBody = str(input.body);
        if (commentBody === '') return sendError(res, 400, 'body is required', SCOPES), true;
        const comment = addCommentOp(store, resolved.repo, number, commentBody);
        if (isOpError(comment)) return sendError(res, comment.status, comment.error, SCOPES), true;
        sendJson(res, 201, commentView(comment), SCOPES);
        return true;
      }
      if (method === 'GET') {
        const resolved = resolveRepo(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const issue = resolved.repo.issues.get(number);
        if (issue === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
        sendJson(res, 200, issue.comments.map(commentView), SCOPES);
        return true;
      }
      return sendError(res, 404, 'Not Found', SCOPES), true;
    }
    // GET/POST /issues
    if (rest.length === 0) {
      if (method === 'POST') {
        const resolved = resolveRepoForWrite(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
        const input = asObject(parsed.value);
        const title = str(input.title);
        if (title === '') return sendError(res, 400, 'title is required', SCOPES), true;
        const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        const issue = createIssueOp(store, resolved.repo, title, str(input.body), labelNames);
        if (isOpError(issue)) return sendError(res, issue.status, issue.error, SCOPES), true;
        sendJson(res, 201, issueView(issue), SCOPES);
        return true;
      }
      if (method === 'GET') {
        const resolved = resolveRepo(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let issues = [...resolved.repo.issues.values()];
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        if (sort === 'created') issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
        const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
        sendJson(res, 200, issues.slice(0, perPage).map(issueView), SCOPES);
        return true;
      }
      return sendError(res, 404, 'Not Found', SCOPES), true;
    }
    // GET/PATCH /issues/{n}
    if (rest.length === 1) {
      const number = Number.parseInt(rest[0] as string, 10);
      if (method === 'GET') {
        const resolved = resolveRepo(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const issue = resolved.repo.issues.get(number);
        if (issue === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
        sendJson(res, 200, issueView(issue), SCOPES);
        return true;
      }
      if (method === 'PATCH') {
        const resolved = resolveRepoForWrite(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const issue = resolved.repo.issues.get(number);
        if (issue === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
        const input = asObject(parsed.value);
        if (typeof input.state === 'string') {
          if (input.state !== 'open' && input.state !== 'closed') {
            return sendError(res, 422, 'Invalid state', SCOPES), true;
          }
          issue.state = input.state;
          issue.closed_at = input.state === 'closed' ? issue.closed_at ?? NOW_ISO : null;
          issue.updated_at = NOW_ISO;
        }
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        sendJson(res, 200, issueView(issue), SCOPES);
        return true;
      }
      return sendError(res, 404, 'Not Found', SCOPES), true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  // ---- pulls ----
  if (section === 'pulls') {
    // GET /pulls/{n}/files
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      const number = Number.parseInt(rest[0] as string, 10);
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const pull = resolved.repo.pulls.get(number);
      if (pull === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
      sendJson(res, 200, pull.files, SCOPES);
      return true;
    }
    // PUT /pulls/{n}/merge
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const number = Number.parseInt(rest[0] as string, 10);
      const resolved = resolveRepoForWrite(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const result = mergePullOp(store, resolved.repo, number);
      if (!result.ok) return sendError(res, result.status, result.message, SCOPES), true;
      sendJson(res, 200, { merged: true, sha: result.sha, message: result.message }, SCOPES);
      return true;
    }
    // GET/POST /pulls
    if (rest.length === 0) {
      if (method === 'POST') {
        const resolved = resolveRepoForWrite(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON', SCOPES), true;
        const input = asObject(parsed.value);
        const head = str(input.head);
        const base = str(input.base);
        const title = str(input.title);
        if (head === '' || base === '' || title === '') {
          return sendError(res, 400, 'head, base and title are required', SCOPES), true;
        }
        const pull = createPullOp(store, resolved.repo, title, str(input.body), head, base);
        if (isOpError(pull)) return sendError(res, pull.status, pull.error, SCOPES), true;
        sendJson(res, 201, pullView(pull), SCOPES);
        return true;
      }
      if (method === 'GET') {
        const resolved = resolveRepo(owner, name, authed);
        if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...resolved.repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
        const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
        sendJson(res, 200, pulls.slice(0, perPage).map(pullView), SCOPES);
        return true;
      }
      return sendError(res, 404, 'Not Found', SCOPES), true;
    }
    // GET /pulls/{n}
    if (rest.length === 1 && method === 'GET') {
      const number = Number.parseInt(rest[0] as string, 10);
      const resolved = resolveRepo(owner, name, authed);
      if ('status' in resolved) return sendError(res, resolved.status, resolved.status === 401 ? 'Requires authentication' : 'Not Found', SCOPES), true;
      const pull = resolved.repo.pulls.get(number);
      if (pull === undefined) return sendError(res, 404, 'Not Found', SCOPES), true;
      sendJson(res, 200, pullView(pull), SCOPES);
      return true;
    }
    return sendError(res, 404, 'Not Found', SCOPES), true;
  }

  return notFound(res), true;
}

function dirEntry(repo: Repo, dirPath: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    size: 0,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.default_branch}/${path}`,
    download_url: isDir ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.default_branch}/${path}`,
  };
}

function fileEntry(repo: Repo, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`,
    download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.default_branch}/${path}`,
  };
}
