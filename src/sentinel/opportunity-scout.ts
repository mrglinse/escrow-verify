
import fs from 'fs';
import path from 'path';

interface DiscoveredIssue {
  id: string;
  title: string;
  repo: string;
  url: string;
  body: string;
  reward?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

async function fetchLiveBounties(): Promise<DiscoveredIssue[]> {
  console.log('🔍 Searching live GitHub repositories for open TypeScript bounties...');
  
  const query = encodeURIComponent('is:issue is:open label:bounty language:TypeScript');
  const url = `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=5`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Sentinel-Bounty-Scout',
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned status ${response.status}`);
    }

    const data = await response.json();
    const items = data.items || [];

    return items.map((item: any) => ({
      id: `gh-${item.id}`,
      title: item.title,
      repo: item.repository_url.replace('https://api.github.com/repos/', ''),
      url: item.html_url,
      body: item.body || 'No description provided.',
      reward: 'Web3 / Open Source Escrow',
      status: 'pending' as const
    }));
  } catch (error) {
    console.warn('⚠️ Could not fetch live GitHub API, falling back to local registry:', error);
    return [];
  }
}

async function runScout() {
  const issues = await fetchLiveBounties();
  const outputPath = path.join(process.cwd(), 'src/sentinel/data/discovered_issues.json');
  
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (issues.length > 0) {
    fs.writeFileSync(outputPath, JSON.stringify(issues, null, 2));
    console.log(`✅ Discovered and saved ${issues.length} live bounties to ${outputPath}`);
  } else {
    console.log('ℹ️ No new live issues fetched in this run.');
  }
}

runScout();

