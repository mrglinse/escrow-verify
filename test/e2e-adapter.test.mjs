import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEthereumGrantsAdapter } from '../src/adapters/ethereum-grants.mjs';
import { evaluateEligibility, ELIGIBILITY_OUTCOMES } from '../src/eligibility-engine.mjs';
import { createRegionProfile, RegionProfileManager } from '../src/region-profile.mjs';
import { scoreOpportunity } from '../src/scoring-engine.mjs';
import { PolicyGuard } from '../src/policy-guard.mjs';
import { TaskQueue } from '../src/task-queue.mjs';

const now = new Date('2026-10-28T12:00:00.000Z');
const feed = `<?xml version="1.0"?><rss><channel><item><title>Research grant now open</title><link>https://blog.ethereum.org/en/2026/10/research-grant-open</link><description>Public, no-fee research grant application. Currently open for review.</description><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

test('Ethereum grant discovery to guarded execution readiness stays free and evidence-backed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-e2e-'));
  try {
    const indexPath = join(directory, 'evidence.json');
    const snapshotsDirectory = join(directory, 'snapshots');
    const queuePath = join(directory, 'tasks.json');
    const adapter = createEthereumGrantsAdapter();
    let fetchedUrl;
    const discovered = await adapter.discover({
      indexPath,
      snapshotsDirectory,
      now,
      fetchImpl: async (url, options) => {
        fetchedUrl = url;
        assert.equal(options.redirect, 'manual');
        return { ok: true, status: 200, url, text: async () => feed };
      }
    });

    assert.equal(fetchedUrl, 'https://blog.ethereum.org/en/feed.xml');
    assert.equal(discovered.summary.discovered, 1);
    assert.equal(discovered.records.length, 1);
    const record = discovered.records[0];
    const sourceEvidence = {
      sourceId: record.sourceId,
      sourceUrl: record.recordUrl,
      observedAt: record.sourceFetchedAt,
      contentSha256: record.sourceContentSha256
    };
    const profileManager = new RegionProfileManager();
    const profile = profileManager.register(createRegionProfile({
      id: 'e2e-local',
      executionEnvironment: { kind: 'local', virtualRegion: 'local-only' },
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      networkEndpoints: [{ id: 'official-feed', role: 'source', url: 'https://blog.ethereum.org/en/feed.xml' }]
    }));
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
    const applicant = {
      applicationTerritory: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:territory', checkedAt: now.toISOString() },
      legalResidency: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:residency', checkedAt: now.toISOString() },
      automationPlanned: false
    };
    const eligibilityDecision = evaluateEligibility({ opportunity, applicant, regionProfile: profile, evidenceIndex: discovered.evidenceIndex, now });
    assert.equal(eligibilityDecision.outcome, ELIGIBILITY_OUTCOMES.ELIGIBLE);

    const evidence = { ...sourceEvidence, sourceName: 'Ethereum Foundation Blog', url: record.recordUrl };
    const scoringResult = scoreOpportunity({
      opportunity: {
        id: record.recordId,
        ...sourceEvidence,
        reward: { type: 'cash', amount: 0, currency: 'USD', transferability: 'transferable', realizable: true, evidence: sourceEvidence },
        costAssessment: { complete: true, unavoidable: [{ amount: 0, currency: 'USD', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence },
        payoutHistory: { status: 'documented', records: [], evidence: sourceEvidence },
        effort: { hours: 2, evidence: sourceEvidence },
        riskAssessment: { complete: true, indicators: [], evidence: sourceEvidence }
      },
      eligibilityDecision: { ...eligibilityDecision, supportingSources: [evidence] },
      evidenceIndex: discovered.evidenceIndex
    });
    assert.equal(scoringResult.rankable, true);
    assert.equal(scoringResult.blockedByZeroCapitalPolicy, false);

    const task = adapter.prepareTask(record, { eligibilityDecision, scoringResult });
    const invokedActions = [];
    const queue = new TaskQueue({
      path: queuePath,
      policyGuard: new PolicyGuard(),
      handlers: {
        'ethereum-grant-review': async (queuedTask, context) => context.perform('read-public-source', async () => {
          invokedActions.push('read-public-source');
          return { readiness: queuedTask.payload.readiness, idempotencyKey: context.idempotencyKey };
        })
      },
      now: () => now
    });
    const enqueued = await queue.enqueue(task);
    const completed = await queue.processNext();

    assert.equal(enqueued.task.state, 'queued');
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result.readiness, 'eligible-for-human-review');
    assert.equal(completed.result.idempotencyKey, task.dedupeKey);
    assert.deepEqual(invokedActions, ['read-public-source']);
    assert.equal(task.actions.includes('submit-form'), false);
    assert.deepEqual(task.policy.costs, []);
    assert.equal(task.policy.requiresSpending, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ethereum adapter refuses ineligible, unrankable, or off-host records', () => {
  const adapter = createEthereumGrantsAdapter();
  const record = { sourceId: 'ethereum-foundation-blog', recordId: 'f'.repeat(64), recordUrl: 'https://blog.ethereum.org/grant', status: 'unverified' };

  assert.throws(() => adapter.prepareTask(record, { eligibilityDecision: { outcome: ELIGIBILITY_OUTCOMES.NEEDS_MANUAL_REVIEW }, scoringResult: { opportunityId: record.recordId, rankable: true } }), /eligible decision/);
  assert.throws(() => adapter.prepareTask(record, { eligibilityDecision: { outcome: ELIGIBILITY_OUTCOMES.ELIGIBLE }, scoringResult: { opportunityId: record.recordId, rankable: false } }), /rankable/);
  assert.throws(() => adapter.prepareTask({ ...record, recordUrl: 'https://example.net/grant' }, { eligibilityDecision: { outcome: ELIGIBILITY_OUTCOMES.ELIGIBLE }, scoringResult: { opportunityId: record.recordId, rankable: true } }), /outside its verified host/);
  assert.throws(() => adapter.prepareTask(record, {
    eligibilityDecision: { outcome: ELIGIBILITY_OUTCOMES.ELIGIBLE, supportingSources: [] },
    scoringResult: { opportunityId: record.recordId, eligibilityOutcome: ELIGIBILITY_OUTCOMES.ELIGIBLE, rankable: true, blockedByZeroCapitalPolicy: false, evidence: { opportunity: { sourceId: record.sourceId, url: record.recordUrl, contentSha256: 'a'.repeat(64) } } }
  }), /evidence must match/);
});