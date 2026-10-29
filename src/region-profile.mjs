const PROFILE_KINDS = new Set(['local', 'container', 'virtual-machine', 'remote']);
const ENDPOINT_ROLES = new Set(['source', 'evidence-storage', 'network-egress']);

export const REGION_PROFILE_SCOPE = 'execution-only';

export const REGION_ISOLATION_RULES = Object.freeze([
  'Execution region is not legal residency.',
  'Locale and time zone are not legal residency or tax status.',
  'Network endpoints are not legal residency, tax status, or identity verification.'
]);

function exactKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} field is not allowed: ${key}`);
    }
  }
}

function freezeDeep(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) freezeDeep(child);
  }
  return Object.freeze(value);
}

export function createRegionProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Region profile must be an object');
  }
  exactKeys(input, new Set(['id', 'scope', 'executionEnvironment', 'locale', 'timeZone', 'networkEndpoints']), 'Profile');
  if (input.scope !== undefined && input.scope !== REGION_PROFILE_SCOPE) {
    throw new Error('Region profile scope must be execution-only');
  }
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.id)) {
    throw new Error('Profile id must be a non-empty identifier');
  }

  const environment = input.executionEnvironment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('Execution environment is required');
  }
  exactKeys(environment, new Set(['kind', 'virtualRegion']), 'Execution environment');
  if (!PROFILE_KINDS.has(environment.kind)) throw new Error('Unsupported execution environment kind');
  if (typeof environment.virtualRegion !== 'string' || !environment.virtualRegion.trim()) {
    throw new Error('Virtual execution region must be explicit');
  }

  if (typeof input.locale !== 'string' || !input.locale.trim()) throw new Error('Locale must be explicit');
  let locale;
  try {
    locale = Intl.getCanonicalLocales(input.locale)[0];
  } catch {
    throw new Error('Invalid locale');
  }

  if (typeof input.timeZone !== 'string' || !input.timeZone.trim()) throw new Error('Time zone must be explicit');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone });
  } catch {
    throw new Error('Invalid time zone');
  }

  if (!Array.isArray(input.networkEndpoints)) throw new Error('Network endpoints must be an array');
  const endpointIds = new Set();
  const networkEndpoints = input.networkEndpoints.map((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
      throw new Error('Network endpoint must be an object');
    }
    exactKeys(endpoint, new Set(['id', 'role', 'url']), 'Network endpoint');
    if (typeof endpoint.id !== 'string' || !endpoint.id.trim() || endpointIds.has(endpoint.id)) {
      throw new Error('Network endpoint id must be present and unique');
    }
    endpointIds.add(endpoint.id);
    if (!ENDPOINT_ROLES.has(endpoint.role)) throw new Error(`Unsupported network endpoint role: ${endpoint.role}`);

    let url;
    try {
      url = new URL(endpoint.url);
    } catch {
      throw new Error(`Invalid network endpoint URL: ${endpoint.id}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error(`Network endpoint must be a credential-free HTTPS URL: ${endpoint.id}`);
    }
    return { id: endpoint.id, role: endpoint.role, url: url.href };
  });

  return freezeDeep({
    id: input.id,
    scope: REGION_PROFILE_SCOPE,
    executionEnvironment: {
      kind: environment.kind,
      virtualRegion: environment.virtualRegion.trim()
    },
    locale,
    timeZone: input.timeZone,
    networkEndpoints
  });
}

export class RegionProfileManager {
  #profiles = new Map();

  register(input) {
    const profile = createRegionProfile(input);
    if (this.#profiles.has(profile.id)) throw new Error(`Region profile already exists: ${profile.id}`);
    this.#profiles.set(profile.id, profile);
    return profile;
  }

  get(profileId) {
    const profile = this.#profiles.get(profileId);
    if (!profile) throw new Error(`Unknown region profile: ${profileId}`);
    return profile;
  }

  list() {
    return [...this.#profiles.values()];
  }
}