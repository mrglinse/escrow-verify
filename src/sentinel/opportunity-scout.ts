
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

interface BountyTask {
  issueUrl: string;
  platform: string;
  rewardAmount: number;
  currency: string;
  isEscrowFunded: boolean;
}

async function scoutOpportunities() {
  console.log('🔍 Running Crypto-Native Opportunity Scout (Opire Focus)...');

  const verifiedBounties: BountyTask[] = [];

  // 1. Fetch active issues from Opire API
  try {
    console.log('📡 Fetching active tasks from Opire...');
    const response = await fetch('https://api.opire.io/bounties');
    const data = await response.json();
    
    // Process and validate that the bounty escrow is active & funded
    // (Adjust parser keys based on Opire's exact response payload structure)
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.funded && item.reward > 0) {
          verifiedBounties.push({
            issueUrl: item.issueUrl || item.url,
            platform: 'opire',
            rewardAmount: item.reward,
            currency: item.currency || 'USDC',
            isEscrowFunded: true
          });
        }
      }
    }
  } catch (err) {
    console.error('⚠️ Opire fetch warning:', err);
  }

  // 2. Save verified tasks into Supabase queue
  for (const bounty of verifiedBounties) {
    if (bounty.isEscrowFunded && bounty.rewardAmount > 0) {
      await supabase.from('sentinel_queue').upsert({
        platform: bounty.platform,
        issue_url: bounty.issueUrl,
        reward: bounty.rewardAmount,
        currency: bounty.currency,
        status: 'queued'
      }, { onConflict: 'issue_url' });
    }
  }

  console.log(`✅ Scout complete. Queued ${verifiedBounties.length} verified crypto tasks.`);
}

scoutOpportunities();
