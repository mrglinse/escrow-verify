import { discover } from './engine.mjs';

try {
  const result = await discover();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`GDAS discovery failed: ${error.message}\n`);
  process.exitCode = 1;
}