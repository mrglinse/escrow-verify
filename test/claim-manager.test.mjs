import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditLedger } from '../src/audit-ledger.mjs';
import { ClaimManager } from '../src/claim-manager.mjs';
import { PolicyGuard } from '../src/policy-guard.mjs';
import { RewardTracker } from '../src/reward-tracker.mjs';

const at = new Date('2026-10-28T12:00:00.000Z');
const receiptHash = 'a'.repeat(64);
const approvalReceiptHash = 'b'.repeat(64);
const txHash = 'c'.repeat(64);
const feeEvidence = { providerId: 'public-fee-estimator', reference: 'quote:network:100', observedAt: at.toISOString() };
const sponsorEvidence = { providerId: 'sponsor-registry', reference: 'sponsor:grant:fee', observedAt: at.toISOString() };
const claimEvidence = { providerId: 'program-platform', reference: 'claim:approved:001', observedAt: at.toISOString() };
const accountEvidence = { providerId: 'program-platform', reference: 'account:binding:001', observedAt: at.toISOString() };

async function withManager(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-claim-'));
  try {
    const ledger = new AuditLedger(join(directory, 'audit.jsonl'));
    const tracker = new RewardTracker({ ledger });
    const manager = new ClaimManager({
      ledger,
      policyGuard: new PolicyGuard(),
      feeLimits: { 'example-chain': '500' },
      trustedFeeProviders: ['public-fee-estimator'],
      trustedSponsorProviders: ['sponsor-registry'],
      trustedPlatformProviders: ['program-platform'],
      now: () => at,
      ...options
    });
    await run({ directory, ledger, tracker, manager });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function approvedCryptoReward(tracker) {
  await tracker.recordClaim({ rewardId: 'crypto-reward', claimId: 'claim-crypto-1', status: 'approved', evidence: claimEvidence, at });
  const [receipt] = await tracker.recordReceipt({
    rewardId: 'crypto-reward', claimId: 'claim-crypto-1', addressId: 'receiving-wallet-1', network: 'example-chain',
    transactionHash: receiptHash, assetSymbol: 'COIN', assetClass: 'crypto', amountAtomic: '10000', decimals: 0,
    confirmations: 12, transferable: true, evidence: { providerId: 'public-chain-rpc', reference: 'block:100', observedAt: at.toISOString() }, at
  });
  return receipt;
}

async function cryptoIntent(manager, receipt, overrides = {}) {
  return manager.prepareCryptoClaim({
    rewardId: 'crypto-reward',
    claimId: 'claim-crypto-1',
    receiptEventId: receipt.eventId,
    transaction: { network: 'example-chain', to: 'public-destination-reference', valueAtomic: '9000', assetSymbol: 'COIN', data: '0x' },
    feeQuote: { network: 'example-chain', providerId: 'public-fee-estimator', amountAtomic: '100', assetSymbol: 'COIN', evidence: feeEvidence },
    feeFundingSource: 'sponsor',
    feeFundingEvidence: sponsorEvidence,
    ...overrides
  });
}

function approvalFor(intent) {
  return { approved: true, intentHash: intent.intentHash, approvalReference: 'human-approval-001', approvedAt: at.toISOString() };
}

test('Pathway A prepares only an approved claim with a confirmed reward receipt and in-limit sponsored fee', async () => {
  await withManager(async ({ tracker, manager, ledger }) => {
    const receipt = await approvedCryptoReward(tracker);
    const intent = await cryptoIntent(manager, receipt);
    const entry = (await ledger.readAll()).find((item) => item.type === 'claim_intent_prepared');

    assert.equal(intent.pathway, 'crypto');
    assert.equal(intent.fee.amountAtomic, '100');
    assert.equal(intent.fee.fundingSource, 'sponsor');
    assert.equal(intent.policy.outOfPocketAmountAtomic, '0');
    assert.equal(entry.details.intentHash, intent.intentHash);
  });
});

test('Pathway A blocks unapproved rewards, missing receipts, stale/untrusted quotes, and fee-cap violations', async () => {
  await withManager(async ({ tracker, manager }) => {
    const receipt = await approvedCryptoReward(tracker);
    await assert.rejects(cryptoIntent(manager, receipt, { feeQuote: { network: 'example-chain', providerId: 'public-fee-estimator', amountAtomic: '501', assetSymbol: 'COIN', evidence: feeEvidence } }), /exceeds the configured policy limit/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeFundingSource: 'user-wallet' }), /Out-of-pocket or unknown fee funding/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeFundingEvidence: undefined }), /Fee sponsorship requires/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeFundingEvidence: { ...sponsorEvidence, providerId: 'untrusted-sponsor' } }), /trusted sponsor provider/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeFundingEvidence: { ...sponsorEvidence, observedAt: '2026-10-28T11:00:00.000Z' } }), /stale or future-dated/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeQuote: { network: 'example-chain', providerId: 'untrusted', amountAtomic: '100', assetSymbol: 'COIN', evidence: { ...feeEvidence, providerId: 'untrusted' } } }), /not from a trusted provider/);
    await assert.rejects(cryptoIntent(manager, receipt, { feeQuote: { network: 'example-chain', providerId: 'public-fee-estimator', amountAtomic: '100', assetSymbol: 'COIN', evidence: { ...feeEvidence, observedAt: '2026-10-28T11:00:00.000Z' } } }), /stale or future-dated/);
    await assert.rejects(cryptoIntent(manager, receipt, { transaction: { network: 'example-chain', to: 'public-destination-reference', valueAtomic: '9901', assetSymbol: 'COIN' }, feeFundingSource: 'reward-deducted' }), /exceed the confirmed reward amount/);
    await assert.rejects(manager.prepareCryptoClaim({ rewardId: 'crypto-reward', claimId: 'missing', receiptEventId: receipt.eventId, transaction: { network: 'example-chain', to: 'destination' }, feeQuote: { network: 'example-chain', providerId: 'public-fee-estimator', amountAtomic: '1', assetSymbol: 'COIN', evidence: feeEvidence }, feeFundingSource: 'sponsor', feeFundingEvidence: sponsorEvidence }), /matching approved claim/);

    await tracker.recordClaim({ rewardId: 'pending-receipt', claimId: 'claim-pending', status: 'approved', evidence: claimEvidence, at });
    const pending = await tracker.recordReceipt({ rewardId: 'pending-receipt', claimId: 'claim-pending', addressId: 'w1', network: 'example-chain', transactionHash: 'd'.repeat(64), assetSymbol: 'COIN', assetClass: 'crypto', amountAtomic: '1000', decimals: 0, confirmations: 0, evidence: { providerId: 'public-chain-rpc', reference: 'block:101', observedAt: at.toISOString() }, at });
    await assert.rejects(manager.prepareCryptoClaim({ rewardId: 'pending-receipt', claimId: 'claim-pending', receiptEventId: pending.eventId, transaction: { network: 'example-chain', to: 'destination' }, feeQuote: { network: 'example-chain', providerId: 'public-fee-estimator', amountAtomic: '1', assetSymbol: 'COIN', evidence: feeEvidence }, feeFundingSource: 'sponsor', feeFundingEvidence: sponsorEvidence }), /matching approved claim and confirmed crypto reward receipt/);
  });
});

