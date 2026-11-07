import fs from 'fs';
import path from 'path';

export async function fetchGithubBounties() {
  console.log('🔍 [Scout 3: GitHub Native] Searching open web3/typescript bounties...');
  try {
    const query = encodeURIComponent('is:issue is:open label:bounty language:typescript');
    const res = await fetch(`https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=15`, {
      headers: {
        'User-Agent': 'GDAS-Sentinel/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) return [];
    const data = await res.json();

    return (data.items || []).map((item: any) => ({
      id: `gh-${item.id}`,
      title: item.title,
      repo: item.html_url.replace('https://github.com/', '').split('/issues')[0],
      url: item.html_url,
      body: item.body || '',
      reward: 'GitHub Bounty',
      source: 'github',
      status: 'pending',
      discovered_at: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('❌ [Github Scout Error]:', err);
    return [];
  }
}

export default fetchGithubBounties;
