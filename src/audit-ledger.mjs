import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const GENESIS_HASH = '0'.repeat(64);
const LOCK_STALE_MS = 30_000;
const SECRET_FIELD = /(seed|mnemonic|private.?key|passphrase|password|credential|api.?key|secret)/i;
const EVENT_TYPES = new Set([
  'reward_advertised', 'reward_pending', 'task_completed', 'claim_approved', 'claim_pending', 'receipt_pending',
  'asset_receipt_confirmed', 'asset_locked', 'asset_transferable', 'speculative_token',
  'balance_observed', 'realized_proceeds', 'claim_intent_prepared', 'claim_human_rejected',
  'claim_submission_requested', 'claim_submission_confirmed', 'claim_submission_uncertain',
  'virtual_usd_claim_prepared'
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rejectSecrets(value, location = 'event') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`Sensitive field is forbidden in audit data: ${location}.${key}`);
    rejectSecrets(child, `${location}.${key}`);
  }
}

function entryHash(entry) {
  const { hash, ...body } = entry;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function sameEvent(left, right) {
  return left.type === right.type && left.rewardId === right.rewardId && canonical(left.details) === canonical(right.details);
}

export class AuditLedger {
  #path;

  constructor(path = 'data/gdas-audit-ledger.jsonl') {
    this.#path = resolve(path);
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
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath);
            handle = await open(lockPath, 'wx', 0o600);
          }
        } catch (recoveryError) {
          if (recoveryError.code !== 'ENOENT') throw recoveryError;
        }
      }
      if (!handle) throw new Error('Audit ledger is locked by another writer');
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

  async #readUnchecked() {
    try {
      const contents = await readFile(this.#path, 'utf8');
      return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async verify() {
    let entries;
    try {
      entries = await this.#readUnchecked();
    } catch (error) {
      return { valid: false, entries: [], checkedEntries: 0, error: `Audit ledger could not be parsed: ${error.message}` };
    }
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.sequence !== index + 1 || entry.previousHash !== previousHash || entry.hash !== entryHash(entry)) {
        return { valid: false, entries: [], checkedEntries: index, error: `Audit chain validation failed at entry ${index + 1}` };
      }
      previousHash = entry.hash;
    }
    return { valid: true, entries, checkedEntries: entries.length, headHash: previousHash };
  }

  async readAll() {
    const verification = await this.verify();
    if (!verification.valid) throw new Error(verification.error);
    return verification.entries;
  }

  async append(event) {
    const [entry] = await this.appendMany([event]);
    return entry;
  }

  async appendMany(events) {
    if (!Array.isArray(events) || events.length === 0) throw new Error('At least one audit event is required');
    for (const event of events) {
      if (!event || !EVENT_TYPES.has(event.type) || typeof event.rewardId !== 'string' || !event.rewardId.trim() || !Number.isFinite(Date.parse(event.timestamp)) || !event.details || typeof event.details !== 'object') {
        throw new Error('Invalid audit event');
      }
      rejectSecrets(event);
      try {
        JSON.stringify(event.details);
      } catch {
        throw new Error('Audit event details must be JSON serializable');
      }
    }

    return this.#withLock(async () => {
      const verification = await this.verify();
      if (!verification.valid) throw new Error(verification.error);
      const entries = [...verification.entries];
      let previousHash = verification.headHash;
      const appended = [];

      for (const event of events) {
        const eventId = event.eventId ?? randomUUID();
        const existing = entries.find((entry) => entry.eventId === eventId);
        if (existing) {
          if (!sameEvent(existing, event)) throw new Error(`Audit event ID collision: ${eventId}`);
          appended.push(existing);
          continue;
        }
        const body = {
          sequence: entries.length + 1,
          eventId,
          previousHash,
          type: event.type,
          rewardId: event.rewardId,
          timestamp: new Date(event.timestamp).toISOString(),
          details: structuredClone(event.details)
        };
        const entry = { ...body, hash: entryHash(body) };
        entries.push(entry);
        appended.push(entry);
        previousHash = entry.hash;
      }

      const freshEntries = appended.filter((entry) => entry.sequence > verification.entries.length);
      if (freshEntries.length) {
        const handle = await open(this.#path, 'a', 0o600);
        try {
          await handle.writeFile(`${freshEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return appended;
    });
  }
}

export const AUDIT_EVENT_TYPES = EVENT_TYPES;