import { validateSourceUrl } from './source-registry.mjs';

function decodeEntities(value) {
  return value
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cleanText(value) {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(block, names) {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (match) return cleanText(match[1]);
  }
  return '';
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createRssAdapter() {
  return {
    type: 'rss',
    parse(body, source) {
      const entries = [];
      for (const match of body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
        const block = match[1];
        const title = readTag(block, ['title']);
        const url = readTag(block, ['link']);
        if (!title || !url) continue;

        entries.push({
          title,
          url,
          summary: readTag(block, ['description', 'content:encoded']),
          publishedAt: parseDate(readTag(block, ['pubDate', 'published', 'dc:date'])),
          expiresAt: parseDate(readTag(block, ['expiresAt', 'expirationDate', 'expiration']))
        });
      }
      return entries.filter((entry) => source.keywords.some((keyword) => entry.title.toLowerCase().includes(keyword)));
    }
  };
}

export function createHtmlListingAdapter() {
  return {
    type: 'html',
    parse(body, source, sourceUrl) {
      const safeBody = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
      const entries = [];
      for (const match of safeBody.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
        const title = cleanText(match[2]);
        if (!href || !title || !source.keywords.some((keyword) => title.toLowerCase().includes(keyword))) continue;

        let url;
        try {
          url = new URL(decodeEntities(href), sourceUrl).href;
          validateSourceUrl(source, url);
        } catch {
          continue;
        }
        entries.push({ title, url, summary: '', publishedAt: null, expiresAt: null });
      }
      return entries;
    }
  };
}

export function createAdapterRegistry() {
  return new Map([
    ['rss', createRssAdapter()],
    ['html', createHtmlListingAdapter()]
  ]);
}