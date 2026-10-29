import { createEthereumGrantsAdapter } from './adapters/ethereum-grants.mjs';
import { createSolanaGrantsAdapter } from './adapters/solana-grants.mjs';
import { discover as runDiscovery } from './engine.mjs';
import { EvidenceStore } from './evidence-store.mjs';
import { getSource } from './source-registry.mjs';

export class ProgramAdapterRegistry {
  #adapters = new Map();

  register(adapter) {
    if (!adapter || typeof adapter !== 'object' || typeof adapter.sourceId !== 'string' || typeof adapter.parse !== 'function') {
      throw new TypeError('Program adapter requires a registered sourceId and parse function');
    }
    const source = getSource(adapter.sourceId);
    if (adapter.type !== source.type) throw new Error(`Adapter type ${adapter.type} does not match registered source ${source.id} type ${source.type}`);
    if (this.#adapters.has(adapter.sourceId)) throw new Error(`Adapter already registered for source ${adapter.sourceId}`);
    this.#adapters.set(adapter.sourceId, Object.freeze(adapter));
    return this;
  }

  get(sourceId) {
    const adapter = this.#adapters.get(sourceId);
    if (!adapter) throw new Error(`No program adapter registered for source ${sourceId}`);
    return adapter;
  }

  has(sourceId) {
    return this.#adapters.has(sourceId);
  }

  list() {
    return [...this.#adapters.values()];
  }

  adapterMap(sourceIds = this.#adapters.keys()) {
    return new Map([...sourceIds].map((sourceId) => [sourceId, this.get(sourceId)]));
  }

  async discover({
    sourceIds = [...this.#adapters.keys()],
    indexPath = 'data/gdas-evidence.json',
    snapshotsDirectory = 'data/snapshots',
    fetchImpl = globalThis.fetch,
    now = new Date(),
    concurrency = 2
  } = {}) {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) throw new Error('At least one registered source ID is required');
    for (const sourceId of sourceIds) this.get(sourceId);
    const summary = await runDiscovery({
      sourceIds,
      indexPath,
      snapshotsDirectory,
      fetchImpl,
      now,
      concurrency,
      adapters: this.adapterMap(sourceIds)
    });
    const evidenceIndex = await new EvidenceStore(indexPath, snapshotsDirectory).load();
    const records = Object.values(evidenceIndex.records)
      .filter((record) => sourceIds.includes(record.sourceId) && record.lastSeenAt === now.toISOString())
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
    return { summary, records, evidenceIndex };
  }
}

export function createDefaultAdapterRegistry() {
  return new ProgramAdapterRegistry()
    .register(createEthereumGrantsAdapter())
    .register(createSolanaGrantsAdapter());
}
