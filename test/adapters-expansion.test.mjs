import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProgramAdapterRegistry, createDefaultAdapterRegistry } from '../src/adapter-registry.mjs';
import { createSolanaGrantsAdapter } from '../src/adapters/solana-grants.mjs';
import { evaluateEligibility, ELIGIBILITY_OUTCOMES } from '../src/eligibility-engine.mjs';
import { createRegionProfile } from '../src/region-profile.mjs';
import { scoreOpportunity } from '../src/scoring-engine.mjs';

const now = new Date('2026-10-28T12:00:00.000Z');
const ethereumFeed = `<?xml version="1.0"?><rss><channel><item><title>Protocol grant announcement</title><link>https://blog.ethereum.org/en/2026/10/protocol-grant</link><description>Research grant update</description><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const solanaPage = `<html><body><h1>Grants</h1><a href="/grants-funding#developer">Developer Grants Program</a><a href="https://attacker.example/grant">Grant at another site</a><a href="/about">About</a></body></html>`;

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-adapters-'));
  try {
    await run({ directory, indexPath: join(directory, 'evidence.json'), snapshotsDirectory: join(directory, 'snapshots') });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mockResponse(url) {
  const body = url.includes('ethereum.org') ? ethereumFeed : solanaPage;
  return { ok: true, status: 200, url, text: async () => body };
}

test('default registry validates official adapters and rejects unknown or mismatched registrations', () => {
  const registry = createDefaultAdapterRegistry();
  assert.equal(registry.has('ethereum-foundation-blog'), true);
  assert.equal(registry.has('solana-foundation-grants'), true);
  assert.equal(registry.list().length, 2);
  assert.throws(() => registry.get('unregistered-source'), /No program adapter registered/);
  assert.throws(() => new ProgramAdapterRegistry().register({ sourceId: 'solana-foundation-grants', type: 'rss', parse() {} }), /does not match/);
});

test('registry dispatches both program adapters concurrently and maps exact-source evidence', async () => {
  await withStore(async ({ directory, indexPath, snapshotsDirectory }) => {
    const registry = createDefaultAdapterRegistry();
    let inFlight = 0;
    let maximumInFlight = 0;
    const result = await registry.discover({
      indexPath,
      snapshotsDirectory,
      now,
      concurrency: 2,
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'manual');
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return mockResponse(url);
      }
    });

    assert.equal(maximumInFlight, 2);
    assert.equal(result.summary.sources.length, 2);
    assert.equal(result.summary.discovered, 2);
    assert.deepEqual(result.records.map((record) => record.sourceId).sort(), ['ethereum-foundation-blog', 'solana-foundation-grants']);
    for (const id of ['ethereum-foundation-blog', 'solana-foundation-grants']) {
      const source = result.evidenceIndex.sources[id];
      const snapshot = await import('node:fs/promises').then(({ readFile }) => readFile(join(directory, source.snapshotPath), 'utf8'));
      assert.equal(source.contentSha256, hash(snapshot));
      assert.equal(source.fetchedAt, now.toISOString());
    }
    assert.equal(result.records.find((record) => record.sourceId === 'solana-foundation-grants').recordUrl, 'https://solana.org/grants-funding#developer');
  });
});

test('Solana HTML adapter drops off-host links and maps captured source evidence into eligibility and scoring', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    const adapter = createSolanaGrantsAdapter();
    const result = await adapter.discover({
      indexPath,
      snapshotsDirectory,
      now,
      fetchImpl: async (url) => mockResponse(url)
    });
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.recordUrl, 'https://solana.org/grants-funding#developer');
    const sourceEvidence = {
      sourceId: record.sourceId,
      sourceUrl: record.recordUrl,
      observedAt: record.sourceFetchedAt,
      contentSha256: record.sourceContentSha256
    };
    const rule = (values) => ({ ...values, evidence: sourceEvidence });
    const opportunity = {
      id: record.recordId,
      status: record.status,
      sourceId: record.sourceId,
      sourceUrl: record.recordUrl,
      sourceFetchedAt: record.sourceFetchedAt,
      sourceContentSha256: record.sourceContentSha256,
      availability: { status: 'open', evidence: sourceEvidence },
      expiresAt: null,
      requirements: {
        territories: rule({ allowedJurisdictions: ['US'], excludedJurisdictions: [] }),
        residency: rule({ required: true, allowedJurisdictions: ['US'], excludedJurisdictions: [] }),
        accountConstraints: rule({ accountRequired: false, allowedTypes: [], requiresStartingCapital: false, requiresDeposit: false, requiresFee: false, requiresTrading: false }),
        withdrawalRules: rule({ required: false, allowedMethods: [] }),
        automationPermissions: rule({ allowed: false })
      }
    };
    const regionProfile = createRegionProfile({
      id: 'solana-adapter-test',
      executionEnvironment: { kind: 'local', virtualRegion: 'local-only' },
      locale: 'en-US',
      timeZone: 'America/New_York',
      networkEndpoints: [{ id: 'solana-grants', role: 'source', url: 'https://solana.org/grants-funding' }]
    });
    const applicant = {
      applicationTerritory: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:territory', checkedAt: now.toISOString() },
      legalResidency: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:residency', checkedAt: now.toISOString() },
      automationPlanned: false
    };
    const decision = evaluateEligibility({ opportunity, regionProfile, applicant, evidenceIndex: result.evidenceIndex, now });
    assert.equal(decision.outcome, ELIGIBILITY_OUTCOMES.ELIGIBLE);

    const supportingSource = { ...sourceEvidence, sourceName: record.sourceName, url: record.recordUrl };
    const scored = scoreOpportunity({
      opportunity: {
        id: record.recordId,
        ...sourceEvidence,
        reward: { type: 'cash', amount: 0, currency: 'USD', transferability: 'transferable', realizable: true, evidence: sourceEvidence },
        costAssessment: { complete: true, unavoidable: [{ amount: 0, currency: 'USD', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence },
        payoutHistory: { status: 'documented', records: [], evidence: sourceEvidence },
        effort: { hours: 2, evidence: sourceEvidence },
        riskAssessment: { complete: true, indicators: [], evidence: sourceEvidence }
      },
      eligibilityDecision: { ...decision, supportingSources: [supportingSource] },
      evidenceIndex: result.evidenceIndex
    });
    assert.equal(scored.rankable, true);
    assert.equal(scored.blockedByZeroCapitalPolicy, false);
    assert.equal(scored.opportunityId, record.recordId);
  });
});

test('registry concurrency is bounded and source selection must be registered', async () => {
  await withStore(async ({ indexPath, snapshotsDirectory }) => {
    const registry = createDefaultAdapterRegistry();
    await assert.rejects(registry.discover({ sourceIds: ['unregistered'], indexPath, snapshotsDirectory, fetchImpl: async () => assert.fail('must not fetch') }), /No program adapter registered/);
    await assert.rejects(registry.discover({ sourceIds: ['solana-foundation-grants'], indexPath, snapshotsDirectory, concurrency: 9, fetchImpl: async () => mockResponse('https://solana.org/grants-funding') }), /concurrency must be an integer/);
  });
});
