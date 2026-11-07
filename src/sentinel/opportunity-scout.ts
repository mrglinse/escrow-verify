import { saveBountiesToSupabase } from './supabase-client';
import { fetchAlgoraBounties } from './scout-algora';
import { fetchGithubBounties } from './scout-github';
import { fetchOpireBounties } from './scout-opire';

async function runOpportunityScout() {
  console.log('🔍 [Opportunity Scout] Scanning live Web3 & open-source bounties...');

  try {
    // 1. Gather bounties from active platform connectors
    const algoraTasks = await fetchAlgoraBounties();
    const githubTasks = await fetchGithubBounties();
    const opireTasks = await fetchOpireBounties();

    const allBounties = [...algoraTasks, ...githubTasks, ...opireTasks];
    console.log(`📊 [Opportunity Scout] Total bounties discovered: ${allBounties.length}`);

    if (allBounties.length > 0) {
      // 2. Sync directly to Supabase cloud database
      await saveBountiesToSupabase(allBounties);
    } else {
      console.log('ℹ️ No new bounties found in this scan cycle.');
    }

  } catch (error) {
    console.error('❌ Error during opportunity scout execution:', error);
  }
}

runOpportunityScout();
