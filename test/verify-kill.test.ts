/** Process-kill honesty tests against real processes. No OpenCode, no models. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, runChecks, ChecksAbortedError } from '../src/verify/checks.js';

describe('verified termination', () => {
  it('timed-out command is killed and reported honestly', async () => {
    const t0 = Date.now();
    const r = await runCheck(process.cwd(), {
      name: 'hang',
      command: 'node -e "setTimeout(()=>{},60000)"',
      required: true,
      timeoutMs: 2000,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 'timeout');
    assert.equal(r.killed, true, 'death must be verified, not assumed');
    assert.ok(elapsed < 15000, `took ${elapsed}ms (kill + verify should be fast)`);
    assert.match(r.detail ?? '', /exceeded 2000ms/);
  });

  it('aborted check stops and never claims success', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    const t0 = Date.now();
    const r = await runCheck(process.cwd(), {
      name: 'long',
      command: 'node -e "setTimeout(()=>{},60000)"',
      required: true,
      timeoutMs: 60000,
    }, ctl.signal);
    assert.equal(r.status, 'error');
    assert.match(r.detail ?? '', /aborted/);
    assert.ok(Date.now() - t0 < 30000, 'abort must preempt the 60s timeout');
  });

  it('runChecks stops issuing after abort', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(runChecks(process.cwd(), [
      { name: 'a', command: 'node -e "1"', required: true, timeoutMs: 5000 },
    ], ctl.signal), (e: unknown) => (e as Error).name === 'ChecksAbortedError');
    assert.equal(new ChecksAbortedError().name, 'ChecksAbortedError');
  });

  it('passing check is unaffected (killed stays unset)', async () => {
    const r = await runCheck(process.cwd(), { name: 'ok', command: 'node -e "1"', required: true, timeoutMs: 10000 });
    assert.equal(r.status, 'pass');
    assert.equal(r.killed, undefined);
  });
});
