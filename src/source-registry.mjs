export const SOURCES = Object.freeze([
  Object.freeze({
    id: 'ethereum-foundation-blog',
    name: 'Ethereum Foundation Blog',
    url: 'https://blog.ethereum.org/en/feed.xml',
    hostname: 'blog.ethereum.org',
    type: 'rss',
    keywords: Object.freeze(['grant', 'funding', 'fellowship', 'bounty'])
  }),
  Object.freeze({
    id: 'solana-foundation-grants',
    name: 'Solana Foundation Grants',
    url: 'https://solana.org/grants-funding',
    hostname: 'solana.org',
    type: 'html',
    keywords: Object.freeze(['grant', 'funding', 'fellowship', 'bounty'])
  })
]);

const sourceById = new Map(SOURCES.map((source) => [source.id, source]));

export function getSource(sourceId) {
  const source = sourceById.get(sourceId);
  if (!source) {
    throw new Error(`Unknown source: ${sourceId}`);
  }

  validateSource(source);
  return source;
}

export function validateSource(source) {
  if (!source || typeof source !== 'object' || !source.id || !source.url || !source.hostname) {
    throw new Error('Invalid source definition');
  }

  let url;
  try {
    url = new URL(source.url);
  } catch {
    throw new Error(`Invalid source URL for ${source.id}`);
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== source.hostname) {
    throw new Error(`Source URL is not allowed for ${source.id}`);
  }
  if (!['rss', 'html'].includes(source.type)) {
    throw new Error(`Unsupported source type for ${source.id}`);
  }

  return source;
}

export function validateSourceUrl(source, candidateUrl) {
  validateSource(source);
  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    throw new Error(`Invalid URL returned by source ${source.id}`);
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== source.hostname) {
    throw new Error(`Source ${source.id} returned a URL outside its verified host`);
  }

  return url;
}