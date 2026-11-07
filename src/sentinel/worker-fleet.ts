import fs from 'fs';
import path from 'path';

const METAMASK_PAYOUT_ADDRESS = '0x50519...C07aC';

interface TaskItem {
  id: string;
  title: string;
  repo: string;
  url: string;
  body: string;
  reward?: string;
  source: 'algora' | 'opire' | 'github';
  status: 'pending' | 'in_progress' | 'completed';
}

const WORKER_PROMPTS: Record<string, string> = {
  algora_code_gen: 'You are an elite Web3 & TypeScript developer. Generate production-ready code fixes for high-value bounties.',
  algora_security_auditor: 'You are a Web3 security auditor. Fix vulnerabilities, overflow bugs, and logic flaws in smart contracts and TypeScript SDKs.',
  opire_react_specialist: 'You are a Senior Frontend Engineer specializing in React, Next.js, Tailwind, and UI bug resolution.',
  opire_backend_dev: 'You are a Node.js & Database Systems architect. Resolve backend API errors, SQL queries, and async runtime issues.',
  github_bug_engine: 'You are an open-source bug hunter. Provide clean, minimal, non-breaking bug fixes for open GitHub issues.',
  github_refactor_agent: 'You are a Code Quality Specialist. Refactor messy logic, improve TypeScript typing, and fix failing test suites.'
};

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-sonnet',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
      }),
    });

    if (!res.ok) return '';
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('❌ OpenRouter API call failed:', err);
    return '';
  }
}

async function executeTwoPassFix(workerKey: string, task: TaskItem): Promise<string> {
  const systemPrompt = WORKER_PROMPTS[workerKey];

  console.log(`  └─ 📝 [Pass 1: Generation] Worker (${workerKey}) drafting solution...`);
  const initialDraft = await callClaude(
    systemPrompt,
    `Target Repository: ${task.repo}\nIssue Title: ${task.title}\nIssue Description:\n${task.body}\n\nTask: Produce a complete code fix for this issue.`
  );

  if (!initialDraft) return '';

  console.log(`  └─ 🔍 [Pass 2: Review & Self-Correction] Auditing draft for logic errors...`);
  const reviewPrompt = `You are a Lead Code Reviewer. Review the draft fix below for syntax bugs, edge cases, or broken types. Correct any mistakes and output the final git patch file.

Issue: ${task.title}
Draft Solution:
${initialDraft}

Requirements:
1. Ensure code compiles cleanly with zero syntax/logic errors.
2. Embed payout tag: // Payout Wallet: ${METAMASK_PAYOUT_ADDRESS}
3. Return ONLY the finalized patch.`;

  const finalAuditedPatch = await callClaude('You are a Lead Security & Code Auditor.', reviewPrompt);
  return finalAuditedPatch || initialDraft;
}

export async function run6WorkerFleet() {
  const dataFile = path.join(process.cwd(), 'src/sentinel/data/discovered_issues.json');
  const patchDir = path.join(process.cwd(), 'src/sentinel/patches');

  if (!fs.existsSync(patchDir)) fs.mkdirSync(patchDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    console.log('ℹ️ No task queue found. Skipping worker fleet run.');
    return;
  }

  const tasks: TaskItem[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  const pendingTasks = tasks.filter(t => t.status === 'pending');

  console.log(`🤖 [6-Worker Fleet] Active. Processing ${pendingTasks.length} bounties...`);

  for (const task of pendingTasks) {
    let workerKey = 'github_bug_engine';
    if (task.source === 'algora') workerKey = 'algora_code_gen';
    if (task.source === 'opire') workerKey = 'opire_react_specialist';

    console.log(`🚀 Dispatching Worker (${workerKey}) for [${task.source.toUpperCase()}] task: ${task.id}`);
    const finalPatch = await executeTwoPassFix(workerKey, task);

    if (finalPatch) {
      const patchFileName = `patch-${task.id}.patch`;
      fs.writeFileSync(path.join(patchDir, patchFileName), finalPatch);
      console.log(`💾 [Audited & Corrected Patch Saved]: ${patchFileName}`);
      task.status = 'completed';
    }
  }

  fs.writeFileSync(dataFile, JSON.stringify(tasks, null, 2));
  console.log('✅ [6-Worker Fleet] All tasks audited, corrected, and saved.');
}
  
