import { randomUUID } from 'node:crypto';

const ASSET_CLASSES = new Set(['fiat', 'crypto', 'token', 'non-transferable']);
const TX_HASH = /^(?:0x)?[a-z\d:_-]{16,128}$/i;
const INTEGER = /^\d+$/;

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('A valid event timestamp is required');
  return date.toISOString();
}

function validateAmount(amountAtomic, decimals) {
  if (typeof amountAtomic !== 'string' || !INTEGER.test(amountAtomic)) throw new Error('Asset amount must be an integer atomic-unit string');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Asset decimals must be an integer between 0 and 36');
}

export class RewardTracker {
  #ledger;
  #minimumConfirmations;

  constructor({ ledger, minimumConfirmations = 1 } = {}) {
    if (!ledger || typeof ledger.append !== 'function' || typeof ledger.appendMany !== 'function' || typeof ledger.readAll !== 'function') {
      throw new TypeError('An AuditLedger-compatible ledger is required');
    }
    if (!Number.isInteger(minimumConfirmations) || minimumConfirmations < 1) throw new Error('Minimum confirmations must be a positive integer');
    this.#ledger = ledger;
    this.#minimumConfirmations = minimumConfirmations;
  }

  async recordAdvertised({ rewardId, title, sourceEvidence, advertisedAmount = null, advertisedUnit = null, at } = {}) {
    if (!rewardId || !title || !sourceEvidence?.sourceId || !sourceEvidence?.url || !sourceEvidence?.contentSha256) throw new Error('Advertised rewards require title and source evidence');
    return this.#ledger.append({
      type: 'reward_advertised', rewardId, timestamp: timestamp(at),
      details: { title, advertisedAmount, advertisedUnit, sourceEvidence: structuredClone(sourceEvidence) }
    });
  }

  async recordPendingReward({ rewardId, reason, evidence, at } = {}) {
    if (!reason || !evidence) throw new Error('Pending rewards require a reason and evidence');
    return this.#ledger.append({ type: 'reward_pending', rewardId, timestamp: timestamp(at), details: { reason, evidence: structuredClone(evidence) } });
  }

  async recordTaskCompleted({ rewardId, taskId, evidence, at } = {}) {
    if (!taskId || !evidence) throw new Error('Task completion requires task ID and evidence');
    return this.#ledger.append({ type: 'task_completed', rewardId, timestamp: timestamp(at), details: { taskId, evidence: structuredClone(evidence) } });
  }

  async recordClaim({ rewardId, claimId, status, evidence, at } = {}) {
    if (!claimId || !['approved', 'pending'].includes(status) || !evidence) throw new Error('Claim requires ID, approved/pending status, and evidence');
    return this.#ledger.append({
      type: status === 'approved' ? 'claim_approved' : 'claim_pending',
      rewardId,
      timestamp: timestamp(at),
      details: { claimId, evidence: structuredClone(evidence) }
    });
  }

  async recordReceipt({ rewardId, addressId, network, transactionHash, assetSymbol, assetClass, amountAtomic, decimals, confirmations, claimId = null, fee = null, transferable = false, withdrawable = false, lockedUntil = null, evidence, at } = {}) {
    if (!rewardId || !addressId || !network || !TX_HASH.test(transactionHash ?? '') || !assetSymbol || !ASSET_CLASSES.has(assetClass) || !Number.isInteger(confirmations) || confirmations < 0 || (claimId !== null && typeof claimId !== 'string') || typeof transferable !== 'boolean' || typeof withdrawable !== 'boolean' || !evidence) {
      throw new Error('Receipt is missing valid read-only observation fields');
    }
    validateAmount(amountAtomic, decimals);
    if (BigInt(amountAtomic) <= 0n) throw new Error('A confirmed receipt amount must be greater than zero');
    if (withdrawable && !transferable) throw new Error('A non-transferable asset cannot be marked withdrawable');
    if (lockedUntil !== null && !Number.isFinite(Date.parse(lockedUntil))) throw new Error('Lock expiry must be a valid timestamp');
    if (fee) {
      validateAmount(fee.amountAtomic, fee.decimals);
      if (!fee.assetSymbol || !['sender', 'recipient', 'unknown'].includes(fee.payer)) throw new Error('Fee requires an asset symbol and payer classification');
    }

    const observedAt = timestamp(at);
    const transactionEvidence = structuredClone(evidence);
    const eventId = `${network}:${transactionHash.toLowerCase()}:${addressId}`;
    if (confirmations < this.#minimumConfirmations) {
      return this.#ledger.append({
        eventId: `${eventId}:pending:${observedAt}`, type: 'receipt_pending', rewardId, timestamp: observedAt,
        details: { addressId, network, transactionHash, assetSymbol, assetClass, amountAtomic, decimals, confirmations, requiredConfirmations: this.#minimumConfirmations, claimId, fee: fee ? structuredClone(fee) : null, evidence: transactionEvidence }
      });
    }

    const events = [{
      eventId: `${eventId}:confirmed:${observedAt}`, type: 'asset_receipt_confirmed', rewardId, timestamp: observedAt,
      details: { addressId, network, transactionHash, assetSymbol, assetClass, amountAtomic, decimals, confirmations, claimId, fee: fee ? structuredClone(fee) : null, evidence: transactionEvidence }
    }];
    if (assetClass === 'token') {
      events.push({ eventId: `${eventId}:speculative:${observedAt}`, type: 'speculative_token', rewardId, timestamp: observedAt, details: { addressId, network, transactionHash, assetSymbol, amountAtomic, decimals, evidence: transactionEvidence } });
    }
    if (lockedUntil && Date.parse(lockedUntil) > Date.parse(observedAt)) {
      events.push({ eventId: `${eventId}:locked:${observedAt}`, type: 'asset_locked', rewardId, timestamp: observedAt, details: { addressId, network, transactionHash, assetSymbol, amountAtomic, decimals, lockedUntil: timestamp(lockedUntil), evidence: transactionEvidence } });
    } else if (transferable) {
      events.push({ eventId: `${eventId}:transferable:${observedAt}`, type: 'asset_transferable', rewardId, timestamp: observedAt, details: { addressId, network, transactionHash, assetSymbol, amountAtomic, decimals, withdrawable, evidence: transactionEvidence } });
    }
    return this.#ledger.appendMany(events);
  }

  async recordBalance({ rewardId, addressId, network, assetSymbol, assetClass, amountAtomic, decimals, transferable, withdrawable = false, lockedUntil = null, evidence, at } = {}) {
    if (!rewardId || !addressId || !network || !assetSymbol || !ASSET_CLASSES.has(assetClass) || typeof transferable !== 'boolean' || typeof withdrawable !== 'boolean' || !evidence) {
      throw new Error('Balance observation is missing required fields');
    }
    validateAmount(amountAtomic, decimals);
    if (withdrawable && !transferable) throw new Error('A non-transferable asset cannot be marked withdrawable');
    const observedAt = timestamp(at);
    if (lockedUntil !== null && !Number.isFinite(Date.parse(lockedUntil))) throw new Error('Lock expiry must be a valid timestamp');
    const details = { addressId, network, assetSymbol, assetClass, amountAtomic, decimals, transferable, withdrawable, lockedUntil, evidence: structuredClone(evidence) };
    const events = [{ type: 'balance_observed', rewardId, timestamp: observedAt, details }];
    if (assetClass === 'token') events.push({ type: 'speculative_token', rewardId, timestamp: observedAt, details });
    if (lockedUntil && Date.parse(lockedUntil) > Date.parse(observedAt)) events.push({ type: 'asset_locked', rewardId, timestamp: observedAt, details });
    else if (transferable) events.push({ type: 'asset_transferable', rewardId, timestamp: observedAt, details });
    return this.#ledger.appendMany(events);
  }

  async recordRealizedProceeds({ rewardId, receiptEventId, at } = {}) {
    const entries = await this.#ledger.readAll();
    const receipt = entries.find((entry) => entry.eventId === receiptEventId && entry.type === 'asset_receipt_confirmed');
    const approvedClaim = receipt?.details.claimId && entries.find((entry) => entry.type === 'claim_approved' && entry.rewardId === rewardId && entry.details.claimId === receipt.details.claimId);
    if (!receipt || receipt.rewardId !== rewardId || receipt.details.assetClass !== 'fiat' || !approvedClaim) {
      throw new Error('Realized proceeds require a confirmed fiat receipt linked to an approved claim; assets are never sold or converted here');
    }
    return this.#ledger.append({
      eventId: `${receipt.eventId}:realized`,
      type: 'realized_proceeds',
      rewardId,
      timestamp: timestamp(at),
      details: { receiptEventId, currency: receipt.details.assetSymbol, amountAtomic: receipt.details.amountAtomic, decimals: receipt.details.decimals, evidence: receipt.details.evidence }
    });
  }
}