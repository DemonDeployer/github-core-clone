// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL and MCP, all on
// one process over the shared store. main.ts owns the entry <-> env lifecycle; this file
// is the server it binds.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendJson, nextRequestId } from './send.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { store } from './store.ts';
import {
  buildV0,
  v2Advertisement,
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  parseUploadPackV2,
  parseUploadPackV0,
} from './git-http.ts';

/** Largest request body accepted (the clone-setup push carries ~600 objects). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

class BodyTooLargeError extends Error {}

/** Read a request body fully into memory. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, data: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(data);
}

/** Git smart-HTTP routes: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}. */
function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer | null,
  owner: string,
  repoName: string,
  service: string,
): void {
  const method = req.method ?? 'GET';
  const repo = store.getRepo(owner, repoName);

  if (service === 'info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const svc = url.searchParams.get('service');
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (svc === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (v2) {
        sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, buildV0(repo, 'git-upload-pack', store), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (svc === 'git-receive-pack') {
      // Receive-pack always advertises v0 (the client throws on a v2 answer).
      sendBuffer(res, 200, buildV0(repo, 'git-receive-pack', store), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (service === 'git-upload-pack') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const payload = body ?? Buffer.alloc(0);
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      if (v2) {
        const parsed = parseUploadPackV2(payload);
        if (parsed.command === 'ls-refs') {
          sendBuffer(
            res,
            200,
            handleLsRefs(repo, { peel: parsed.peel, symrefs: parsed.symrefs, unborn: parsed.unborn, prefixes: parsed.prefixes }, store),
            'application/x-git-upload-pack-result',
          );
        } else if (parsed.command === 'fetch') {
          sendBuffer(
            res,
            200,
            handleFetchV2(store, parsed.wants, parsed.haves, parsed.shallow, parsed.depth),
            'application/x-git-upload-pack-result',
          );
        } else {
          sendJson(res, 400, { message: `Unknown command: ${parsed.command}` });
        }
      } else {
        const parsed = parseUploadPackV0(payload);
        sendBuffer(
          res,
          200,
          handleFetchV0(store, parsed.wants, parsed.haves, parsed.shallow, parsed.depth),
          'application/x-git-upload-pack-result',
        );
      }
    } catch {
      // Malformed framing: a 400, and the server stays healthy for the next request.
      sendJson(res, 400, { message: 'Malformed request' });
    }
    return;
  }

  if (service === 'git-receive-pack') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const report = handleReceivePack(store, repo, body ?? Buffer.alloc(0));
    sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : null;

        if (method === 'POST' && path === '/api/graphql') {
          handleGraphql(req, res, body);
          return;
        }
        if (method === 'POST' && path === '/mcp') {
          handleMcp(req, res, body);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handleRest(req, res, url, body);
          return;
        }
        const gitMatch = GIT_ROUTE.exec(path);
        if (gitMatch !== null) {
          let owner = gitMatch[1] as string;
          let repoName = gitMatch[2] as string;
          try {
            owner = decodeURIComponent(owner);
            repoName = decodeURIComponent(repoName);
          } catch {
            // Keep the raw segments on a decode failure.
          }
          handleGit(req, res, url, body, owner, repoName, gitMatch[3] as string);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          if (!res.headersSent) sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        // Never crash on a request: answer 500 JSON and keep serving.
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.destroy();
      }
    })();
  });
}
