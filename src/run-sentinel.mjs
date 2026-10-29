import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultAdapterRegistry } from './adapter-registry.mjs';
import { AuditLedger } from './audit-ledger.mjs';
import { evaluateEligibility, ELIGIBILITY_OUTCOMES } from './eligibility-engine.mjs';
import { GDAS_TASK_POLICY_TEMPLATE, PolicyGuard } from './policy-guard.mjs';
import { createRegionProfile } from './region-profile.mjs';
import { rankOpportunities } from './scoring-engine.mjs';
import { TaskQueue } from './task-queue.mjs';
import { generateDailyReport } from './daily-reporter.mjs';
import { getSource } from './source-registry.mjs';

function defaultRegionProfile(sourceIds, registry) {
  const endpoints = sourceIds.map((sourceId) => {
    registry.get(sourceId);
    const source = getSource(sourceId);
    return { id: source.id, role: 'source', url: source.url };
  });
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return createRegionProfile({
    id: 'gdas-local-runner',
    executionEnvironment: { kind: 'local', virtualRegion: 'local-only' },
    locale,
    timeZone,
    networkEndpoints: endpoints
  });
}

function candidateInputs(config, recordId) {
  const candidate = config.candidates?.[recordId] ?? {};
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`Candidate config must be an object for ${recordId}`);
  return candidate;
}

