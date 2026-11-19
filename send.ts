// send.ts — shared JSON response helpers. Every JSON reply carries a non-empty
// X-GitHub-Request-Id (the conformance suite asserts it on REST replies).

import type { ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  // Encode once: the byte length comes from the buffer itself, and
  // res.end(buffer) sends it without re-encoding the string (which a
  // res.end(string) would do as a second full pass over the body).
  const data = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': data.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(data);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, { message }, headers);
}

/** A 204 with no body (DELETE repo). The request-id header is still present. */
export function sendNoContent(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}
