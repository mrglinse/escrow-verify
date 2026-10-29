import { getSource, validateSourceUrl } from './source-registry.mjs';
import { ELIGIBILITY_OUTCOMES } from './eligibility-engine.mjs';

const MAX_SCORE = 100;

function verifiedEvidence(reference, evidenceIndex) {
  if (!reference || typeof reference !== 'object') return null;
  try {
    const source = getSource(reference.sourceId);
    const url = validateSourceUrl(source, reference.sourceUrl).href;
    const observedAt = reference.observedAt ?? reference.sourceFetchedAt;
    const contentHash = reference.contentSha256 ?? reference.sourceContentSha256;
    const indexed = evidenceIndex?.sources?.[source.id];
    if (!Number.isFinite(Date.parse(observedAt)) || !/^[a-f\d]{64}$/i.test(contentHash ?? '')) return null;
    if (!indexed || indexed.contentSha256?.toLowerCase() !== contentHash.toLowerCase()) return null;
    if (new Date(indexed.fetchedAt).toISOString() !== new Date(observedAt).toISOString()) return null;
    return { sourceId: source.id, sourceName: source.name, url, observedAt: new Date(observedAt).toISOString(), contentSha256: contentHash.toLowerCase() };
  } catch {
    return null;
  }
}

function opportunityEvidence(opportunity, evidenceIndex) {
  return verifiedEvidence(opportunity.evidence ?? {
    sourceId: opportunity.sourceId,
    sourceUrl: opportunity.sourceUrl,
    observedAt: opportunity.sourceFetchedAt ?? opportunity.observedAt,
    contentSha256: opportunity.sourceContentSha256 ?? opportunity.contentSha256
  }, evidenceIndex);
}

function classifyReward(reward, evidenceIndex) {
  const evidence = verifiedEvidence(reward?.evidence, evidenceIndex);
  if (!evidence) return { category: 'unverified', amount: null, currency: null, evidence: null };
  if (reward.type === 'token') return { category: 'speculative', amount: null, currency: null, evidence };
  if (reward.transferability === 'non-transferable' || ['points', 'in-kind'].includes(reward.type)) {
    return { category: 'non-transferable', amount: null, currency: null, evidence };
  }
  if (reward.type !== 'cash' || reward.transferability !== 'transferable' || reward.realizable !== true || !Number.isFinite(reward.amount) || reward.amount < 0 || !/^[A-Z]{3}$/.test(reward.currency ?? '')) {
    return { category: 'unpriced', amount: null, currency: null, evidence };
  }
  return { category: 'cash', amount: reward.amount, currency: reward.currency, evidence };
}

function assessCosts(costAssessment, currency, evidenceIndex) {
  const evidence = verifiedEvidence(costAssessment?.evidence, evidenceIndex);
  if (!costAssessment || costAssessment.complete !== true || !Array.isArray(costAssessment.unavoidable) || !evidence) {
    return { status: 'unverified', amount: null, currency: null, evidence: null, positiveCost: false };
  }

  let total = 0;
  for (const cost of costAssessment.unavoidable) {
    if (!cost || cost.unavoidable !== true || !Number.isFinite(cost.amount) || cost.amount < 0 || !/^[A-Z]{3}$/.test(cost.currency ?? '') || !verifiedEvidence(cost.evidence, evidenceIndex)) {
      return { status: 'unverified', amount: null, currency: null, evidence, positiveCost: false };
    }
    if (cost.amount > 0) {
      if (currency && cost.currency !== currency) return { status: 'currency-mismatch', amount: null, currency: null, evidence, positiveCost: true };
      total += cost.amount;
    }
  }
  return { status: 'verified', amount: total, currency: currency ?? null, evidence, positiveCost: total > 0 };
}

