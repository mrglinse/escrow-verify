import { createHash } from 'node:crypto';
import { PolicyGuard, GDAS_TASK_POLICY_TEMPLATE } from './policy-guard.mjs';

const INTEGER = /^\d+$/;
const TRANSACTION_HASH = /^[a-z\d:_-]{16,160}$/i;
const REFERENCE = /^[a-z\d][a-z\d._:-]{7,127}$/i;
const ACCOUNT_BINDING_REFERENCE = /^binding:[a-f\d]{64}$/i;
const SECRET_KEY = /(seed|mnemonic|private.?key|passphrase|password|credential|api.?key|secret|access.?token)/i;
const ZERO_COST_POLICY = Object.freeze({ ...GDAS_TASK_POLICY_TEMPLATE, costs: Object.freeze([]) });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function rejectSecrets(value, location = 'claim') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`Sensitive field is forbidden in claim data: ${location}.${key}`);
    rejectSecrets(child, `${location}.${key}`);
  }
}

function atomic(value, label) {
  if (typeof value !== 'string' || !INTEGER.test(value)) throw new Error(`${label} must be an integer atomic-unit string`);
  return BigInt(value);
}

function isoDate(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function assertEvidence(evidence, label) {
  if (!evidence || typeof evidence !== 'object' || typeof evidence.providerId !== 'string' || !/^[a-z\d._-]{1,80}$/i.test(evidence.providerId) || typeof evidence.reference !== 'string' || !/^[a-z\d._:/-]{1,256}$/i.test(evidence.reference) || !evidence.observedAt) {
    throw new Error(`${label} requires a provider, reference, and observation timestamp`);
  }
  return { providerId: evidence.providerId, reference: evidence.reference, observedAt: isoDate(evidence.observedAt, `${label} timestamp`) };
}

function policyTask() {
  return { actions: ['free-task'], policy: { ...ZERO_COST_POLICY } };
}

function amountWithinFeeLimit(feeAmount, feeLimit) {
  return feeAmount <= atomic(feeLimit, 'Configured maximum network fee');
}

export class ClaimManager {
  #ledger;
  #policyGuard;
  #feeLimits;
  #trustedFeeProviders;
  #trustedSponsorProviders;
  #trustedPlatformProviders;
  #now;
  #maxFeeQuoteAgeMs;

  constructor({ ledger, policyGuard = new PolicyGuard(), feeLimits = {}, trustedFeeProviders = [], trustedSponsorProviders = [], trustedPlatformProviders = [], now = () => new Date(), maxFeeQuoteAgeMs = 120_000 } = {}) {
    if (!ledger || typeof ledger.readAll !== 'function' || typeof ledger.append !== 'function') throw new TypeError('An AuditLedger-compatible ledger is required');
    if (!(policyGuard instanceof PolicyGuard)) throw new TypeError('A PolicyGuard is required');
    if (!Array.isArray(trustedFeeProviders) || !Array.isArray(trustedSponsorProviders) || !Array.isArray(trustedPlatformProviders) || !Number.isFinite(maxFeeQuoteAgeMs) || maxFeeQuoteAgeMs <= 0) throw new Error('Provider allowlists and quote age limit are required');
    this.#ledger = ledger;
    this.#policyGuard = policyGuard;
    this.#feeLimits = Object.freeze({ ...feeLimits });
    this.#trustedFeeProviders = new Set(trustedFeeProviders);
    this.#trustedSponsorProviders = new Set(trustedSponsorProviders);
    this.#trustedPlatformProviders = new Set(trustedPlatformProviders);
    this.#now = now;
    this.#maxFeeQuoteAgeMs = maxFeeQuoteAgeMs;
  }

  async #verifiedEntries() {
    const verification = await this.#ledger.verify();
    if (!verification.valid) throw new Error(`Claim actions blocked: audit ledger invalid (${verification.error})`);
    return verification.entries;
  }

  #approvedClaim(entries, rewardId, claimId) {
    return entries.find((entry) => entry.type === 'claim_approved' && entry.rewardId === rewardId && entry.details.claimId === claimId);
  }

  #assertPolicy() {
    const decision = this.#policyGuard.inspect(policyTask());
    if (!decision.allowed) throw new Error(`Zero-capital policy blocked claim: ${decision.reasons.join(', ')}`);
    return policyTask();
  }

  async prepareCryptoClaim({ rewardId, claimId, receiptEventId, transaction, feeQuote, feeFundingSource, feeFundingEvidence } = {}) {
    if (!rewardId || !claimId || !receiptEventId || !transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw new Error('Crypto claim requires reward, claim, receipt, and unsigned transaction details');
    rejectSecrets(transaction, 'transaction');
    const entries = await this.#verifiedEntries();
    const approvedClaim = this.#approvedClaim(entries, rewardId, claimId);
    const receipt = entries.find((entry) => entry.eventId === receiptEventId && entry.type === 'asset_receipt_confirmed');
    if (!approvedClaim || !receipt || receipt.rewardId !== rewardId || receipt.details.claimId !== claimId || !['crypto', 'token'].includes(receipt.details.assetClass)) {
      throw new Error('Crypto claim requires a matching approved claim and confirmed crypto reward receipt');
    }
    if (transaction.network !== receipt.details.network || typeof transaction.to !== 'string' || !transaction.to.trim()) {
      throw new Error('Unsigned transaction must target the confirmed reward network and a destination');
    }
    if (Object.keys(transaction).some((key) => !['network', 'to', 'valueAtomic', 'assetSymbol', 'data'].includes(key)) || (transaction.data !== undefined && transaction.data !== '0x')) {
      throw new Error('Only plain native-asset transfers are supported; contract calls and unknown transaction fields are blocked');
    }
    if (transaction.assetSymbol !== receipt.details.assetSymbol) throw new Error('Transaction asset must match the confirmed reward asset');
    const transactionValue = atomic(transaction.valueAtomic, 'Transaction value');
    if (transactionValue > BigInt(receipt.details.amountAtomic)) throw new Error('Transaction value exceeds the confirmed reward amount');
    const feeEvidence = assertEvidence(feeQuote?.evidence, 'Network fee quote');
    if (!feeQuote || feeQuote.network !== receipt.details.network || !this.#trustedFeeProviders.has(feeQuote.providerId) || feeQuote.evidence.providerId !== feeQuote.providerId || feeQuote.assetSymbol !== receipt.details.assetSymbol) {
      throw new Error('Network fee quote is not from a trusted provider for the confirmed reward asset/network');
    }
    const quoteTime = Date.parse(feeEvidence.observedAt);
    const now = this.#now();
    if (quoteTime > now.getTime() || now.getTime() - quoteTime > this.#maxFeeQuoteAgeMs) throw new Error('Network fee quote is stale or future-dated');
    const feeAmount = atomic(feeQuote.amountAtomic, 'Quoted network fee');
    const feeLimit = this.#feeLimits[receipt.details.network];
    if (feeLimit === undefined || !amountWithinFeeLimit(feeAmount, feeLimit)) throw new Error('Network fee exceeds the configured policy limit');
    if (!['sponsor', 'reward-deducted'].includes(feeFundingSource)) throw new Error('Out-of-pocket or unknown fee funding is blocked');
    const fundingEvidence = feeFundingSource === 'sponsor' ? assertEvidence(feeFundingEvidence, 'Fee sponsorship') : null;
    if (feeFundingSource === 'sponsor' && !this.#trustedSponsorProviders.has(fundingEvidence.providerId)) throw new Error('Fee sponsorship evidence is not from a trusted sponsor provider');
    if (fundingEvidence) {
      const age = now.getTime() - Date.parse(fundingEvidence.observedAt);
      if (age < 0 || age > this.#maxFeeQuoteAgeMs) throw new Error('Fee sponsorship evidence is stale or future-dated');
    }

    if (feeFundingSource === 'reward-deducted') {
      if (feeQuote.assetSymbol !== receipt.details.assetSymbol || transactionValue + feeAmount > BigInt(receipt.details.amountAtomic)) {
        throw new Error('Reward-deducted fee and transaction value exceed the confirmed reward amount');
      }
    }

    const safeTransaction = structuredClone(transaction);
    const intent = {
      pathway: 'crypto', rewardId, claimId, receiptEventId,
      network: receipt.details.network,
      recipientReference: hash(transaction.to),
      transaction: safeTransaction,
      fee: { amountAtomic: feeAmount.toString(), assetSymbol: feeQuote.assetSymbol, fundingSource: feeFundingSource, providerId: feeQuote.providerId, evidence: feeEvidence, fundingEvidence },
      policy: { outOfPocketAmountAtomic: '0', requiresDeposit: false, requiresFee: false },
      preparedAt: now.toISOString()
    };
    intent.intentHash = hash({ ...intent, transaction: safeTransaction });
    this.#assertPolicy();
    await this.#ledger.append({
      eventId: `claim-intent:${intent.intentHash}`,
      type: 'claim_intent_prepared', rewardId, timestamp: intent.preparedAt,
      details: { claimId, receiptEventId, intentHash: intent.intentHash, network: intent.network, recipientReference: intent.recipientReference, fee: intent.fee, policy: intent.policy }
    });
    return Object.freeze(intent);
  }

  async executeCryptoClaim({ intent, humanApproval, isolatedSigner } = {}) {
    if (!intent || intent.pathway !== 'crypto' || typeof humanApproval !== 'function') throw new Error('Crypto execution requires a prepared intent and explicit human approval callback');
    if (!isolatedSigner || isolatedSigner.mode !== 'isolated' || typeof isolatedSigner.signAndSubmit !== 'function' || Object.keys(isolatedSigner).some((key) => !['mode', 'signAndSubmit'].includes(key))) {
      throw new Error('An isolated signer exposing only signAndSubmit is required');
    }
    rejectSecrets(intent, 'intent');
    const { intentHash, ...intentBody } = intent;
    const expectedHash = hash(intentBody);
    if (expectedHash !== intent.intentHash) throw new Error('Prepared crypto claim was modified after approval details were created');
    const entries = await this.#verifiedEntries();
    if (!this.#approvedClaim(entries, intent.rewardId, intent.claimId) || !entries.some((entry) => entry.eventId === intent.receiptEventId && entry.type === 'asset_receipt_confirmed' && entry.rewardId === intent.rewardId && entry.details.claimId === intent.claimId)) {
      throw new Error('Crypto claim approval or confirmed receipt is no longer valid');
    }
    const alreadySubmitted = entries.find((entry) => entry.type === 'claim_submission_confirmed' && entry.details.intentHash === intent.intentHash);
    if (alreadySubmitted) return { status: 'already-submitted', transactionHash: alreadySubmitted.details.transactionHash, intentHash: intent.intentHash };
    const priorRequest = entries.find((entry) => entry.type === 'claim_submission_requested' && entry.details.intentHash === intent.intentHash);
    if (priorRequest) throw new Error('Submission outcome is already pending/uncertain; automatic retry is blocked');

    const approval = await humanApproval({
      intentHash: intent.intentHash,
      rewardId: intent.rewardId,
      claimId: intent.claimId,
      network: intent.network,
      recipientReference: intent.recipientReference,
      amountAtomic: intent.transaction.valueAtomic,
      assetSymbol: intent.transaction.assetSymbol,
      fee: intent.fee,
      outOfPocketAmountAtomic: '0'
    });
    if (!approval || approval.approved !== true || approval.intentHash !== intent.intentHash || typeof approval.approvalReference !== 'string' || !REFERENCE.test(approval.approvalReference)) {
      await this.#ledger.append({
        eventId: `claim-rejected:${intent.intentHash}`,
        type: 'claim_human_rejected', rewardId: intent.rewardId, timestamp: this.#now().toISOString(),
        details: { claimId: intent.claimId, intentHash: intent.intentHash, reason: 'Missing, denied, or mismatched human approval' }
      });
      return { status: 'approval-required', intentHash: intent.intentHash };
    }
    const approvedAt = isoDate(approval.approvedAt, 'Human approval timestamp');
    if (Date.parse(approvedAt) > this.#now().getTime()) throw new Error('Human approval timestamp is in the future');

    this.#assertPolicy();
    const idempotencyKey = `claim:${intent.rewardId}:${intent.claimId}:${intent.intentHash}`;
    await this.#ledger.append({
      eventId: `claim-requested:${intent.intentHash}`,
      type: 'claim_submission_requested', rewardId: intent.rewardId, timestamp: this.#now().toISOString(),
      details: { claimId: intent.claimId, intentHash: intent.intentHash, approvalReference: approval.approvalReference, idempotencyKey }
    });
    try {
      const task = policyTask();
      const result = await this.#policyGuard.execute(task, () => isolatedSigner.signAndSubmit(structuredClone(intent.transaction), { intentHash: intent.intentHash, approvalReference: approval.approvalReference, idempotencyKey }));
      if (!result || typeof result.transactionHash !== 'string' || !TRANSACTION_HASH.test(result.transactionHash)) throw new Error('Isolated signer returned no valid transaction hash');
      await this.#ledger.append({
        eventId: `claim-submitted:${intent.intentHash}`,
        type: 'claim_submission_confirmed', rewardId: intent.rewardId, timestamp: this.#now().toISOString(),
        details: { claimId: intent.claimId, intentHash: intent.intentHash, transactionHash: result.transactionHash, network: intent.network, approvalReference: approval.approvalReference }
      });
      return { status: 'submitted', transactionHash: result.transactionHash, intentHash: intent.intentHash };
    } catch (error) {
      await this.#ledger.append({
        eventId: `claim-uncertain:${intent.intentHash}`,
        type: 'claim_submission_uncertain', rewardId: intent.rewardId, timestamp: this.#now().toISOString(),
        details: { claimId: intent.claimId, intentHash: intent.intentHash, error: error instanceof Error ? error.message : String(error), approvalReference: approval.approvalReference }
      });
      return { status: 'submission-uncertain', intentHash: intent.intentHash };
    }
  }

  async prepareVirtualUsdClaim({ rewardId, claimId, amountAtomic, minimumPayoutAtomic, accountBindingReference, accountBindingEvidence, platformEvidence, feeAssessment } = {}) {
    if (!rewardId || !claimId || !ACCOUNT_BINDING_REFERENCE.test(accountBindingReference ?? '')) throw new Error('Virtual USD claim requires an approved claim and opaque account binding reference');
    const amount = atomic(amountAtomic, 'Virtual USD claim amount');
    const minimum = atomic(minimumPayoutAtomic, 'Platform minimum payout');
    if (amount <= 0n) throw new Error('Virtual USD claim amount must be greater than zero');
    if (amount < minimum) throw new Error('Virtual USD claim is below the platform minimum payout threshold');
    const evidence = assertEvidence(platformEvidence, 'Platform payout terms');
    const bindingEvidence = assertEvidence(accountBindingEvidence, 'Account binding');
    if (!this.#trustedPlatformProviders.has(evidence.providerId) || !this.#trustedPlatformProviders.has(bindingEvidence.providerId)) throw new Error('Platform terms and account binding require a trusted platform provider');
    if (!feeAssessment || feeAssessment.complete !== true || !Array.isArray(feeAssessment.fees) || !feeAssessment.evidence) {
      throw new Error('Virtual USD payout requires a complete evidence-backed fee assessment');
    }
    const feeEvidence = assertEvidence(feeAssessment.evidence, 'Payout fee assessment');
    if (!this.#trustedPlatformProviders.has(feeEvidence.providerId)) throw new Error('Payout fee assessment requires a trusted platform provider');
    if (Object.keys(feeAssessment).some((key) => !['complete', 'fees', 'evidence'].includes(key))) throw new Error('Unknown payout fee assessment fields are blocked');
    for (const fee of feeAssessment.fees) {
      if (Object.keys(fee).some((key) => !['type', 'amountAtomic'].includes(key))) throw new Error('Unknown payout fee fields are blocked');
      if (!fee || !['activation', 'withdrawal-unlock', 'processing', 'network', 'other'].includes(fee.type) || typeof fee.amountAtomic !== 'string' || atomic(fee.amountAtomic, 'Payout fee') !== 0n) {
        throw new Error('Activation, withdrawal-unlock, or any positive/unknown payout fee is blocked by zero-capital policy');
      }
    }
    const entries = await this.#verifiedEntries();
    if (!this.#approvedClaim(entries, rewardId, claimId)) throw new Error('Virtual USD pathway requires an approved claim');
    const policy = this.#assertPolicy();
    const preparedAt = this.#now().toISOString();
    const intent = {
      pathway: 'virtual-usd', rewardId, claimId,
      amountAtomic: amount.toString(), minimumPayoutAtomic: minimum.toString(), currency: 'USD',
      accountBindingReference,
      accountBindingEvidence: bindingEvidence,
      platformEvidence: evidence,
      feeAssessment: { complete: true, fees: feeAssessment.fees.map((fee) => ({ type: fee.type, amountAtomic: fee.amountAtomic })), evidence: feeEvidence },
      policy: { outOfPocketAmountAtomic: '0', requiresDeposit: false, requiresFee: false },
      preparedAt
    };
    intent.intentHash = hash(intent);
    await this.#ledger.append({
      eventId: `virtual-usd-claim:${intent.intentHash}`,
      type: 'virtual_usd_claim_prepared', rewardId, timestamp: preparedAt,
      details: { claimId, intentHash: intent.intentHash, amountAtomic: intent.amountAtomic, minimumPayoutAtomic: intent.minimumPayoutAtomic, accountBindingReference, accountBindingEvidence: bindingEvidence, platformEvidence: evidence, feeAssessment: intent.feeAssessment, policy: intent.policy, guardAction: policy.actions[0] }
    });
    return Object.freeze(intent);
  }
}