test('Pathway A requires exact human approval before isolated signing and submits once', async () => {
  await withManager(async ({ tracker, manager, ledger }) => {
    const receipt = await approvedCryptoReward(tracker);
    const intent = await cryptoIntent(manager, receipt);
    let signatures = 0;
    const isolatedSigner = {
      mode: 'isolated',
      async signAndSubmit(transaction, context) {
        signatures += 1;
        assert.equal(transaction.to, 'public-destination-reference');
        assert.equal(context.intentHash, intent.intentHash);
        assert.match(context.idempotencyKey, /^claim:/);
        return { transactionHash: txHash };
      }
    };

    const denied = await manager.executeCryptoClaim({ intent, humanApproval: async () => ({ approved: false }), isolatedSigner });
    assert.equal(denied.status, 'approval-required');
    assert.equal(signatures, 0);

    const mismatchedApproval = await manager.executeCryptoClaim({ intent, humanApproval: async () => ({ ...approvalFor(intent), intentHash: 'f'.repeat(64) }), isolatedSigner });
    assert.equal(mismatchedApproval.status, 'approval-required');
    assert.equal(signatures, 0);

    const submitted = await manager.executeCryptoClaim({ intent, humanApproval: async (request) => approvalFor({ ...intent, intentHash: request.intentHash }), isolatedSigner });
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.transactionHash, txHash);
    assert.equal(signatures, 1);

    const repeated = await manager.executeCryptoClaim({ intent, humanApproval: async () => assert.fail('repeat must not request approval'), isolatedSigner });
    assert.equal(repeated.status, 'already-submitted');
    assert.equal(signatures, 1);
    assert.equal((await ledger.readAll()).filter((item) => item.type === 'claim_submission_confirmed').length, 1);
  });
});

