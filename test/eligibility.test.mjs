import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEligibility, ELIGIBILITY_OUTCOMES } from '../src/eligibility-engine.mjs';
import { createRegionProfile, RegionProfileManager } from '../src/region-profile.mjs';
import { SOURCES } from '../src/source-registry.mjs';

const checkedAt = '2026-10-28T12:00:00.000Z';
const sourceEvidence = Object.freeze({
  sourceId: SOURCES[0].id,
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

function regionProfile(overrides = {}) {
  return createRegionProfile({
    id: 'test-local',
    executionEnvironment: { kind: 'container', virtualRegion: 'US-EAST-1' },
    locale: 'en-US',
    timeZone: 'America/New_York',
    networkEndpoints: [{ id: 'official-source', role: 'source', url: 'https://blog.ethereum.org/' }],
    ...overrides
  });
}

function opportunity(overrides = {}) {
  return {
    id: 'grant-1',
    status: 'unverified',
    sourceId: sourceEvidence.sourceId,
    sourceUrl: sourceEvidence.sourceUrl,
    sourceFetchedAt: sourceEvidence.observedAt,
    sourceContentSha256: sourceEvidence.contentSha256,
    availability: { status: 'open', evidence: sourceEvidence },
    requirements: {
      territories: { allowedJurisdictions: ['US', 'CA'], excludedJurisdictions: [], evidence: sourceEvidence },
      residency: { required: true, allowedJurisdictions: ['US', 'CA'], excludedJurisdictions: [], evidence: sourceEvidence },
      accountConstraints: { accountRequired: false, allowedTypes: [], requiresStartingCapital: false, requiresDeposit: false, requiresFee: false, requiresTrading: false, evidence: sourceEvidence },
      withdrawalRules: { required: true, allowedMethods: ['bank-transfer'], evidence: sourceEvidence },
      automationPermissions: { allowed: false, evidence: sourceEvidence }
    },
    ...overrides
  };
}

function applicant(overrides = {}) {
  return {
    applicationTerritory: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:territory-1', checkedAt },
    legalResidency: { jurisdiction: 'US', status: 'verified', evidenceReference: 'review:residency-1', checkedAt },
    withdrawalMethod: 'bank-transfer',
    automationPlanned: false,
    ...overrides
  };
}

function evaluate({ offer = opportunity(), person = applicant(), profile = regionProfile(), now = new Date(checkedAt) } = {}) {
  return evaluateEligibility({ opportunity: offer, applicant: person, regionProfile: profile, evidenceIndex, now });
}

test('region profiles validate execution configuration and manager prevents duplicate IDs', () => {
  const manager = new RegionProfileManager();
  const profile = manager.register(regionProfile());

  assert.equal(profile.scope, 'execution-only');
  assert.equal(manager.get('test-local').executionEnvironment.virtualRegion, 'US-EAST-1');
  assert.throws(() => manager.register(regionProfile()), /already exists/);
  assert.throws(() => createRegionProfile({ ...regionProfile(), legalResidency: 'US' }), /field is not allowed/);
  assert.throws(() => createRegionProfile({ ...regionProfile(), executionEnvironment: { ...regionProfile().executionEnvironment, taxStatus: 'US' } }), /field is not allowed/);
});

test('virtual region, locale, timezone, and endpoints cannot satisfy residency requirements', () => {
  const result = evaluate({ person: applicant({ legalResidency: undefined }) });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.NEEDS_MANUAL_REVIEW);
  assert.ok(result.missingEvidence.includes('independently verified legal residency evidence'));
  assert.match(result.reasoning.join(' '), /not legal-residency evidence/);
  assert.equal(result.executionProfileId, 'test-local');
});

test('invalid execution profiles cannot produce a positive eligibility outcome', () => {
  const result = evaluate({ profile: { ...regionProfile(), networkEndpoints: [{ id: 'bad', role: 'source', url: 'http://example.test' }] } });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.ok(result.missingEvidence.includes('valid execution-only region profile'));
});

test('verified residency outside the allowed jurisdictions is ineligible', () => {
  const result = evaluate({ person: applicant({ legalResidency: { jurisdiction: 'GB', status: 'verified', evidenceReference: 'review:residency-2', checkedAt } }) });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.match(result.reasoning.join(' '), /jurisdiction GB conflicts/);
});

test('missing opportunity or rule evidence returns unverified with explicit gaps', () => {
  const offer = opportunity({ sourceContentSha256: 'not-a-hash' });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.equal(result.supportingSource, null);
  assert.ok(result.missingEvidence.includes('verified opportunity source and captured content evidence'));

  const missingRule = opportunity({ requirements: { ...opportunity().requirements, territories: { unrestricted: true } } });
  const ruleResult = evaluate({ offer: missingRule });
  assert.equal(ruleResult.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.ok(ruleResult.missingEvidence.includes('requirements.territories.evidence'));
});

test('evidence hashes and timestamps must match the local captured source index', () => {
  const result = evaluateEligibility({
    opportunity: opportunity(),
    applicant: applicant(),
    regionProfile: regionProfile(),
    evidenceIndex: { sources: { 'ethereum-foundation-blog': { fetchedAt: checkedAt, contentSha256: 'c'.repeat(64) } } },
    now: new Date(checkedAt)
  });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.ok(result.missingEvidence.includes('verified opportunity source and captured content evidence'));
});

test('a Stage A unverified discovery is not treated as an open opportunity', () => {
  const offer = opportunity({ availability: undefined });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.ok(result.missingEvidence.includes('source-index-backed confirmation that the opportunity is open'));
  assert.match(result.reasoning.join(' '), /does not establish that the opportunity is currently open/);
});

test('source-index-backed closed availability is ineligible', () => {
  const offer = opportunity({ availability: { status: 'closed', evidence: sourceEvidence } });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.match(result.reasoning.join(' '), /marked closed/);
});

test('contradictory unrestricted territory rules are unverified', () => {
  const offer = opportunity({
    requirements: { ...opportunity().requirements, territories: { unrestricted: true, allowedJurisdictions: ['US'], excludedJurisdictions: [], evidence: sourceEvidence } }
  });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.UNVERIFIED);
  assert.ok(result.missingEvidence.includes('requirements.territories.policy'));
});

test('a verified territory mismatch is ineligible and cannot be bypassed by execution region', () => {
  const result = evaluate({
    person: applicant({ applicationTerritory: { jurisdiction: 'GB', status: 'verified', evidenceReference: 'review:territory-2', checkedAt } }),
    profile: regionProfile({ executionEnvironment: { kind: 'container', virtualRegion: 'US' } })
  });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.match(result.reasoning.join(' '), /verified application territory GB conflicts/);
});

test('missing territory evidence requires manual review even when the execution region matches', () => {
  const result = evaluate({ person: applicant({ applicationTerritory: undefined }) });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.NEEDS_MANUAL_REVIEW);
  assert.ok(result.missingEvidence.includes('verified application territory evidence'));
});

