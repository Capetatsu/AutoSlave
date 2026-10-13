/**
 * OpenCodeAdapter — the ONLY AutoSlave code that knows OpenCode's API.
 * Agent-neutral operations: list/create sessions, send tasks, subscribe to events,
 * fetch history, diffs, abort, model selection, and race-free turn completion.
 *
 * Completion design (decision D2): events are hints, message history is truth.
 * `waitForTurn` first checks history for a terminal `idle` after `since`, then
 * subscribes and awaits the terminal event, then reconciles against history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { request, subscribe } from './client.js';
import type {
  AgentEvent,
  CreateSessionBody,
  DiffEntry,
  InboxReceipt,
  InterruptResult,
  ModelRef,
  PermissionRequestInfo,
  PromptBody,
  SessionInfo,
  SessionMessage,
  TurnResult,
} from './types.js';

export class TimeoutError extends Error {
  constructor(public sessionID: string, public timeoutMs: number) {
    super(`timed out waiting for turn on ${sessionID} after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

function logLine(logPath: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

/** Map a server event type to the internal vocabulary. Unknown → `agent.unknown`. */
export function normalizeEvent(serverType: string, sessionID: string | null, raw: unknown): AgentEvent {
  let kind: AgentEvent['kind'] = 'agent.unknown';
  let outcome: string | undefined;
  switch (serverType) {
    case 'session.execution.started':
      kind = 'agent.started';
      break;
    case 'session.execution.succeeded':
      kind = 'agent.idle';
      outcome = 'succeeded';
      break;
    case 'session.execution.failed':
      kind = 'agent.error';
      outcome = 'failed';
      break;
    case 'session.error':
      kind = 'agent.error';
      break;
    case 'permission.asked':
      kind = 'agent.permission_requested';
      break;
    case 'session.step.started':
    case 'session.step.streamed':
    case 'session.step.ended':
    case 'session.text.started':
    case 'session.text.delta':
    case 'session.text.ended':
    case 'session.reasoning.started':
    case 'session.reasoning.delta':
    case 'session.reasoning.ended':
    case 'session.usage.updated':
    case 'session.diff':
    case 'session.inbox.enqueued':
    case 'session.inbox.delivered':
    case 'session.instructions.updated':
    case 'session.status':
      kind = 'agent.progress';
      break;
    default:
      kind = 'agent.unknown';
  }
  return { kind, serverType, sessionID, at: Date.now(), outcome, raw };
}

/** Extract the session id from a raw event payload, if present. */
export function eventSessionID(data: unknown): string | null {
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    const inner = (d.data ?? d) as Record<string, unknown>;
    if (typeof inner.sessionID === 'string') return inner.sessionID;
    if (typeof d.sessionID === 'string') return d.sessionID;
  }
  return null;
}

export interface AdapterOptions {
  /** Append-only raw log of calls + events. Defaults to `<cwd>/.autoslave/raw.log`. */
  logPath?: string;
}

export class OpenCodeAdapter {
  private logPath: string;

  constructor(opts: AdapterOptions = {}) {
    this.logPath = opts.logPath ?? path.join(process.cwd(), '.autoslave', 'raw.log');
  }

  private log(entry: Record<string, unknown>): void {
    try {
      logLine(this.logPath, entry);
    } catch {
      /* logging must never break control flow */
    }
  }

  async listSessions(limit = 50): Promise<SessionInfo[]> {
    const r = await request<{ data: SessionInfo[] }>('GET', `/api/session?limit=${limit}&order=desc`);
    this.log({ op: 'listSessions', status: r.status, ms: r.ms, count: r.data.data.length });
    return r.data.data;
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    const r = await request<{ data: SessionInfo }>('GET', `/api/session/${sessionID}`);
    this.log({ op: 'getSession', status: r.status, ms: r.ms, sessionID });
    return r.data.data;
  }

  async createSession(body: CreateSessionBody): Promise<SessionInfo> {
    const r = await request<{ data: SessionInfo }>('POST', '/api/session', body);
    this.log({ op: 'createSession', status: r.status, ms: r.ms, sessionID: r.data.data.id, body });
    return r.data.data;
  }

  async setModel(sessionID: string, model: ModelRef): Promise<void> {
    const r = await request('POST', `/api/session/${sessionID}/model`, { model });
    this.log({ op: 'setModel', status: r.status, ms: r.ms, sessionID, model });
  }

  /** Send a task prompt. Returns the inbox receipt immediately (async execution). */
  async sendTask(sessionID: string, text: string, delivery?: PromptBody['delivery']): Promise<InboxReceipt> {
    const r = await request<{ data: InboxReceipt }>('POST', `/api/session/${sessionID}/prompt`, {
      text,
      ...(delivery ? { delivery } : {}),
    } satisfies PromptBody);
    this.log({ op: 'sendTask', status: r.status, ms: r.ms, sessionID, inboxID: r.data.data.id, chars: text.length });
    return r.data.data;
  }

