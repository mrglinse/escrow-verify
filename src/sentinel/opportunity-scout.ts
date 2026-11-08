import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ CRITICAL: Missing Supabase URL or Key.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function autonomousScout() {
  console.log('🤖 Autonomous Scout active: Scanning live repositories for open tasks...');

  try {
    // Fetch open issues from target repositories automatically
    const response = await fetch('https://api.github.com/repos/expressjs/express/issues?state=open&per_page=10', {
      headers: {
        'User-Agent': 'GDAS-Autonomous-Sentinel',
        ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.statusText}`);
    }

    const issues = await response.json();
    console.log(`🔍 Scanned ${issues.length} live items. Filtering opportunities...`);

    let addedCount = 0;

    for (const issue of issues) {
      // Skip pull requests if returned in issues endpoint
      if (issue.pull_request) continue;

      // Check if this task is already in your Supabase queue
      const { data: existing } = await supabase
        .from('sentinel_queue')
        .select('id')
        .eq('issue_url', issue.html_url)
        .maybeSingle();

      if (!existing) {
        // Automatically insert into queue so the worker engine picks it up
        const { error: insertError } = await supabase
          .from('sentinel_queue')
          .insert({
            issue_url: issue.html_url,
            title: issue.title,
            body: issue.body || '',
            status: 'queued',
            created_at: new Date().toISOString()
          });

        if (insertError) {
          console.error(`❌ Failed to queue task (${issue.title}):`, insertError.message);
        } else {
          console.log(`📥 Autonomously queued: ${issue.title}`);
          addedCount++;
        }
      }
    }

    console.log(`✅ Autonomous scout cycle complete. Added ${addedCount} new tasks to queue.`);
  } catch (err: any) {
    console.error('❌ Autonomous scout execution error:', err.message);
    process.exit(1);
  }
}

autonomousScout();
