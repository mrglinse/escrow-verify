import fs from 'fs';
import path from 'path';

export async function fetchOpireBounties() {
  console.log('🔍 [Scout 2: Opire/GitHub] Querying Opire rewarded developer issues...');
  try {
    const query = encodeURIComponent('is:issue is:open label:opire language:typescript');
    const res = await fetch(`https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=10`, {
      headers: {
        'User-Agent': 'GDAS-Sentinel/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) return [];
    const data = await res.json();

    return (data.items || []).map((item: any) => ({
      id: `opire-${item.id}`,
      title: item.title,
      repo: item.html_url.replace('https://github.com/', '').split('/issues/')[0],
      url: item.html_url,
      body: item.body || '',
      reward: 'Opire Bounty',
      source: 'opire',
      status: 'pending',
      discoveredAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('❌ [Opire Scout Error]:', err);
    return [];
  }
}
