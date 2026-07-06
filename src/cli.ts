#!/usr/bin/env node
/**
 * BridgeBench CLI.
 *
 *   bridgebench ui run -m openai/gpt-5.4[,anthropic/...] [-t s1-lava-lamp-redux] [--resume] [--dry]
 *   bridgebench ui evaluate <artifact.html> -t <taskId> [-m <modelId>]
 *   bridgebench ui tasks
 *   bridgebench providers
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import chalk from 'chalk';
import { Command } from 'commander';

import {
  RESULTS_DIR,
  SEASON,
  SNAPSHOTS_DIR,
  loadBridgeBenchEnv,
  privateDir,
} from './config.js';
import { getDisplayName, listProviders, PROVIDERS } from './providers/index.js';
import { UiArtifactEvaluator, launchEvalBrowser } from './suites/ui/evaluator/index.js';
import { sha256 } from './suites/ui/evaluator/page-setup.js';
import { UiArtifactExtractor } from './suites/ui/extractor.js';
import { UiArtifactNormalizer } from './suites/ui/normalizer.js';
import { UiBenchResultStore } from './suites/ui/result-store.js';
import { UiModelRunner } from './suites/ui/runner.js';
import { calculateUiScore } from './suites/ui/score.js';
import { UiArtifactStore } from './suites/ui/store.js';
import { UiTaskLoader } from './suites/ui/task-loader.js';
import { UiArtifactValidator } from './suites/ui/validator.js';
import {
  buildUiBenchSkipKey,
  type UiArtifactEvaluationResult,
  type UiBenchFullTask,
  type UiBenchTaskResult,
} from './suites/ui/types.js';

const UI_RESULTS_DIR = path.join(RESULTS_DIR, 'ui');
const UI_ARTIFACTS_DIR = path.join(UI_RESULTS_DIR, 'artifacts');
const UI_JOURNAL_PATH = path.join(UI_RESULTS_DIR, 'journal.jsonl');
const UI_SNAPSHOT_PATH = path.join(UI_RESULTS_DIR, 'snapshot.json');
const SEASON_SNAPSHOT_PATH = path.join(
  SNAPSHOTS_DIR,
  `season-${SEASON.id}`,
  'ui-bench-snapshot.json',
);

function parseApiKeys(raw?: string): Record<string, string> {
  if (!raw) return {};
  const keys: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`Invalid --api-key format: "${pair}". Expected provider=key`);
    keys[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return keys;
}

function trimEvaluation(
  evaluation: UiArtifactEvaluationResult | null,
): UiBenchTaskResult['evaluation'] {
  if (!evaluation) return null;
  const { consoleSample: _sample, screenshots: _shots, browser: _browser, ...rest } = evaluation;
  return rest;
}

async function runUiBench(options: {
  model: string;
  name?: string;
  task?: string;
  resume: boolean;
  dry: boolean;
  apiKey?: string;
  maxTokens?: string;
  temperature?: string;
}): Promise<void> {
  loadBridgeBenchEnv();

  const loader = new UiTaskLoader();
  const tasks = options.task
    ? [await loader.loadById(options.task)]
    : await loader.loadAll();

  if (!loader.hasPrivateOverlay()) {
    console.log(
      chalk.yellow(
        '⚠ BRIDGEBENCH_PRIVATE_DIR not set — hidden interaction probes unavailable; interaction scores will be marked PARTIAL.',
      ),
    );
  }

  const modelIds = options.model.split(',').map((m) => m.trim()).filter(Boolean);
  const displayNames = options.name?.split(',').map((n) => n.trim()) ?? [];
  const apiKeys = parseApiKeys(options.apiKey);

  const store = new UiBenchResultStore({
    journalPath: UI_JOURNAL_PATH,
    snapshotPath: UI_SNAPSHOT_PATH,
  });
  const artifactStore = new UiArtifactStore(UI_ARTIFACTS_DIR);
  const extractor = new UiArtifactExtractor();
  const normalizer = new UiArtifactNormalizer();
  const validator = new UiArtifactValidator();

  const skipSet = options.resume ? await store.buildSkipSet() : new Set<string>();

  let browser = null;
  let executablePath = '';
  if (!options.dry) {
    const launched = await launchEvalBrowser();
    browser = launched.browser;
    executablePath = launched.executablePath;
    console.log(chalk.dim(`Chromium: ${executablePath}`));
  }

  store.open();

  try {
    for (const [index, modelId] of modelIds.entries()) {
      const displayName = displayNames[index] ?? getDisplayName(modelId);
      console.log(chalk.bold(`\n━━ ${displayName} (${modelId}) ━━`));

      const runner = new UiModelRunner({
        modelId,
        displayName,
        apiKeys,
        maxTokens: options.maxTokens ? Number(options.maxTokens) : undefined,
        temperature: options.temperature ? Number(options.temperature) : undefined,
      });

      for (const task of tasks) {
        if (skipSet.has(buildUiBenchSkipKey(modelId, task.id))) {
          console.log(chalk.dim(`  ↷ ${task.id} (already in journal, --resume)`));
          continue;
        }

        process.stdout.write(`  ▸ ${task.id} … `);

        let result: UiBenchTaskResult;
        try {
          result = await runSingleTask({
            runner,
            task,
            modelId,
            displayName,
            artifactStore,
            extractor,
            normalizer,
            validator,
            browser,
            executablePath,
          });
          const scoreText = result.success
            ? chalk.green(`${result.scores.total}`)
            : chalk.red(`FAIL (${result.errorType ?? 'low score'})`);
          const partial = result.scores.interactionPartial ? chalk.yellow(' [partial]') : '';
          console.log(`${scoreText}${partial}`);
        } catch (error) {
          console.log(chalk.red(`runner error: ${error instanceof Error ? error.message : error}`));
          result = {
            modelId,
            displayName,
            taskId: task.id,
            season: task.season,
            category: task.category,
            scores: {
              renderIntegrity: 0,
              motion: 0,
              interaction: 0,
              determinism: 0,
              specAdherence: 0,
              total: 0,
              interactionPartial: true,
            },
            validation: {
              valid: false,
              errors: [`runner error: ${error instanceof Error ? error.message : String(error)}`],
              warnings: [],
              metadata: {
                sizeBytes: 0,
                hasDoctype: false,
                hasHtmlTag: false,
                hasManifest: false,
                hasTaskApi: false,
                hasImportMap: false,
                importMapCanonical: false,
                usesThree: false,
                moduleSpecifiers: [],
                externalAssetRefs: [],
                forbiddenApiRefs: [],
                declaredControlIds: [],
              },
            },
            evaluation: null,
            providerResponseMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            success: false,
            errorType: 'runner_error',
            timestamp: new Date().toISOString(),
            artifactSha256: null,
            artifactPaths: { html: '', screenshots: {} },
          };
        }

        store.append(result);
      }
    }
  } finally {
    await store.close();
    if (browser) await browser.close().catch(() => {});
  }

  const allTasks = await loader.loadAll();
  const snapshot = await store.rebuildSnapshot(
    allTasks.map((t) => t.id),
    modelIds,
  );
  store.writeSnapshotCopy(snapshot, SEASON_SNAPSHOT_PATH);

  console.log(chalk.bold('\n━━ UI Bench Leaderboard (harness score) ━━'));
  for (const entry of snapshot.leaderboard.slice(0, 15)) {
    console.log(
      `  ${String(entry.rank).padStart(2)}  ${entry.displayName.padEnd(32)} ${entry.harnessScore}`,
    );
  }
  console.log(chalk.dim(`\nSnapshot: ${UI_SNAPSHOT_PATH}\nSeason copy: ${SEASON_SNAPSHOT_PATH}`));
}

async function runSingleTask(input: {
  runner: UiModelRunner;
  task: UiBenchFullTask;
  modelId: string;
  displayName: string;
  artifactStore: UiArtifactStore;
  extractor: UiArtifactExtractor;
  normalizer: UiArtifactNormalizer;
  validator: UiArtifactValidator;
  browser: Awaited<ReturnType<typeof launchEvalBrowser>>['browser'] | null;
  executablePath: string;
}): Promise<UiBenchTaskResult> {
  const { task } = input;

  const response = await input.runner.runTask(task);
  const html = input.extractor.extractHtml(response.rawResponse);
  const normalizedHtml = input.normalizer.normalize(html, {
    taskTitle: task.title,
    modelName: input.displayName,
  });
  const validation = input.validator.validateHtml(normalizedHtml, task);

  const record = await input.artifactStore.writeArtifact({
    modelId: input.modelId,
    displayName: input.displayName,
    task,
    html,
    normalizedHtml,
    rawResponse: response.rawResponse,
    providerResponseMs: response.providerResponseMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    validation,
  });

  let evaluation: UiArtifactEvaluationResult | null = null;
  if (input.browser && validation.valid) {
    const evaluator = new UiArtifactEvaluator(input.browser);
    evaluation = await evaluator.evaluate({
      html: normalizedHtml,
      task,
      outputDir: record.paths.dir,
      executablePath: input.executablePath,
    });
  }

  const scores = calculateUiScore({ task, validation, evaluation });

  return {
    modelId: input.modelId,
    displayName: input.displayName,
    taskId: task.id,
    season: task.season,
    category: task.category,
    scores,
    validation,
    evaluation: trimEvaluation(evaluation),
    providerResponseMs: response.providerResponseMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    success: validation.valid && (evaluation?.ok ?? false) && scores.total > 0,
    errorType: !validation.valid
      ? 'validation_error'
      : evaluation && !evaluation.ok
        ? 'evaluation_error'
        : undefined,
    timestamp: new Date().toISOString(),
    artifactSha256: sha256(normalizedHtml),
    artifactPaths: {
      html: record.paths.normalized,
      screenshots: evaluation?.screenshots ?? {},
    },
  };
}

async function evaluateArtifactFile(
  file: string,
  options: { task: string; model?: string },
): Promise<void> {
  loadBridgeBenchEnv();

  const loader = new UiTaskLoader();
  const task = await loader.loadById(options.task);
  const html = await fs.readFile(path.resolve(file), 'utf8');

  const normalizer = new UiArtifactNormalizer();
  const validator = new UiArtifactValidator();
  const modelName = options.model ?? 'manual';

  const normalizedHtml = normalizer.normalize(html, {
    taskTitle: task.title,
    modelName,
  });
  const validation = validator.validateHtml(normalizedHtml, task);

  console.log(chalk.bold('Validation:'), validation.valid ? chalk.green('valid') : chalk.red('INVALID'));
  for (const error of validation.errors) console.log(chalk.red(`  ✗ ${error}`));
  for (const warning of validation.warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));

  const outputDir = path.join(UI_RESULTS_DIR, '_evaluations', `${task.id}-${Date.now()}`);

  let evaluation: UiArtifactEvaluationResult | null = null;
  if (validation.valid) {
    const { browser, executablePath } = await launchEvalBrowser();
    try {
      const evaluator = new UiArtifactEvaluator(browser);
      evaluation = await evaluator.evaluate({
        html: normalizedHtml,
        task,
        outputDir,
        executablePath,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const scores = calculateUiScore({ task, validation, evaluation });

  if (evaluation) {
    console.log(chalk.bold('\nEvaluation:'));
    console.log(`  webgl: ${evaluation.webgl.active ?? 'none'} (${evaluation.webgl.renderer ?? 'n/a'})`);
    console.log(`  fps: ${evaluation.fps ?? 'n/a'}  animation: ${evaluation.animation.detected} (${evaluation.animation.changedPct.join('%, ')}%)`);
    console.log(`  pageErrors: ${evaluation.pageErrors.length}  consoleErrors: ${evaluation.consoleErrorCount}  blocked: ${evaluation.networkRequestsBlocked}`);
    console.log(`  determinism: ran=${evaluation.determinism.ran} replayΔ=${evaluation.determinism.replayChangedPct}% statesMatch=${evaluation.determinism.statesMatch}`);
    console.log(`  controls: [${evaluation.controlsFound.join(', ')}]  viewportFill: ${evaluation.viewportFill}`);
    if (evaluation.probes) {
      for (const probe of evaluation.probes) {
        const icon = probe.passed ? chalk.green('✓') : chalk.red('✗');
        console.log(`  probe ${icon} ${probe.id}${probe.details ? chalk.dim(` — ${probe.details}`) : ''}${probe.error ? chalk.red(` — ${probe.error}`) : ''}`);
      }
    } else {
      console.log(chalk.yellow('  probes: none available (partial interaction scoring)'));
    }
    console.log(chalk.dim(`  screenshots: ${outputDir}`));
  }

  console.log(chalk.bold('\nScores:'));
  console.log(
    `  render ${scores.renderIntegrity} | motion ${scores.motion} | interaction ${scores.interaction}${scores.interactionPartial ? ' (partial)' : ''} | determinism ${scores.determinism} | spec ${scores.specAdherence}`,
  );
  console.log(chalk.bold(`  TOTAL: ${scores.total}`));
}

// ---------------------------------------------------------------------------

const program = new Command();
program.name('bridgebench').description('BridgeBench — the vibe coding benchmark');

const ui = program.command('ui').description('UI Bench (Season 1)');

ui.command('run')
  .description('Generate + evaluate artifacts for one or more models')
  .requiredOption('-m, --model <ids>', 'comma-separated model IDs (provider/model)')
  .option('-n, --name <names>', 'display names matching --model order')
  .option('-t, --task <taskId>', 'run a single task')
  .option('--resume', 'skip (model, task) pairs already successful in the journal', false)
  .option('--dry', 'generate + validate only — no browser evaluation', false)
  .option('--api-key <pairs>', 'inline API keys: provider=key,provider=key')
  .option('--max-tokens <n>', 'completion token ceiling')
  .option('--temperature <t>', 'sampling temperature')
  .action(runUiBench);

ui.command('evaluate')
  .description('Validate + evaluate an existing artifact HTML file')
  .argument('<file>', 'path to artifact HTML')
  .requiredOption('-t, --task <taskId>', 'task to grade against')
  .option('-m, --model <name>', 'label for the artifact source')
  .action(evaluateArtifactFile);

ui.command('tasks')
  .description('List Season tasks')
  .action(async () => {
    const loader = new UiTaskLoader();
    const tasks = await loader.loadAll();
    for (const task of tasks) {
      console.log(
        `${task.id.padEnd(30)} ${task.category.padEnd(12)} ${task.title}` +
          (task.probes ? chalk.dim(`  [${task.probes.length} probes]`) : chalk.yellow('  [no probes]')),
      );
    }
  });

program
  .command('providers')
  .description('Show configured providers')
  .action(() => {
    loadBridgeBenchEnv();
    for (const provider of listProviders()) {
      const status = provider.hasKey
        ? chalk.green(`configured via ${provider.configuredVia}`)
        : chalk.dim(`set ${provider.envKey}`);
      console.log(`${provider.slug.padEnd(12)} ${provider.name.padEnd(16)} ${status}`);
    }
    console.log(chalk.dim(`\nPrivate probes: ${privateDir() ?? 'not configured (BRIDGEBENCH_PRIVATE_DIR)'}`));
    console.log(chalk.dim(`Providers: ${Object.keys(PROVIDERS).length} — Season: ${SEASON.name}`));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
