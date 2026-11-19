// Boot file for the forge. Everything here exists to introduce this process
// to the grading environment and to keep it alive until that environment
// has finished with it.
//
// The environment (the "env") is a separate program, and it cannot guess
// where this server ended up listening: the port is only picked by the
// operating system at listen time. So the first job after binding is to
// report the port back:
//
//   - MAKEFUN_ENV_URL holds the env's origin. Without it there is nobody
//     to report to, and the process exits 1 straight away.
//   - The forge built by app.ts is bound to port 0, an ephemeral port.
//     The env's own port is never touched; the env is sitting on it.
//   - A POST to /register carrying {"port": N} as JSON tells the env
//     where the trial's traffic should go. 200 means the address was
//     taken. 409 means another process registered first, which is not
//     this process's problem: it just carries on waiting like the rest.
//     400 and 405 mean the request itself broke the contract, and no
//     amount of retrying repairs that, so those end the program.
//   - GET /done is polled from then on. It answers {"done": false} while
//     the trial runs and {"done": true} once the env has written its
//     export; on that answer the listener closes and the process exits 0.
//
// Settings the forge itself cares about (the trial clock, the shop token,
// the seed) are read inside app.ts. This file needs only the env's origin.

import { createApp } from './app.ts';

/** An answer from the env that waiting and asking again will never fix. */
class HopelessAnswerError extends Error {}

/** Sleep for the given number of milliseconds. */
function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * How long to wait before trying again, given the number of failures so
 * far: a fifth of a second at first, doubling with each failure, and
 * never more than a second and a half.
 */
function delayAfter(failures: number): number {
  return Math.min(1500, 200 * 2 ** Math.min(failures, 6));
}

/** One call to the env, abandoned if it has not answered within 15 seconds. */
function callEnv(origin: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
}

/**
 * POST our port to the env until it accepts the registration. Refused
 * connections, timeouts and 5xx answers only mean the env may still be
 * starting, so they are retried after a pause; the two hopeless statuses
 * are the only way out besides success.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await callEnv(origin, '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      const detail = await reply.text().catch(() => '');
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new HopelessAnswerError(`register was refused with HTTP ${reply.status}: ${detail}`);
      }
    } catch (err) {
      if (err instanceof HopelessAnswerError) throw err;
      // A network-level failure says nothing about the contract; retry.
    }
    failures += 1;
    await nap(delayAfter(failures));
  }
}

/**
 * Ask the env whether the trial is over, again and again, until it says
 * so. A garbled body, a non-200 answer or a call that never lands all
 * mean the same thing: not over yet.
 */
async function awaitTrialEnd(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await callEnv(origin, '/done');
      if (reply.ok) {
        const payload: unknown = await reply.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      } else {
        await reply.text().catch(() => undefined);
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    failures += 1;
    await nap(delayAfter(failures));
  }
}

/** Stop listening; if connections linger, stop waiting after two seconds. */
function stopListening(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, 2000);
    server.close(() => {
      clearTimeout(deadline);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** The whole life of the process: bind, announce, wait, shut down. */
async function run(origin: string): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      resolve();
    });
  });
  const bound = forge.address();
  if (bound === null || typeof bound !== 'object') {
    throw new Error('listening did not produce a TCP port to announce');
  }
  console.log(`[forge] listening on port ${bound.port}`);

  await announcePort(origin, bound.port);
  console.log('[forge] the env knows where we are; standing by for the end of the trial');

  await awaitTrialEnd(origin);
  await stopListening(forge);
  console.log('[forge] trial over; goodbye');
}

const origin = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
if (origin === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set, so there is no env to register with; exiting');
  process.exit(1);
}

run(origin).then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(`[forge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
