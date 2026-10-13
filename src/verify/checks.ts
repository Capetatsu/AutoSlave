/**
 * Phase 3 deterministic verification: run configured project commands
 * (tests, build, lint, typecheck) in the target working directory, capture
 * exit code, duration and bounded output. No new dependencies (child_process).
 *
 * Config file (per-project, version-controlled): `<workdir>/autoslave.checks.json`
 * { "checks": [{ "name": "unit", "command": "node --test", "required": true,
 *                "timeoutMs": 120000 }] }
 * `required` defaults to true; `timeoutMs` defaults to 120000.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export interface CheckDef {
  name: string;
  command: string;
  required: boolean;
  timeoutMs: number;
}

export type CheckStatus = 'pass' | 'fail' | 'timeout' | 'error';

export interface CheckResult {
  name: string;
  command: string;
  required: boolean;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  /** Bounded combined output (see MAX_OUTPUT_CHARS). */
  output: string;
  /** Tail excerpt for packets/feedback (see EXCERPT_CHARS). */
  excerpt: string;
  truncated: boolean;
  /** True only when process death was verified after a kill. */
  killed?: boolean;
  detail?: string;
}

export class ChecksAbortedError extends Error {
  constructor() {
    super('verification aborted by user request');
    this.name = 'ChecksAbortedError';
  }
}

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_OUTPUT_CHARS = 32768;
export const EXCERPT_CHARS = 4000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Load + validate the per-project config. Missing file → no checks. */
export function loadChecks(workdir: string): CheckDef[] {
  const file = path.join(workdir, 'autoslave.checks.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid ${file}: ${(e as Error).message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.checks)) {
    throw new Error(`invalid ${file}: expected { "checks": [...] }`);
  }
  return parsed.checks.map((c: unknown, i: number) => normalizeCheck(c, i, file));
}

