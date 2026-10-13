/**
 * State store: durable workflow state (tasks, messages, audit sequence) plus
 * control requests (pause/resume/kill) and the append-only audit log.
 * Single JSON file, atomic writes. Crash recovery beyond clean restart is Phase 4.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BusMessage, Task } from '../workflow/types.js';

export interface StoreData {
  seq: number;
  tasks: Record<string, Task>;
  messages: BusMessage[];
}

export type ControlAction = 'pause' | 'resume' | 'kill';

function homeDir(): string {
  return process.env.AUTOSLAVE_HOME ?? path.join(process.cwd(), '.autoslave');
}

/** Resolved home dir (adapter logs, registry, workflow state). */
export function autoslaveHome(): string {
  return homeDir();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export class StateStore {
  private data: StoreData;

  constructor(private home: string = homeDir()) {
    this.data = { seq: 0, tasks: {}, messages: [] };
    this.load();
  }

  get statePath(): string {
    return path.join(this.home, 'workflows.json');
  }

  get auditPath(): string {
    return path.join(this.home, 'audit.log');
  }

  controlPath(taskId: string): string {
    return path.join(this.home, `control-${taskId}.json`);
  }

  private load(): void {
    try {
      this.data = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as StoreData;
      this.data.tasks ??= {};
      this.data.messages ??= [];
      this.data.seq ??= 0;
    } catch {
      /* missing/corrupt store starts empty */
    }
  }

  private save(): void {
    fs.mkdirSync(this.home, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.statePath);
  }

  /** Next audit sequence number (persisted). */
  nextSeq(): number {
    this.data.seq += 1;
    this.save();
    return this.data.seq;
  }

  saveTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.data.tasks[task.id] = task;
    this.save();
  }

  getTask(id: string): Task | undefined {
    return this.data.tasks[id];
  }

  listTasks(): Task[] {
    return Object.values(this.data.tasks);
  }

  /** Persist a message BEFORE delivery. Redelivery reuses the same id. */
  persistMessage(msg: BusMessage): void {
    this.data.messages.push(msg);
    this.save();
  }

  markDelivered(id: string, status: 'sent' | 'failed', detail?: string): void {
    const m = this.data.messages.find((x) => x.id === id);
    if (m) {
      m.delivery = { status, detail, at: new Date().toISOString() };
      this.save();
    }
  }

  messagesFor(taskId: string): BusMessage[] {
    return this.data.messages.filter((m) => m.taskId === taskId);
  }

  audit(entry: { task: string; agent: string; kind: string; detail: string }): void {
    const seq = this.nextSeq();
    fs.appendFileSync(
      this.auditPath,
      JSON.stringify({ seq, ts: new Date().toISOString(), ...entry }) + '\n',
    );
  }

  readAudit(taskId?: string, limit = 200): Array<Record<string, unknown>> {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(this.auditPath, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const filtered = taskId ? rows.filter((r) => r.task === taskId) : rows;
    return filtered.slice(-limit);
  }

  /** CLI writes a control request; the running engine consumes it. */
  requestControl(taskId: string, action: ControlAction): void {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.controlPath(taskId), JSON.stringify({ action, at: new Date().toISOString() }));
  }

  /** Engine reads (and consumes) a pending control request, if any. */
  takeControl(taskId: string): ControlAction | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.controlPath(taskId), 'utf8')) as { action: ControlAction };
      fs.rmSync(this.controlPath(taskId));
      return raw.action;
    } catch {
      return null;
    }
  }

  /** Engine peeks without consuming (used inside the paused loop). */
  peekControl(taskId: string): ControlAction | null {
    try {
      return (JSON.parse(fs.readFileSync(this.controlPath(taskId), 'utf8')) as { action: ControlAction }).action;
    } catch {
      return null;
    }
  }
}
