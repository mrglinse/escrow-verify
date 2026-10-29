function inUtcDay(timestamp, date) {
  return typeof timestamp === 'string' && timestamp.slice(0, 10) === date;
}

function decimalString(amountAtomic, decimals) {
  const negative = amountAtomic.startsWith('-');
  const digits = (negative ? amountAtomic.slice(1) : amountAtomic).padStart(decimals + 1, '0');
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function addAmount(totals, asset, amountAtomic, decimals) {
  const current = totals[asset];
  if (!current) {
    totals[asset] = { atomic: BigInt(amountAtomic), decimals };
    return;
  }
  const scale = Math.max(current.decimals, decimals);
  current.atomic = current.atomic * (10n ** BigInt(scale - current.decimals)) + BigInt(amountAtomic) * (10n ** BigInt(scale - decimals));
  current.decimals = scale;
}

function formattedTotals(totals) {
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)).map(([asset, value]) => [asset, decimalString(value.atomic.toString(), value.decimals)]));
}

export async function generateDailyReport({
  date = new Date().toISOString().slice(0, 10),
  discoverySummary = {},
  taskResults = [],
  auditLedger,
  systemHealth = {}
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error('Report date must be YYYY-MM-DD');
  if (!auditLedger || typeof auditLedger.verify !== 'function') throw new TypeError('An AuditLedger-compatible ledger is required');
  const verification = await auditLedger.verify();
  const allEvents = verification.valid ? verification.entries : [];
  const events = allEvents.filter((entry) => inUtcDay(entry.timestamp, date));
  const tasks = taskResults.filter((task) => inUtcDay(task.completedAt ?? task.updatedAt, date));
  const observedFees = {};
  const realized = {};
  const realizedEvents = events.filter((entry) => entry.type === 'realized_proceeds');
  const receiptStates = new Map();
  const claimStates = new Map();

  for (const entry of allEvents) {
    if (['receipt_pending', 'asset_receipt_confirmed'].includes(entry.type)) {
      const { network, transactionHash, addressId } = entry.details;
      receiptStates.set(`${network}:${transactionHash}:${addressId}`, entry);
    }
    if (['claim_pending', 'claim_approved'].includes(entry.type)) {
      claimStates.set(`${entry.rewardId}:${entry.details.claimId}`, entry);
    }
  }
  const dailyReceiptStates = [...receiptStates.values()].filter((entry) => inUtcDay(entry.timestamp, date));

  for (const entry of dailyReceiptStates) {
    if (entry.type === 'asset_receipt_confirmed' && entry.details.fee?.payer && entry.details.fee.payer !== 'unknown') {
      const fee = entry.details.fee;
      addAmount(observedFees, fee.assetSymbol, fee.amountAtomic, fee.decimals);
    }
  }
  for (const entry of realizedEvents) addAmount(realized, entry.details.currency, entry.details.amountAtomic, entry.details.decimals);
  const netIncome = Object.fromEntries(Object.entries(realized).map(([asset, value]) => [asset, { ...value }]));
  for (const entry of dailyReceiptStates) {
    if (entry.type !== 'asset_receipt_confirmed' || entry.details.assetClass !== 'fiat' || entry.details.fee?.payer !== 'recipient') continue;
    const fee = entry.details.fee;
    const current = netIncome[entry.details.assetSymbol];
    if (!current || fee.assetSymbol !== entry.details.assetSymbol) continue;
    const scale = Math.max(current.decimals, fee.decimals);
    current.atomic = current.atomic * (10n ** BigInt(scale - current.decimals)) - BigInt(fee.amountAtomic) * (10n ** BigInt(scale - fee.decimals));
    current.decimals = scale;
  }

  const earnings = formattedTotals(realized);
  const healthEntries = Object.entries(systemHealth);
  const health = {
    status: !verification.valid || healthEntries.some(([, status]) => status === 'error' || status === 'degraded') ? 'degraded' : healthEntries.length ? 'healthy' : 'unknown',
    checks: systemHealth,
    auditLedgerValid: verification.valid,
    auditEntriesChecked: verification.checkedEntries
  };
  const confirmedReceiptCount = dailyReceiptStates.filter((entry) => entry.type === 'asset_receipt_confirmed').length;
  const zeroEarnings = verification.valid && confirmedReceiptCount === 0;

  return {
    date,
    generatedAt: new Date().toISOString(),
    summary: !verification.valid
      ? 'Confirmed earnings could not be verified because the audit ledger failed integrity checks.'
      : zeroEarnings
        ? 'Zero confirmed earnings for this reporting period.'
        : `Confirmed asset receipts: ${confirmedReceiptCount}; realized proceeds recorded in ${Object.keys(earnings).length} currency/asset unit(s).`,
    discovery: {
      sourcesChecked: discoverySummary.sources?.length ?? 0,
      discovered: discoverySummary.discovered ?? 0,
      duplicates: discoverySummary.duplicates ?? 0,
      expired: discoverySummary.expired ?? 0
    },
    taskExecution: {
      completed: tasks.filter((task) => task.state === 'completed').length,
      failed: tasks.filter((task) => task.state === 'failed').length,
      blocked: tasks.filter((task) => task.state === 'blocked').length,
      expired: tasks.filter((task) => task.state === 'expired').length
    },
    rewards: {
      advertised: events.filter((entry) => entry.type === 'reward_advertised').length,
      pendingRewards: events.filter((entry) => entry.type === 'reward_pending').length,
      completedTasks: events.filter((entry) => entry.type === 'task_completed').length,
      approvedClaims: events.filter((entry) => entry.type === 'claim_approved').length,
      pendingClaims: [...claimStates.values()].filter((entry) => entry.type === 'claim_pending' && inUtcDay(entry.timestamp, date)).length,
      confirmedAssetReceipts: confirmedReceiptCount,
      pendingReceipts: dailyReceiptStates.filter((entry) => entry.type === 'receipt_pending').length,
      lockedAssets: events.filter((entry) => entry.type === 'asset_locked').length,
      transferableBalances: events.filter((entry) => entry.type === 'asset_transferable').length,
      speculativeTokens: events.filter((entry) => entry.type === 'speculative_token').length,
      realizedProceeds: realizedEvents.length
    },
    observedFees: formattedTotals(observedFees),
    realizedProceedsByCurrency: earnings,
    netRealizedIncomeByCurrency: formattedTotals(netIncome),
    zeroConfirmedEarnings: zeroEarnings,
    systemHealth: health
  };
}