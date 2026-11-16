// mcp.ts — POST /mcp, JSON-RPC 2.0 over Streamable HTTP, modern era (2026-07-28).
// The server answers server/discover, so the client negotiates the modern era and never
// uses the legacy initialize handshake or a session id. Every request is auth-checked
// independently: no Authorization header -> HTTP 401, before any method handling.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './send.ts';
import { store, VIEWER } from './store.ts';
import { repoView, issueView, pullView, isAuthed } from './rest.ts';
import { createIssueOp, createPullOp, mergePullOp, isOpError } from './ops.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The six required tools, in a fixed order; the definitions are static so tools/list
 *  is byte-identical across calls. Required lists only what the suite can fill. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;

function rpcResult(res: ServerResponse, id: RpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: RpcId, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/** A successful tool result: text JSON + structuredContent (the suite reads both). */
function toolOk(result: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

function callTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === '') return { error: { code: -32602, message: 'Missing required argument: name' } };
      const created = store.createRepo(VIEWER.login, repoName, {
        description: strArg(args, 'description'),
        private: args.private === true,
      });
      if (typeof created === 'object' && 'error' in created) {
        return { result: toolErr(`Repository ${VIEWER.login}/${repoName} already exists`) };
      }
      const view = repoView(created);
      return { result: toolOk({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, description: view.description, default_branch: view.default_branch, html_url: view.html_url, url: view.url }) };
    }
    case 'get_repo': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (owner === '' || repoName === '') return { error: { code: -32602, message: 'Missing required arguments: owner and repo' } };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const view = repoView(repo);
      return { result: toolOk({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, description: view.description, default_branch: view.default_branch, html_url: view.html_url, url: view.url }) };
    }
    case 'create_issue': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      if (owner === '' || repoName === '' || title === '') {
        return { error: { code: -32602, message: 'Missing required arguments: owner, repo, title' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const issue = createIssueOp(store, repo, title, strArg(args, 'body'), []);
      if (isOpError(issue)) return { result: toolErr(issue.error) };
      const view = issueView(issue);
      return { result: toolOk({ id: view.id, number: view.number, title: view.title, body: view.body, state: view.state, html_url: view.html_url, url: view.url }) };
    }
    case 'list_issues': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (owner === '' || repoName === '') return { error: { code: -32602, message: 'Missing required arguments: owner and repo' } };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const state = strArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const list = issues.map((i) => ({ id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return { result: { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { issues: list } } };
    }
    case 'create_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return { error: { code: -32602, message: 'Missing required arguments: owner, repo, title, head, base' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const pull = createPullOp(store, repo, title, strArg(args, 'body'), head, base);
      if (isOpError(pull)) return { result: toolErr(pull.error) };
      const view = pullView(pull);
      return { result: toolOk({ id: view.id, number: view.number, title: view.title, body: view.body, state: view.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } }) };
    }
    case 'merge_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const pullNumber = numArg(args, 'pull_number');
      if (owner === '' || repoName === '' || !Number.isFinite(pullNumber)) {
        return { error: { code: -32602, message: 'Missing required arguments: owner, repo, pull_number' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const result = mergePullOp(store, repo, pullNumber);
      if (!result.ok) return { result: toolErr(result.message) };
      return { result: toolOk({ number: pullNumber, merged: true, state: 'closed', sha: result.sha }) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Handle POST /mcp. Always answers; unknown methods get -32601, unknown tools -32602. */
export function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | null): boolean {
  // Auth is decided before any method or tool handling, on every request.
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = body === null || body.length === 0 ? null : JSON.parse(body.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 + -32700 (modern era).
    rpcError(res, null, -32700, 'Parse error', 400);
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(res, null, -32600, 'Invalid Request');
    return true;
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const hasId = request.id !== undefined;

  // Notifications (no id) are acknowledged with an empty 202.
  if (!hasId) {
    res.writeHead(202);
    res.end();
    return true;
  }

  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      rpcResult(res, id, {
        serverInfo,
        capabilities: { tools: {} },
        supportedVersions: [REVISION],
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      rpcResult(res, id, {
        protocolVersion: REVISION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(name, args);
      if ('error' in outcome) {
        rpcError(res, id, outcome.error.code, outcome.error.message);
        return true;
      }
      rpcResult(res, id, outcome.result);
      return true;
    }
    case 'ping':
      rpcResult(res, id, {});
      return true;
    default:
      rpcError(res, id, -32601, `Method not found: ${method}`);
      return true;
  }
}
