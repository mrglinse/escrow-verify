import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const scriptSource = await readFile(new URL('../assets/gdas-dashboard.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../gateway.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../assets/gdas-dashboard.css', import.meta.url), 'utf8');

function loadDashboard() {
  const sandbox = { module: { exports: {} }, crypto: webcrypto, TextEncoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(scriptSource, sandbox, { filename: 'gdas-dashboard.js' });
  return sandbox.module.exports;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('dashboard model reports explicit zero earnings for an empty verified ledger', () => {
  const dashboard = loadDashboard();
  const model = dashboard.buildDashboardModel({ ledgerIntegrity: { valid: true, checkedEntries: 0 } });

  assert.equal(model.zeroConfirmedEarnings, true);
  assert.equal(model.confirmedReceipts.length, 0);
  assert.equal(model.pendingClaims.length, 0);
  assert.equal(model.realizedTotal, '$0');
  assert.equal(model.imported, true);
});

test('dashboard derives latest receipt state, claims, speculative assets, and realized totals', () => {
  const dashboard = loadDashboard();
  const entries = [
    { type: 'receipt_pending', rewardId: 'r1', details: { network: 'chain', transactionHash: 'tx-1234567890123456', addressId: 'w1' } },
    { type: 'asset_receipt_confirmed', rewardId: 'r1', details: { network: 'chain', transactionHash: 'tx-1234567890123456', addressId: 'w1' } },
    { type: 'claim_pending', rewardId: 'r1', details: { claimId: 'claim-1' } },
    { type: 'speculative_token', rewardId: 'r2', details: { network: 'chain', transactionHash: 'tx-token-12345678', addressId: 'w1', assetSymbol: 'TOK' } },
    { type: 'realized_proceeds', rewardId: 'r1', details: { currency: 'USD', amountAtomic: '12345', decimals: 2 } }
  ];
  const model = dashboard.buildDashboardModel({ ledgerEntries: entries, ledgerIntegrity: { valid: true, checkedEntries: entries.length } });

  assert.equal(model.confirmedReceipts.length, 1);
  assert.equal(model.pendingReceipts.length, 0);
  assert.equal(model.pendingClaims.length, 1);
  assert.equal(model.speculativeTokens.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(model.realizedProceeds)), { USD: '123.45' });
  assert.equal(model.zeroConfirmedEarnings, false);
});

test('dashboard withholds imported ledger figures when integrity verification fails', () => {
  const dashboard = loadDashboard();
  const entries = [{ type: 'asset_receipt_confirmed', details: { network: 'n', transactionHash: 'tx-1234567890123456', addressId: 'w' } }];
  const model = dashboard.buildDashboardModel({ ledgerEntries: entries, ledgerIntegrity: { valid: false, error: 'tampered' } });

  assert.equal(model.confirmedReceipts.length, 0);
  assert.equal(model.zeroConfirmedEarnings, false);
  assert.equal(model.integrityValid, false);
});

test('browser ledger verifier accepts a valid hash chain and rejects tampering', async () => {
  const dashboard = loadDashboard();
  const body = { sequence: 1, eventId: 'e1', previousHash: '0'.repeat(64), type: 'claim_approved', rewardId: 'r1', timestamp: '2026-10-28T00:00:00.000Z', details: { claimId: 'c1' } };
  const entry = { ...body, hash: createHash('sha256').update(canonical(body)).digest('hex') };

  assert.equal((await dashboard.verifyLedger([entry])).valid, true);
  assert.equal((await dashboard.verifyLedger([{ ...entry, details: { claimId: 'changed' } }])).valid, false);
});

test('human approval dispatch raises a local review event but does not approve or sign', () => {
  const dashboard = loadDashboard();
  let observed;
  const target = {
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent(event) { observed = event; return true; }
  };
  dashboard.approvalRequest(target, { intentHash: 'a'.repeat(64), pathway: 'crypto' });

  assert.equal(observed.type, 'gdas:human-approval-requested');
  assert.equal(observed.detail.intentHash, 'a'.repeat(64));
  assert.equal(observed.detail.approved, undefined);
});

test('dashboard escapes imported text and uses local assets without remote API calls', () => {
  const dashboard = loadDashboard();
  assert.equal(dashboard.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.match(htmlSource, /assets\/gdas-dashboard\.css/);
  assert.match(htmlSource, /assets\/gdas-dashboard\.js/);
  assert.doesNotMatch(htmlSource, /https?:\/\//);
  assert.doesNotMatch(scriptSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.match(htmlSource, /Zero confirmed earnings/);
  assert.match(htmlSource, /Request human review/);
  assert.match(cssSource, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(cssSource, /^\+/m);
});
