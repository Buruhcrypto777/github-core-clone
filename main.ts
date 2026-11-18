// How this entry talks to the trial env, and why each step is shaped the way it is.
//
// The env is a separate server (http://store:8080 inside a trial pod) that drives the suite.
// This file does the harness's half of the handshake and nothing else: it starts the forge
// server app.ts builds, hands the env the port it landed on, and then waits until the env
// reports the trial finished. The suite grades the server, not this handshake, so the only
// job here is to do the handshake exactly as env/src/wire.ts expects it and to stay alive
// until the env says the trial is over.
//
//   - MAKEFUN_ENV_URL gives the env's origin. With no origin there is nobody to register
//     with, so the process gives up at once with exit code 1.
//   - The server binds port 0 and lets the kernel choose. Port 8080 belongs to the env.
//   - POST /register carries {"port": N}. The env remembers the caller's address plus N as
//     the base URL and calls it from then on. The first registration wins: a 409 means some
//     other process already registered, and this one simply keeps waiting like the rest.
//   - GET /done is a short poll, never a held-open request: the env answers immediately
//     with {"done": false} while the suite runs and {"done": true} when the export is ready.
//     A failed or slow poll is retried with a short exponential backoff.
//   - Once done is true, close the server and exit 0. The harness stops the env afterwards
//     and the scorer reads the export the env wrote.
//
// Nothing here reaches beyond its own server and the env: no package, no Node built-in
// beyond fetch and the server itself, and no model call.

import { createApp as buildServer } from './app.ts';

/** Write a line to stdout. */
function log(line: string): void {
  process.stdout.write(line + '\n');
}

/** Write a message to stderr and stop the program. */
function fail(message: string): never {
  process.stderr.write(message + '\n');
  return process.exit(1);
}

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') fail('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with');

/** The longest a single register or done call may run before it is dropped and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** The first pause between retries, and the longest pause the backoff may grow to. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The pause after `failures` failed calls: exponential from BACKOFF_FIRST_MS, capped. */
function backoffFor(failures: number): number {
  const exponent = Math.min(failures, 8);
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** exponent);
}

/**
 * POST the bound port until the env takes it. A 200 means the env recorded it; a 409 means
 * a first registration already won, which is not this process's problem to fix. A 400 or
 * 405 means the request itself broke the contract, so the program ends; a network error or
 * any other status is retried, because the env may still be coming up.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await fetch(envOrigin + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => null);
    if (res !== null) {
      if ([200, 409].includes(res.status)) return;
      if (res.status === 400 || res.status === 405) {
        const detail = await res.text().catch(() => null);
        if (detail !== null) throw new Error('register answered HTTP ' + res.status + ': ' + detail);
      }
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return sooner than that. */
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await fetch(envOrigin + '/done', {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => null);
    if (res !== null && res.ok) {
      const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
      if (body !== null && body.done === true) return;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

/** Bind the port, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = buildServer();
  await new Promise<void>((ready, broken) => {
    server.once('error', broken);
    server.listen(0, () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  log('[entry] listening on port ' + bound.port);
  await announcePort(bound.port);
  log('[entry] registered; waiting for the env to say done');
  await awaitDone();
  server.close(); // stop accepting new connections now that the trial is over
  log('[entry] done');
}

run().then(
  () => process.exit(0),
  (err: unknown) => fail('[entry] ' + (err instanceof Error ? err.message : String(err))),
);
