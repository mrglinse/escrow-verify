import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

async function generatePatchWithOpenRouter(issueDescription: string): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/mrglinse/escrow-verify', // Optional: for rankings
      'X-Title': 'GDAS Sentinel' // Optional: app identifier
    },
    body: JSON.stringify({
      model: 'openrouter/free', // Automatically routes to available free models with coding support
      messages: [
        {
          role: 'system',
          content: 'You are an autonomous senior software engineer. Analyze the given GitHub issue and write a precise code patch to solve it. Return clean implementation code.'
        },
        {
          role: 'user',
          content: issueDescription
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${JSON.stringify(data)}`);
  }

  return data.choices[0]?.message?.content || '// No patch generated';
}

async function runWorkerEngine() {
  console.log('🤖 Initializing Sentinel Worker Engine with OpenRouter...');

  const { data: tasks, error } = await supabase
    .from('sentinel_queue')
    .select('*')
    .eq('status', 'queued')
    .limit(1);

  if (error || !tasks || tasks.length === 0) {
    console.log('📭 No queued tasks found in sentinel database.');
    return;
  }

  const task = tasks[0];
  console.log(`🎯 Processing Task ID: ${task.id} | Issue: ${task.issue_url}`);

  await supabase
    .from('sentinel_queue')
    .update({ status: 'processing' })
    .eq('id', task.id);

  try {
    const branchName = `gdas-fix-${task.id.slice(0, 6)}`;
    execSync(`git checkout -b ${branchName}`);

    console.log('💡 Requesting free open-source model patch from OpenRouter...');
    const patchContent = await generatePatchWithOpenRouter(task.issue_url);

    // Apply generated content to repository workspace file or patch output
    // fs.writeFileSync('src/patch-output.ts', patchContent);

    execSync('git config user.name "GDAS Sentinel Bot"');
    execSync('git config user.email "sentinel@bot.internal"');
    execSync('git add .');
    execSync(`git commit -m "fix: autonomous resolution via OpenRouter free tier for task ${task.issue_url}"`);
    execSync(`git push origin ${branchName}`);

    console.log(`🚀 Successfully pushed fix branch: ${branchName}`);

    await supabase
      .from('sentinel_queue')
      .update({ status: 'pr_opened', branch_name: branchName })
      .eq('id', task.id);

  } catch (err: any) {
    console.error(`❌ Worker execution failed for task ${task.id}:`, err.message);
    await supabase
      .from('sentinel_queue')
      .update({ status: 'failed', error_log: err.message })
      .eq('id', task.id);
  }
}

runWorkerEngine();
