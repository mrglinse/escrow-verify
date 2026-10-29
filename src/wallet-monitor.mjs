import { createHash } from 'node:crypto';

const SECRET_FIELD = /(seed|mnemonic|private.?key|passphrase|password|credential|api.?key|secret)/i;
const WRITE_METHOD = /^(send|sign|broadcast|transfer|submit|write|purchase|swap|approve|withdraw|deposit)/i;

function rejectSecretFields(value, location) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`Wallet monitor refuses secret-bearing field: ${location}.${key}`);
    rejectSecretFields(child, `${location}.${key}`);
  }
}

function addressHash(address) {
  return createHash('sha256').update(address.toLowerCase()).digest('hex');
}

export class ReadOnlyWalletMonitor {
  #addresses;
  #client;
  #tracker;
  #minimumConfirmations;

  constructor({ addresses, publicClient, tracker, minimumConfirmations = 1 } = {}) {
    if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('At least one designated receiving address is required');
    if (!publicClient || publicClient.access !== 'public-free' || typeof publicClient.getAddressActivity !== 'function') {
      throw new Error('A free public read-only client with getAddressActivity is required');
    }
    if (Object.keys(publicClient).some((key) => WRITE_METHOD.test(key))) {
      throw new Error('Wallet monitor refuses a client exposing transaction or signing methods');
    }
    rejectSecretFields(addresses, 'addresses');
    rejectSecretFields(publicClient, 'publicClient');
    for (const key of Object.keys(publicClient)) {
      if (!['access', 'getAddressActivity'].includes(key)) throw new Error(`Unsupported public client field: ${key}`);
    }
    for (const address of addresses) {
      if (!address || typeof address.id !== 'string' || !address.id || typeof address.network !== 'string' || !address.network || typeof address.address !== 'string' || !address.address.trim()) {
        throw new Error('Each receiving address requires id, network, and address');
      }
      for (const key of Object.keys(address)) {
        if (!['id', 'network', 'address'].includes(key)) throw new Error(`Unsupported receiving address field: ${key}`);
      }
    }
    if (!tracker || typeof tracker.recordReceipt !== 'function' || typeof tracker.recordBalance !== 'function') throw new TypeError('A RewardTracker-compatible tracker is required');
    this.#addresses = addresses.map((item) => Object.freeze({ ...item }));
    this.#client = publicClient;
    this.#tracker = tracker;
    this.#minimumConfirmations = minimumConfirmations;
  }

  async scan({ rewardId, at = new Date() } = {}) {
    if (typeof rewardId !== 'string' || !rewardId.trim()) throw new Error('A reward ID is required for wallet observations');
    const observedAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
    const result = { addresses: [], pendingReceipts: 0, confirmedReceipts: 0, balancesObserved: 0, ledgerEvents: 0 };

    for (const designated of this.#addresses) {
      const response = await this.#client.getAddressActivity(designated.address, { network: designated.network });
      rejectSecretFields(response, 'public response');
      if (!response || !Array.isArray(response.transactions) || !Array.isArray(response.balances) || typeof response.providerId !== 'string' || !/^[a-z\d._-]{1,80}$/i.test(response.providerId) || typeof response.reference !== 'string' || !/^[a-z\d._:/-]{1,256}$/i.test(response.reference)) {
        throw new Error('Public client returned an invalid read-only activity response');
      }
      const evidence = { providerId: response.providerId, reference: response.reference, observedAt };
      const addressResult = { addressId: designated.id, addressHash: addressHash(designated.address), transactions: 0, confirmed: 0, pending: 0, balances: 0 };

      for (const transaction of response.transactions) {
        if (transaction.direction !== 'received' || transaction.toAddress !== designated.address) {
          throw new Error(`Public client returned a transaction not attributed to designated address ${designated.id}`);
        }
        if (transaction.network !== undefined && transaction.network !== designated.network) {
          throw new Error(`Public client returned a transaction on an unexpected network for ${designated.id}`);
        }
        const recorded = await this.#tracker.recordReceipt({
          rewardId,
          addressId: designated.id,
          network: designated.network,
          transactionHash: transaction.transactionHash,
          assetSymbol: transaction.assetSymbol,
          assetClass: transaction.assetClass,
          amountAtomic: transaction.amountAtomic,
          decimals: transaction.decimals,
          confirmations: transaction.confirmations,
          claimId: transaction.claimId ?? null,
          fee: transaction.fee ?? null,
          transferable: transaction.transferable ?? false,
          withdrawable: transaction.withdrawable ?? false,
          lockedUntil: transaction.lockedUntil ?? null,
          evidence,
          at: observedAt
        });
        const events = Array.isArray(recorded) ? recorded : [recorded];
        addressResult.transactions += 1;
        addressResult.confirmed += events.some((event) => event.type === 'asset_receipt_confirmed') ? 1 : 0;
        addressResult.pending += events.some((event) => event.type === 'receipt_pending') ? 1 : 0;
        result.ledgerEvents += events.length;
      }

      for (const balance of response.balances) {
        const events = await this.#tracker.recordBalance({
          rewardId,
          addressId: designated.id,
          network: designated.network,
          ...balance,
          evidence,
          at: observedAt
        });
        addressResult.balances += 1;
        result.ledgerEvents += events.length;
      }
      result.pendingReceipts += addressResult.pending;
      result.confirmedReceipts += addressResult.confirmed;
      result.balancesObserved += addressResult.balances;
      result.addresses.push(addressResult);
    }
    return result;
  }
}