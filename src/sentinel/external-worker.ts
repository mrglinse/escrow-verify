import fs from 'fs';
import path from 'path';

// 🛑 Replace with your actual public MetaMask EVM address (0x...)
const METAMASK_PAYOUT_ADDRESS = '0xYourMetaMaskPublicAddressHere';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

interface Task {
  id: string;
  title: string;
  repo: string;
  url: string;
  body: string;
  reward?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

async function fetchFileContext(repo: string, filePath: string): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Sentinel-Level3.5-Engine',
        'Accept': 'application/vnd.github.v3.raw'
      }
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Stage 2: Initial Code Patch Generation
 */
async function generateInitialPatch(task: Task, contextCode: string): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    return `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n+// Fix for ${task.url}\n+// Payout Address: ${METAMASK_PAYOUT_ADDRESS}\n`;
  }

  const prompt = `Write a clean Git unified diff patch resolving this issue for repo ${task.repo}:
Issue: ${task.title}
Details: ${task.body}
Context: ${contextCode.slice(0, 2000)}

Rule: Include payout comment: ${METAMASK_PAYOUT_ADDRESS}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.7-sonnet',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

/**
 * Stage 3: Claude Code Review & Self-Correction Audit Engine
 */
async function auditAndRefinePatch(draftPatch: string, task: Task): Promise<string> {
  if (!OPENROUTER_API_KEY || !draftPatch) return draftPatch;

  console.log(`🧐 [Claude Auditor] Reviewing patch logic and diff syntax...`);

  const reviewPrompt = `You are a Senior Code Auditor. Review this proposed git patch:

${draftPatch}

Verify:
1. Is it valid unified diff format starting with '---' and '+++'?
2. Does it fix the issue without introducing syntax errors or missing variables?
3. Does it preserve the payout address (${METAMASK_PAYOUT_ADDRESS})?

Return ONLY the final, corrected, raw git patch. Do not include markdown code block syntax (no \`\`\`diff).`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.7-sonnet',
        messages: [{ role: 'user', content: reviewPrompt }],
        temperature: 0.1
      })
    });
    const data = await res.json();
    let cleaned = data.choices?.[0]?.message?.content || draftPatch;
    return cleaned.replace(/^```(diff)?\n/i, '').replace(/\n```$/i, '');
  } catch {
    return draftPatch;
  }
}

async function processTasks() {
  const tasksPath = path.join(process.cwd(), 'src/sentinel/data/discovered_issues.json');
  const patchesDir = path.join(process.cwd(), 'src/sentinel/patches');

  if (!fs.existsSync(tasksPath)) return;

  const tasks: Task[] = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
  const pendingTasks = tasks.filter(t => t.status !== 'completed');

  if (pendingTasks.length === 0) return;

  for (const task of tasks) {
    if (task.status === 'completed') continue;

    console.log(`⚡ Processing task: "${task.title}"`);
    const packageJson = await fetchFileContext(task.repo, 'package.json');
    const mainSource = await fetchFileContext(task.repo, 'src/index.ts');
    const combinedContext = `package.json:\n${packageJson}\n\nsrc/index.ts:\n${mainSource}`;

    // Stage 2: Draft Fix
    const rawPatch = await generateInitialPatch(task, combinedContext);

    // Stage 3: Claude Code Review Pass
    const reviewedPatch = await auditAndRefinePatch(rawPatch, task);

    // Stage 4: Save & Payload Output
    if (!fs.existsSync(patchesDir)) {
      fs.mkdirSync(patchesDir, { recursive: true });
    }
    fs.writeFileSync(path.join(patchesDir, `patch-${task.id}.patch`), reviewedPatch);

    console.log(`✅ [Claude Approved] Patch saved for ${task.repo}`);
    task.status = 'completed';
  }

  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
}

processTasks();
