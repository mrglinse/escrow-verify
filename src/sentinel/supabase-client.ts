import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveBountiesToSupabase(bounties: any[]) {
  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️ Supabase credentials missing. Skipping cloud sync.');
    return;
  }

  for (const bounty of bounties) {
    const { error } = await supabase
      .from('bounty_queue')
      .upsert({
        id: bounty.id,
        title: bounty.title,
        repo: bounty.repo,
        url: bounty.url,
        body: bounty.body,
        reward: bounty.reward,
        source: bounty.source,
        status: bounty.status || 'pending'
      }, { onConflict: 'id', ignoreDuplicates: true });

    if (error) {
      console.error(`❌ Error inserting bounty ${bounty.id}:`, error.message);
    }
  }
  console.log(`☁️ Synced bounty batch to Supabase successfully.`);
}
