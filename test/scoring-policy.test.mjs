import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rankOpportunities, scoreOpportunity } from '../src/scoring-engine.mjs';
import { PolicyGuard, PolicyViolationError, GDAS_TASK_POLICY_TEMPLATE } from '../src/policy-guard.mjs';
import { TaskQueue } from '../src/task-queue.mjs';
import { ELIGIBILITY_OUTCOMES } from '../src/eligibility-engine.mjs';

const checkedAt = '2026-10-28T12:00:00.000Z';
const sourceEvidence = Object.freeze({
  sourceId: 'ethereum-foundation-blog',
  sourceUrl: 'https://blog.ethereum.org/en/2026/01/research-grant',
  observedAt: checkedAt,
  contentSha256: 'a'.repeat(64)
});
const evidenceIndex = Object.freeze({
  sources: {
    'ethereum-foundation-blog': { fetchedAt: checkedAt, contentSha256: 'a'.repeat(64) },
    'solana-foundation-grants': { fetchedAt: checkedAt, contentSha256: 'b'.repeat(64) }
  }
});

function eligibleDecision(outcome = ELIGIBILITY_OUTCOMES.ELIGIBLE) {
  return {
    outcome,
    lastCheckedAt: checkedAt,
    supportingSources: [{ ...sourceEvidence, sourceName: 'Ethereum Foundation Blog', url: sourceEvidence.sourceUrl }]
  };
}

