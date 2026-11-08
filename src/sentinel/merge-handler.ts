import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase configuration.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function handleMergedPR() {
  const prUrl = process.env.PR_URL;
  const prTitle = process.env.PR_TITLE;
  const prNumber = process.env.PR_NUMBER;

  console.log(`🎉 Detected merged Pull Request #${prNumber}: "${prTitle}"`);
  console.log(`🔗 PR Link: ${prUrl}`);

  // Update Supabase bounty queue to mark the task as merged / rewardable
  const { error } = await supabase
    .from('bounty_queue')
    .update({ 
      status: 'merged',
      updated_at: new Date().toISOString()
    })
    .eq('solution_url', prUrl);

  if (error) {
    console.error('❌ Failed to update bounty queue status in Supabase:', error);
    process.exit(1);
  }

  console.log('✅ Bounty queue successfully updated to MERGED. Ready for automated payout claim!');
}

handleMergedPR().catch((err) => {
  console.error('❌ Merge handler error:', err);
  process.exit(1);
});
