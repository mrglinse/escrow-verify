import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditLedger } from '../src/audit-ledger.mjs';
import { RewardTracker } from '../src/reward-tracker.mjs';
import { ReadOnlyWalletMonitor } from '../src/wallet-monitor.mjs';
import { generateDailyReport } from '../src/daily-reporter.mjs';

const day = '2026-10-28';
const at = `${day}T12:00:00.000Z`;
const hash = 'a'.repeat(64);
const evidence = { providerId: 'public-chain-rpc', reference: 'block:42', observedAt: at };

async function withLedger(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gdas-rewards-'));
  try {
    await run({ directory, path: join(directory, 'audit.jsonl'), ledger: new AuditLedger(join(directory, 'audit.jsonl')) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('reward states distinguish advertised, completed, approved, pending, confirmed, locked, transferable, speculative, and realized', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger, minimumConfirmations: 2 });
    await tracker.recordAdvertised({ rewardId: 'r1', title: 'Grant', sourceEvidence: { sourceId: 'ethereum-foundation-blog', url: 'https://blog.ethereum.org/grant', contentSha256: hash }, at });
    await tracker.recordPendingReward({ rewardId: 'r1', reason: 'Awaiting approval', evidence, at });
    await tracker.recordTaskCompleted({ rewardId: 'r1', taskId: 'task-1', evidence, at });
    await tracker.recordClaim({ rewardId: 'r1', claimId: 'claim-1', status: 'approved', evidence, at });
    await tracker.recordClaim({ rewardId: 'r2', claimId: 'claim-2', status: 'pending', evidence, at });
    await tracker.recordReceipt({ rewardId: 'r2', addressId: 'wallet-1', network: 'testnet', transactionHash: hash, assetSymbol: 'TOK', assetClass: 'token', amountAtomic: '500000', decimals: 6, confirmations: 1, evidence, at });
    const entries = await tracker.recordReceipt({ rewardId: 'r1', claimId: 'claim-1', addressId: 'wallet-1', network: 'bank', transactionHash: 'b'.repeat(64), assetSymbol: 'USD', assetClass: 'fiat', amountAtomic: '12345', decimals: 2, confirmations: 2, fee: { amountAtomic: '45', decimals: 2, assetSymbol: 'USD', payer: 'recipient' }, transferable: true, withdrawable: true, evidence, at });
    const realized = await tracker.recordRealizedProceeds({ rewardId: 'r1', receiptEventId: entries[0].eventId, at });
    await tracker.recordBalance({ rewardId: 'r3', addressId: 'wallet-1', network: 'testnet', assetSymbol: 'LOCK', assetClass: 'token', amountAtomic: '900', decimals: 2, transferable: false, lockedUntil: '2026-11-01T00:00:00.000Z', evidence, at });
    const types = (await ledger.readAll()).map((entry) => entry.type);

    for (const type of ['reward_advertised', 'reward_pending', 'task_completed', 'claim_approved', 'claim_pending', 'receipt_pending', 'asset_receipt_confirmed', 'asset_locked', 'asset_transferable', 'speculative_token', 'balance_observed', 'realized_proceeds']) {
      assert.ok(types.includes(type), `expected ledger event ${type}`);
    }
    assert.equal(realized.type, 'realized_proceeds');
    assert.equal(types.filter((type) => type === 'asset_receipt_confirmed').length, 1);
  });
});

test('realized proceeds require an actual confirmed fiat receipt, never token conversion', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger });
    await tracker.recordReceipt({ rewardId: 'token-reward', addressId: 'w1', network: 'chain', transactionHash: hash, assetSymbol: 'TOKEN', assetClass: 'token', amountAtomic: '1000', decimals: 0, confirmations: 1, evidence, at });
    const tokenReceipt = (await ledger.readAll()).find((entry) => entry.type === 'asset_receipt_confirmed');

    await assert.rejects(tracker.recordRealizedProceeds({ rewardId: 'token-reward', receiptEventId: tokenReceipt.eventId, at }), /confirmed fiat receipt/);
    await assert.rejects(tracker.recordRealizedProceeds({ rewardId: 'missing', receiptEventId: 'missing', at }), /confirmed fiat receipt/);
  });
});

