/** Unit tests: AgentRegistry persistence. Uses a temp dir — no OpenCode needed. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRegistry } from '../src/registry/registry.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-reg-'));
});

function reg(): AgentRegistry {
  return new AgentRegistry(path.join(dir, 'registry.json'));
}

describe('AgentRegistry', () => {
  it('adds and lists agents', () => {
    const r = reg();
    const a = r.add({ role: 'coder', sessionId: 'ses_1', serverUrl: 'http://x', workdir: '/w' });
    assert.match(a.id, /^agent_/);
    assert.equal(a.status, 'idle');
    assert.equal(r.list().length, 1);
  });

  it('persists across instances', () => {
    const r = reg();
    const a = r.add({ role: 'reviewer', sessionId: 'ses_9', serverUrl: 'http://x', workdir: '/w' });
    const r2 = reg();
    assert.equal(r2.get(a.id)?.sessionId, 'ses_9');
  });

  it('sets role and status', () => {
    const r = reg();
    const a = r.add({ role: 'coder', sessionId: 'ses_1', serverUrl: 'http://x', workdir: '/w' });
    r.setRole(a.id, 'reviewer');
    r.setStatus(a.id, 'working');
    assert.equal(r.get(a.id)?.role, 'reviewer');
    assert.equal(r.get(a.id)?.status, 'working');
  });

  it('finds by session and removes', () => {
    const r = reg();
    const a = r.add({ role: 'coder', sessionId: 'ses_1', serverUrl: 'http://x', workdir: '/w' });
    assert.equal(r.findBySession('ses_1')?.id, a.id);
    assert.equal(r.remove(a.id), true);
    assert.equal(r.get(a.id), undefined);
  });

  it('rejects unknown agents', () => {
    const r = reg();
    assert.throws(() => r.setRole('agent_nope', 'coder'), /unknown agent/);
    assert.equal(r.remove('agent_nope'), false);
  });
});