function makeScoringOpportunity(record, scoringInput = {}) {
  if (!scoringInput || typeof scoringInput !== 'object' || Array.isArray(scoringInput)) throw new Error(`Scoring input must be an object for ${record.recordId}`);
  return {
    ...scoringInput,
    id: record.recordId,
    sourceId: record.sourceId,
    sourceUrl: record.recordUrl,
    sourceFetchedAt: record.sourceFetchedAt,
    sourceContentSha256: record.sourceContentSha256
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function runSentinel({
  config = {},
  configPath,
  dataDirectory = 'data',
  sourceIds,
  concurrency = 2,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  registry = createDefaultAdapterRegistry()
} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Runner config must be an object');
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) throw new Error('Unsupported runner config schemaVersion');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Runner clock must be a valid Date');
  const selectedSources = sourceIds ?? config.sourceIds ?? registry.list().map((adapter) => adapter.sourceId);
  if (!Array.isArray(selectedSources) || selectedSources.length === 0 || new Set(selectedSources).size !== selectedSources.length) {
    throw new Error('Runner requires a non-empty list of unique source IDs');
  }
  for (const sourceId of selectedSources) registry.get(sourceId);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Runner concurrency must be between 1 and 8');

  const root = resolve(dataDirectory);
  const evidencePath = join(root, 'gdas-evidence.json');
  const snapshotsDirectory = join(root, 'snapshots');
  const queuePath = join(root, 'gdas-task-queue.json');
  const ledgerPath = join(root, 'gdas-audit-ledger.jsonl');
  const reportDirectory = join(root, 'reports');
  const startedAt = now.toISOString();
  const discovery = await registry.discover({
    sourceIds: selectedSources,
    indexPath: evidencePath,
    snapshotsDirectory,
    fetchImpl,
    now,
    concurrency
  });

  const regionProfile = config.regionProfile
    ? createRegionProfile(config.regionProfile)
    : defaultRegionProfile(selectedSources, registry);
  const evaluations = [];
  const queue = new TaskQueue({
    path: queuePath,
    policyGuard: new PolicyGuard(),
    handlers: {
      'ethereum-grant-review': async (task, context) => context.perform('draft', () => ({ readiness: task.payload.readiness, idempotencyKey: context.idempotencyKey })),
      'solana-grant-review': async (task, context) => context.perform('draft', () => ({ readiness: task.payload.readiness, idempotencyKey: context.idempotencyKey }))
    },
    now: () => now
  });
  const evaluationCandidates = [];

  for (const record of discovery.records) {
    const input = candidateInputs(config, record.recordId);
    const opportunity = {
      id: record.recordId,
      status: record.status,
      sourceId: record.sourceId,
      sourceUrl: record.recordUrl,
      sourceFetchedAt: record.sourceFetchedAt,
      sourceContentSha256: record.sourceContentSha256,
      availability: input.availability,
      expiresAt: input.expiresAt ?? record.expiresAt,
      requirements: input.requirements
    };
    const eligibilityDecision = evaluateEligibility({
      opportunity,
      regionProfile,
      evidenceIndex: discovery.evidenceIndex,
      applicant: input.applicant ?? {},
      now
    });
    const scoringOpportunity = makeScoringOpportunity(record, input.scoring);
    const decisionForScoring = {
      ...eligibilityDecision,
      supportingSources: (eligibilityDecision.supportingSources ?? []).map((source) => ({
        ...source,
        sourceUrl: source.url
      }))
    };
    evaluationCandidates.push({ opportunity: scoringOpportunity, eligibilityDecision: decisionForScoring });
    evaluations.push({ record, eligibilityDecision, scoringOpportunity, decisionForScoring, task: null });
  }

  const scores = rankOpportunities(evaluationCandidates, discovery.evidenceIndex);
  const scoreById = new Map(scores.map((score) => [score.opportunityId, score]));
  const enqueuedTasks = [];
  for (const evaluation of evaluations) {
    const scoringResult = scoreById.get(evaluation.record.recordId);
    evaluation.scoringResult = scoringResult;
    if (![ELIGIBILITY_OUTCOMES.ELIGIBLE, ELIGIBILITY_OUTCOMES.ELIGIBLE_WITH_CONDITIONS].includes(evaluation.eligibilityDecision.outcome) || !scoringResult?.rankable) continue;
    const adapter = registry.get(evaluation.record.sourceId);
    const task = adapter.prepareTask(evaluation.record, {
      eligibilityDecision: evaluation.eligibilityDecision,
      scoringResult
    });
    const enqueued = await queue.enqueue(task);
    evaluation.task = { id: enqueued.task.id, state: enqueued.task.state, duplicate: enqueued.duplicate };
    enqueuedTasks.push(evaluation.task);
  }

  const taskResults = await queue.list();
  const auditLedger = new AuditLedger(ledgerPath);
  const report = await generateDailyReport({
    date: now.toISOString().slice(0, 10),
    discoverySummary: discovery.summary,
    taskResults,
    auditLedger,
    systemHealth: {
      discovery: 'healthy',
      adapters: 'healthy',
      policy: 'healthy',
      queue: taskResults.some((task) => ['blocked', 'failed'].includes(task.state)) ? 'degraded' : 'healthy'
    }
  });

  const reportPath = join(reportDirectory, `${now.toISOString().slice(0, 10)}.json`);
  const runArtifactPath = join(root, 'gdas-last-run.json');
  const runArtifact = {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt,
    completedAt: now.toISOString(),
    mode: 'local-read-only',
    discovery: discovery.summary,
    evaluations: evaluations.map(({ record, eligibilityDecision, scoringResult, task }) => ({
      recordId: record.recordId,
      sourceId: record.sourceId,
      title: record.title,
      eligibilityOutcome: eligibilityDecision.outcome,
      eligibilityReasoning: eligibilityDecision.reasoning,
      missingEvidence: eligibilityDecision.missingEvidence,
      score: scoringResult.score,
      rankable: scoringResult.rankable,
      blockedByZeroCapitalPolicy: scoringResult.blockedByZeroCapitalPolicy,
      task
    })),
    taskQueue: { path: queuePath, enqueuedThisRun: enqueuedTasks.length, states: taskResults.map(({ id, state, type }) => ({ id, state, type })) },
    reportPath,
    policy: { outOfPocketSpend: false, signing: false, payoutSubmission: false, walletWrites: false }
  };
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(runArtifactPath, runArtifact);

  return { runArtifact, runArtifactPath, report, reportPath, discovery, evaluations, scores, enqueuedTasks, taskResults };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!['--config', '--data-dir', '--concurrency'].includes(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[{ '--config': 'configPath', '--data-dir': 'dataDirectory', '--concurrency': 'concurrency' }[argument]] = argument === '--concurrency' ? Number(value) : value;
    index += 1;
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Usage: node src/run-sentinel.mjs [--config FILE] [--data-dir DIR] [--concurrency 1-8]\n');
    return null;
  }
  let config = {};
  if (options.configPath) config = JSON.parse(await readFile(resolve(options.configPath), 'utf8'));
  const result = await runSentinel({ ...options, config });
  process.stdout.write(`${JSON.stringify({ runArtifactPath: result.runArtifactPath, reportPath: result.reportPath, sources: result.discovery.summary.sources.length, discovered: result.discovery.summary.discovered, evaluated: result.evaluations.length, queued: result.enqueuedTasks.length }, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`GDAS sentinel failed closed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