test('Pathway A does not sign modified intents or accept a non-isolated signer', async () => {
  await withManager(async ({ tracker, manager }) => {
    const receipt = await approvedCryptoReward(tracker);
    const intent = await cryptoIntent(manager, receipt);
    const signer = { mode: 'isolated', signAndSubmit: async () => ({ transactionHash: txHash }) };
    const modified = { ...intent, transaction: { ...intent.transaction, valueAtomic: '1' } };
    await assert.rejects(manager.executeCryptoClaim({ intent: modified, humanApproval: async () => approvalFor(modified), isolatedSigner: signer }), /modified/);
    await assert.rejects(manager.executeCryptoClaim({ intent, humanApproval: async () => approvalFor(intent), isolatedSigner: { ...signer, mode: 'in-process' } }), /isolated signer/);
  });
});

test('Pathway B enforces platform minimum and requires an approved claim and opaque account binding', async () => {
  await withManager(async ({ tracker, manager, ledger }) => {
    await tracker.recordClaim({ rewardId: 'virtual-reward', claimId: 'claim-usd-1', status: 'approved', evidence: claimEvidence, at });
    const args = {
      rewardId: 'virtual-reward', claimId: 'claim-usd-1', amountAtomic: '10000', minimumPayoutAtomic: '5000',
      accountBindingReference: `binding:${'d'.repeat(64)}`,
      accountBindingEvidence: accountEvidence,
      platformEvidence: accountEvidence,
      feeAssessment: { complete: true, fees: [], evidence: accountEvidence }
    };
    const intent = await manager.prepareVirtualUsdClaim(args);
    assert.equal(intent.pathway, 'virtual-usd');
    assert.equal(intent.currency, 'USD');
    assert.equal(intent.policy.outOfPocketAmountAtomic, '0');
    assert.equal((await ledger.readAll()).filter((item) => item.type === 'virtual_usd_claim_prepared').length, 1);

    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, amountAtomic: '4999' }), /below the platform minimum/);
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, accountBindingReference: 'binding:1234567890123456' }), /opaque account binding/);
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, claimId: 'missing-claim' }), /approved claim/);
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, platformEvidence: { ...accountEvidence, providerId: 'untrusted-platform' } }), /trusted platform provider/);
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, amountAtomic: '0' }), /greater than zero/);
  });
});

test('Pathway B blocks activation, withdrawal-unlock, and every positive or unknown fee', async () => {
  await withManager(async ({ tracker, manager }) => {
    await tracker.recordClaim({ rewardId: 'virtual-reward', claimId: 'claim-usd-1', status: 'approved', evidence: claimEvidence, at });
    const args = {
      rewardId: 'virtual-reward', claimId: 'claim-usd-1', amountAtomic: '10000', minimumPayoutAtomic: '5000',
      accountBindingReference: `binding:${'d'.repeat(64)}`, accountBindingEvidence: accountEvidence, platformEvidence: accountEvidence,
      feeAssessment: { complete: true, fees: [], evidence: accountEvidence }
    };
    for (const type of ['activation', 'withdrawal-unlock', 'processing']) {
      await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, feeAssessment: { ...args.feeAssessment, fees: [{ type, amountAtomic: '1' }] } }), /fee is blocked/);
      await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, feeAssessment: { ...args.feeAssessment, fees: [{ type, amountAtomic: 'unknown' }] } }), /integer atomic-unit/);
    }
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, feeAssessment: { ...args.feeAssessment, requiresDeposit: true } }), /Unknown payout fee assessment fields/);
    await assert.rejects(manager.prepareVirtualUsdClaim({ ...args, feeAssessment: { ...args.feeAssessment, evidence: { ...accountEvidence, providerId: 'untrusted-provider' } } }), /trusted platform provider/);
  });
});

test('claim manager refuses secret material in transaction payloads and blocks zero-capital policy overrides', async () => {
  await withManager(async ({ tracker, manager }) => {
    const receipt = await approvedCryptoReward(tracker);
    await assert.rejects(cryptoIntent(manager, receipt, { transaction: { network: 'example-chain', to: 'recipient', privateKey: 'secret' } }), /Sensitive field is forbidden/);
    await assert.rejects(cryptoIntent(manager, receipt, { transaction: { network: 'example-chain', to: 'recipient', valueAtomic: '1', assetSymbol: 'COIN', data: '0xdeadbeef' } }), /plain native-asset transfers/);
  });
});