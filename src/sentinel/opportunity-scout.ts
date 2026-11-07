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

function isValidBounty(item: any): boolean {
  const bodyText = (item.body || '').toLowerCase();
  const titleText = (item.title || '').toLowerCase();
  const content = `${titleText} ${bodyText}`;

  // Rule 1: REJECT SCAMS (Demands upfront deposit, gas fee, or off-platform chat)
  const scamTriggers = ['pay upfront', 'deposit', 'registration fee', 't.me/', 'telegram', 'whatsapp', 'pay first'];
  if (scamTriggers.some(trigger => content.includes(trigger))) {
    return false;
  }

  // Rule 2: REQUIRE VERIFIED ESCROW OR CASH MARKER
  const escrowPlatforms = ['algora', 'polar.sh', 'gitcoin', 'bountycaster', '$'];
  return escrowPlatforms.some(platform => content.includes(platform));
}

async function fetchVerifiedBounties(): Promise<DiscoveredIssue[]> {
  console.log('🔍 Scouting High-Acceptance Web3 & TypeScript Bounties...');
  
  // Query targeting Algora, Polar.sh, and verified TypeScript bounty labels
  const query = encodeURIComponent('is:issue is:open (label:bounty OR label:algora OR "polar.sh") language:TypeScript');
  const url = `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=10`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Sentinel-Verified-Scout',
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);

    const data = await response.json();
    const items = data.items || [];

    // Apply Scam Filter
    const verifiedItems = items.filter(isValidBounty);
    console.log(`✅ Filtered ${items.length} raw issues down to ${verifiedItems.length} verified bounties.`);

    return verifiedItems.map((item: any) => ({
      id: `gh-${item.id}`,
      title: item.title,
      repo: item.repository_url.replace('https://api.github.com/repos/', ''),
      url: item.html_url,
      body: item.body || '',
      reward: 'Verified Escrow / Cash Attached',
      status: 'pending' as const
    }));
  } catch (error) {
    console.warn('⚠️ Scout fetch warning:', error);
    return [];
  }
}

async function runScout() {
  const issues = await fetchVerifiedBounties();
  const outputPath = path.join(process.cwd(), 'src/sentinel/data/discovered_issues.json');
  
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(issues, null, 2));
  console.log(`🎉 Saved ${issues.length} verified bounty tasks to queue.`);
}

runScout();