function payoutSummary(history, evidenceIndex) {
  const evidence = verifiedEvidence(history?.evidence, evidenceIndex);
  if (!history || !evidence || !['documented', 'unknown'].includes(history.status) || !Array.isArray(history.records)) {
    return { verified: false, records: [], totalsByCurrency: {}, evidence: null };
  }
  const records = [];
  for (const record of history.records) {
    if (record.status !== 'paid' || !Number.isFinite(record.amount) || record.amount < 0 || !/^[A-Z]{3}$/.test(record.currency ?? '') || !Number.isFinite(Date.parse(record.paidAt))) continue;
    const recordEvidence = verifiedEvidence(record.evidence, evidenceIndex);
    if (recordEvidence) records.push({ amount: record.amount, currency: record.currency, paidAt: new Date(record.paidAt).toISOString(), evidence: recordEvidence });
  }
  const totalsByCurrency = {};
  for (const record of records) totalsByCurrency[record.currency] = (totalsByCurrency[record.currency] ?? 0) + record.amount;
  return { verified: true, historyStatus: history.status, records, totalsByCurrency, evidence };
}

function riskPoints(assessment, evidenceIndex) {
  const evidence = verifiedEvidence(assessment?.evidence, evidenceIndex);
  if (!assessment || assessment.complete !== true || !Array.isArray(assessment.indicators) || !evidence) return { points: 0, verified: false };
  let penalty = 0;
  for (const indicator of assessment.indicators) {
    if (!indicator || !['low', 'medium', 'high'].includes(indicator.severity) || !verifiedEvidence(indicator.evidence, evidenceIndex)) {
      return { points: 0, verified: false };
    }
    penalty += { low: 2, medium: 6, high: 12 }[indicator.severity];
  }
  return { points: Math.max(0, 20 - Math.min(20, penalty)), verified: true };
}

function effortPoints(effort, evidenceIndex) {
  if (!effort || !Number.isFinite(effort.hours) || effort.hours < 0 || !verifiedEvidence(effort.evidence, evidenceIndex)) {
    return { points: 0, verified: false };
  }
  const points = effort.hours <= 1 ? 20 : effort.hours <= 8 ? 15 : effort.hours <= 40 ? 10 : 5;
  return { points, verified: true };
}

