import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Retrieve private key securely from GitHub Actions environment secrets
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
// Set your target network RPC (e.g., Ethereum, Arbitrum, or Base RPC URL)
const RPC_URL = process.env.RPC_URL || 'https://rpc.ankr.com/eth'; 

// Standard Escrow Claim ABI interface placeholder
const ESCROW_ABI = [
  "function claimBounty(uint256 bountyId) external"
];

async function processMergedBounties() {
  console.log('💰 Scanning for merged bounties ready for payout claim...');

  // 1. Find tasks in Supabase marked as 'merged' but not yet claimed
  const { data: tasks, error } = await supabase
    .from('sentinel_queue')
    .select('*')
    .eq('status', 'merged');

  if (error || !tasks || tasks.length === 0) {
    console.log('📭 No merged payouts pending claim.');
    return;
  }

  if (!PRIVATE_KEY) {
    console.error('❌ CRITICAL: WALLET_PRIVATE_KEY environment variable is missing!');
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  for (const task of tasks) {
    console.log(`💸 Processing payout claim for task ${task.id} on ${task.platform}`);

    try {
      // 2. Connect to the escrow contract and execute claim
      const escrowContract = new ethers.Contract(task.escrow_contract_address, ESCROW_ABI, wallet);
      const tx = await escrowContract.claimBounty(task.issue_id);
      
      console.log(`🔗 Transaction broadcasted: ${tx.hash}`);
      await tx.wait(); // Wait for network confirmation

      console.log(`✅ Successfully claimed bounty reward for ${task.issue_url}`);

      // 3. Update Supabase status to claimed
      await supabase
        .from('sentinel_queue')
        .update({ status: 'claimed' })
        .eq('id', task.id);

    } catch (err: any) {
      console.error(`❌ Payout transaction failed for task ${task.id}:`, err.message);
      await supabase
        .from('sentinel_queue')
        .update({ status: 'payout_failed', error_log: err.message })
        .eq('id', task.id);
    }
  }
}

processMergedBounties();
        
