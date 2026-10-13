/**
 * Contract tests: OpenCodeAdapter against the REAL pinned OpenCode server.
 * Skips gracefully when the server is unreachable. Burns a few tiny prompts
 * on free-tier models — keep additions minimal.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OpenCodeAdapter } from '../src/adapter/adapter.js';
import { discoverConnection } from '../src/adapter/client.js';

let adapter: OpenCodeAdapter;
let available = false;
let workdir: string;

before(async () => {
  try {
    discoverConnection();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-contract-'));
    // session.diff is snapshot/git-based: it reports nothing outside a git repo
    // (see spike/findings/phase0-findings.md Q13). Real projects are repos.
    execFileSync('git', ['init', '-q'], { cwd: workdir });
    adapter = new OpenCodeAdapter({ logPath: path.join(workdir, 'raw.log') });
    await adapter.listSessions(1);
    available = true;
  } catch (e) {
    console.log(`contract tests skipped: ${(e as Error).message}`);
  }
});

describe('adapter contract (live OpenCode)', () => {
  it('lists sessions', async (t) => {
    if (!available) { t.skip('no OpenCode server'); return; }
    const sessions = await adapter.listSessions(5);
    assert.ok(Array.isArray(sessions));
  });

  it('register flow: create -> subscribe-before-send -> task -> terminal turn -> history', async (t) => {
    if (!available) { t.skip('no OpenCode server'); return; }
    const session = await adapter.createSession({ title: 'autoslave-contract', location: { directory: workdir } });
    assert.match(session.id, /^ses_/);
    assert.equal(session.location?.directory, workdir);

    const seen: string[] = [];
    const unsub = adapter.subscribeSession(session.id, (e) => seen.push(e.kind));
    const since = Date.now();
    const receipt = await adapter.sendTask(session.id, 'Reply with exactly the token CONTRACT-OK. No tools.');
    assert.match(receipt.id, /^msg_/);
    const turn = await adapter.waitForTurn(session.id, since, 120000);
    unsub();
    assert.equal(turn.outcome, 'succeeded');
    assert.ok(turn.assistantText.includes('CONTRACT-OK'), `got: ${turn.assistantText.slice(0, 120)}`);
    assert.ok(seen.includes('agent.started'), `events: ${seen.join(',')}`);
    assert.ok(seen.includes('agent.idle'), `events: ${seen.join(',')}`);

    const history = await adapter.getHistory(session.id);
    assert.ok(history.some((m) => m.type === 'idle' && m.outcome === 'succeeded'));
  });

  it('diff reflects a file the agent created, then abort on an idle session is safe', async (t) => {
    if (!available) { t.skip('no OpenCode server'); return; }
    const session = await adapter.createSession({ title: 'autoslave-contract-2', location: { directory: workdir } });
    const since = Date.now();
    await adapter.sendTask(session.id, 'Create file contract-note.txt containing exactly CONTRACT-FILE. Nothing else. No shell.');
    const turn = await adapter.waitForTurn(session.id, since, 120000);
    assert.equal(turn.outcome, 'succeeded');
    assert.ok(fs.existsSync(path.join(workdir, 'contract-note.txt')));
    const diff = await adapter.getDiff(session.id);
    assert.ok(diff.some((d) => d.file.endsWith('contract-note.txt') && d.patch.includes('CONTRACT-FILE')));
    // Aborting an idle session must not error; returns false (nothing to interrupt).
    const interrupted = await adapter.abort(session.id);
    assert.equal(interrupted, false);
  });

  it('model can be switched per session', async (t) => {
    if (!available) { t.skip('no OpenCode server'); return; }
    const session = await adapter.createSession({ title: 'autoslave-contract-3', location: { directory: workdir } });
    await adapter.setModel(session.id, { id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
    const since = Date.now();
    await adapter.sendTask(session.id, 'Reply with exactly MODEL-OK. No tools.');
    const turn = await adapter.waitForTurn(session.id, since, 120000);
    assert.equal(turn.model?.id, 'mimo-v2.6-flash-free');
    // On-topic reply proves the session works after the switch. Exact-token
    // obedience is asserted on the default model above; free-tier models are
    // flaky at it (observed once), so this stays loose by design.
    assert.ok(turn.assistantText.length > 0 && turn.assistantText.includes('MODEL'));
  });
});