test('an absent required account produces conditions without creating an account', () => {
  const offer = opportunity({
    requirements: { ...opportunity().requirements, accountConstraints: { accountRequired: true, allowedTypes: ['individual'], requiresStartingCapital: false, requiresDeposit: false, requiresFee: false, requiresTrading: false, evidence: sourceEvidence } }
  });
  const result = evaluate({ offer, person: applicant({ account: { status: 'absent' } }) });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS);
  assert.match(result.reasoning.join(' '), /does not create accounts or identities/);
});

test('unsupported withdrawal method and disallowed automation are ineligible', () => {
  const withdrawalResult = evaluate({ person: applicant({ withdrawalMethod: 'crypto-wallet' }) });
  const automationResult = evaluate({ person: applicant({ automationPlanned: true }) });

  assert.equal(withdrawalResult.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.equal(automationResult.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
});

test('starting capital, deposits, fees, and trading requirements are ineligible', () => {
  const offer = opportunity({
    requirements: {
      ...opportunity().requirements,
      accountConstraints: {
        accountRequired: false,
        allowedTypes: [],
        requiresStartingCapital: true,
        requiresDeposit: true,
        requiresFee: true,
        requiresTrading: true,
        evidence: sourceEvidence
      }
    }
  });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.match(result.reasoning.join(' '), /violates GDAS core principles/);
});

test('expiry boundary is inclusive and every decision includes evidence metadata', () => {
  const result = evaluate({ offer: opportunity({ expiresAt: checkedAt }) });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.INELIGIBLE);
  assert.equal(result.lastCheckedAt, checkedAt);
  assert.equal(result.supportingSource.sourceId, SOURCES[0].id);
  assert.ok(Array.isArray(result.reasoning));
  assert.ok(Array.isArray(result.missingEvidence));
});

test('complete supported requirements return eligible with the requirement source', () => {
  const offer = opportunity({
    requirements: {
      ...opportunity().requirements,
      residency: {
        ...opportunity().requirements.residency,
        evidence: {
          sourceId: 'solana-foundation-grants',
          sourceUrl: 'https://solana.org/grants-funding',
          observedAt: checkedAt,
          contentSha256: 'b'.repeat(64)
        }
      }
    }
  });
  const result = evaluate({ offer });

  assert.equal(result.outcome, ELIGIBILITY_OUTCOMES.ELIGIBLE);
  assert.equal(result.scope, 'requirements-fit-and-verified-availability');
  assert.equal(result.supportingSources.length, 3);
  assert.deepEqual(result.missingEvidence, []);
});