import { getSource, validateSourceUrl } from './source-registry.mjs';
import { createRegionProfile } from './region-profile.mjs';

export const ELIGIBILITY_OUTCOMES = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  ELIGIBLE_WITH_CONDITIONS: 'ELIGIBLE_WITH_CONDITIONS',
  NEEDS_MANUAL_REVIEW: 'NEEDS_MANUAL_REVIEW',
  INELIGIBLE: 'INELIGIBLE',
  UNVERIFIED: 'UNVERIFIED'
});

const REQUIREMENT_KEYS = Object.freeze([
  'territories',
  'residency',
  'accountConstraints',
  'withdrawalRules',
  'automationPermissions'
]);

function validDate(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function sourceReference(reference, evidenceIndex) {
  if (!reference || typeof reference !== 'object') return null;
  try {
    const source = getSource(reference.sourceId);
    const sourceUrl = validateSourceUrl(source, reference.sourceUrl).href;
    const observedAt = reference.observedAt ?? reference.sourceFetchedAt;
    const contentSha256 = reference.contentSha256 ?? reference.sourceContentSha256;
    if (!validDate(observedAt) || !/^[a-f\d]{64}$/i.test(contentSha256 ?? '')) return null;
    const capturedSource = evidenceIndex?.sources?.[source.id];
    if (!capturedSource || !validDate(capturedSource.fetchedAt) || capturedSource.contentSha256?.toLowerCase() !== contentSha256.toLowerCase()) return null;
    if (new Date(capturedSource.fetchedAt).toISOString() !== new Date(observedAt).toISOString()) return null;
    return {
      sourceId: source.id,
      sourceName: source.name,
      url: sourceUrl,
      observedAt: new Date(observedAt).toISOString(),
      contentSha256: contentSha256.toLowerCase()
    };
  } catch {
    return null;
  }
}

function jurisdiction(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function validJurisdictionList(value) {
  return Array.isArray(value) && value.every((item) => /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(jurisdiction(item)));
}

function hasApplicantEvidence(fact) {
  return fact && fact.status === 'verified' && typeof fact.evidenceReference === 'string' && fact.evidenceReference.trim() && validDate(fact.checkedAt);
}

function hasEvidenceBackedRule(rule, evidenceIndex) {
  return sourceReference(rule?.evidence, evidenceIndex) !== null;
}

function validateRequirements(requirements, missingEvidence, evidenceIndex) {
  if (!requirements || typeof requirements !== 'object') {
    missingEvidence.push('opportunity.requirements');
    return false;
  }

  let valid = true;
  for (const key of REQUIREMENT_KEYS) {
    const rule = requirements[key];
    if (!rule || typeof rule !== 'object' || !hasEvidenceBackedRule(rule, evidenceIndex)) {
      missingEvidence.push(`requirements.${key}.evidence`);
      valid = false;
      continue;
    }

    if (key === 'territories') {
      const allowed = rule.allowedJurisdictions ?? [];
      const excluded = rule.excludedJurisdictions ?? [];
      if (!validJurisdictionList(allowed) || !validJurisdictionList(excluded) || (allowed.length === 0 && excluded.length === 0 && rule.unrestricted !== true) || (rule.unrestricted === true && (allowed.length > 0 || excluded.length > 0))) {
        missingEvidence.push('requirements.territories.policy');
        valid = false;
      }
    } else if (key === 'residency') {
      if (typeof rule.required !== 'boolean' || !validJurisdictionList(rule.allowedJurisdictions ?? []) || !validJurisdictionList(rule.excludedJurisdictions ?? [])) {
        missingEvidence.push('requirements.residency.policy');
        valid = false;
      }
    } else if (key === 'accountConstraints') {
      if (typeof rule.accountRequired !== 'boolean' || !Array.isArray(rule.allowedTypes) || !rule.allowedTypes.every((item) => typeof item === 'string' && item.trim()) || (rule.accountRequired && rule.allowedTypes.length === 0) || ['requiresStartingCapital', 'requiresDeposit', 'requiresFee', 'requiresTrading'].some((field) => typeof rule[field] !== 'boolean')) {
        missingEvidence.push('requirements.accountConstraints.policy');
        valid = false;
      }
    } else if (key === 'withdrawalRules') {
      if (typeof rule.required !== 'boolean' || !Array.isArray(rule.allowedMethods) || !rule.allowedMethods.every((item) => typeof item === 'string' && item.trim()) || (rule.required && rule.allowedMethods.length === 0)) {
        missingEvidence.push('requirements.withdrawalRules.policy');
        valid = false;
      }
    } else if (typeof rule.allowed !== 'boolean') {
      missingEvidence.push('requirements.automationPermissions.policy');
      valid = false;
    }
  }
  return valid;
}

function makeDecision({ outcome, reasoning, source, supportingSources, lastCheckedAt, missingEvidence, profileId }) {
  return {
    outcome,
    scope: 'requirements-fit-and-verified-availability',
    reasoning,
    supportingSource: source,
    supportingSources: supportingSources ?? (source ? [source] : []),
    lastCheckedAt,
    missingEvidence,
    executionProfileId: profileId ?? null
  };
}

export function evaluateEligibility({ opportunity, regionProfile, evidenceIndex, applicant = {}, now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  const lastCheckedAt = now.toISOString();
  const missingEvidence = [];
  const reasoning = [];
  let profile;
  try {
    profile = createRegionProfile(regionProfile);
  } catch {
    missingEvidence.push('valid execution-only region profile');
    reasoning.push('Execution profile is missing or invalid; execution metadata cannot establish legal status.');
  }

  const opportunitySource = opportunity && sourceReference({
    sourceId: opportunity.sourceId,
    sourceUrl: opportunity.sourceUrl,
    sourceFetchedAt: opportunity.sourceFetchedAt,
    sourceContentSha256: opportunity.sourceContentSha256
  }, evidenceIndex);
  if (!opportunitySource) missingEvidence.push('verified opportunity source and captured content evidence');

  if (!opportunity || opportunity.status === 'expired') {
    if (opportunity?.status === 'expired' && opportunitySource) {
      return makeDecision({
        outcome: ELIGIBILITY_OUTCOMES.INELIGIBLE,
        reasoning: ['The opportunity is marked expired by its captured source record.'],
        source: opportunitySource,
        lastCheckedAt,
        missingEvidence,
        profileId: profile?.id
      });
    }
    reasoning.push('Opportunity details are unavailable or lack an evidence-backed source.');
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }

  if (!opportunitySource) {
    reasoning.push('Opportunity source evidence is missing, malformed, or outside the official source registry.');
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: null, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }

  if (opportunity.availability?.status === 'closed') {
    const availabilitySource = sourceReference(opportunity.availability.evidence, evidenceIndex);
    if (availabilitySource) {
      return makeDecision({
        outcome: ELIGIBILITY_OUTCOMES.INELIGIBLE,
        reasoning: ['The opportunity is marked closed by source-index-backed availability evidence.'],
        source: opportunitySource,
        supportingSources: [opportunitySource, availabilitySource],
        lastCheckedAt,
        missingEvidence,
        profileId: profile?.id
      });
    }
  }

  if (opportunity.expiresAt !== null && opportunity.expiresAt !== undefined) {
    if (!validDate(opportunity.expiresAt)) {
      missingEvidence.push('valid opportunity expiry date');
      reasoning.push('The supplied expiry date is malformed, so current availability cannot be verified.');
      return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: profile?.id });
    }
    if (Date.parse(opportunity.expiresAt) <= now.getTime()) {
      reasoning.push('The source-backed opportunity expiry is at or before the evaluation time.');
      return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.INELIGIBLE, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: profile?.id });
    }
  }

  const availabilitySource = opportunity.availability?.status === 'open'
    ? sourceReference(opportunity.availability.evidence, evidenceIndex)
    : null;
  if (!availabilitySource) {
    missingEvidence.push('source-index-backed confirmation that the opportunity is open');
    reasoning.push('A discovered record or requirements match does not establish that the opportunity is currently open.');
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }

  if (!profile) {
    reasoning.push('A valid execution-only regional profile is required; no legal or eligibility fact is inferred from execution settings.');
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: null });
  }

  if (!validateRequirements(opportunity.requirements, missingEvidence, evidenceIndex)) {
    reasoning.push('One or more eligibility rules are missing structured requirements or supporting source evidence.');
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.UNVERIFIED, reasoning, source: opportunitySource, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }

  const supportingSources = [opportunitySource, availabilitySource];
  for (const key of REQUIREMENT_KEYS) {
    const source = sourceReference(opportunity.requirements[key].evidence, evidenceIndex);
    if (source && !supportingSources.some((item) => item.sourceId === source.sourceId && item.url === source.url)) supportingSources.push(source);
  }

  const hardFailures = [];
  const manualReview = [];
  const conditions = [];
  const { territories, residency, accountConstraints, withdrawalRules, automationPermissions } = opportunity.requirements;

  if (territories.unrestricted !== true && ((territories.allowedJurisdictions?.length ?? 0) > 0 || (territories.excludedJurisdictions?.length ?? 0) > 0)) {
    const territory = applicant.applicationTerritory;
    if (!hasApplicantEvidence(territory) || !jurisdiction(territory.jurisdiction)) {
      missingEvidence.push('verified application territory evidence');
      manualReview.push('Application territory requires independent evidence; execution region, locale, timezone, and endpoint are not substitutes.');
    } else {
      const value = jurisdiction(territory.jurisdiction);
      if (territories.excludedJurisdictions?.map(jurisdiction).includes(value) || (territories.allowedJurisdictions?.length && !territories.allowedJurisdictions.map(jurisdiction).includes(value))) {
        hardFailures.push(`The verified application territory ${value} conflicts with the published territory rules.`);
      }
    }
  }

  if (residency.required) {
    const fact = applicant.legalResidency;
    if (!hasApplicantEvidence(fact) || !jurisdiction(fact.jurisdiction)) {
      missingEvidence.push('independently verified legal residency evidence');
      manualReview.push('Legal residency evidence requires independent review; execution region, locale, timezone, and endpoint are not legal-residency evidence.');
    } else {
      const value = jurisdiction(fact.jurisdiction);
      if (residency.excludedJurisdictions?.map(jurisdiction).includes(value) || (residency.allowedJurisdictions?.length && !residency.allowedJurisdictions.map(jurisdiction).includes(value))) {
        hardFailures.push(`The independently verified residency jurisdiction ${value} conflicts with the published residency rules.`);
      }
    }
  }

  if (accountConstraints.accountRequired) {
    const account = applicant.account;
    if (account?.status === 'absent') {
      conditions.push('A compliant account is required; this engine does not create accounts or identities.');
    } else if (!hasApplicantEvidence(account) || typeof account.type !== 'string') {
      missingEvidence.push('verified account constraint evidence');
      manualReview.push('Account status or type is not independently evidenced.');
    } else if (accountConstraints.allowedTypes.length && !accountConstraints.allowedTypes.includes(account.type)) {
      hardFailures.push('The verified account type is not allowed by the published account constraints.');
    }
  }
  if (accountConstraints.requiresStartingCapital || accountConstraints.requiresDeposit || accountConstraints.requiresFee || accountConstraints.requiresTrading) {
    hardFailures.push('The opportunity requires starting capital, a deposit, a fee, or trading, which violates GDAS core principles.');
  }

  if (withdrawalRules.required) {
    if (typeof applicant.withdrawalMethod !== 'string' || !applicant.withdrawalMethod.trim()) {
      missingEvidence.push('selected withdrawal method');
      manualReview.push('A withdrawal method is required to compare against the published rules.');
    } else if (!withdrawalRules.allowedMethods.includes(applicant.withdrawalMethod)) {
      hardFailures.push('The selected withdrawal method is not allowed by the published withdrawal rules.');
    }
  }

  if (typeof applicant.automationPlanned !== 'boolean') {
    missingEvidence.push('whether automation is planned');
    manualReview.push('Automation intent is unspecified.');
  } else if (applicant.automationPlanned && !automationPermissions.allowed) {
    hardFailures.push('The opportunity does not permit the planned automation.');
  }

  reasoning.push('Execution profile was recorded for environment context only and was not used as residency, tax, territory, or identity evidence.');
  if (hardFailures.length) {
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.INELIGIBLE, reasoning: [...reasoning, ...hardFailures], source: opportunitySource, supportingSources, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }
  if (manualReview.length) {
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.NEEDS_MANUAL_REVIEW, reasoning: [...reasoning, ...manualReview], source: opportunitySource, supportingSources, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }
  if (conditions.length) {
    return makeDecision({ outcome: ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS, reasoning: [...reasoning, ...conditions], source: opportunitySource, supportingSources, lastCheckedAt, missingEvidence, profileId: profile?.id });
  }

  return makeDecision({
    outcome: ELIGIBILITY_OUTCOMES.ELIGIBLE,
    reasoning: [...reasoning, 'All supplied, source-backed requirements match the separately evidenced applicant facts.'],
    source: opportunitySource,
    supportingSources,
    lastCheckedAt,
    missingEvidence,
    profileId: profile?.id
  });
}