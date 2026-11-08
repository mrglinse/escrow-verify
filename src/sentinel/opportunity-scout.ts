import { createClient } from '@supabase/supabase-js';

// Bulletproof environment variable resolution for Supabase credentials
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ CRITICAL: Missing Supabase URL or Key in environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function scoutOpportunities() {
  console.log('🔍 Scouting for open, funded issues on platforms (Opire/GitHub)...');

  try {
    // Example fetch or discovery logic
    // Add your platform API calls here to discover tasks and insert into Supabase 'sentinel_queue'
    
    const { data, error } = await supabase
      .from('sentinel_queue')
      .select('*')
      .limit(5);

    if (error) {
      console.error('❌ Supabase query error:', error.message);
      return;
    }

    console.log(`✅ Scout completed successfully. Found ${data?.length || 0} tasks in queue.`);
  } catch (err: any) {
    console.error('❌ Opportunity scout failed:', err.message);
    process.exit(1);
  }
}

scoutOpportunities();
