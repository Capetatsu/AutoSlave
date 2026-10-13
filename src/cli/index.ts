/**
 * AutoSlave minimal CLI (Phase 1: direct mode — talks straight to the adapter.
 * The daemon client arrives in Phase 2; `autoslave run` does not exist yet.)
 */
import { OpenCodeAdapter } from '../adapter/adapter.js';
import { AgentRegistry } from '../registry/registry.js';
import type { AgentRole } from '../registry/registry.js';
import { discoverConnection } from '../adapter/client.js';
import { readFileSync } from 'node:fs';

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}

function help(): string {
  return `autoslave ${version()} — coordinate OpenCode sessions (Phase 1 direct mode; no daemon yet)
Usage:
  autoslave agent add --session <id> --role <coder|reviewer> [--model <id>] [--workdir <dir>]
  autoslave agent add --create --dir <directory> --role <role> [--title <t>] [--model <id>]
  autoslave agent list
  autoslave agent role <agentId> <role>
  autoslave agent remove <agentId>
  autoslave send <agentId> <text...> [--wait [--timeout <ms>]]
  autoslave status <agentId>
`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const VALID_ROLES: AgentRole[] = ['coder', 'reviewer', 'tester', 'debugger', 'planner', 'architect', 'researcher'];

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const registry = new AgentRegistry();
  const adapter = new OpenCodeAdapter();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(help());
    return 0;
  }

  if (cmd === 'agent' && sub === 'add') {
    const role = (flag(rest, '--role') ?? 'coder') as AgentRole;
    if (!VALID_ROLES.includes(role)) {
      console.error(`invalid role: ${role} (valid: ${VALID_ROLES.join(', ')})`);
      return 1;
    }
    const conn = discoverConnection();
    const createDir = flag(rest, '--dir');
    let sessionId = flag(rest, '--session');
    let workdir = flag(rest, '--workdir') ?? process.cwd();
    let model = flag(rest, '--model');
    if (createDir) {
      const created = await adapter.createSession({
        title: flag(rest, '--title') ?? `autoslave-${role}`,
        location: { directory: createDir },
      });
      sessionId = created.id;
      workdir = createDir;
      model = model ?? created.model?.id;
    }
    if (!sessionId) {
      console.error('provide --session <id> or --create --dir <directory>');
      return 1;
    }
    const rec = registry.add({ role, sessionId, serverUrl: conn.baseUrl, model, workdir });
    console.log(`${rec.id} role=${rec.role} session=${rec.sessionId} dir=${rec.workdir}${rec.model ? ` model=${rec.model}` : ''}`);
    return 0;
  }

  if (cmd === 'agent' && sub === 'list') {
    for (const a of registry.list()) {
      console.log(`${a.id} role=${a.role} status=${a.status} session=${a.sessionId}${a.model ? ` model=${a.model}` : ''} dir=${a.workdir}`);
    }
    return 0;
  }

  if (cmd === 'agent' && sub === 'role') {
    const [id, role] = rest;
    if (!id || !VALID_ROLES.includes(role as AgentRole)) {
      console.error('usage: autoslave agent role <agentId> <role>');
      return 1;
    }
    const rec = registry.setRole(id, role as AgentRole);
    console.log(`${rec.id} role=${rec.role}`);
    return 0;
  }

  if (cmd === 'agent' && sub === 'remove') {
    if (!rest[0] || !registry.remove(rest[0])) {
      console.error(`unknown agent: ${rest[0] ?? ''}`);
      return 1;
    }
    console.log(`removed ${rest[0]}`);
    return 0;
  }

  if (cmd === 'send') {
    const id = sub;
    const rec = id ? registry.get(id) : undefined;
    if (!rec) {
      console.error(`unknown agent: ${id ?? ''}`);
      return 1;
    }
    const waitIdx = rest.indexOf('--wait');
    const text = (waitIdx >= 0 ? rest.slice(0, waitIdx) : rest.filter((a) => a !== '--timeout' && a !== flag(rest, '--timeout'))).join(' ');
    if (!text) {
      console.error('usage: autoslave send <agentId> <text...> [--wait]');
      return 1;
    }
    const since = Date.now();
    const receipt = await adapter.sendTask(rec.sessionId, text);
    registry.setStatus(rec.id, 'working');
    console.log(`sent inbox=${receipt.id} delivery=${receipt.delivery}`);
    if (waitIdx >= 0) {
      const timeout = Number(flag(rest, '--timeout') ?? 180000);
      try {
        const turn = await adapter.waitForTurn(rec.sessionId, since, timeout);
        registry.setStatus(rec.id, 'idle');
        console.log(`turn outcome=${turn.outcome} model=${turn.model?.id ?? '?'} text=${turn.assistantText.slice(0, 300)}`);
      } catch (e) {
        registry.setStatus(rec.id, 'error');
        console.error(`wait failed: ${(e as Error).message}`);
        return 1;
      }
    }
    return 0;
  }

  if (cmd === 'status') {
    const rec = sub ? registry.get(sub) : undefined;
    if (!rec) {
      console.error(`unknown agent: ${sub ?? ''}`);
      return 1;
    }
    const info = await adapter.getSession(rec.sessionId);
    const history = await adapter.getHistory(rec.sessionId, 5, 'desc');
    const last = history[0];
    console.log(`${rec.id} role=${rec.role} status=${rec.status} outcome=${info.outcome ?? '?'} model=${info.model?.id ?? rec.model ?? '?'} last=${last?.type}${last?.outcome ? `:${last.outcome}` : ''}`);
    return 0;
  }

  console.error(help());
  return 1;
}

const code = await main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`autoslave: ${(e as Error).message}`);
  return 1;
});
// Exit explicitly only on failure: a natural exit lets open sockets close cleanly
// (explicit process.exit with live handles trips a libuv assertion on Windows).
if (typeof code === 'number' && code !== 0) process.exit(code);
