/**
 * Phase 4 static permission policy: deterministic, user-owned rules enforced
 * OUTSIDE any model. A model can never grant itself permissions: every decision
 * derives solely from this file's rules plus the requested action — model text
 * is never an input (see answerPermission signature).
 *
 * Policy file: `<AUTOSLAVE_HOME>/policy.json`. Absent → built-in defaults.
 * { "roles": { "coder":    { "read": ["**"], "write": ["src/**"], "exec": ["node *"] },
 *              "reviewer": { "read": ["**"], "write": [],          "exec": [] } } }
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RoleCapability {
  read: string[];
  write: string[];
  exec: string[];
}

export interface Policy {
  roles: Record<string, RoleCapability>;
}

export type PolicyDecision = 'allow' | 'deny' | 'escalate';

export function defaultPolicy(): Policy {
  return {
    roles: {
      coder: { read: ['**'], write: ['**'], exec: ['node *', 'npm *', 'npx *', 'git *'] },
      reviewer: { read: ['**'], write: [], exec: [] },
      tester: { read: ['**'], write: ['**/*.test.*', 'test/**'], exec: ['node *', 'npm test', 'npm run test*'] },
      debugger: { read: ['**'], write: [], exec: ['node *', 'npm test', 'git *'] },
    },
  };
}

export function policyPath(homeDir: string): string {
  return path.join(homeDir, 'policy.json');
}

/** Load user policy or fall back to defaults. Returns which source was used. */
export function loadPolicy(homeDir: string): { policy: Policy; source: 'file' | 'defaults' } {
  try {
    const raw = JSON.parse(fs.readFileSync(policyPath(homeDir), 'utf8')) as Partial<Policy>;
    if (!raw || typeof raw !== 'object' || !raw.roles || typeof raw.roles !== 'object') {
      throw new Error('expected { "roles": { ... } }');
    }
    for (const [role, cap] of Object.entries(raw.roles)) {
      for (const k of ['read', 'write', 'exec'] as const) {
        const v = (cap as Partial<RoleCapability>)[k];
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
          throw new Error(`roles.${role}.${k} must be an array of strings`);
        }
      }
    }
    return { policy: raw as Policy, source: 'file' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { policy: defaultPolicy(), source: 'defaults' };
    throw new Error(`invalid policy file: ${(e as Error).message}`);
  }
}

/** Minimal glob: ** (any depth), * (within a segment), ? (one char). */
export function matchGlob(pattern: string, target: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const t = target.replace(/\\/g, '/');
  // Translate to regex segment-wise.
  const rx = `^${p
    .split('/')
    .map((seg) => {
      if (seg === '**') return '§§';
      return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    })
    .join('/')
    .replace(/§§/g, '.*')}$`;
  return new RegExp(rx).test(t);
}

export interface PolicyOp {
  kind: 'read' | 'write' | 'exec';
  /** Repo-relative path (read/write) or full command line (exec). */
  target: string;
}

/**
 * Evaluate one operation. Closed default: unknown roles and unmatched
 * read/write are denied; unmatched exec escalates (explicit allowlist).
 */
export function evaluate(policy: Policy, role: string, op: PolicyOp): PolicyDecision {
  const cap = policy.roles[role];
  if (!cap) return 'deny';
  const patterns = cap[op.kind] ?? [];
  const hit = patterns.some((g) => (op.kind === 'exec' ? matchCommand(g, op.target) : matchGlob(g, op.target)));
  if (hit) return 'allow';
  return op.kind === 'exec' ? 'escalate' : 'deny';
}

/** Exec patterns match the command's first token plus args (* wildcards). */
function matchCommand(pattern: string, command: string): boolean {
  const p = pattern.trim().replace(/\s+/g, ' ');
  const c = command.trim().replace(/\s+/g, ' ');
  return matchGlob(p, c);
}

/**
 * Check a set of changed files (repo-relative) against a role's write scope.
 * Returns violations; empty means compliant. Used for post-turn enforcement.
 */
export function checkWriteScope(policy: Policy, role: string, files: string[]): string[] {
  return files.filter((f) => evaluate(policy, role, { kind: 'write', target: f }) !== 'allow');
}

export interface PermissionRequest {
  action: string;
  resources: string[];
}

/**
 * Answer an OpenCode permission request from static rules. NOTE the signature:
 * there is deliberately NO parameter for model output — a model's response can
 * never influence this decision. Callers map the result to the API reply
 * vocabulary (allow→always, deny→reject, escalate→leave pending for a human).
 */
export function answerPermission(
  policy: Policy,
  role: string,
  req: PermissionRequest,
): { decision: PolicyDecision; reply?: 'always' | 'reject' } {
  const kind: PolicyOp['kind'] = req.action === 'write' ? 'write' : req.action === 'read' ? 'read' : 'exec';
  // Worst decision across all requested resources wins (deny > escalate > allow).
  let worst: PolicyDecision = 'allow';
  const targets = req.resources.length > 0 ? req.resources : [''];
  for (const target of targets) {
    const d = evaluate(policy, role, { kind, target });
    if (d === 'deny') {
      worst = 'deny';
      break;
    }
    if (d === 'escalate') worst = 'escalate';
  }
  if (worst === 'allow') return { decision: 'allow', reply: 'always' };
  if (worst === 'deny') return { decision: 'deny', reply: 'reject' };
  return { decision: 'escalate' };
}
