# GDAS Discovery Foundation

Stage A monitors a small, fixed set of official Ethereum and Solana Foundation sources for grant and ecosystem-program announcements. It has no trading, deposit, fee, wallet, or account-creation functionality. Discovered entries are leads for human review, not confirmed or currently open offers.

## Architecture

- `src/source-registry.mjs` owns the explicit source allowlist and exact HTTPS hostname checks. Runtime input cannot add arbitrary sources.
- `src/adapters.mjs` defines the adapter contract: `type` plus `parse(body, source, sourceUrl)`, returning entries with title, URL, summary, publication time, and optional explicit expiry.
- `src/engine.mjs` fetches sources with bounded concurrency, a timeout and response-size limit, manual redirect handling, host validation, content hashing, duplicate detection, and expiry classification.
- `src/evidence-store.mjs` writes immutable content snapshots and a local JSON evidence index with first-seen, last-seen, fetch timestamps, source hash, and record status.
- `src/cli.mjs` runs the registered sources.

The engine only marks a record `expired` when the source explicitly supplies an expiry timestamp in the past. Everything else remains `unverified`; a missing expiry does not imply the offer is open.

## Stage B: Eligibility and Regional Configuration

- `src/region-profile.mjs` stores execution environment, virtual region, locale, timezone, and HTTPS network endpoints. Profiles reject legal-residency, tax-status, and identity fields. These execution settings are never used as legal facts.
- `src/eligibility-engine.mjs` evaluates an opportunity only when its source and all five rule groups have evidence references tied to registered official source hosts and matching timestamp/hash entries in the local Stage A evidence index. Decisions include a standardized outcome, reasoning, supporting source(s), evaluation timestamp, and missing evidence.
- Applicant territory and legal-residency facts are separate from execution profiles and require independently reviewed evidence references. The engine checks their structure; it does not authenticate identity, inspect documents, create accounts, move funds, or determine legal/tax status.
- Source-backed account constraints must explicitly state whether starting capital, deposits, fees, or trading are required. Any such requirement is `INELIGIBLE` under GDAS core principles.
- A Stage A record's `unverified` status is not proof that an opportunity is open. Positive outcomes require a separate `availability: { status: 'open', evidence }` assertion whose source timestamp and hash match the local evidence index; source-backed `closed` entries are ineligible.
- Missing rule evidence is `UNVERIFIED`; missing applicant evidence is `NEEDS_MANUAL_REVIEW`; a verified conflict is `INELIGIBLE`; a known unmet account prerequisite is `ELIGIBLE_WITH_CONDITIONS`.

Load the local Stage A index and pass it as `evidenceIndex` to `evaluateEligibility`; without a matching captured source entry the result is `UNVERIFIED`. Run all discovery and eligibility tests with `npm test`.

## Stage C: Scoring and Policy Controls

- `src/scoring-engine.mjs` ranks only `ELIGIBLE` and `ELIGIBLE_WITH_CONDITIONS` decisions with evidence-index-matched records. It computes cash net reward only when the reward, all unavoidable costs, payout history, effort, and risk assessment are evidence-backed and currency-comparable. Token rewards are `speculative`; points and in-kind rewards are `non-transferable`; neither receives a fabricated cash value.
- `src/policy-guard.mjs` requires explicit zero-capital declarations and rejects deposits, token purchases, trading, paid APIs/upgrades, spending actions, or undeclared/positive costs.
- `src/task-queue.mjs` persists task state, dedupe keys, deadlines, policy decisions, results, and checkpoints. Fixed registered handlers execute only through the queue's guard; interrupted running tasks can be resumed with their checkpoint and are rechecked before execution.

Verify Stage C and all prior stages with `npm test`. Queue usage requires a fixed handler registry and `PolicyGuard`; never invoke task handlers through an unguarded path. The guard enforces declarations at this application boundary; operating-system sandboxing is still required if arbitrary or untrusted handler code is introduced.

## Stage D: Ethereum Grant Adapter

- `src/adapters/ethereum-grants.mjs` selects only the registered Ethereum Foundation RSS source, delegates fetching, exact-host validation, content hashing, and local evidence storage to the Stage A discovery engine, and prepares only free public-source review tasks after an eligible decision and rankable zero-cost score.
- The prepared task is for execution readiness and human review only. It does not submit applications, create accounts, trade, transfer funds, or pay for services.
- `test/e2e-adapter.test.mjs` drives discovery through regional profile validation, eligibility, scoring, task preparation, queueing, policy-guarded handler execution, and the final human-review-ready state with a mocked official feed response.

Run the end-to-end and full regression suite with `npm test`.

## Stage E: Reward Verification and Reporting

- `src/audit-ledger.mjs` stores append-only JSONL events with a SHA-256 hash chain, stable event IDs, duplicate protection, and rejection of secret-bearing fields.
- `src/reward-tracker.mjs` keeps advertised rewards, completed tasks, claims, pending/confirmed receipts, locked/transferable balances, speculative tokens, and realized fiat proceeds as separate events. Realized proceeds require a linked, confirmed fiat receipt; the tracker does not sell or convert assets.
- `src/wallet-monitor.mjs` accepts designated public receiving addresses and calls only a declared `public-free` client's `getAddressActivity` method. It rejects clients exposing transaction/signing methods, never requests keys or seed phrases, hashes addresses in scan summaries, and does not write addresses into the ledger.
- `src/daily-reporter.mjs` reports discovery, queue results, claims, receipts, observed fees, net realized income, and ledger/system health. With a valid ledger and no ledger-backed proceeds it explicitly says “Zero confirmed earnings for this reporting period”; a corrupt ledger reports earnings as unverifiable instead.