export function scoreOpportunity({ opportunity, eligibilityDecision, evidenceIndex } = {}) {
  const id = opportunity?.id ?? null;
  const missingEvidence = [];
  const positiveEligibility = [ELIGIBILITY_OUTCOMES.ELIGIBLE, ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS].includes(eligibilityDecision?.outcome);
  const eligibilitySourcesValid = Array.isArray(eligibilityDecision?.supportingSources) && eligibilityDecision.supportingSources.length > 0 && eligibilityDecision.supportingSources.every((source) => verifiedEvidence(source, evidenceIndex));
  const source = opportunity && opportunityEvidence(opportunity, evidenceIndex);
  if (!source) missingEvidence.push('opportunity source evidence');
  if (!positiveEligibility || !eligibilitySourcesValid || !Number.isFinite(Date.parse(eligibilityDecision?.lastCheckedAt))) {
    missingEvidence.push('current evidence-backed eligible decision');
  }

  const reward = classifyReward(opportunity?.reward, evidenceIndex);
  if (reward.category === 'unverified' || reward.category === 'unpriced') missingEvidence.push('evidence-backed realizable reward valuation');
  const costs = assessCosts(opportunity?.costAssessment, reward.currency, evidenceIndex);
  if (costs.status !== 'verified') missingEvidence.push('complete evidence-backed unavoidable cost assessment');
  const payouts = payoutSummary(opportunity?.payoutHistory, evidenceIndex);
  if (!payouts.verified) missingEvidence.push('evidence-backed payout history assessment');
  else if (payouts.historyStatus === 'unknown') missingEvidence.push('actual payout history is unknown');
  const effort = effortPoints(opportunity?.effort, evidenceIndex);
  if (!effort.verified) missingEvidence.push('evidence-backed effort estimate');
  const risk = riskPoints(opportunity?.riskAssessment, evidenceIndex);
  if (!risk.verified) missingEvidence.push('complete evidence-backed risk assessment');

  let netReward = { amount: null, currency: null, status: 'not-valued' };
  let netRewardPoints = 0;
  if (reward.category === 'cash' && costs.status === 'verified') {
    if (costs.amount > 0 && costs.currency !== reward.currency) {
      netReward = { amount: null, currency: null, status: 'currency-mismatch' };
      missingEvidence.push('comparable reward and cost currencies');
    } else {
      const amount = reward.amount - costs.amount;
      netReward = { amount, currency: reward.currency, status: amount > 0 ? 'positive' : amount === 0 ? 'break-even' : 'negative' };
      netRewardPoints = amount > 0 ? 30 : amount === 0 ? 15 : 0;
    }
  } else if (reward.category === 'cash' && costs.status === 'currency-mismatch') {
    netReward = { amount: null, currency: null, status: 'currency-mismatch' };
    missingEvidence.push('comparable reward and cost currencies');
  } else if (reward.category === 'speculative') {
    netReward = { amount: null, currency: null, status: 'speculative' };
  } else if (reward.category === 'non-transferable') {
    netReward = { amount: null, currency: null, status: 'non-transferable' };
  }

  const evidenceComponents = [source, reward.evidence, costs.evidence, payouts.evidence, effort.verified, risk.verified];
  const evidencePoints = Math.round((evidenceComponents.filter(Boolean).length / evidenceComponents.length) * 25);
  const payoutPoints = Math.min(25, payouts.records.length * 5);
  const conditionPenalty = eligibilityDecision?.outcome === ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS ? 10 : 0;
  const score = positiveEligibility && eligibilitySourcesValid
    ? Math.max(0, Math.min(MAX_SCORE, evidencePoints + payoutPoints + netRewardPoints + effort.points + risk.points - conditionPenalty))
    : null;
  const blockedByZeroCapitalPolicy = costs.positiveCost;
  const rankable = score !== null && missingEvidence.length === 0 && !blockedByZeroCapitalPolicy;

  return {
    opportunityId: id,
    score,
    rankable,
    blockedByZeroCapitalPolicy,
    blockingReasons: blockedByZeroCapitalPolicy ? ['Unavoidable positive costs violate the zero-capital policy.'] : [],
    eligibilityOutcome: eligibilityDecision?.outcome ?? null,
    components: { evidenceQuality: evidencePoints, actualPayoutHistory: payoutPoints, netReward: netRewardPoints, effort: effort.points, risk: risk.points, conditionsPenalty: conditionPenalty },
    valuation: {
      rewardCategory: reward.category,
      grossReward: reward.category === 'cash' ? { amount: reward.amount, currency: reward.currency } : null,
      unavoidableCosts: costs.status === 'verified' ? { amount: costs.amount, currency: costs.currency } : null,
      netReward
    },
    payoutHistory: { count: payouts.records.length, totalsByCurrency: payouts.totalsByCurrency },
    effortHours: effort.verified ? opportunity.effort.hours : null,
    riskIndicators: risk.verified ? opportunity.riskAssessment.indicators.map(({ severity, label }) => ({ severity, label: label ?? null })) : null,
    evidence: { opportunity: source, reward: reward.evidence, costs: costs.evidence, payoutHistory: payouts.evidence },
    missingEvidence
  };
}

export function rankOpportunities(candidates, evidenceIndex) {
  if (!Array.isArray(candidates)) throw new Error('Candidates must be an array');
  return candidates
    .map((candidate) => scoreOpportunity({ ...candidate, evidenceIndex }))
    .sort((left, right) => {
      if (left.rankable !== right.rankable) return left.rankable ? -1 : 1;
      if (left.score !== right.score) return (right.score ?? -1) - (left.score ?? -1);
      return String(left.opportunityId).localeCompare(String(right.opportunityId));
    });
}