test('audit ledger persists a verifiable hash chain and refuses sensitive fields', async () => {
  await withLedger(async ({ path, ledger }) => {
    await ledger.append({ type: 'reward_advertised', rewardId: 'r1', timestamp: at, details: { title: 'Grant' } });
    const verified = await ledger.verify();
    assert.equal(verified.valid, true);
    assert.equal(verified.checkedEntries, 1);
    await assert.rejects(ledger.append({ type: 'reward_advertised', rewardId: 'r2', timestamp: at, details: { seedPhrase: 'never-store' } }), /Sensitive field is forbidden/);
    await writeFile(path, `${await readFile(path, 'utf8')}tampered\n`);
    assert.equal((await ledger.verify()).valid, false);
  });
});

test('wallet monitor calls only the public read method and records pending/confirmed amounts and observed fees', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger, minimumConfirmations: 2 });
    const calls = [];
    const publicClient = {
      access: 'public-free',
      async getAddressActivity(address, options) {
        calls.push({ address, options });
        return {
          providerId: 'public-chain-rpc', reference: 'block:42',
          transactions: [
            { direction: 'received', toAddress: address, network: options.network, transactionHash: hash, assetSymbol: 'COIN', assetClass: 'crypto', amountAtomic: '2500000', decimals: 6, confirmations: 1, transferable: false, fee: { amountAtomic: '100', decimals: 6, assetSymbol: 'COIN', payer: 'sender' } },
            { direction: 'received', toAddress: address, network: options.network, transactionHash: 'c'.repeat(64), assetSymbol: 'USD', assetClass: 'fiat', amountAtomic: '2500', decimals: 2, confirmations: 4, transferable: true, withdrawable: true, fee: { amountAtomic: '25', decimals: 2, assetSymbol: 'USD', payer: 'recipient' } }
          ],
          balances: [{ assetSymbol: 'LOCK', assetClass: 'token', amountAtomic: '700', decimals: 2, transferable: false, withdrawable: false, lockedUntil: '2026-11-01T00:00:00.000Z' }]
        };
      },
    };
    const monitor = new ReadOnlyWalletMonitor({ addresses: [{ id: 'receive-1', network: 'example-chain', address: 'public-address' }], publicClient, tracker, minimumConfirmations: 2 });
    const result = await monitor.scan({ rewardId: 'r1', at });
    const entries = await ledger.readAll();

    assert.deepEqual(calls, [{ address: 'public-address', options: { network: 'example-chain' } }]);
    assert.equal(result.confirmedReceipts, 1);
    assert.equal(result.pendingReceipts, 1);
    assert.equal(result.balancesObserved, 1);
    assert.equal(entries.find((entry) => entry.type === 'asset_receipt_confirmed').details.amountAtomic, '2500');
    assert.equal(entries.find((entry) => entry.type === 'asset_receipt_confirmed').details.fee.payer, 'recipient');
    assert.equal(entries.some((entry) => 'address' in entry.details), false);
    assert.equal(entries.some((entry) => 'seedPhrase' in entry.details), false);
    assert.equal(calls.length, 1);
  });
});

test('wallet monitor rejects seed material and clients without free read-only access', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger });
    const publicClient = { access: 'public-free', getAddressActivity: async () => ({}) };
    assert.throws(() => new ReadOnlyWalletMonitor({ addresses: [{ id: 'w1', network: 'chain', address: 'public', seedPhrase: 'x' }], publicClient, tracker }), /refuses secret-bearing field/);
    assert.throws(() => new ReadOnlyWalletMonitor({ addresses: [{ id: 'w1', network: 'chain', address: 'public' }], publicClient: { ...publicClient, access: 'paid-api' }, tracker }), /free public read-only client/);
    assert.throws(() => new ReadOnlyWalletMonitor({ addresses: [{ id: 'w1', network: 'chain', address: 'public' }], publicClient: { ...publicClient, sendTransaction() {} }, tracker }), /refuses a client exposing transaction/);
  });
});

