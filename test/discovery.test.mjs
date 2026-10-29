import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discover } from '../src/engine.mjs';
import { SOURCES, getSource, validateSource } from '../src/source-registry.mjs';

const rss = (expiresAt = '') => `<?xml version="1.0"?><rss><channel><item><title>Research grant opportunity</title><link>https://blog.ethereum.org/en/2026/01/research-grant</link><description>Funding for ecosystem research</description><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate>${expiresAt ? `<expiresAt>${expiresAt}</expiresAt>` : ''}</item></channel></rss>`;

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-test-'));
  try {
    await run({
      indexPath: join(directory, 'evidence.json'),
      snapshotsDirectory: join(directory, 'snapshots')
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mockFetch(body, responseUrl = SOURCES[0].url) {
  return async () => ({ ok: true, status: 200, url: responseUrl, text: async () => body });
}

test('registry accepts only the configured HTTPS host and known source IDs', () => {
  assert.equal(getSource('ethereum-foundation-blog').hostname, 'blog.ethereum.org');
  assert.throws(() => getSource('untrusted-source'), /Unknown source/);
  assert.throws(() => validateSource({ ...SOURCES[0], url: 'https://attacker.example/feed.xml' }), /not allowed/);
  assert.throws(() => validateSource({ ...SOURCES[0], url: 'http://blog.ethereum.org/feed.xml' }), /not allowed/);
});

test('duplicate items across runs retain one record and update observation timestamps', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const first = await discover({ sourceIds: ['ethereum-foundation-blog'], indexPath, snapshotsDirectory, fetchImpl: mockFetch(rss()), now });
    const second = await discover({ sourceIds: ['ethereum-foundation-blog'], indexPath, snapshotsDirectory, fetchImpl: mockFetch(rss()), now: new Date('2026-10-29T12:00:00.000Z') });
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const records = Object.values(index.records);

    assert.equal(first.discovered, 1);
    assert.equal(second.discovered, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].seenCount, 2);
    assert.equal(records[0].firstSeenAt, now.toISOString());
    assert.equal(records[0].lastSeenAt, '2026-10-29T12:00:00.000Z');
    assert.match(records[0].sourceContentSha256, /^[a-f0-9]{64}$/);
  });
});

test('offers with an explicit past expiry are recorded as expired', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    const result = await discover({
      sourceIds: ['ethereum-foundation-blog'],
      indexPath,
      snapshotsDirectory,
      fetchImpl: mockFetch(rss('2026-10-27T00:00:00.000Z')),
      now: new Date('2026-10-28T12:00:00.000Z')
    });
    const index = JSON.parse(await readFile(indexPath, 'utf8'));

    assert.equal(result.expired, 1);
    assert.equal(Object.values(index.records)[0].status, 'expired');
  });
});

test('a source response redirected outside its verified host is rejected', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    await assert.rejects(discover({
      sourceIds: ['ethereum-foundation-blog'],
      indexPath,
      snapshotsDirectory,
      fetchImpl: mockFetch(rss(), 'https://attacker.example/feed.xml')
    }), /outside its verified host/);
  });
});

test('a streamed source response larger than the configured cap is rejected', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    const fetchImpl = async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 200 });
    await assert.rejects(discover({
      sourceIds: ['ethereum-foundation-blog'],
      indexPath,
      snapshotsDirectory,
      fetchImpl
    }), /exceeded the 2097152-byte limit/);
  });
});

test('source fetch evidence is persisted even when no candidates match', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    await discover({
      sourceIds: ['ethereum-foundation-blog'],
      indexPath,
      snapshotsDirectory,
      fetchImpl: mockFetch('<rss><channel></channel></rss>'),
      now: new Date('2026-10-28T12:00:00.000Z')
    });
    const index = JSON.parse(await readFile(indexPath, 'utf8'));

    assert.equal(index.sources['ethereum-foundation-blog'].fetchedAt, '2026-10-28T12:00:00.000Z');
    assert.equal(index.sources['ethereum-foundation-blog'].candidateCount, 0);
    assert.match(index.sources['ethereum-foundation-blog'].contentSha256, /^[a-f0-9]{64}$/);
  });
});