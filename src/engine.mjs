import { SOURCES, getSource, validateSourceUrl } from './source-registry.mjs';
import { createAdapterRegistry } from './adapters.mjs';
import { EvidenceStore, sha256 } from './evidence-store.mjs';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

async function readBoundedBody(response, sourceId) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error(`Source ${sourceId} exceeded the ${MAX_SOURCE_BYTES}-byte limit`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error(`Source ${sourceId} exceeded the ${MAX_SOURCE_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function offerStatus(expiresAt, now) {
  if (!expiresAt) return 'unverified';
  return new Date(expiresAt).getTime() <= now.getTime() ? 'expired' : 'unverified';
}

async function fetchSource({ source, adapter, fetchImpl, store, now }) {
  if (!adapter || typeof adapter.parse !== 'function') {
    throw new Error(`No valid adapter registered for source ${source.id}`);
  }
  const response = await fetchImpl(source.url, {
    headers: { accept: source.type === 'rss' ? 'application/rss+xml, application/xml, text/xml' : 'text/html' },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Source ${source.id} returned HTTP ${response.status}`);
  validateSourceUrl(source, response.url || source.url);
  const body = await readBoundedBody(response, source.id);
  const contentHash = sha256(body);
  const snapshotPath = await store.saveSnapshot(source.id, source.type === 'rss' ? 'xml' : 'html', body, contentHash);
  const parsedEntries = adapter.parse(body, source, source.url).map((entry) => ({
    entry,
    recordUrl: validateSourceUrl(source, entry.url).href
  }));
  return { source, contentHash, snapshotPath, parsedEntries };
}

export async function discover({
  sourceIds = SOURCES.map((source) => source.id),
  indexPath = 'data/gdas-evidence.json',
  snapshotsDirectory = 'data/snapshots',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  adapters = createAdapterRegistry(),
  concurrency = 2
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible implementation is required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Discovery concurrency must be an integer from 1 to 8');

  const store = new EvidenceStore(indexPath, snapshotsDirectory);
  const index = await store.load();
  const sourcesToFetch = sourceIds.map((sourceId) => {
    const source = getSource(sourceId);
    const adapter = adapters.get(source.id) ?? adapters.get(source.type);
    return { source, adapter };
  });
  const fetchedSources = new Array(sourcesToFetch.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, sourcesToFetch.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < sourcesToFetch.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      fetchedSources[currentIndex] = await fetchSource({ ...sourcesToFetch[currentIndex], fetchImpl, store, now });
    }
  }));

  const summary = { runAt: now.toISOString(), sources: [], discovered: 0, duplicates: 0, expired: 0 };
  for (const result of fetchedSources) {
    const { source, contentHash, snapshotPath, parsedEntries } = result;
    index.sources[source.id] = {
      url: source.url,
      fetchedAt: now.toISOString(),
      contentSha256: contentHash,
      snapshotPath,
      candidateCount: parsedEntries.length
    };
    let sourceDiscovered = 0;
    let sourceDuplicates = 0;

    for (const { entry, recordUrl } of parsedEntries) {
      const recordId = sha256(`${source.id}\n${recordUrl}`);
      const previous = index.records[recordId];
      if (previous) sourceDuplicates += 1;

      const record = {
        recordId,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        recordUrl,
        title: entry.title,
        summary: entry.summary,
        publishedAt: entry.publishedAt,
        expiresAt: entry.expiresAt,
        status: offerStatus(entry.expiresAt, now),
        firstSeenAt: previous?.firstSeenAt ?? now.toISOString(),
        lastSeenAt: now.toISOString(),
        seenCount: (previous?.seenCount ?? 0) + 1,
        sourceFetchedAt: now.toISOString(),
        sourceContentSha256: contentHash,
        snapshotPath
      };

      if (record.status === 'expired') summary.expired += 1;
      if (!previous) {
        summary.discovered += 1;
        sourceDiscovered += 1;
      }
      index.records[recordId] = record;
    }

    summary.duplicates += sourceDuplicates;
    summary.sources.push({ id: source.id, fetchedAt: now.toISOString(), records: sourceDiscovered, duplicates: sourceDuplicates, snapshotPath });
  }

  index.lastRunAt = now.toISOString();
  await store.save(index);
  return summary;
}