test('daily report explicitly states zero confirmed earnings and separates claims, receipts, and fees', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger });
    await tracker.recordAdvertised({ rewardId: 'r1', title: 'Grant', sourceEvidence: { sourceId: 'ethereum-foundation-blog', url: 'https://blog.ethereum.org/grant', contentSha256: hash }, at });
    await tracker.recordClaim({ rewardId: 'r1', claimId: 'c1', status: 'pending', evidence, at });
    const report = await generateDailyReport({
      date: day,
      discoverySummary: { sources: [{ id: 'ethereum-foundation-blog' }], discovered: 4, duplicates: 1, expired: 0 },
      taskResults: [{ state: 'completed', completedAt: at }, { state: 'blocked', updatedAt: at }],
      auditLedger: ledger,
      systemHealth: { discovery: 'healthy', queue: 'healthy' }
    });

    assert.match(report.summary, /Zero confirmed earnings/);
    assert.equal(report.zeroConfirmedEarnings, true);
    assert.equal(report.rewards.confirmedAssetReceipts, 0);
    assert.equal(report.rewards.pendingClaims, 1);
    assert.deepEqual(report.realizedProceedsByCurrency, {});
    assert.deepEqual(report.taskExecution, { completed: 1, failed: 0, blocked: 1, expired: 0 });
    assert.equal(report.systemHealth.status, 'healthy');
  });
});

test('a confirmed token receipt is not reported as zero earnings or realized income', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger });
    await tracker.recordReceipt({ rewardId: 'token-r', addressId: 'w1', network: 'chain', transactionHash: hash, assetSymbol: 'TOK', assetClass: 'token', amountAtomic: '1000', decimals: 0, confirmations: 3, evidence, at });
    const report = await generateDailyReport({ date: day, auditLedger: ledger });

    assert.equal(report.zeroConfirmedEarnings, false);
    assert.equal(report.rewards.confirmedAssetReceipts, 1);
    assert.equal(report.rewards.speculativeTokens, 1);
    assert.deepEqual(report.realizedProceedsByCurrency, {});
  });
});

test('receipt status advances from pending to confirmed without counting both states', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger, minimumConfirmations: 2 });
    const receipt = { rewardId: 'r1', addressId: 'w1', network: 'chain', transactionHash: hash, assetSymbol: 'COIN', assetClass: 'crypto', amountAtomic: '100', decimals: 0, evidence };
    await tracker.recordReceipt({ ...receipt, confirmations: 1, at });
    await tracker.recordReceipt({ ...receipt, confirmations: 2, at: '2026-10-28T13:00:00.000Z' });
    const report = await generateDailyReport({ date: day, auditLedger: ledger });

    assert.equal(report.rewards.pendingReceipts, 0);
    assert.equal(report.rewards.confirmedAssetReceipts, 1);
    assert.equal(report.zeroConfirmedEarnings, false);
  });
});

test('daily report reports only ledger-backed fiat proceeds and subtracts recipient-paid fees', async () => {
  await withLedger(async ({ ledger }) => {
    const tracker = new RewardTracker({ ledger });
    await tracker.recordClaim({ rewardId: 'r1', claimId: 'approved-r1', status: 'approved', evidence, at });
    const [receipt] = await tracker.recordReceipt({ rewardId: 'r1', claimId: 'approved-r1', addressId: 'w1', network: 'bank', transactionHash: hash, assetSymbol: 'USD', assetClass: 'fiat', amountAtomic: '12345', decimals: 2, confirmations: 2, transferable: true, withdrawable: true, fee: { amountAtomic: '45', decimals: 2, assetSymbol: 'USD', payer: 'recipient' }, evidence, at });
    await tracker.recordRealizedProceeds({ rewardId: 'r1', receiptEventId: receipt.eventId, at });
    const report = await generateDailyReport({ date: day, auditLedger: ledger });

    assert.equal(report.realizedProceedsByCurrency.USD, '123.45');
    assert.equal(report.netRealizedIncomeByCurrency.USD, '123');
    assert.equal(report.observedFees.USD, '0.45');
    assert.equal(report.zeroConfirmedEarnings, false);
  });
});

test('daily report does not claim zero earnings when its audit ledger is invalid', async () => {
  await withLedger(async ({ path, ledger }) => {
    await ledger.append({ type: 'reward_advertised', rewardId: 'r1', timestamp: at, details: { title: 'Grant' } });
    await writeFile(path, `${await readFile(path, 'utf8')}tampered\n`);
    const report = await generateDailyReport({ date: day, auditLedger: ledger });

    assert.equal(report.zeroConfirmedEarnings, false);
    assert.match(report.summary, /could not be verified/);
    assert.equal(report.systemHealth.status, 'degraded');
    assert.equal(report.systemHealth.auditLedgerValid, false);
  });
});