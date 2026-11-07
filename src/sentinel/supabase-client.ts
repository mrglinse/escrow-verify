import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase URL or Key in environment variables.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveBountiesToSupabase(bounties: any[]) {
  if (!bounties || bounties.length === 0) return;

  console.log(`☁️ Syncing ${bounties.length} bounties to Supabase...`);
  
  const { data, error } = await supabase
    .from('bounty_queue')
    .upsert(bounties, { onConflict: 'id' });

  if (error) {
    console.error('❌ Error saving to Supabase:', error);
    throw error;
  }

  console.log('✅ Successfully synced bounties to Supabase!');
  return data;
}
