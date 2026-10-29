(function (root) {
  'use strict';

  const GENESIS_HASH = '0'.repeat(64);

  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  async function sha256(value) {
    if (!root.crypto?.subtle || !root.TextEncoder) return null;
    const bytes = new root.TextEncoder().encode(value);
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function verifyLedger(entries) {
    if (!Array.isArray(entries)) return { valid: false, error: 'Ledger must be a JSONL event array.', checkedEntries: 0 };
    if (!root.crypto?.subtle) return { valid: false, error: 'This browser cannot verify SHA-256 ledger integrity.', checkedEntries: 0 };
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < entries.length; index += 1) {
      const { hash, ...body } = entries[index] ?? {};
      const computed = await sha256(canonical(body));
      if (body.sequence !== index + 1 || body.previousHash !== previousHash || hash !== computed) {
        return { valid: false, error: `Ledger integrity failed at event ${index + 1}.`, checkedEntries: index };
      }
      previousHash = hash;
    }
    return { valid: true, checkedEntries: entries.length, headHash: previousHash };
  }

  function amountText(amountAtomic, decimals) {
    if (typeof amountAtomic !== 'string' || !/^\d+$/.test(amountAtomic) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const digits = amountAtomic.padStart(decimals + 1, '0');
    if (!decimals) return digits;
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }

  function groupAmounts(entries, eventType, pick) {
    const amounts = {};
    for (const entry of entries) {
      if (entry.type !== eventType) continue;
      const details = pick(entry);
      if (!details || !/^[A-Z]{3,12}$/.test(details.asset ?? details.currency ?? '') || !/^\d+$/.test(details.amountAtomic ?? '') || !Number.isInteger(details.decimals)) continue;
      const asset = details.asset ?? details.currency;
      const value = BigInt(details.amountAtomic);
      const current = amounts[asset];
      if (!current) amounts[asset] = { value, decimals: details.decimals };
      else {
        const scale = Math.max(current.decimals, details.decimals);
        current.value = current.value * (10n ** BigInt(scale - current.decimals)) + value * (10n ** BigInt(scale - details.decimals));
        current.decimals = scale;
      }
    }
    return Object.fromEntries(Object.entries(amounts).map(([asset, value]) => [asset, amountText(value.value.toString(), value.decimals)]));
  }

  function currentReceiptEvents(entries) {
    const current = new Map();
    for (const entry of entries) {
      if (!['receipt_pending', 'asset_receipt_confirmed'].includes(entry.type)) continue;
      const details = entry.details ?? {};
      current.set(`${details.network}:${details.transactionHash}:${details.addressId}`, entry);
    }
    return [...current.values()];
  }

  function currentClaimEvents(entries) {
    const current = new Map();
    for (const entry of entries) {
      if (!['claim_pending', 'claim_approved'].includes(entry.type)) continue;
      const details = entry.details ?? {};
      current.set(`${entry.rewardId}:${details.claimId}`, entry);
    }
    return [...current.values()];
  }

  function buildDashboardModel({ ledgerEntries = [], ledgerIntegrity = null, evidenceIndex = null, queueState = null, dashboardState = null, now = new Date() } = {}) {
    const events = ledgerIntegrity?.valid === false ? [] : ledgerEntries;
    const receipts = currentReceiptEvents(events);
    const claims = currentClaimEvents(events);
    const tasks = Array.isArray(queueState?.tasks) ? queueState.tasks : [];
    const opportunities = Array.isArray(dashboardState?.opportunities) ? dashboardState.opportunities : Object.values(evidenceIndex?.records ?? {}).map((record) => ({
      id: record.recordId,
      title: record.title,
      sourceName: record.sourceName,
      sourceUrl: record.recordUrl,
      eligibilityStatus: record.eligibilityStatus ?? 'UNVERIFIED',
      score: Number.isFinite(record.score) ? record.score : null,
      taskState: record.taskState,
      evidenceStatus: record.sourceContentSha256 ? 'Captured' : 'Missing'
    }));
    const locked = events.filter((entry) => entry.type === 'asset_locked' && (!entry.details?.lockedUntil || Date.parse(entry.details.lockedUntil) > now.getTime()));
    const speculative = new Map();
    for (const entry of events.filter((item) => item.type === 'speculative_token')) {
      const details = entry.details ?? {};
      speculative.set(`${details.network}:${details.transactionHash}:${details.addressId}:${details.assetSymbol}`, entry);
    }
    const claimIntents = new Map();
    for (const entry of events) {
      if (!['claim_intent_prepared', 'virtual_usd_claim_prepared', 'claim_human_rejected', 'claim_submission_requested', 'claim_submission_confirmed', 'claim_submission_uncertain'].includes(entry.type)) continue;
      const key = entry.details?.intentHash;
      if (key) claimIntents.set(key, entry);
    }
    const tasksByOpportunity = new Map();
    for (const task of tasks) {
      const opportunityId = task.task?.payload?.opportunityId;
      if (opportunityId) tasksByOpportunity.set(opportunityId, task.state);
    }
    const queueCounts = Object.fromEntries(['queued', 'completed', 'blocked', 'failed', 'expired'].map((state) => [state, tasks.filter((task) => task.state === state).length]));
    const confirmedReceipts = receipts.filter((entry) => entry.type === 'asset_receipt_confirmed');
    const realizedProceeds = groupAmounts(events, 'realized_proceeds', (entry) => ({ currency: entry.details.currency, amountAtomic: entry.details.amountAtomic, decimals: entry.details.decimals }));
    const observedFees = groupAmounts(confirmedReceipts, 'asset_receipt_confirmed', (entry) => entry.details.fee?.payer && entry.details.fee.payer !== 'unknown'
      ? { asset: entry.details.fee.assetSymbol, amountAtomic: entry.details.fee.amountAtomic, decimals: entry.details.fee.decimals }
      : null);
    const integrityValid = ledgerIntegrity?.valid === true;

    return {
      ledgerIntegrity,
      integrityValid,
      confirmedReceipts,
      pendingReceipts: receipts.filter((entry) => entry.type === 'receipt_pending'),
      pendingClaims: claims.filter((entry) => entry.type === 'claim_pending'),
      approvedClaims: claims.filter((entry) => entry.type === 'claim_approved'),
      lockedAssets: locked,
      transferableBalances: events.filter((entry) => entry.type === 'asset_transferable'),
      withdrawableBalances: events.filter((entry) => entry.type === 'asset_transferable' && entry.details?.withdrawable === true),
      speculativeTokens: [...speculative.values()],
      realizedProceeds,
      observedFees,
      advertised: events.filter((entry) => entry.type === 'reward_advertised').length,
      pendingRewards: events.filter((entry) => entry.type === 'reward_pending').length,
      completedRewards: events.filter((entry) => entry.type === 'task_completed').length,
      claimIntents: [...claimIntents.values()],
      opportunities: opportunities.map((item) => ({ ...item, taskState: item.taskState ?? tasksByOpportunity.get(item.id) ?? 'not queued' })),
      queueCounts,
      zeroConfirmedEarnings: integrityValid && confirmedReceipts.length === 0,
      realizedTotal: Object.entries(realizedProceeds).map(([asset, amount]) => `${asset} ${amount}`).join(' · ') || '$0',
      imported: Boolean(ledgerIntegrity || evidenceIndex || queueState || dashboardState)
    };
  }

  function approvalRequest(target, intent) {
    if (!intent || typeof intent !== 'object' || typeof intent.intentHash !== 'string') throw new Error('A prepared claim intent is required');
    const EventConstructor = target.CustomEvent ?? root.CustomEvent;
    if (!EventConstructor || typeof target.dispatchEvent !== 'function') throw new Error('Local approval event target is unavailable');
    const event = new EventConstructor('gdas:human-approval-requested', {
      detail: { intentHash: intent.intentHash, pathway: intent.pathway ?? 'crypto' },
      bubbles: false,
      cancelable: false
    });
    target.dispatchEvent(event);
    return event;
  }

  function init(document, host) {
    const state = { ledgerEntries: [], ledgerIntegrity: null, evidenceIndex: null, queueState: null, dashboardState: null, activeIntent: null };
    const byId = (id) => document.getElementById(id);
    const toast = (message) => {
      const element = byId('toast');
      if (!element) return;
      element.textContent = message;
      element.classList.add('is-visible');
      host.clearTimeout(element._timer);
      element._timer = host.setTimeout(() => element.classList.remove('is-visible'), 3000);
    };
    const statusClass = (value) => {
      const normalized = String(value ?? '').toLowerCase();
      if (normalized.includes('eligible') || normalized.includes('confirmed') || normalized === 'completed' || normalized === 'verified') return 'eligible';
      if (normalized.includes('pending') || normalized.includes('review') || normalized.includes('queued') || normalized.includes('prepared')) return 'pending';
      if (normalized.includes('ineligible') || normalized.includes('blocked') || normalized.includes('failed') || normalized.includes('uncertain')) return 'blocked';
      return '';
    };
    const setText = (id, value) => { const element = byId(id); if (element) element.textContent = String(value); };
    const label = (value) => escapeHtml(value || 'Unknown');
    const setEmpty = (id, visible) => { const element = byId(id); if (element) element.hidden = !visible; };

    function render() {
      const model = buildDashboardModel(state);
      setText('report-date', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date()));
      setText('metric-receipts', model.confirmedReceipts.length);
      setText('metric-receipts-note', model.confirmedReceipts.length ? 'Confirmed on-chain / account receipts' : 'No confirmed receipts recorded');
      setText('metric-pending', model.pendingClaims.length);
      setText('metric-locked', model.lockedAssets.length);
      setText('metric-speculative', model.speculativeTokens.length);
      setText('metric-realized', model.realizedTotal);
      setText('metric-income-note', model.zeroConfirmedEarnings ? 'Zero confirmed earnings' : `${Object.keys(model.realizedProceeds).length} realized asset unit(s)`);
      setText('earnings-headline', state.ledgerIntegrity?.valid === false ? 'Earnings unverified' : model.zeroConfirmedEarnings ? 'Zero confirmed earnings' : `${model.confirmedReceipts.length} confirmed receipt(s)`);
      setText('earnings-copy', state.ledgerIntegrity?.valid === false ? 'Ledger integrity failed. No figures are shown as verified.' : model.zeroConfirmedEarnings ? 'No confirmed payouts are present in the verified local ledger.' : `Realized proceeds: ${model.realizedTotal}. Confirmed receipts remain separate from realized income.`);
      setText('summary-advertised', model.advertised);
      setText('summary-completed', model.completedRewards);
      setText('summary-approved', model.approvedClaims.length);
      setText('summary-pending-receipts', model.pendingReceipts.length);
      setText('summary-transferable', model.transferableBalances.length);
      setText('summary-withdrawable', model.withdrawableBalances.length);
      setText('ledger-state', state.ledgerIntegrity ? (model.integrityValid ? 'Integrity verified' : 'Integrity failed') : 'No ledger');
      setText('integrity-label', state.ledgerIntegrity ? (model.integrityValid ? 'Verified' : 'Failed') : 'Not loaded');
      setText('discovery-count', model.opportunities.length);
      setText('claim-count', model.claimIntents.length);
      setText('crypto-intents', model.claimIntents.filter((entry) => entry.type === 'claim_intent_prepared').length);
      setText('usd-intents', model.claimIntents.filter((entry) => entry.type === 'virtual_usd_claim_prepared').length);

      const totalTasks = Object.values(model.queueCounts).reduce((sum, count) => sum + count, 0);
      setText('queue-total', `${totalTasks} task${totalTasks === 1 ? '' : 's'}`);
      const queueMax = Math.max(1, ...Object.values(model.queueCounts));
      for (const queueState of ['queued', 'completed', 'blocked']) {
        setText(`queue-${queueState}`, model.queueCounts[queueState]);
        const bar = byId(`bar-${queueState}`);
        if (bar) bar.style.width = `${Math.round(model.queueCounts[queueState] / queueMax * 100)}%`;
      }
      const failed = model.queueCounts.failed + model.queueCounts.expired;
      setText('queue-failed', failed);
      const failedBar = byId('bar-failed');
      if (failedBar) failedBar.style.width = `${Math.round(failed / queueMax * 100)}%`;

      const healthTitle = byId('health-title');
      const healthDescription = byId('health-description');
      const healthIcon = document.querySelector('.health-icon');
      const policyStatus = byId('policy-status');
      if (!state.imported) {
        if (healthTitle) healthTitle.textContent = 'State not loaded';
        if (healthDescription) healthDescription.textContent = 'Choose local ledger or state files to populate this dashboard. No remote requests are made.';
        if (healthIcon) healthIcon.textContent = '·';
        if (policyStatus) { policyStatus.textContent = 'READ ONLY'; policyStatus.className = 'status-pill status-neutral'; }
      } else if (state.ledgerIntegrity && !model.integrityValid) {
        if (healthTitle) healthTitle.textContent = 'Audit integrity check failed';
        if (healthDescription) healthDescription.textContent = state.ledgerIntegrity.error || 'Ledger entries are not displayed as verified results.';
        if (healthIcon) { healthIcon.textContent = '!'; healthIcon.classList.add('health-error'); }
        if (policyStatus) { policyStatus.textContent = 'BLOCKED'; policyStatus.className = 'status-pill status-bad'; }
      } else {
        if (healthTitle) healthTitle.textContent = 'Local state loaded';
        if (healthDescription) healthDescription.textContent = state.ledgerIntegrity ? `${state.ledgerIntegrity.checkedEntries} ledger events verified locally. Imported data is read-only.` : 'State JSON loaded locally; no audit ledger was provided for integrity verification.';
        if (healthIcon) { healthIcon.textContent = '✓'; healthIcon.classList.remove('health-error'); }
        if (policyStatus) { policyStatus.textContent = 'READ ONLY'; policyStatus.className = 'status-pill status-ok'; }
      }

      const rows = model.opportunities.map((item) => `<tr><td><strong>${label(item.title ?? item.id)}</strong><small>${label(item.id)}</small></td><td><strong>${label(item.sourceName ?? item.sourceId)}</strong><small>${label(item.sourceUrl ?? '')}</small></td><td><span class="table-status ${statusClass(item.eligibilityStatus)}">${label(item.eligibilityStatus ?? 'UNVERIFIED')}</span></td><td>${Number.isFinite(item.score) ? escapeHtml(item.score) : '—'}</td><td><span class="table-status ${statusClass(item.taskState)}">${label(item.taskState)}</span></td><td>${label(item.evidenceStatus ?? 'Unverified')}</td></tr>`).join('');
      const opportunityRows = byId('opportunity-rows');
      if (opportunityRows) opportunityRows.innerHTML = rows;
      setEmpty('opportunity-empty', model.opportunities.length === 0);

      const intents = model.claimIntents.map((entry) => {
        const details = entry.details ?? {};
        const pathway = entry.type === 'virtual_usd_claim_prepared' ? 'Virtual USD' : 'Crypto wallet';
        const status = entry.type.replaceAll('_', ' ');
        const amount = details.amountAtomic ? `USD atomic ${details.amountAtomic}` : details.fee?.amountAtomic ? `Fee ${details.fee.amountAtomic} ${details.fee.assetSymbol}` : details.network ?? '—';
        const feeVerified = details.fee ? 'Evidence captured' : details.feeAssessment?.complete ? 'Fee screen passed' : 'Review required';
        const canRequest = entry.type === 'claim_intent_prepared';
        const intentHash = details.intentHash ?? '';
        return `<tr><td><strong>${label(entry.rewardId)}</strong><small>${label(details.claimId ?? entry.eventId)}</small></td><td>${pathway}</td><td><span class="table-status ${statusClass(entry.type)}">${label(status)}</span></td><td>${label(feeVerified)}</td><td>${label(amount)}</td><td>${canRequest ? `<button class="approval-trigger" type="button" data-intent-hash="${escapeHtml(intentHash)}">Review intent</button>` : '<span class="table-status">No action</span>'}</td></tr>`;
      }).join('');
      const claimRows = byId('claim-rows');
      if (claimRows) claimRows.innerHTML = intents;
      setEmpty('claim-empty', model.claimIntents.length === 0);
    }

    async function readJsonFile(file) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.jsonl') || file.name.toLowerCase().endsWith('.ndjson')) return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      return JSON.parse(text);
    }

    async function handleImport(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = await readJsonFile(file);
        if (event.target.id === 'ledger-file') {
          state.ledgerEntries = parsed;
          state.ledgerIntegrity = await verifyLedger(parsed);
        } else if (Array.isArray(parsed.tasks) && parsed.schemaVersion === 1) state.queueState = parsed;
        else if (parsed.records && parsed.sources) state.evidenceIndex = parsed;
        else state.dashboardState = parsed;
        render();
        toast(state.ledgerIntegrity?.valid === false ? state.ledgerIntegrity.error : `${file.name} loaded locally.`);
      } catch (error) {
        toast(`Could not load file: ${error.message}`);
      } finally {
        event.target.value = '';
      }
    }

    function switchTab(name) {
      for (const button of document.querySelectorAll('[data-tab-target]')) {
        const active = button.dataset.tabTarget === name;
        button.classList.toggle('is-active', active);
        button.classList.toggle('is-selected', active);
        if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
      }
      for (const panel of document.querySelectorAll('[data-panel]')) {
        const active = panel.dataset.panel === name;
        panel.classList.toggle('is-visible', active);
        panel.hidden = !active;
      }
    }

    document.querySelectorAll('[data-tab-target]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tabTarget)));
    byId('ledger-file')?.addEventListener('change', handleImport);
    byId('state-file')?.addEventListener('change', handleImport);
    byId('claim-rows')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-intent-hash]');
      if (!button) return;
      state.activeIntent = { intentHash: button.dataset.intentHash, pathway: 'crypto' };
      byId('approval-detail').textContent = `Intent ${state.activeIntent.intentHash.slice(0, 18)}… is prepared. Review the fee evidence and transaction in the verified local ledger before proceeding.`;
      byId('approval-status').textContent = '';
      byId('approval-dialog').showModal();
    });
    byId('request-approval')?.addEventListener('click', () => {
      try {
        approvalRequest(host, state.activeIntent);
        byId('approval-status').textContent = 'Local review event raised. No approval, signature, submission, or asset movement occurred.';
        toast('Review request emitted locally; no signer is connected.');
      } catch (error) {
        byId('approval-status').textContent = error.message;
      }
    });
    document.querySelectorAll('.dialog-close').forEach((button) => button.addEventListener('click', () => byId('approval-dialog').close()));
    render();
  }

  const api = { amountText, approvalRequest, buildDashboardModel, canonical, escapeHtml, verifyLedger };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.document) init(root.document, root);
})(globalThis);
