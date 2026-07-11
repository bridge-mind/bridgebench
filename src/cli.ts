#!/usr/bin/env node
import path from 'node:path';

import { Command } from 'commander';

import { ArenaRunner } from './arena.js';
import { loadProjectEnv } from './env.js';
import { FileArenaLogger } from './logger.js';
import { listModels } from './models.js';
import { OpenRouterClient, sanitizeError } from './openrouter.js';
import { findProjectRoot } from './paths.js';
import { writeReports } from './report.js';
import { ArenaStore, categoryStoreConfig } from './store.js';
import { TaskLoader } from './tasks.js';
import { formatTriage, triageJournal } from './triage.js';
import { BenchmarkCategorySchema, CATEGORIES, type BenchmarkCategory } from './types.js';

loadProjectEnv();

const ROOT = findProjectRoot(import.meta.url);

function createStore(category: BenchmarkCategory): ArenaStore {
  return new ArenaStore(categoryStoreConfig(category));
}

function logRoot(category: BenchmarkCategory): string {
  return path.join(ROOT, 'results', category, 'logs');
}

function parseCategory(value: string): BenchmarkCategory {
  const parsed = BenchmarkCategorySchema.safeParse(value);
  if (!parsed.success) throw new Error(`Unknown category ${value}; expected one of: ${CATEGORIES.join(', ')}`);
  return parsed.data;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive number, got ${value}`);
  return parsed;
}

function openRouter(): OpenRouterClient {
  return new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
}

const program = new Command()
  .name('bridgebench-v3')
  .description('Autonomous BridgeBench V3 arenas: reasoning and hallucination')
  .version('0.1.0');

const models = program.command('models').description('Inspect or validate the pinned model registry');
models.command('list').action(() => {
  for (const model of listModels()) {
    console.log(`${model.role.padEnd(10)} ${model.id.padEnd(40)} ${model.displayName}`);
  }
});
models.command('validate').action(async () => {
  const client = openRouter();
  for (const model of listModels()) {
    await client.validateModel(model);
    console.log(`✓ ${model.id} -> ${model.canonicalSlug}`);
  }
});

const tasks = program.command('tasks').description('Inspect the task packs');
tasks
  .command('validate')
  .option('-c, --category <category>', `limit to one category (${CATEGORIES.join(', ')})`, parseCategory)
  .action(async (options: { category?: BenchmarkCategory }) => {
    const categories = options.category ? [options.category] : CATEGORIES;
    for (const category of categories) {
      const loader = new TaskLoader(category);
      const loaded = await loader.loadAll();
      const mode = loader.hasPrivate ? 'public + private halves' : 'public halves only';
      console.log(`✓ ${category}: ${loaded.length} tasks validated (${mode})`);
      for (const task of loaded) console.log(`  ${task.public.cluster.padEnd(28)} ${task.public.id}`);
    }
  });

const arena = program.command('arena').description('Run autonomous arena matches');
arena
  .command('run')
  .option('-c, --category <category>', `arena to run (${CATEGORIES.join(', ')})`, parseCategory, 'reasoning')
  .option('-n, --matches <count>', 'number of task-level matches', positiveInteger, 12)
  .option('-s, --seed <seed>', 'reproducible scheduling seed', 'bridgebench-v3-mvp')
  .option('--max-cost-usd <amount>', 'hard stop before the next match after this spend', positiveNumber, 25)
  .option('--resume', 'skip match IDs already present in the journal', false)
  .option('--debug', 'mirror all structured log entries to the console', false)
  .option('--no-health-stop', 'do not halt the run when most matches have failed responses')
  .action(
    async (options: {
      category: BenchmarkCategory;
      matches: number;
      seed: string;
      maxCostUsd: number;
      resume: boolean;
      debug: boolean;
      healthStop: boolean;
    }) => {
      const logger = new FileArenaLogger({ dir: logRoot(options.category), verbose: options.debug });
      console.log(`Run log: ${logger.filePath}`);
      const store = createStore(options.category);
      const loaded = await new TaskLoader(options.category).loadAll({ requirePrivate: true });
      const runner = new ArenaRunner(new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '', logger), store, undefined, logger);
      try {
        const result = await runner.run(
          {
            category: options.category,
            seed: options.seed,
            matches: options.matches,
            maxCostUsd: options.maxCostUsd,
            resume: options.resume,
            healthStop: options.healthStop,
          },
          loaded,
        );
        console.log(`Completed ${result.completed} new ${options.category} matches; run spend $${result.costUsd.toFixed(4)}.`);
        if (result.stoppedForBudget) console.log('Stopped at the configured cost boundary; rerun with --resume to continue.');
        const triage = triageJournal(store.readAll().filter((match) => match.runId === result.runId));
        console.log(`\n=== Run health ===\n${formatTriage(triage)}`);
      } finally {
        console.log(`Run log: ${logger.filePath}`);
      }
    },
  );

arena
  .command('triage')
  .description('Analyze journaled matches for failures, suspiciously fast responses, and judging anomalies')
  .option('-c, --category <category>', `arena journal to analyze (${CATEGORIES.join(', ')})`, parseCategory, 'reasoning')
  .option('--run <runId>', 'limit the report to one run id')
  .option('--json', 'emit the machine-readable report', false)
  .option('--strict', 'exit non-zero when any anomaly is found', false)
  .action((options: { category: BenchmarkCategory; run?: string; json: boolean; strict: boolean }) => {
    const results = createStore(options.category)
      .readAll()
      .filter((match) => !options.run || match.runId === options.run);
    if (results.length === 0) {
      console.log(options.run ? `No journaled ${options.category} matches for run ${options.run}.` : `The ${options.category} journal is empty.`);
      return;
    }
    const reports = triageJournal(results);
    console.log(options.json ? JSON.stringify(reports, null, 2) : formatTriage(reports));
    const anomalies = reports.reduce((sum, report) => sum + report.anomalies.length, 0);
    if (options.strict && anomalies > 0) {
      console.error(`Strict mode: ${anomalies} anomalies found.`);
      process.exitCode = 1;
    }
  });

arena
  .command('generation <generationId>')
  .description("Fetch OpenRouter's ground-truth record for a journaled generation id (native tokens, reasoning, provider)")
  .action(async (generationId: string) => {
    const data = await openRouter().fetchGeneration(generationId);
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command('report')
  .description('Rebuild JSON and Markdown reports from the journals')
  .option('-c, --category <category>', `limit to one category (${CATEGORIES.join(', ')})`, parseCategory)
  .action((options: { category?: BenchmarkCategory }) => {
    const categories = options.category ? [options.category] : CATEGORIES;
    for (const category of categories) {
      const snapshot = writeReports(createStore(category));
      console.log(`✓ ${category}: wrote reports for ${snapshot.matches.length} matches`);
    }
  });

program.parseAsync().catch((error) => {
  console.error(`BridgeBench V3: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
