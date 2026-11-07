import fs from 'fs';
import path from 'path';
import { fetchAlgoraBounties } from './scout-algora';
import { fetchOpireBounties } from './scout-opire';
import { fetchGitHubBounties } from './scout-github';

async function runScoutFleet() {
  console.log('🚀 [GDAS Fleet Orchestrator] Launching 3 Specialized Scouts...');

  const dataDir = path.join(process.cwd(), 'src/sentinel/data');
  const dataFile = path.join(dataDir, 'discovered_issues.json');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Run all 3 scouts concurrently
  const [algoraResults, opireResults, githubResults] = await Promise.all([
    fetchAlgoraBounties(),
    fetchOpireBounties(),
    fetchGitHubBounties(),
  ]);

  const allDiscovered = [...algoraResults, ...opireResults, ...githubResults];

  // Merge and deduplicate existing task queue
  let existingTasks: any[] = [];
  if (fs.existsSync(dataFile)) {
    try {
      existingTasks = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    } catch {
      existingTasks = [];
    }
  }

  const existingIds = new Set(existingTasks.map(t => t.id));
  const newTasks = allDiscovered.filter(t => !existingIds.has(t.id));

  const updatedQueue = [...existingTasks, ...newTasks];

  fs.writeFileSync(dataFile, JSON.stringify(updatedQueue, null, 2));
  console.log(`✅ [Fleet Aggregator] Added ${newTasks.length} new bounties into queue. Total queue: ${updatedQueue.length}`);
}

runScoutFleet();

