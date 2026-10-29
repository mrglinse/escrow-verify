import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PolicyGuard } from './policy-guard.mjs';

const EMPTY_QUEUE = Object.freeze({ schemaVersion: 1, tasks: [], dedupeKeys: {} });
const LOCK_STALE_MS = 30_000;
const RUNNING_STALE_MS = 30_000;

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) freezeDeep(item);
  }
  return Object.freeze(value);
}

function validDeadline(deadline) {
  if (deadline === undefined || deadline === null) return true;
  return typeof deadline === 'string' && Number.isFinite(Date.parse(deadline));
}

export class TaskQueue {
  #path;
  #handlers;
  #guard;
  #now;
  #processing = false;

  constructor({ path = 'data/gdas-task-queue.json', handlers, policyGuard = new PolicyGuard(), now = () => new Date() } = {}) {
    if (!(policyGuard instanceof PolicyGuard)) throw new TypeError('A PolicyGuard is required');
    if (!handlers || typeof handlers !== 'object') throw new TypeError('A fixed handler registry is required');
    this.#path = resolve(path);
    this.#handlers = new Map(Object.entries(handlers));
    this.#guard = policyGuard;
    this.#now = now;
  }

  async #load() {
    try {
      const data = JSON.parse(await readFile(this.#path, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.tasks) || !data.dedupeKeys || typeof data.dedupeKeys !== 'object') {
        throw new Error('Task queue file has an unsupported or invalid format');
      }
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return clone(EMPTY_QUEUE);
      throw error;
    }
  }

