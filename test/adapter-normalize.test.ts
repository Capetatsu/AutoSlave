/** Unit tests: event normalization. Mocked frames only — no OpenCode needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, eventSessionID } from '../src/adapter/adapter.js';

describe('normalizeEvent', () => {
  const cases: Array<[string, string]> = [
    ['session.execution.started', 'agent.started'],
    ['session.execution.succeeded', 'agent.idle'],
    ['session.execution.failed', 'agent.error'],
    ['session.error', 'agent.error'],
    ['permission.asked', 'agent.permission_requested'],
    ['session.step.started', 'agent.progress'],
    ['session.step.ended', 'agent.progress'],
    ['session.text.delta', 'agent.progress'],
    ['session.reasoning.ended', 'agent.progress'],
    ['session.usage.updated', 'agent.progress'],
    ['session.diff', 'agent.progress'],
    ['session.inbox.enqueued', 'agent.progress'],
    ['session.something.new.in.v2030', 'agent.unknown'],
    ['', 'agent.unknown'],
  ];
  for (const [serverType, kind] of cases) {
    it(`${serverType || '(empty)'} -> ${kind}`, () => {
      const ev = normalizeEvent(serverType, 'ses_x', { type: serverType });
      assert.equal(ev.kind, kind);
      assert.equal(ev.sessionID, 'ses_x');
      assert.deepEqual(ev.raw, { type: serverType });
    });
  }

  it('carries outcome on terminal events', () => {
    assert.equal(normalizeEvent('session.execution.succeeded', null, {}).outcome, 'succeeded');
    assert.equal(normalizeEvent('session.execution.failed', null, {}).outcome, 'failed');
  });
});

describe('eventSessionID', () => {
  it('reads nested data.sessionID', () => {
    assert.equal(eventSessionID({ type: 'x', data: { sessionID: 'ses_1' } }), 'ses_1');
  });
  it('reads top-level sessionID', () => {
    assert.equal(eventSessionID({ sessionID: 'ses_2' }), 'ses_2');
  });
  it('returns null when absent', () => {
    assert.equal(eventSessionID({ type: 'x' }), null);
    assert.equal(eventSessionID(null), null);
    assert.equal(eventSessionID('str'), null);
  });
});
