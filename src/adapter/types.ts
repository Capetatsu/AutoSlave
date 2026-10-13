/**
 * AutoSlave OpenCode adapter — type definitions.
 *
 * Subset of the OpenCode v2 HTTP API verified against the served 2.0.28 spec
 * (`spike/findings/openapi-2.0.28.json`) and live spike runs. Unknown fields are
 * tolerated: every interface allows extension and raw payloads are preserved.
 */

/** `{ id, providerID, variant? }` — identifies a model on a provider. */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** `POST /api/session` body. */
export interface CreateSessionBody {
  title?: string;
  agent?: string;
  model?: ModelRef;
  location?: { directory: string };
  /** Static permission ruleset (second layer; see Phase 4 evidence for limits). */
  permissions?: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>;
}

/** One entry of `GET /api/session/{id}/permission` → `data[]`. */
export interface PermissionRequestInfo {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  [key: string]: unknown;
}

/** `GET /api/session/{id}` → `data`. Optional fields are omitted by the server. */
export interface SessionInfo {
  id: string;
  projectID?: string;
  agent?: string;
  model?: ModelRef;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time?: { created: number; updated: number; idle?: number };
  title?: string;
  subpath?: string;
  location?: { directory: string };
  [key: string]: unknown;
}

/** `POST /api/session/{id}/prompt` body. */
export interface PromptBody {
  text: string;
  /** Delivery hint. Server default observed: `"steer"` on an idle session. */
  delivery?: 'steer' | 'queue';
}

/** `POST .../prompt` → `data`: inbox receipt, NOT the reply (async by nature). */
export interface InboxReceipt {
  id: string;
  sessionID: string;
  delivery: 'steer' | 'queue';
  [key: string]: unknown;
}

/** One entry of an assistant message's `content[]`. */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** `GET /api/session/{id}/message` → `data[]` (v2 shape). */
export interface SessionMessage {
  id: string;
  type: string;
  text?: string;
  agent?: string;
  model?: ModelRef;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  content?: ContentPart[];
  time?: { created: number; streamed?: number; completed?: number };
  [key: string]: unknown;
}

/** `GET /api/session/{id}/diff` → `data[]`. */
export interface DiffEntry {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
  [key: string]: unknown;
}

/** `POST .../interrupt` → `{ interrupted: boolean }`. */
export interface InterruptResult {
  interrupted: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalized (agent-neutral) events. Only these cross the adapter boundary.
// Unknown server events are preserved as `agent.unknown`, never dropped.
// ---------------------------------------------------------------------------

export type AgentEventKind =
  | 'agent.started'
  | 'agent.progress'
  | 'agent.idle'
  | 'agent.error'
  | 'agent.permission_requested'
  | 'agent.unknown';

export interface AgentEvent {
  kind: AgentEventKind;
  /** Server-side event name, e.g. `session.step.ended`. */
  serverType: string;
  sessionID: string | null;
  /** Local receipt time (epoch ms). */
  at: number;
  outcome?: string;
  raw: unknown;
}

/** Outcome of a completed turn, reconciled against message history. */
export interface TurnResult {
  sessionID: string;
  outcome: 'succeeded' | 'failed' | 'interrupted';
  /** Concatenated assistant `text` parts of the final turn (may be empty). */
  assistantText: string;
  model?: ModelRef;
  /** `idle` message id that closed the turn. */
  idleMessageID: string;
  /** `idle` message creation time (epoch ms). */
  idleAt: number;
}
