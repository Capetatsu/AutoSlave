/** Unit tests for the verification runner: config, bounds, timeouts. No OpenCode. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXCERPT_CHARS,
  MAX_OUTPUT_CHARS,
  loadChecks,
  packetSection,
  parseCheckFlag,
  redactSecrets,
  resolveChecks,
  runCheck,
  runChecks,
} from '../src/verify/checks.js';

describe('loadChecks', () => {
  it('missing file → no checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-v-'));
    assert.deepEqual(loadChecks(dir), []);
  });

  it('validates entries and defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-v-'));
    fs.writeFileSync(
      path.join(dir, 'autoslave.checks.json'),
      JSON.stringify({ checks: [{ name: 'unit', command: 'node --test' }, { name: 'lint', command: 'npm run lint', required: false, timeoutMs: 5000 }] }),
    );
    assert.deepEqual(loadChecks(dir), [
      { name: 'unit', command: 'node --test', required: true, timeoutMs: 120000 },
      { name: 'lint', command: 'npm run lint', required: false, timeoutMs: 5000 },
    ]);
  });

  it('rejects malformed config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-v-'));
    fs.writeFileSync(path.join(dir, 'autoslave.checks.json'), '{bad json');
    assert.throws(() => loadChecks(dir), /invalid/);
    fs.writeFileSync(path.join(dir, 'autoslave.checks.json'), JSON.stringify({ checks: [{ name: '', command: 'x' }] }));
    assert.throws(() => loadChecks(dir), /name/);
    fs.writeFileSync(path.join(dir, 'autoslave.checks.json'), JSON.stringify({ checks: [{ name: 'u' }] }));
    assert.throws(() => loadChecks(dir), /command/);
  });
});

describe('parseCheckFlag / resolveChecks', () => {
  it('parses name=command', () => {
    assert.deepEqual(parseCheckFlag('unit=node --test', true), {
      name: 'unit',
      command: 'node --test',
      required: true,
      timeoutMs: 120000,
    });
    assert.throws(() => parseCheckFlag('noequals', true), /name=command/);
  });

  it('CLI overrides config on duplicate names', () => {
    const merged = resolveChecks(
      [{ name: 'unit', command: 'old', required: true, timeoutMs: 1 }],
      [{ name: 'unit', command: 'new', required: false, timeoutMs: 2 }],
    );
    assert.deepEqual(merged, [{ name: 'unit', command: 'new', required: false, timeoutMs: 2 }]);
  });
});

describe('runCheck', () => {
  it('pass captures exit code and duration', async () => {
    const r = await runCheck(process.cwd(), { name: 'ok', command: 'node -e "console.log(1)"', required: true, timeoutMs: 30000 });
    assert.equal(r.status, 'pass');
    assert.equal(r.exitCode, 0);
    assert.ok(r.durationMs >= 0);
    assert.ok(r.output.includes('1'));
  });

  it('fail captures non-zero exit', async () => {
    const r = await runCheck(process.cwd(), { name: 'bad', command: 'node -e "console.error(\'boom\');process.exit(3)"', required: true, timeoutMs: 30000 });
    assert.equal(r.status, 'fail');
    assert.equal(r.exitCode, 3);
    assert.ok(r.excerpt.includes('boom'));
  });

  it('bounds output and excerpt', async () => {
    const r = await runCheck(
      process.cwd(),
      { name: 'chatty', command: 'node -e "let s=\'\';for(let i=0;i<200000;i++)s+=\'y\';process.stdout.write(s)"', required: true, timeoutMs: 30000 },
    );
    assert.equal(r.status, 'pass');
    assert.ok(r.output.length <= MAX_OUTPUT_CHARS, `output ${r.output.length}`);
    assert.ok(r.excerpt.length <= EXCERPT_CHARS, `excerpt ${r.excerpt.length}`);
    assert.equal(r.truncated, true);
  });

  it('timeout kills and reports', async () => {
    const r = await runCheck(
      process.cwd(),
      { name: 'slow', command: 'node -e "setTimeout(()=>{},30000)"', required: true, timeoutMs: 1500 },
    );
    assert.equal(r.status, 'timeout');
    assert.ok((r.detail ?? '').length > 0);
  });

  it('redacts secrets from stored output', () => {
    const out = redactSecrets('using x-api-key: sk-abc123 and password= hunter2 done');
    assert.ok(!out.includes('sk-abc123') && !out.includes('hunter2'), out);
  });

  it('runs sequentially in order', async () => {
    const order: string[] = [];
    const real = await runChecks(process.cwd(), [
      { name: 'a', command: 'node -e "1"', required: true, timeoutMs: 30000 },
      { name: 'b', command: 'node -e "1"', required: true, timeoutMs: 30000 },
    ]);
    order.push(...real.map((r) => r.name));
    assert.deepEqual(order, ['a', 'b']);
  });
});

describe('packetSection', () => {
  it('states reviewer-only mode when empty', () => {
    assert.ok(packetSection([]).includes('none configured'));
    assert.ok(packetSection(undefined).includes('none configured'));
  });

  it('lists statuses and failure excerpts', () => {
    const s = packetSection([
      { name: 'unit', command: 'c', required: true, status: 'fail', exitCode: 1, durationMs: 5, output: 'o', excerpt: 'FAIL xyz', truncated: false },
      { name: 'lint', command: 'c', required: false, status: 'pass', exitCode: 0, durationMs: 5, output: '', excerpt: '', truncated: false },
    ]);
    assert.ok(s.includes('[required] unit: fail') && s.includes('FAIL xyz') && s.includes('blocks approval'));
    assert.ok(s.includes('[optional] lint: pass'));
  });
});
