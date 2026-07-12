import path from 'node:path';

import { buildJudgePayload, judgePromptPolicyHash, judgeSystemPrompt } from '../src/judges.js';
import { listModels } from '../src/models.js';
import { MAX_PROMPT_CHARS } from '../src/openrouter-transport.js';
import { findProjectRoot } from '../src/paths.js';
import { buildCompetitorPrompt, competitorPromptPolicyHash, TaskLoader } from '../src/tasks.js';

const ROOT = findProjectRoot(import.meta.url);
const APPROXIMATE_CHARS_PER_TOKEN = 4;

async function main(): Promise<void> {
  const loader = new TaskLoader('reasoning');
  const tasks = await loader.loadAll({ requirePrivate: true });
  tasks.sort((left, right) => left.public.cluster.localeCompare(right.public.cluster));

  console.log(
    `Reasoning pack: ${tasks.length} tasks (${loader.hasPrivate ? 'public + private' : 'public only'})`,
  );
  console.log('');

  let failures = 0;
  for (const task of tasks) {
    const competitor = buildCompetitorPrompt(task);
    const competitorSize = competitor.system.length + competitor.user.length;
    const maxAnswerChars =
      Math.max(...listModels('competitor').map((model) => model.request.maxTokens)) *
      APPROXIMATE_CHARS_PER_TOKEN;
    const judgePayload = buildJudgePayload(
      task,
      'x'.repeat(maxAnswerChars),
      'x'.repeat(maxAnswerChars),
    );
    const judgeSize = judgeSystemPrompt(task.public.category).length + judgePayload.length;
    const overBudget = competitorSize > MAX_PROMPT_CHARS || judgeSize > MAX_PROMPT_CHARS;
    if (overBudget) failures += 1;

    const status = overBudget ? 'FAIL' : 'ok';
    console.log(
      `[${status}] ${task.public.cluster.padEnd(28)} ${task.public.id}@${task.public.version}`,
    );
    console.log(
      `       artifacts=${task.public.artifacts.length} evidence=${task.private.requiredEvidence.length} decoys=${task.private.disqualifyingErrors.length}`,
    );
    console.log(
      `       prompt chars: competitor=${competitorSize} judge(worst)=${judgeSize} (limit ${MAX_PROMPT_CHARS})`,
    );
  }

  console.log('');
  console.log(
    `Policy hashes: competitor=${competitorPromptPolicyHash('reasoning')} judge=${judgePromptPolicyHash('reasoning')}`,
  );
  console.log(`Project root: ${path.relative(process.cwd(), ROOT) || '.'}`);

  if (failures > 0) {
    console.error(`\n${failures} task(s) exceed the prompt budget.`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
