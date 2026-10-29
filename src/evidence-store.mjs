import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';

const EMPTY_INDEX = Object.freeze({ schemaVersion: 1, lastRunAt: null, sources: {}, records: {} });

export class EvidenceStore {
  constructor(indexPath, snapshotsDirectory) {
    this.indexPath = resolve(indexPath);
    this.snapshotsDirectory = resolve(snapshotsDirectory);
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (data.schemaVersion !== 1 || !data.records || typeof data.records !== 'object') {
        throw new Error('Unsupported or invalid evidence index');
      }
      data.sources ??= {};
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_INDEX);
      throw error;
    }
  }

  async saveSnapshot(sourceId, extension, body, contentHash) {
    await mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 });
    const filename = `${sourceId}-${contentHash}.${extension}`;
    const absolutePath = join(this.snapshotsDirectory, filename);
    try {
      await writeFile(absolutePath, body, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return relative(dirname(this.indexPath), absolutePath);
  }

  async save(index) {
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.indexPath);
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}