  /**
   * Subscribe to normalized events for one session. MUST be called before `sendTask`
   * (the server does not replay; see findings Q9). Returns an unsubscribe function.
   */
  subscribeSession(sessionID: string, onEvent: (e: AgentEvent) => void): () => void {
    const ctl = new AbortController();
    const { closed } = subscribe(
      (frame) => {
        const data = frame.data as { type?: string };
        const serverType = typeof data?.type === 'string' ? data.type : frame.event;
        const sid = eventSessionID(frame.data);
        // Match by explicit session id, else by id appearing anywhere in the frame.
        if (sid !== sessionID && !JSON.stringify(frame.data).includes(sessionID)) return;
        const ev = normalizeEvent(serverType, sid ?? sessionID, frame.data);
        this.log({ op: 'event', kind: ev.kind, serverType, sessionID: ev.sessionID });
        onEvent(ev);
      },
      ctl.signal,
    );
    closed.catch(() => {});
    closed.finally(() => this.log({ op: 'unsubscribe', sessionID }));
    return () => ctl.abort();
  }

  async getHistory(sessionID: string, limit = 50, order: 'asc' | 'desc' = 'asc'): Promise<SessionMessage[]> {
    const r = await request<{ data: SessionMessage[] }>(
      'GET',
      `/api/session/${sessionID}/message?order=${order}&limit=${limit}`,
    );
    this.log({ op: 'getHistory', status: r.status, ms: r.ms, sessionID, count: r.data.data.length });
    return r.data.data;
  }

  async getDiff(sessionID: string): Promise<DiffEntry[]> {
    const r = await request<{ data: DiffEntry[] }>('GET', `/api/session/${sessionID}/diff`);
    const n = Array.isArray(r.data.data) ? r.data.data.length : 0;
    this.log({ op: 'getDiff', status: r.status, ms: r.ms, sessionID, entries: n });
    return r.data.data;
  }

  async abort(sessionID: string): Promise<boolean> {
    const r = await request<InterruptResult>('POST', `/api/session/${sessionID}/interrupt`);
    this.log({ op: 'abort', status: r.status, ms: r.ms, sessionID, interrupted: r.data.interrupted });
    return r.data.interrupted;
  }

  /** Pending permission requests for a session (often empty; see evidence). */
  async listPermissions(sessionID: string): Promise<PermissionRequestInfo[]> {
    const r = await request<{ data: PermissionRequestInfo[] }>('GET', `/api/session/${sessionID}/permission`);
    this.log({ op: 'listPermissions', status: r.status, ms: r.ms, sessionID, count: r.data.data.length });
    return r.data.data;
  }

  /** Answer one permission request. Decision must come from static policy. */
  async replyPermission(sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
    const r = await request('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, { decision });
    this.log({ op: 'replyPermission', status: r.status, ms: r.ms, sessionID, requestID, decision });
  }

  /**
   * Wait for the turn started after `since` (epoch ms) to terminate.
   * 1. History first (covers already-finished and missed-event races).
   * 2. Otherwise subscribe and await the terminal event.
   * 3. Reconcile against history; terminal event without a matching `idle`
   *    message is NOT accepted (events are hints, history is truth).
   */
  async waitForTurn(sessionID: string, since: number, timeoutMs = 180000): Promise<TurnResult> {
    const deadline = Date.now() + timeoutMs;
    const checkHistory = async (): Promise<TurnResult | null> => {
      // Newest-first page, reversed: the API's `asc` order pages from the oldest.
      const msgs = (await this.getHistory(sessionID, 20, 'desc')).reverse();
      // Newest terminal idle after `since`.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.type === 'idle' && (m.time?.created ?? 0) > since) {
          // Assistant message directly preceding the idle closes the turn.
          let assistantText = '';
          let model: ModelRef | undefined;
          for (let j = i - 1; j >= 0; j--) {
            if (msgs[j].type === 'assistant') {
              assistantText = (msgs[j].content ?? [])
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('\n');
              model = msgs[j].model;
              break;
            }
            if (msgs[j].type === 'user') break;
          }
          return {
            sessionID,
            outcome: m.outcome ?? 'failed',
            assistantText,
            model,
            idleMessageID: m.id,
            idleAt: m.time?.created ?? Date.now(),
          };
        }
        if (m.type === 'user' && (m.time?.created ?? 0) > since) break; // a newer turn began
      }
      return null;
    };

    const early = await checkHistory();
    if (early) {
      this.log({ op: 'waitForTurn', sessionID, via: 'history-immediate', outcome: early.outcome });
      return early;
    }

    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        unsub();
        try {
          const late = await checkHistory();
          if (late) {
            this.log({ op: 'waitForTurn', sessionID, via: 'history-after-timeout', outcome: late.outcome });
            resolve(late);
          } else reject(new TimeoutError(sessionID, timeoutMs));
        } catch (e) {
          reject(e);
        }
      }, Math.max(0, deadline - Date.now()));

      const unsub = this.subscribeSession(sessionID, (ev) => {
        if (ev.kind === 'agent.idle' || ev.kind === 'agent.error') {
          clearTimeout(timer);
          unsub();
          checkHistory()
            .then((r) => {
              if (r) {
                this.log({ op: 'waitForTurn', sessionID, via: 'event+history', outcome: r.outcome });
                resolve(r);
              } else {
                // Terminal event but no matching idle in history: keep waiting briefly.
                this.waitForTurn(sessionID, since, Math.max(1000, deadline - Date.now())).then(resolve, reject);
              }
            })
            .catch(reject);
        }
      });
    });
  }
}
