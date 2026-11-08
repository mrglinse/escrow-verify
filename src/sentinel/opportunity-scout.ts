import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

interface CryptoBountyTask {
  issueUrl: string;
  platform: 'opire' | 'gitwork';
  rewardAmount: number;
  currency: string;
  isEscrowFunded: boolean;
}

async function scoutCryptoBounties() {
  console.log('🔍 Running Crypto-Native Anti-Scam Scout...');

  const verifiedBounties: CryptoBountyTask[] = [];

  // 1. Fetch active issues from Opire
  try {
    const res = await fetch('https://api.opire.io/bounties');
    const opireData = await res.json();
    // Parse and validate funded escrows
  } catch (err) {
    console.error('⚠️ Opire API connection skipped:', err);
  }

  // 2. Fetch active issues from GitWork
  try {
    const res = await fetch('https://gitwork.io/api/bounties');
    const gitworkData = await res.json();
    // Parse and validate USDC/SOL escrow status
  } catch (err) {
    console.error('⚠️ GitWork API connection skipped:', err);
  }

  // Insert valid, funded items into Supabase queue
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

scoutCryptoBounties();
