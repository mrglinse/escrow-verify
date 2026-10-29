const REQUIRED_POLICY_FLAGS = Object.freeze([
  'requiresStartingCapital',
  'requiresDeposit',
  'requiresFee',
  'requiresTokenPurchase',
  'requiresTrading',
  'requiresPaidApi',
  'requiresUpgrade',
  'requiresSpending'
]);
const ALLOWED_POLICY_FIELDS = new Set([...REQUIRED_POLICY_FLAGS, 'costs']);

const PROHIBITED_ACTIONS = new Set([
  'deposit', 'token-purchase', 'purchase-token', 'trade', 'trading', 'paid-api',
  'paid-upgrade', 'upgrade', 'payment', 'purchase', 'spend', 'fee', 'transfer-funds'
]);
const APPROVED_ACTIONS = new Set(['read-public-source', 'analyze', 'draft', 'store-evidence', 'free-application', 'free-task']);

function normalizeAction(action) {
  return String(action).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export class PolicyViolationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyViolationError';
    this.code = code;
  }
}

export class PolicyGuard {
  inspect(task) {
    const reasons = [];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      return { allowed: false, reasons: ['INVALID_TASK'] };
    }

    const declaration = task.policy;
    if (!declaration || typeof declaration !== 'object') {
      return { allowed: false, reasons: ['MISSING_POLICY_DECLARATION'] };
    }
    for (const field of Object.keys(declaration)) {
      if (!ALLOWED_POLICY_FIELDS.has(field)) reasons.push(`UNKNOWN_POLICY_FIELD_${field.toUpperCase()}`);
    }
    for (const flag of REQUIRED_POLICY_FLAGS) {
      if (declaration[flag] !== false) reasons.push(declaration[flag] === true ? `PROHIBITED_${flag.toUpperCase()}` : `UNDECLARED_${flag.toUpperCase()}`);
    }
    if (!Array.isArray(declaration.costs)) {
      reasons.push('UNDECLARED_COSTS');
    } else {
      for (const cost of declaration.costs) {
        if (!cost || typeof cost !== 'object' || !Number.isFinite(cost.amount) || cost.amount !== 0) {
          reasons.push('POSITIVE_OR_UNKNOWN_COST');
          break;
        }
      }
    }

    const actions = task.actions;
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every((action) => typeof action === 'string')) {
      reasons.push('UNDECLARED_ACTIONS');
    } else {
      for (const action of actions) {
        const normalized = normalizeAction(action);
        if (PROHIBITED_ACTIONS.has(normalized)) reasons.push(`PROHIBITED_ACTION_${normalized.toUpperCase().replaceAll('-', '_')}`);
        else if (!APPROVED_ACTIONS.has(normalized)) reasons.push(`UNAPPROVED_ACTION_${normalized.toUpperCase().replaceAll('-', '_')}`);
      }
    }
    return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  assertOperationAllowed(action) {
    const normalized = normalizeAction(action);
    if (PROHIBITED_ACTIONS.has(normalized)) {
      throw new PolicyViolationError('PROHIBITED_OPERATION', `GDAS zero-capital policy blocks ${normalized}`);
    }
    if (!APPROVED_ACTIONS.has(normalized)) {
      throw new PolicyViolationError('UNAPPROVED_OPERATION', `GDAS policy does not allow ${normalized}`);
    }
    return true;
  }

  async perform(task, action, operation, context) {
    const normalized = normalizeAction(action);
    if (!this.inspect(task).allowed || !task.actions.map(normalizeAction).includes(normalized)) {
      throw new PolicyViolationError('POLICY_BLOCKED', `Task is not authorized to perform ${normalized}`);
    }
    this.assertOperationAllowed(normalized);
    if (!APPROVED_ACTIONS.has(normalized)) {
      throw new PolicyViolationError('UNAPPROVED_OPERATION', `GDAS policy does not allow ${normalized}`);
    }
    if (typeof operation !== 'function') throw new TypeError('Guarded operation must be a function');
    return operation(context);
  }

  async execute(task, executor, context) {
    const decision = this.inspect(task);
    if (!decision.allowed) {
      throw new PolicyViolationError('POLICY_BLOCKED', `Task blocked by GDAS policy: ${decision.reasons.join(', ')}`);
    }
    if (typeof executor !== 'function') throw new TypeError('Guarded executor must be a function');
    return executor(context);
  }
}

export const GDAS_TASK_POLICY_TEMPLATE = Object.freeze({
  requiresStartingCapital: false,
  requiresDeposit: false,
  requiresFee: false,
  requiresTokenPurchase: false,
  requiresTrading: false,
  requiresPaidApi: false,
  requiresUpgrade: false,
  requiresSpending: false,
  costs: Object.freeze([])
});