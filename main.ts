// Entry lifecycle: the forge process talks to the trial env over HTTP.
// The env hands this process its origin in MAKEFUN_ENV_URL. The process
// starts the app on an ephemeral port, reports that port to the env, and
// then waits until the env reports the trial finished. Nothing else here
// is graded; the app itself (app.ts) is what the suite exercises.
//
// Wire contract, step by step:
//   - No MAKEFUN_ENV_URL means there is no env to talk to: exit 1 at once.
//   - listen(0) lets the kernel choose a free port. Port 8080 belongs to
//     the env and must never be bound by this process.
//   - POST <env>/register {"port": N}. The env records the caller address
//     plus N and dials that base URL from then on. The first register wins;
//     a 409 means another entry already registered, so this process simply
//     carries on waiting like any other.
//   - GET <env>/done until the body reads {"done": true}. The env answers
//     immediately ({"done": false} while the suite is still running), so
//     this is a poll loop, never a long-held request.
//   - Close the server and exit 0. The harness then stops the env, which
//     writes the export the scorer reads.
//
// Only the app is imported here: no packages, no Node built-ins beyond
// what the runtime already provides, no model call.

import { createApp } from './app.ts';

// Origin of the trial env, with any trailing slashes trimmed off.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request may take at most this long before it is abandoned.
const REQUEST_BUDGET_MS = 30_000;
// Retry spacing starts here and doubles, up to the cap below.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Spacing after `failures` consecutive failed attempts: exponential
// growth from BACKOFF_FIRST_MS, capped at BACKOFF_LIMIT_MS.
function backoffAfter(failures: number): number {
  const doubled = BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_LIMIT_MS, doubled);
}

// Runs `attempt` until it reports success, retrying after a growing
// pause. A `fatal` error ends the process instead of retrying: the
// caller decides which failures are fatal by throwing an Error whose
// message starts with 'fatal: '.
async function retryUntilDone(attempt: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let ok: boolean;
    try {
      ok = await attempt();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('fatal: ')) throw err;
      ok = false;
    }
    if (ok) return;
    await pause(backoffAfter(failures));
  }
}

// Tell the env which port the app bound. 200 is the normal answer and
// 409 means a first register already won, which is fine either way.
// 400 and 405 are contract errors and end the program; anything else
// (the env still starting, a 5xx, a dropped connection) is retried.
async function announcePort(port: number): Promise<void> {
  await retryUntilDone(async () => {
    const res = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new Error(`fatal: register answered HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  });
}

// Ask the env whether the trial is over, polling until it says yes.
// A failed poll or a "not yet" answer just means "ask again later".
async function awaitTrialEnd(): Promise<void> {
  await retryUntilDone(async () => {
    const res = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

// The whole life of the process: bind, announce, wait, shut down.
async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
