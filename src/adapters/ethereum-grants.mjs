import { createRssAdapter } from '../adapters.mjs';
import { discover as runDiscovery } from '../engine.mjs';
import { EvidenceStore } from '../evidence-store.mjs';
import { ELIGIBILITY_OUTCOMES } from '../eligibility-engine.mjs';
import { getSource, validateSourceUrl } from '../source-registry.mjs';
import { GDAS_TASK_POLICY_TEMPLATE } from '../policy-guard.mjs';

const SOURCE_ID = 'ethereum-foundation-blog';
const rssAdapter = createRssAdapter();

export function createEthereumGrantsAdapter() {
  const source = getSource(SOURCE_ID);
  const adapter = {
    type: 'rss',
    sourceId: SOURCE_ID,
    parse(body, candidateSource) {
      if (candidateSource.id !== SOURCE_ID) throw new Error('Ethereum grants adapter received the wrong source');
      return rssAdapter.parse(body, candidateSource);
    },
    async discover(options = {}) {
      const {
        indexPath = 'data/gdas-evidence.json',
        snapshotsDirectory = 'data/snapshots',
        now = new Date()
      } = options;
      const summary = await runDiscovery({
        ...options,
        sourceIds: [SOURCE_ID],
        indexPath,
        snapshotsDirectory,
        now,
        adapters: new Map([[SOURCE_ID, adapter]])
      });
      const index = await new EvidenceStore(indexPath, snapshotsDirectory).load();
      const records = Object.values(index.records)
        .filter((record) => record.sourceId === SOURCE_ID && record.lastSeenAt === now.toISOString())
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
      return { summary, records, evidenceIndex: index };
    },
    prepareTask(record, { eligibilityDecision, scoringResult, deadline = record?.expiresAt ?? null } = {}) {
      if (!record || record.sourceId !== SOURCE_ID || typeof record.recordId !== 'string' || !/^[a-f\d]{64}$/i.test(record.recordId)) {
        throw new Error('Task preparation requires a discovered Ethereum source record');
      }
      const recordUrl = validateSourceUrl(source, record.recordUrl).href;
      if (record.status === 'expired') throw new Error('Expired opportunities cannot be prepared for execution');
      if (![ELIGIBILITY_OUTCOMES.ELIGIBLE, ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS].includes(eligibilityDecision?.outcome)) {
        throw new Error('Task preparation requires an eligible decision');
      }
      if (scoringResult?.opportunityId !== record.recordId || scoringResult.rankable !== true || scoringResult.blockedByZeroCapitalPolicy) {
        throw new Error('Task preparation requires a rankable, zero-cost scoring result for this source record');
      }
      const scoreEvidence = scoringResult.evidence?.opportunity;
      const decisionEvidenceMatches = eligibilityDecision.supportingSources?.some((item) =>
        item.sourceId === SOURCE_ID && item.url === recordUrl && item.contentSha256 === record.sourceContentSha256
      );
      if (scoringResult.eligibilityOutcome !== eligibilityDecision.outcome || scoreEvidence?.sourceId !== SOURCE_ID || scoreEvidence.url !== recordUrl || scoreEvidence.contentSha256 !== record.sourceContentSha256 || !decisionEvidenceMatches) {
        throw new Error('Eligibility and score evidence must match the discovered source record');
      }

      return {
        type: 'ethereum-grant-review',
        dedupeKey: `ethereum-grant-review:${record.recordId}`,
        deadline,
        actions: ['read-public-source', 'draft'],
        policy: { ...GDAS_TASK_POLICY_TEMPLATE, costs: [] },
        payload: {
          sourceId: SOURCE_ID,
          recordId: record.recordId,
          title: record.title,
          recordUrl,
          sourceContentSha256: record.sourceContentSha256,
          readiness: 'eligible-for-human-review'
        }
      };
    }
  };
  return Object.freeze(adapter);
}