function opportunity(overrides = {}) {
  return {
    id: 'opp-1',
    ...sourceEvidence,
    reward: { type: 'cash', amount: 100, currency: 'USD', transferability: 'transferable', realizable: true, evidence: sourceEvidence },
    costAssessment: { complete: true, unavoidable: [{ amount: 10, currency: 'USD', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence },
    payoutHistory: { status: 'documented', records: [{ status: 'paid', amount: 50, currency: 'USD', paidAt: checkedAt, evidence: sourceEvidence }], evidence: sourceEvidence },
    effort: { hours: 4, evidence: sourceEvidence },
    riskAssessment: { complete: true, indicators: [{ severity: 'low', label: 'Public application', evidence: sourceEvidence }], evidence: sourceEvidence },
    ...overrides
  };
}

function score(offer = opportunity(), decision = eligibleDecision(), index = evidenceIndex) {
  return scoreOpportunity({ opportunity: offer, eligibilityDecision: decision, evidenceIndex: index });
}

async function withQueue(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-queue-'));
  try {
    const path = join(directory, 'queue.json');
    await run({ directory, path, ...options });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function queueTask(overrides = {}) {
  return {
    type: 'research',
    dedupeKey: 'opportunity:opp-1:research',
    deadline: '2026-10-29T12:00:00.000Z',
    actions: ['read-public-source'],
    policy: { ...GDAS_TASK_POLICY_TEMPLATE },
    payload: { opportunityId: 'opp-1' },
    ...overrides
  };
}

test('scores use evidenced cash reward less unavoidable costs and actual paid history', () => {
  const result = score();

  assert.equal(result.valuation.rewardCategory, 'cash');
  assert.deepEqual(result.valuation.netReward, { amount: 90, currency: 'USD', status: 'positive' });
  assert.deepEqual(result.payoutHistory.totalsByCurrency, { USD: 50 });
  assert.equal(result.blockedByZeroCapitalPolicy, true);
  assert.equal(result.rankable, false);
  assert.ok(result.score > 0 && result.score <= 100);
});

test('token and non-transferable rewards are categorized without invented cash values', () => {
  const speculative = score(opportunity({ reward: { type: 'token', amount: 999999, currency: 'XYZ', transferability: 'transferable', realizable: true, evidence: sourceEvidence } }));
  const nonTransferable = score(opportunity({ reward: { type: 'points', amount: 999999, currency: 'USD', transferability: 'non-transferable', evidence: sourceEvidence } }));

  assert.equal(speculative.valuation.rewardCategory, 'speculative');
  assert.equal(speculative.valuation.netReward.amount, null);
  assert.equal(speculative.valuation.grossReward, null);
  assert.equal(nonTransferable.valuation.rewardCategory, 'non-transferable');
  assert.equal(nonTransferable.valuation.netReward.amount, null);
});

test('unsupported eligibility outcomes and mismatched evidence cannot be ranked', () => {
  const needsReview = score(opportunity(), { ...eligibleDecision(), outcome: ELIGIBILITY_OUTCOMES.NEEDS_MANUAL_REVIEW });
  const badEvidence = score(opportunity(), eligibleDecision(), { sources: {} });

  assert.equal(needsReview.score, null);
  assert.equal(needsReview.rankable, false);
  assert.equal(badEvidence.score, null);
  assert.ok(badEvidence.missingEvidence.includes('opportunity source evidence'));
});

test('positive unavoidable cost blocks rankability and currency mismatch prevents net valuation', () => {
  const costly = score(opportunity());
  const mismatch = score(opportunity({ costAssessment: { complete: true, unavoidable: [{ amount: 2, currency: 'EUR', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence } }));

  assert.equal(costly.blockedByZeroCapitalPolicy, true);
  assert.equal(costly.rankable, false);
  assert.equal(mismatch.valuation.netReward.status, 'currency-mismatch');
  assert.equal(mismatch.valuation.netReward.amount, null);
});

test('ranking places supported eligible candidates before unverified candidates', () => {
  const zeroCostAssessment = { complete: true, unavoidable: [{ amount: 0, currency: 'USD', unavoidable: true, evidence: sourceEvidence }], evidence: sourceEvidence };
  const result = rankOpportunities([
    { opportunity: opportunity({ id: 'not-eligible' }), eligibilityDecision: { ...eligibleDecision(), outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED } },
    { opportunity: opportunity({ id: 'eligible', costAssessment: zeroCostAssessment }), eligibilityDecision: eligibleDecision() }
  ], evidenceIndex);

  assert.equal(result[0].opportunityId, 'eligible');
  assert.equal(result[0].rankable, true);
  assert.equal(result[1].rankable, false);
});

test('policy guard rejects missing declarations, prohibited flags, actions, and unknown costs', async () => {
  const guard = new PolicyGuard();
  const cases = [
    {},
    queueTask({ policy: { ...GDAS_TASK_POLICY_TEMPLATE, requiresDeposit: true } }),
    queueTask({ policy: { ...GDAS_TASK_POLICY_TEMPLATE, requiresCashAdvance: false } }),
    queueTask({ actions: ['token_purchase'] }),
    queueTask({ actions: ['submit-form'] }),
    queueTask({ policy: { ...GDAS_TASK_POLICY_TEMPLATE, costs: [{ amount: null }] } })
  ];
  for (const task of cases) assert.equal(guard.inspect(task).allowed, false);
  for (const action of ['deposit', 'token-purchase', 'trade', 'paid-api', 'paid-upgrade', 'spend']) {
    assert.equal(guard.inspect(queueTask({ actions: [action] })).allowed, false);
  }
  await assert.rejects(guard.execute(queueTask({ actions: ['paid-api'] }), () => assert.fail('executor ran')), PolicyViolationError);
  assert.throws(() => guard.assertOperationAllowed('trade'), PolicyViolationError);
  assert.throws(() => guard.assertOperationAllowed('unknown-operation'), PolicyViolationError);
  await assert.rejects(guard.perform(queueTask(), 'paid-api', () => assert.fail('operation ran')), PolicyViolationError);
});

test('queue persists dedupe keys and never runs tasks blocked at admission', async () => {
  await withQueue(async ({ path }) => {
    let executions = 0;
    let idempotencyKey;
    const queue = new TaskQueue({ path, handlers: { research: async (_task, context) => { executions += 1; idempotencyKey = context.idempotencyKey; return context.perform('read-public-source', () => 'ok'); } } });
    const blocked = await queue.enqueue(queueTask({ dedupeKey: 'blocked', policy: { ...GDAS_TASK_POLICY_TEMPLATE, requiresFee: true } }));
    const first = await queue.enqueue(queueTask());
    const duplicate = await queue.enqueue(queueTask());
    assert.equal(blocked.task.state, 'blocked');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.id, first.task.id);

    const completed = await queue.processNext();
    assert.equal(completed.state, 'completed');
    assert.equal(executions, 1);
    assert.equal(idempotencyKey, first.task.dedupeKey);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.dedupeKeys['opportunity:opp-1:research'], first.task.id);
    assert.equal(persisted.tasks.find((task) => task.dedupeKey === 'blocked').state, 'blocked');
  });
});

test('queue expires tasks before execution when deadlines have elapsed', async () => {
  await withQueue(async ({ path }) => {
    let executions = 0;
    const queue = new TaskQueue({ path, handlers: { research: async () => { executions += 1; } }, now: () => new Date('2026-10-30T00:00:00.000Z') });
    await queue.enqueue(queueTask({ deadline: '2026-10-29T12:00:00.000Z' }));
    const result = await queue.processNext();
    assert.equal(result, null);
    assert.equal((await queue.list())[0].state, 'expired');
    assert.equal(executions, 0);
  });
});

test('interrupted tasks resume from their persisted checkpoint through the guard', async () => {
  await withQueue(async ({ path }) => {
    let currentTime = new Date(checkedAt);
    const firstQueue = new TaskQueue({ path, now: () => currentTime, handlers: { research: async (_task, context) => { await context.checkpoint({ cursor: 7 }); throw new Error('simulated restart'); } } });
    const enqueued = await firstQueue.enqueue(queueTask());
    const failed = await firstQueue.processNext();
    assert.equal(failed.state, 'failed');

    const data = JSON.parse(await readFile(path, 'utf8'));
    data.tasks[0].state = 'running';
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(data)));
    let observedCheckpoint;
    const resumedQueue = new TaskQueue({ path, now: () => currentTime, handlers: { research: async (_task, context) => { observedCheckpoint = context.resumeFromCheckpoint; return 'resumed'; } } });
    assert.equal(await resumedQueue.resumeInterrupted(), 0);
    currentTime = new Date(Date.parse(checkedAt) + 31_000);
    assert.equal(await resumedQueue.resumeInterrupted(), 1);
    const completed = await resumedQueue.processNext();

    assert.deepEqual(observedCheckpoint, { cursor: 7 });
    assert.equal(completed.id, enqueued.task.id);
    assert.equal(completed.state, 'completed');
  });
});

test('a live running task is not resumed before its stale-running threshold', async () => {
  await withQueue(async ({ path }) => {
    let currentTime = new Date(checkedAt);
    const firstQueue = new TaskQueue({ path, now: () => currentTime, handlers: { research: async () => 'done' } });
    await firstQueue.enqueue(queueTask());
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.tasks[0].state = 'running';
    data.tasks[0].updatedAt = checkedAt;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(data)));
    assert.equal(await firstQueue.resumeInterrupted(), 0);
    assert.equal((await firstQueue.get(data.tasks[0].id)).state, 'running');
    currentTime = new Date(Date.parse(checkedAt) + 31_000);
    assert.equal(await firstQueue.resumeInterrupted(), 1);
  });
});

test('policy is rechecked at execution and prevents handler invocation', async () => {
  await withQueue(async ({ path }) => {
    let executions = 0;
    const queue = new TaskQueue({ path, handlers: { research: async () => { executions += 1; } } });
    const enqueued = await queue.enqueue(queueTask());
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.tasks[0].task.policy.requiresPaidApi = true;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(data)));

    const blocked = await queue.processNext();
    assert.equal(blocked.state, 'blocked');
    assert.equal(executions, 0);
    assert.equal(blocked.id, enqueued.task.id);
  });
});