function normalizeCheck(c: unknown, i: number, file: string): CheckDef {
  const where = `${file} checks[${i}]`;
  if (!isRecord(c) || typeof c.name !== 'string' || c.name.length === 0) {
    throw new Error(`invalid ${where}: name must be a non-empty string`);
  }
  if (typeof c.command !== 'string' || c.command.length === 0) {
    throw new Error(`invalid ${where}: command must be a non-empty string`);
  }
  if (c.required !== undefined && typeof c.required !== 'boolean') {
    throw new Error(`invalid ${where}: required must be boolean`);
  }
  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || c.timeoutMs <= 0)) {
    throw new Error(`invalid ${where}: timeoutMs must be a positive number`);
  }
  return {
    name: c.name,
    command: c.command,
    required: c.required ?? true,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Parse a CLI `--check name=command` / `--optional-check name=command` flag value. */
export function parseCheckFlag(value: string, required: boolean): CheckDef {
  const eq = value.indexOf('=');
  if (eq <= 0 || eq === value.length - 1) {
    throw new Error(`--check value must look like name=command, got: ${value}`);
  }
  return { name: value.slice(0, eq), command: value.slice(eq + 1), required, timeoutMs: DEFAULT_TIMEOUT_MS };
}

/** Merge config-file checks with CLI overrides (CLI wins on duplicate names). */
export function resolveChecks(configured: CheckDef[], cli: CheckDef[]): CheckDef[] {
  const merged = new Map(configured.map((c) => [c.name, c]));
  for (const c of cli) merged.set(c.name, c);
  return [...merged.values()];
}

// T17 hygiene: never persist secrets that commands may echo.
const SECRET_PATTERNS = [
  /(api[_-]?key\s*[:=]\s*)(['"]?)[^\s'"]+/gi,
  /(x-api-key\s*[:=]\s*)(['"]?)[^\s'"]+/gi,
  /(bearer\s+)[A-Za-z0-9\-._~+/=]+/gi,
  /(password\s*[:=]\s*)(['"]?)[^\s'"]+/gi,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '$1[redacted]');
  }
  return out;
}

/**
 * Run one check. Sequential by design (no parallel orchestration in Phase 3).
 * Output is capped; timeout kills the whole process tree and verifies death.
 * Never claim a kill that was not verified (see `killed`).
 */
export function runCheck(workdir: string, check: CheckDef, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        name: check.name, command: check.command, required: check.required,
        status: 'error', exitCode: null, durationMs: 0, output: '', excerpt: '',
        truncated: false, detail: 'aborted before start',
      });
      return;
    }
    const finish = (status: CheckStatus, exitCode: number | null, output: string, detail?: string, killed?: boolean): void => {
      const clean = redactSecrets(output);
      const truncated = clean.length > MAX_OUTPUT_CHARS;
      const bounded = truncated ? clean.slice(0, MAX_OUTPUT_CHARS) : clean;
      resolve({
        name: check.name,
        command: check.command,
        required: check.required,
        status,
        exitCode,
        durationMs: Date.now() - started,
        output: bounded,
        excerpt: bounded.slice(-EXCERPT_CHARS),
        truncated,
        killed,
        detail,
      });
    };
    let proc;
    try {
      // No spawn.timeout: our own timer below kills the whole tree (not just
      // the shell), which spawn's timeout cannot do on Windows.
      proc = spawn(check.command, {
        cwd: workdir,
        shell: true,
        env: process.env,
      });
    } catch (e) {
      finish('error', null, '', `spawn failed: ${(e as Error).message}`);
      return;
    }
    let settled = false;
    const done = (status: CheckStatus, exitCode: number | null, output: string, detail?: string, killed?: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      finish(status, exitCode, output, detail, killed);
    };
    const onAbort = (): void => {
      killTree(proc).then((killed) => {
        done('error', null, output, 'aborted by user request', killed || undefined);
      });
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(softTimer);
    };
    // Primary timeout: kill the whole tree, verify death, report honestly.
    const softTimer = setTimeout(() => {
      killTree(proc).then((killed) => {
        done('timeout', null, output, `exceeded ${check.timeoutMs}ms`, killed || undefined);
      });
    }, check.timeoutMs);
    let output = '';
    const append = (chunk: Buffer | string): void => {
      // Keep memory bounded even for chatty commands: sliding window.
      output = (output + chunk.toString()).slice(-(MAX_OUTPUT_CHARS + EXCERPT_CHARS));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('error', (e) => done('error', null, output, `spawn error: ${e.message}`));
    proc.on('close', (code, signalName) => {
      if (signalName !== null) {
        // Killed externally (timeout/abort path resolves first via killTree;
        // this branch covers platform-initiated kills).
        const pid: number | undefined = proc.pid;
        (pid === undefined ? Promise.resolve(false) : verifyDead(pid)).then((killed) => {
          done('timeout', null, output, `terminated by signal ${signalName}`, killed || undefined);
        });
      } else {
        done(code === 0 ? 'pass' : 'fail', code, output);
      }
    });
  });
}

/** Kill a process tree, then VERIFY death. Never report killed unless confirmed. */
async function killTree(proc: ReturnType<typeof spawn>): Promise<boolean> {
  const pid: number | undefined = proc.pid;
  if (pid === undefined) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* fall through to verification */
  }
  return verifyDead(pid);
}

/** Poll for process death (up to ~3s). Returns true only when confirmed gone. */
async function verifyDead(pid: number, tries = 15): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await isDead(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return await isDead(pid);
}

async function isDead(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const out = typeof r.stdout === 'string' ? r.stdout : '';
    // tasklist prints a row when alive, "INFO: No tasks..." when dead.
    return !out.includes(String(pid)) || /no tasks/i.test(out);
  }
  try {
    process.kill(pid, 0);
    return false; // signal delivered → alive
  } catch (e) {
    // ESRCH = gone (verified). Anything else (e.g. EPERM = alive but unowned)
    // must NOT be reported as dead.
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Run all checks sequentially in definition order. Aborts cleanly on signal. */
export async function runChecks(workdir: string, checks: CheckDef[], signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (signal?.aborted) throw new ChecksAbortedError();
    results.push(await runCheck(workdir, c, signal));
  }
  return results;
}

/** One-line-per-check summary for the audit log. */
export function auditSummary(results: CheckResult[]): string {
  return results.map((r) => `${r.name}=${r.status}(exit ${r.exitCode ?? 'n/a'}, ${r.durationMs}ms)`).join(' ');
}

/** Bounded facts section for the reviewer context packet. */
export function packetSection(results: CheckResult[] | undefined): string {
  if (!results || results.length === 0) {
    return 'DETERMINISTIC CHECKS: none configured for this task (reviewer judgement only).';
  }
  const lines = ['DETERMINISTIC CHECKS (facts — a failing REQUIRED check blocks approval even on approve):'];
  for (const r of results) {
    lines.push(`- [${r.required ? 'required' : 'optional'}] ${r.name}: ${r.status} (exit ${r.exitCode ?? 'n/a'}, ${r.durationMs}ms)`);
    if (r.status !== 'pass') lines.push(`  excerpt: ${r.excerpt}`);
  }
  return lines.join('\n');
}
