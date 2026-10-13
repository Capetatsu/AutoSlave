/**
 * AgentRegistry — AutoSlave's record of agents. Persisted to a JSON file so the
 * daemon (Phase 2) and CLI share one view. Knows nothing about OpenCode types.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type AgentRole = 'coder' | 'reviewer' | 'tester' | 'debugger' | 'planner' | 'architect' | 'researcher';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'unreachable';

export interface AgentRecord {
  id: string;
  role: AgentRole;
  sessionId: string;
  serverUrl: string;
  model?: string;
  workdir: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

function defaultStorePath(): string {
  const home = process.env.AUTOSLAVE_HOME ?? path.join(process.cwd(), '.autoslave');
  return path.join(home, 'registry.json');
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();

  constructor(private storePath: string = defaultStorePath()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const list = JSON.parse(raw) as AgentRecord[];
      for (const a of list) this.agents.set(a.id, a);
    } catch {
      /* missing/corrupt store starts empty */
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.agents.values()], null, 1));
    fs.renameSync(tmp, this.storePath);
  }

  add(entry: { role: AgentRole; sessionId: string; serverUrl: string; model?: string; workdir: string }): AgentRecord {
    const now = new Date().toISOString();
    const rec: AgentRecord = {
      id: `agent_${randomBytes(3).toString('hex')}`,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      ...entry,
    };
    this.agents.set(rec.id, rec);
    this.save();
    return rec;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()];
  }

  findBySession(sessionId: string): AgentRecord | undefined {
    return this.list().find((a) => a.sessionId === sessionId);
  }

  setRole(id: string, role: AgentRole): AgentRecord {
    const rec = this.mustGet(id);
    rec.role = role;
    rec.updatedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  setStatus(id: string, status: AgentStatus): AgentRecord {
    const rec = this.mustGet(id);
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  setModel(id: string, model: string): AgentRecord {
    const rec = this.mustGet(id);
    rec.model = model;
    rec.updatedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  remove(id: string): boolean {
    const ok = this.agents.delete(id);
    if (ok) this.save();
    return ok;
  }

  private mustGet(id: string): AgentRecord {
    const rec = this.agents.get(id);
    if (!rec) throw new Error(`unknown agent: ${id}`);
    return rec;
  }
}