  async #save(data) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#path);
  }

  async #withLock(operation) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.#path}.lock`;
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath);
            handle = await open(lockPath, 'wx', 0o600);
          }
        } catch (recoveryError) {
          if (recoveryError.code !== 'ENOENT') throw recoveryError;
        }
      }
      if (!handle) throw new Error('Task queue is locked by another writer');
    }

    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async enqueue(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.type !== 'string' || !this.#handlers.has(task.type)) {
      throw new Error('Task must have a registered type');
    }
    if (typeof task.dedupeKey !== 'string' || !task.dedupeKey.trim()) throw new Error('Task requires a stable dedupeKey');
    if (!validDeadline(task.deadline)) throw new Error('Task deadline must be an ISO-compatible date or null');
    if (!Array.isArray(task.actions) || !task.policy) throw new Error('Task must declare actions and zero-capital policy fields');
    const serializableTask = clone(task);
    return this.#withLock(async () => {
      const data = await this.#load();
      const existingId = data.dedupeKeys[task.dedupeKey];
      if (existingId) return { duplicate: true, task: clone(data.tasks.find((record) => record.id === existingId)) };

      const now = this.#now();
      const decision = this.#guard.inspect(serializableTask);
      const expired = task.deadline && Date.parse(task.deadline) <= now.getTime();
      const record = {
        id: typeof task.id === 'string' && task.id ? task.id : randomUUID(),
        dedupeKey: task.dedupeKey,
        type: task.type,
        task: serializableTask,
        state: expired ? 'expired' : decision.allowed ? 'queued' : 'blocked',
        policyReasons: decision.reasons,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        deadline: task.deadline ?? null,
        attempts: 0,
        checkpoint: null,
        result: null,
        error: expired ? 'Task deadline elapsed before enqueue.' : null
      };
      data.tasks.push(record);
      data.dedupeKeys[record.dedupeKey] = record.id;
      await this.#save(data);
      return { duplicate: false, task: clone(record) };
    });
  }

  async list() {
    return this.#withLock(async () => clone((await this.#load()).tasks));
  }

  async get(taskId) {
    return this.#withLock(async () => {
      const record = (await this.#load()).tasks.find((task) => task.id === taskId);
      return record ? clone(record) : null;
    });
  }

  async checkpoint(taskId, checkpoint) {
    const serialized = clone(checkpoint);
    return this.#withLock(async () => {
      const data = await this.#load();
      const record = data.tasks.find((task) => task.id === taskId);
      if (!record || record.state !== 'running') throw new Error('Only a running task can be checkpointed');
      const decision = this.#guard.inspect(record.task);
      if (!decision.allowed) throw new Error(`Checkpoint blocked by policy: ${decision.reasons.join(', ')}`);
      record.checkpoint = serialized;
      record.updatedAt = this.#now().toISOString();
      await this.#save(data);
      return clone(record);
    });
  }

  async resumeInterrupted() {
    return this.#withLock(async () => {
      const data = await this.#load();
      const now = this.#now();
      let resumed = 0;
      for (const record of data.tasks) {
        if (record.state !== 'running') continue;
        const updatedAt = Date.parse(record.updatedAt);
        if (Number.isFinite(updatedAt) && now.getTime() - updatedAt < RUNNING_STALE_MS) continue;
        if (record.deadline && Date.parse(record.deadline) <= now.getTime()) {
          record.state = 'expired';
          record.error = 'Task deadline elapsed while the task was interrupted.';
        } else {
          record.state = 'queued';
          record.resumedAt = now.toISOString();
          resumed += 1;
        }
        record.updatedAt = now.toISOString();
      }
      await this.#save(data);
      return resumed;
    });
  }

  async processNext() {
    if (this.#processing) throw new Error('A queue task is already being processed by this instance');
    this.#processing = true;
    try {
      const record = await this.#withLock(async () => {
        const data = await this.#load();
        const now = this.#now();
        for (const task of data.tasks) {
          if (task.state === 'queued' && task.deadline && Date.parse(task.deadline) <= now.getTime()) {
            task.state = 'expired';
            task.error = 'Task deadline elapsed before execution.';
            task.updatedAt = now.toISOString();
          }
        }
        const next = data.tasks.find((task) => task.state === 'queued');
        if (!next) {
          await this.#save(data);
          return null;
        }
        const decision = this.#guard.inspect(next.task);
        if (!decision.allowed) {
          next.state = 'blocked';
          next.policyReasons = decision.reasons;
          next.updatedAt = now.toISOString();
          await this.#save(data);
          return { blocked: true, record: clone(next) };
        }
        next.state = 'running';
        next.attempts += 1;
        next.updatedAt = now.toISOString();
        await this.#save(data);
        return { blocked: false, record: clone(next) };
      });

      if (!record || record.blocked) return record?.record ?? null;
      const handler = this.#handlers.get(record.record.type);
      if (record.record.deadline && Date.parse(record.record.deadline) <= this.#now().getTime()) {
        return this.#withLock(async () => {
          const data = await this.#load();
          const current = data.tasks.find((task) => task.id === record.record.id);
          current.state = 'expired';
          current.error = 'Task deadline elapsed immediately before execution.';
          current.updatedAt = this.#now().toISOString();
          await this.#save(data);
          return clone(current);
        });
      }
      try {
        const result = await this.#guard.execute(
          record.record.task,
          (context) => handler(freezeDeep(clone(record.record.task)), freezeDeep({
            ...context,
            idempotencyKey: record.record.dedupeKey,
            perform: (action, operation, operationContext) => this.#guard.perform(record.record.task, action, operation, operationContext)
          })),
          freezeDeep({
            checkpoint: (value) => this.checkpoint(record.record.id, value),
            resumeFromCheckpoint: clone(record.record.checkpoint)
          })
        );
        return this.#withLock(async () => {
          const data = await this.#load();
          const current = data.tasks.find((task) => task.id === record.record.id);
          current.state = 'completed';
          current.result = clone(result);
          current.completedAt = this.#now().toISOString();
          current.updatedAt = current.completedAt;
          await this.#save(data);
          return clone(current);
        });
      } catch (error) {
        return this.#withLock(async () => {
          const data = await this.#load();
          const current = data.tasks.find((task) => task.id === record.record.id);
          current.state = error?.code === 'POLICY_BLOCKED' ? 'blocked' : 'failed';
          current.error = error instanceof Error ? error.message : String(error);
          current.updatedAt = this.#now().toISOString();
          await this.#save(data);
          return clone(current);
        });
      }
    } finally {
      this.#processing = false;
    }
  }
}