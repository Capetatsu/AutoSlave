/**
 * Low-level HTTP + SSE client for the OpenCode v2 API. No orchestration logic.
 * Server discovery: `AUTOSLAVE_OPENCODE_URL` env, else `opencode service status`;
 * password from `~/.config/opencode/service.json` (HTTP Basic `opencode:<pw>`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class ApiError extends Error {
  constructor(
    public status: number,
    public op: string,
    public body: string,
  ) {
    super(`${op} failed: HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}

export interface Connection {
  baseUrl: string;
  authHeader: string;
}

let cached: Connection | null = null;

export function discoverConnection(): Connection {
  if (cached) return cached;
  const baseUrl = (
    process.env.AUTOSLAVE_OPENCODE_URL ??
    execFileSync('opencode service status', { encoding: 'utf8', shell: true }).trim().split(/\s+/)[0]
  ).replace(/\/$/, '');
  const svcPath = path.join(os.homedir(), '.config', 'opencode', 'service.json');
  const password: string = JSON.parse(fs.readFileSync(svcPath, 'utf8')).password;
  cached = { baseUrl, authHeader: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
  return cached;
}

/** For tests: inject a connection instead of discovering. */
export function setConnection(conn: Connection | null): void {
  cached = conn;
}

export async function request<T>(
  method: 'GET' | 'POST',
  reqPath: string,
  body?: unknown,
  timeoutMs = 30000,
): Promise<{ status: number; ms: number; data: T }> {
  const conn = discoverConnection();
  const t0 = Date.now();
  const res = await fetch(conn.baseUrl + reqPath, {
    method,
    headers: { Authorization: conn.authHeader, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `${method} ${reqPath}`, text);
  let data: T;
  try {
    data = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ApiError(res.status, `${method} ${reqPath}`, `non-JSON response: ${text.slice(0, 200)}`);
  }
  return { status: res.status, ms: Date.now() - t0, data };
}

export interface RawFrame {
  event: string;
  data: unknown;
  at: number;
}

function parseFrameData(raw: string): unknown {
  try {
    const once: unknown = JSON.parse(raw);
    if (typeof once === 'string') {
      try {
        return JSON.parse(once);
      } catch {
        return once;
      }
    }
    return once;
  } catch {
    return raw;
  }
}

/**
 * Open a shared SSE subscription. Resolves once headers are accepted.
 * Frames are pushed to `onFrame`. No replay: frames sent before this call are lost.
 */
export function subscribe(onFrame: (frame: RawFrame) => void, signal: AbortSignal): { closed: Promise<void> } {
  const conn = discoverConnection();
  const closed = (async () => {
    const res = await fetch(`${conn.baseUrl}/api/event`, {
      headers: { Authorization: conn.authHeader, Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, 'GET /api/event', await res.text().catch(() => ''));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let cur: Record<string, string> = {};
    for (;;) {
      const next = await reader.read().catch((): { done: true; value?: undefined } => ({ done: true }));
      if (next.done) break;
      buf += dec.decode(next.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t === '') {
          if (cur.data !== undefined) {
            onFrame({ event: cur.event ?? 'message', data: parseFrameData(cur.data), at: Date.now() });
            cur = {};
          }
          continue;
        }
        if (t.startsWith(':')) continue;
        const i = t.indexOf(':');
        if (i > 0) cur[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  })();
  return { closed };
}
