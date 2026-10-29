import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSentinel } from '../src/run-sentinel.mjs';

const now = new Date('2026-10-28T12:00:00.000Z');
const feed = `<?xml version="1.0"?><rss><channel><item><title>Research grant opportunity</title><link>https://blog.ethereum.org/en/2026/10/research-grant</link><description>Published grant listing</description><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const workflow = await readFile(new URL('../.github/workflows/gdas-sentinel.yml', import.meta.url), 'utf8');
const sourceId = 'ethereum-foundation-blog';
const recordUrl = 'https://blog.ethereum.org/en/2026/10/research-grant';
const recordId = createHash('sha256').update(`${sourceId}\n${recordUrl}`).digest('hex');
const contentHash = createHash('sha256').update(feed).digest('hex');
const sourceEvidence = {
  sourceId,
  sourceUrl: recordUrl,
  observedAt: now.toISOString(),
  contentSha256: contentHash
};

function eligibleConfig() {
  const rule = (values) => ({ ...values, evidence: sourceEvidence });
  return {
    schemaVersion: 1,
    sourceIds: [sourceId],
    candidates: {
      [recordId]: {
        availability: { status: 'open', evidence: sourceEvidence },
        requirements: {
          territories: rule({ allowedJurisdictions: ['US'], excludedJurisdictions: [] }),
          residency: rule({ required: true, allowedJurisdictions: ['US'], excludedJurisdictions: [] }),
          accountConstraints: rule({ accountRequired: false, allowedTypes: [], requiresStartingCapital: false, requiresDeposit: false, requiresFee: false, requiresTrading: false }),
          withdrawalRules: rule({ required: false, allowedMethods: [] }),
          automationPermissions: rule({ allowed: false })
        },
        applicant: {
          applicationTerritory: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:territory', checkedAt: now.toISOString() },
          legalResidency: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:residency', checkedAt: now.toISOString() },
          automationPlanned: false
        },
        scoring: {
          reward: { type: 'cash', amount: 0, currency: 'USD', transferability: 'transferable', realizable: true, evidence: sourceEvidence },
          costAssessment: { complete: true, unavoidable: [{ amount: 0, currency: 'USD', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence },
          payoutHistory: { status: 'documented', records: [], evidence: sourceEvidence },
          effort: { hours: 2, evidence: sourceEvidence },
          riskAssessment: { complete: true, indicators: [], evidence: sourceEvidence }
        }
      }
    }
  };
}

async function withDirectory(run) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'gdas-sentinel-'));
  try {
    await run({ dataDirectory });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function mockFetch(url) {
  assert.equal(url, 'https://blog.ethereum.org/en/feed.xml');
  return { ok: true, status: 200, url, text: async () => feed };
}

test('headless runner completes discovery through eligibility, scoring, free task queue, and report artifacts', async () => {
  await withDirectory(async ({ dataDirectory }) => {
    let fetches = 0;
    const result = await runSentinel({
      config: eligibleConfig(),
      dataDirectory,
      now,
      fetchImpl: async (url) => { fetches += 1; return mockFetch(url); }
    });
    const artifact = JSON.parse(await readFile(result.runArtifactPath, 'utf8'));
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'));

    assert.equal(fetches, 1);
    assert.equal(result.discovery.summary.discovered, 1);
    assert.equal(result.evaluations[0].eligibilityDecision.outcome, 'ELIGIBLE');
    assert.equal(result.evaluations[0].scoringResult.rankable, true);
    assert.equal(result.enqueuedTasks.length, 1);
    assert.equal(result.enqueuedTasks[0].state, 'queued');
    assert.equal(artifact.mode, 'local-read-only');
    assert.equal(artifact.policy.outOfPocketSpend, false);
    assert.equal(artifact.policy.signing, false);
    assert.equal(artifact.policy.payoutSubmission, false);
    assert.equal(report.discovery.discovered, 1);
    assert.equal(report.taskExecution.completed, 0);
  });
});

test('missing candidate evidence fails closed to unverified with no queued task', async () => {
  await withDirectory(async ({ dataDirectory }) => {
    const result = await runSentinel({ config: { schemaVersion: 1, sourceIds: [sourceId] }, dataDirectory, now, fetchImpl: async (url) => mockFetch(url) });
    const artifact = JSON.parse(await readFile(result.runArtifactPath, 'utf8'));

    assert.equal(result.evaluations[0].eligibilityDecision.outcome, 'UNVERIFIED');
    assert.equal(result.enqueuedTasks.length, 0);
    assert.equal(artifact.evaluations[0].rankable, false);
    assert.equal(artifact.policy.outOfPocketSpend, false);
  });
});

test('fetch and configuration errors stop before run/report success artifacts', async () => {
  await withDirectory(async ({ dataDirectory }) => {
    await assert.rejects(runSentinel({ config: { sourceIds: [sourceId] }, dataDirectory, now, fetchImpl: async (url) => ({ ...mockFetch(url), ok: false, status: 503 }) }), /HTTP 503/);
    await assert.rejects(access(join(dataDirectory, 'gdas-last-run.json')));
    await assert.rejects(access(join(dataDirectory, 'reports', `${now.toISOString().slice(0, 10)}.json`)));
    await assert.rejects(runSentinel({ config: { sourceIds: ['unregistered-source'] }, dataDirectory, now, fetchImpl: async () => assert.fail('must not fetch') }), /No program adapter registered/);
  });
});

test('hourly workflow is manual-dispatchable, read-only, stateful by artifact, and does not commit data', () => {
  assert.match(workflow, /cron: '0 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run sentinel -- --data-dir data/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 7/);
  assert.doesNotMatch(workflow, /git-auto-commit|contents: write/);
});
