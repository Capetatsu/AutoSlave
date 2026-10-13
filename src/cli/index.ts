/**
 * AutoSlave CLI (Phase 2: direct mode — `run` executes the workflow in-process.
 * pause/resume/kill coordinate with the running process through control files.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { OpenCodeAdapter } from '../adapter/adapter.js';
import { AgentRegistry } from '../registry/registry.js';
import type { AgentRole } from '../registry/registry.js';
import { discoverConnection } from '../adapter/client.js';
import { StateStore, autoslaveHome, newId } from '../store/store.js';
import { WorkflowEngine } from '../workflow/engine.js';
import { loadChecks, parseCheckFlag, resolveChecks } from '../verify/checks.js';
import { loadPolicy } from '../policy/policy.js';
import { createWorktree, currentBranch, porcelain, repoRoot } from '../git/worktrees.js';
import { readFileSync } from 'node:fs';

function version(): string {
  // Works both from src/cli (../../package.json) and dist/src/cli (../../../package.json).
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const p = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (p.name === 'autoslave' && p.version) return p.version;
    } catch {
      /* try next candidate */
    }
  }
  return '0.0.0';
}

function help(): string {
  return `autoslave ${version()} — coordinate OpenCode sessions
Usage:
  autoslave agent add --session <id> --role <coder|reviewer> [--model <id>] [--workdir <dir>]
  autoslave agent add --create --dir <directory> --role <role> [--title <t>] [--model <id>]
  autoslave agent list
  autoslave agent role <agentId> <role>
  autoslave agent remove <agentId>
  autoslave send <agentId> <text...> [--wait [--timeout <ms>]]
  autoslave run --task "<objective>" [--plan <file>] --coder <agentId> --reviewer <agentId>
                  [--max-iterations <n>] [--coder-timeout <ms>] [--reviewer-timeout <ms>]
                  [--reviewer-model <provider/model>] [--review-file <path>]
                  [--check "name=command"] [--optional-check "name=command"]
                  [--worktree <repoRoot>] [--target-branch <name>] [--time-budget <ms>]
                  (plus autoslave.checks.json in the coder workdir)
  autoslave recover <taskId>   (resume an interrupted task after a restart)
  autoslave status <agentId> | --task <taskId> | (lists tasks)
  autoslave log [--task <taskId>] [--lines <n>] [--follow]
  autoslave pause <taskId> | autoslave resume <taskId> | autoslave kill <taskId>
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
  const home = autoslaveHome();
  const adapter = new OpenCodeAdapter({ logPath: path.join(home, 'raw.log') });

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
      // Second layer: reviewer sessions are created with a deny-write ruleset
      // to match the read-only policy. Live probes show OpenCode does not
      // surface permission requests for in-tree writes, so this is strictly a
      // backstop — enforcement is instruction + post-turn scope detection.
      const created = await adapter.createSession({
        title: flag(rest, '--title') ?? `autoslave-${role}`,
        location: { directory: createDir },
        ...(role === 'reviewer' ? { permissions: [{ action: 'write', resource: '*', effect: 'deny' as const }] } : {}),
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
      const timeout = Number(flag(argv, '--timeout') ?? 180000);
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
    const store = new StateStore();
    const taskFlag = flag(argv, '--task') ?? (sub && sub.startsWith('task_') ? sub : undefined);
    if (!taskFlag && !sub) {
      const tasks = store.listTasks();
      if (tasks.length === 0) console.log('no tasks yet — run `autoslave run --task ...`');
      for (const t of tasks) {
        console.log(`${t.id} "${t.objective.slice(0, 60)}" state=${t.state} iteration=${t.iteration}/${t.maxIterations}${t.reason ? ` reason=${t.reason.slice(0, 120)}` : ''}`);
      }
      return 0;
    }
    if (taskFlag) {
      const t = store.getTask(taskFlag);
      if (!t) {
        console.error(`unknown task: ${taskFlag}`);
        return 1;
      }
      const coder = registry.get(t.coderAgentId);
      const reviewer = registry.get(t.reviewerAgentId);
      console.log(`task ${t.id} "${t.objective}"`);
      console.log(`  state=${t.state} iteration=${t.iteration}/${t.maxIterations}`);
      console.log(`  coder    ${t.coderAgentId} (${coder?.model ?? '?'}) status=${coder?.status ?? '?'}`);
      console.log(`  reviewer ${t.reviewerAgentId} (${reviewer?.model ?? '?'}) status=${reviewer?.status ?? '?'}`);
      if (t.lastVerdict) {
        console.log(`  last verdict: ${t.lastVerdict.status} — ${t.lastVerdict.summary.slice(0, 160)}`);
      }
      if (t.lastReport) {
        console.log(`  last report: ${t.lastReport.status} — ${t.lastReport.summary.slice(0, 160)}`);
      }
      if (t.lastChecks && t.lastChecks.length > 0) {
        for (const c of t.lastChecks) {
          console.log(`  check ${c.name}: ${c.status} (exit ${c.exitCode ?? 'n/a'}, ${c.durationMs}ms)${c.required ? '' : ' [optional]'}`);
        }
      }
      if (t.reason) console.log(`  reason: ${t.reason}`);
      if (coder?.model && reviewer?.model && coder.model === reviewer.model) {
        console.log(`  warning: coder and reviewer use the same model (${coder.model}) — not independent verification`);
      }
      return 0;
    }
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

  if (cmd === 'log') {
    const store = new StateStore();
    const lines = Number(flag(argv, '--lines') ?? 50);
    const taskFlag = flag(argv, '--task');
    const print = (): void => {
      for (const row of store.readAudit(taskFlag, lines)) {
        console.log(`${row.seq} ${row.ts} ${row.task} ${row.agent} ${row.kind} ${String(row.detail).slice(0, 220)}`);
      }
    };
    print();
    if (rest.includes('--follow')) {
      let shown = store.readAudit(taskFlag, 100000).length;
      const timer = setInterval(() => {
        const rows = store.readAudit(taskFlag, 100000).slice(shown);
        shown += rows.length;
        for (const row of rows) {
          console.log(`${row.seq} ${row.ts} ${row.task} ${row.agent} ${row.kind} ${String(row.detail).slice(0, 220)}`);
        }
      }, 1000);
      await new Promise(() => {});
      clearInterval(timer);
    }
    return 0;
  }

  if ((cmd === 'pause' || cmd === 'resume' || cmd === 'kill') && sub) {
    const store = new StateStore();
    const t = store.getTask(sub);
    if (!t) {
      console.error(`unknown task: ${sub}`);
      return 1;
    }
    const active = ['CODING', 'REVIEWING', 'FIXING', 'PAUSED'].includes(t.state);
    if (cmd === 'kill' && t.state === 'CREATED') {
      t.state = 'KILLED';
      t.reason = 'killed before start';
      store.saveTask(t);
      store.audit({ task: t.id, agent: 'user', kind: 'control', detail: 'kill before start → KILLED' });
      console.log(`${t.id} KILLED`);
      return 0;
    }
    if (!active) {
      console.error(`task ${sub} is ${t.state} — ${cmd} applies to a running task`);
      return 1;
    }
    store.requestControl(sub, cmd);
    console.log(`${cmd} requested for ${sub} (applies at the next checkpoint)`);
    return 0;
  }

  if (cmd === 'run') {
    // NOTE: flags may start at `sub` position, so search the full argv.
    const objective = flag(argv, '--task');
    let coderId = flag(argv, '--coder');
    const reviewerId = flag(argv, '--reviewer');
    if (!objective || !coderId || !reviewerId) {
      console.error('usage: autoslave run --task "<objective>" [--plan <file>] --coder <agentId> --reviewer <agentId>');
      return 1;
    }
    const coder = registry.get(coderId);
    const reviewer = registry.get(reviewerId);
    if (!coder || !reviewer) {
      console.error(`unknown agent(s): ${!coder ? coderId : ''} ${!reviewer ? reviewerId : ''}`);
      return 1;
    }
    if (coder.sessionId === reviewer.sessionId) {
      console.error('coder and reviewer must be different sessions');
      return 1;
    }
    if (coder.role !== 'coder') console.log(`warning: ${coderId} has role ${coder.role}, expected coder`);
    if (reviewer.role !== 'reviewer') console.log(`warning: ${reviewerId} has role ${reviewer.role}, expected reviewer`);
    if (coder.model && reviewer.model && coder.model === reviewer.model) {
      console.log(`warning: both agents use ${coder.model} — reviewer independence reduced (P8)`);
    }
    if (coder.workdir !== reviewer.workdir) {
      console.log(`warning: coder dir ${coder.workdir} != reviewer dir ${reviewer.workdir}; reviewing ${coder.workdir}`);
    }
    const reviewerModel = flag(argv, '--reviewer-model');
    if (reviewerModel) {
      const [providerID, ...restModel] = reviewerModel.split('/');
      const id = restModel.join('/');
      if (!providerID || !id) {
        console.error('--reviewer-model must look like provider/model');
        return 1;
      }
      await adapter.setModel(reviewer.sessionId, { id, providerID });
      console.log(`reviewer model set to ${reviewerModel}`);
    }
    const planPath = flag(argv, '--plan');
    let planExcerpt = '';
    if (planPath) {
      try {
        planExcerpt = fs.readFileSync(planPath, 'utf8');
      } catch (e) {
        console.error(`cannot read plan file: ${(e as Error).message}`);
        return 1;
      }
    }
    const store = new StateStore();
    const { policy, source: policySource } = loadPolicy(home);
    const engine = new WorkflowEngine({ adapter, registry, store, policy });
    console.log(`policy: ${policySource === 'file' ? 'policy.json' : 'built-in defaults (reviewer read-only)'}`);
    const reviewFiles: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--review-file' && argv[i + 1]) reviewFiles.push(argv[i + 1]);
    }

    // Worktree isolation: the coder gets its own branch + worktree outside any
    // checkout. The reviewer keeps its registered session and reads via packets.
    let workdir = coder.workdir;
    let worktree: { repoRoot: string; branch: string; path: string; targetBranch: string; baseSha: string } | undefined;
    let precreatedId: string | undefined;
    const wtRoot = flag(argv, '--worktree');
    if (wtRoot) {
      let root: string;
      try {
        root = repoRoot(wtRoot);
      } catch (e) {
        console.error(`--worktree is not inside a git repo: ${(e as Error).message}`);
        return 1;
      }
      let targetBranch = flag(argv, '--target-branch');
      try {
        if (!targetBranch) targetBranch = currentBranch(root);
      } catch (e) {
        console.error(`cannot determine target branch: ${(e as Error).message}`);
        return 1;
      }
      const taskId = newId('task');
      const branch = `autoslave/${taskId.replace(/^task_/, '')}`;
      try {
        const wt = createWorktree(root, branch, `coder-${taskId.slice(-6)}`);
        try {
          if (porcelain(root) !== '') console.log(`warning: ${root} has uncommitted changes; coder branch starts at HEAD without them`);
        } catch {
          /* diagnostic only */
        }
        worktree = { repoRoot: root, branch, path: wt.path, targetBranch, baseSha: wt.baseSha };
        const coderSession = await adapter.createSession({ title: `autoslave-coder-${taskId.slice(-6)}`, location: { directory: wt.path } });
        const coderAgent = registry.add({ role: 'coder', sessionId: coderSession.id, serverUrl: discoverConnection().baseUrl, workdir: wt.path });
        coderId = coderAgent.id;
        workdir = wt.path;
        precreatedId = taskId;
        console.log(`worktree: ${branch} at ${wt.path} (target ${targetBranch}); coder=${coderAgent.id}`);
      } catch (e) {
        console.error(`worktree setup failed: ${(e as Error).message}`);
        return 1;
      }
    }
    // State/logs must live outside the agent workdir: session diffs attribute
    // ANY file changed inside it during a turn (including our own raw.log).
    {
      const rel = path.relative(workdir, home);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        console.error(`refusing: AutoSlave home ${home} is inside the coder workdir ${workdir} — session diffs would be polluted. Set AUTOSLAVE_HOME to a directory outside it.`);
        return 1;
      }
    }
    // Verification: per-project config file (in the final workdir) plus CLI
    // overrides (CLI wins).
    let configured: ReturnType<typeof loadChecks> = [];
    try {
      configured = loadChecks(workdir);
    } catch (e) {
      console.error(`invalid checks config: ${(e as Error).message}`);
      return 1;
    }
    const cliChecks: ReturnType<typeof parseCheckFlag>[] = [];
    try {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--check' && argv[i + 1]) cliChecks.push(parseCheckFlag(argv[i + 1], true));
        if (argv[i] === '--optional-check' && argv[i + 1]) cliChecks.push(parseCheckFlag(argv[i + 1], false));
      }
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    const checks = resolveChecks(configured, cliChecks);
    console.log(checks.length > 0 ? `checks: ${checks.map((c) => `${c.name}${c.required ? '' : ' (optional)'}`).join(', ')}` : 'checks: none configured (reviewer judgement only)');
    const task = engine.createTask({
      id: precreatedId,
      objective,
      reviewObjective: flag(argv, '--review-objective'),
      planExcerpt,
      planPath,
      coderAgentId: coderId,
      reviewerAgentId: reviewerId,
      workdir,
      reviewFiles,
      checks,
      worktree,
      timeBudgetMs: Number(flag(argv, '--time-budget') ?? 1800000),
      maxIterations: Number(flag(argv, '--max-iterations') ?? 5),
      coderTimeoutMs: Number(flag(argv, '--coder-timeout') ?? 600000),
      reviewerTimeoutMs: Number(flag(argv, '--reviewer-timeout') ?? 300000),
    });
    console.log(`task ${task.id} created — state=${task.state} (iteration 1/${task.maxIterations})`);
    const terminal = await engine.run(task.id);
    const done = store.getTask(task.id);
    console.log(`task ${task.id} terminal state: ${terminal}`);
    if (done?.reason) console.log(`reason: ${done.reason}`);
    return terminal === 'APPROVED' ? 0 : 1;
  }

  if (cmd === 'recover' && sub) {
    const store = new StateStore();
    const { policy } = loadPolicy(home);
    const engine = new WorkflowEngine({ adapter, registry, store, policy });
    try {
      const terminal = await engine.resume(sub);
      const done = store.getTask(sub);
      console.log(`task ${sub} recovered → ${terminal}`);
      if (done?.reason) console.log(`reason: ${done.reason}`);
      return ['APPROVED'].includes(terminal) ? 0 : 1;
    } catch (e) {
      console.error(`recover failed: ${(e as Error).message}`);
      return 1;
    }
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
