import fs from 'fs';
import path from 'path';

export async function fetchAlgoraBounties() {
  console.log('🔍 [Scout 1: Algora] Fetching active Algora bounties...');
  try {
    const res = await fetch('https://algora.io/api/bounties?status=open', {
      headers: { 'User-Agent': 'GDAS-Sentinel/1.0' },
    });

    if (!res.ok) {
      console.warn(`⚠️ Algora returned status ${res.status}`);
      return [];
    }

    const data = await res.json();
    const bounties = data.bounties || [];

    return bounties
      .filter((b: any) => {
        const lang = (b.language || 'TypeScript').toLowerCase();
        return lang.includes('typescript') || lang.includes('javascript') || lang.includes('node');
      })
      .map((b: any) => ({
        id: `algora-${b.id}`,
        title: b.title,
        repo: b.repository_full_name,
        url: b.url,
        body: b.description || '',
        reward: b.amount_in_cents ? `$${b.amount_in_cents / 100}` : 'Algora Bounty',
        source: 'algora',
        status: 'pending',
        discoveredAt: new Date().toISOString(),
      }));
  } catch (err) {
    console.error('❌ [Algora Scout Error]:', err);
    return [];
  }
}