Run the Stage E tests specifically with `node --test test/reward-verification.test.mjs`, or the full suite with `npm test`. A monitor requires an operator-provided free public read client; no paid API or credentials are configured by this project.

## Stage G: Adapter Expansion

- `src/adapters/solana-grants.mjs` adapts the registered Solana Foundation grants page through the existing HTML parser. It retains same-host program links only and delegates fetching, HTTPS host checks, size limits, content hashing, snapshots, duplicate detection, and evidence timestamps to the Stage A engine.
- `src/adapter-registry.mjs` provides a central registry for the Ethereum Foundation RSS adapter and Solana grants HTML adapter. Its `discover()` dispatches sources concurrently with a configurable limit of 1–8 and applies fetched results to the shared local evidence index deterministically.
- Adapter/source IDs and types must match the explicit source registry. Unknown sources fail before any fetch. Discovery results are leads; eligibility and scoring remain separate evidence-backed steps.

Run the Stage G tests with `node --test test/adapters-expansion.test.mjs`, or run all stage tests with `npm test`. The Stage G tests use mocked responses and make no external requests.

## Stage H: Local Automated Runner

- `src/run-sentinel.mjs` runs concurrent registered-source discovery, evidence-backed eligibility, scoring, free human-review queue preparation, and daily reporting. Missing candidate rules, reward/effort/risk valuations, or availability evidence remain `UNVERIFIED` and are not queued.
- The runner does not sign, submit claims, call paid services, or make wallet writes. Its artifacts explicitly record `outOfPocketSpend: false`, `signing: false`, and `payoutSubmission: false`.
- Outputs are local files under the selected data directory: `gdas-evidence.json`, content snapshots, `gdas-task-queue.json`, `gdas-audit-ledger.jsonl`, `reports/YYYY-MM-DD.json`, and `gdas-last-run.json`. A run/report success artifact is written only after the pipeline succeeds.

Run once or inspect CLI help:

```sh
npm run sentinel -- --help
npm run sentinel -- --data-dir data
npm test
```

For unattended local scheduling, an operator may use a cron entry such as `15 7 * * * cd /workspaces/escrow-verify && npm run sentinel -- --data-dir data >> data/sentinel-cron.log 2>&1`. The runner does not install cron or create credentials. Optional input configuration is a local JSON file passed with `--config`; its `sourceIds` must be registered, and candidate requirements/availability must include the same evidence references expected by Stage B/C.

The repository also includes `.github/workflows/gdas-sentinel.yml` for hourly UTC runs and manual dispatch. It uses `contents: read` plus `actions: read`, installs from the lockfile, tests before polling, restores the previous successful run's state artifact, and uploads the next state for seven days. It does not commit runtime data or snapshots; after a retention gap or missing artifact, the run starts with empty state and remains fail-closed until evidence is provided.

## Dashboard

Open `gateway.html` directly in a browser, or run `"$BROWSER" /workspaces/escrow-verify/gateway.html` from the workspace. The dashboard makes no network requests. Import an audit ledger as JSONL/NDJSON to verify its hash chain locally; import a state JSON file for the evidence index, queue state, or an object containing an `opportunities` array. Files are read in memory and never uploaded or modified. A failed ledger check suppresses its derived financial figures.

The claim table can emit a local `gdas:human-approval-requested` browser event for a prepared crypto intent. It does not create approval, sign, submit, or move assets; there is no signer or payout backend connected. Verify dashboard behavior with `node --test test/dashboard.test.mjs`; run all tests with `npm test`.

## Stage F: Multi-Pathway Claim Manager

- `src/claim-manager.mjs` supports crypto claim preparation only from an approved claim and confirmed crypto receipt, with a fresh trusted fee quote under a configured network cap. Fees must be evidenced as sponsor-funded or deducted from the confirmed reward without exceeding it. Signing/submission is isolated behind an exact-intent human approval callback and a signer that exposes only `signAndSubmit`; uncertain submissions are recorded and never automatically retried.
- The virtual USD pathway requires an approved claim, amount at or above the source-stated minimum, a SHA-256-shaped opaque account-binding reference backed by a configured trusted platform provider, and a complete evidence-backed fee assessment. Any nonzero activation, withdrawal-unlock, or other fee is blocked. Crypto fee sponsorship and fee quotations also require configured trusted providers.
- Both pathways are validated through `PolicyGuard` with zero user-funded costs. The manager stores no account numbers, credentials, private keys, or seed phrases. This module does not configure a signer, payout integration, or platform credentials.

Verify Stage F with `node --test test/claim-manager.test.mjs`; run all stages with `npm test`.

## Sources

- Ethereum Foundation Blog RSS: `https://blog.ethereum.org/en/feed.xml`
- Solana Foundation Grants: `https://solana.org/grants-funding`

The registry requires exact host matches for both fetched pages and discovered record URLs. Redirects to another host and unknown source IDs fail closed. Only same-host links are retained by the HTML adapter.

## Run

Requirements: Node.js 20 or later, network access to the two listed HTTPS sources, and no credentials or API keys.

```sh
npm test
npm run discover
```

Evidence is written to `data/gdas-evidence.json`; fetched source snapshots are written under `data/snapshots/`. These files may contain source text and are local runtime output, not committed fixtures. To run with only one registered source, call `discover({ sourceIds: ['ethereum-foundation-blog'] })` from an ESM script. Never add a source without verifying its official ownership, canonical HTTPS hostname, and intended public data.

## REA environment note

REA's read-only CLI doctor confirmed the VS Code registration and Node runtime in the implementation environment. Live REA MCP tools were not exposed in that agent session, so HTTP source fetching is performed by the Node adapters and is not represented as REA-captured evidence.