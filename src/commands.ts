import path from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { ArenaRunner } from './arena.js';
import { loadProjectEnv } from './env.js';
import { FileArenaLogger, redactSecrets, type ArenaLogger } from './logger.js';
import { listModels, resolveCompetitorRoster } from './models.js';
import { OpenRouterClient } from './openrouter.js';
import { publishJournal, publishTarget, publishTasks, resolveApiConfig } from './publish.js';
import { runRemoteArena } from './remote-arena.js';
import { writeReports } from './report.js';
import { ArenaStore, categoryStoreConfig } from './store.js';
import { TaskLoader, validatePublicTaskFile } from './tasks.js';
import { formatTriage, triageJournal } from './triage.js';
import {
  BenchmarkCategorySchema,
  CATEGORIES,
  type ArenaEventSink,
  type ArenaRunConfig,
  type BenchmarkCategory,
} from './types.js';
import { verifyJournal } from './verification.js';
import { ENGINE_VERSION, PACKAGE_NAME } from './version.js';

// CLI logs and path display anchor to the operator's working directory,
// matching where categoryStoreConfig writes results.
const ROOT = process.cwd();

interface CategorySelection {
  category?: BenchmarkCategory;
  all?: boolean;
}

export interface ArenaRunCliOptions {
  category: BenchmarkCategory;
  matches: number;
  seed: string;
  maxCostUsd: number;
  competitor?: string[];
  resume: boolean;
  debug: boolean;
  healthStop: boolean;
}

export interface CliDependencies {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  setExitCode: (code: number) => void;
  createStore: (category: BenchmarkCategory) => ArenaStore;
  createTaskLoader: (category: BenchmarkCategory) => TaskLoader;
  createOpenRouter: (logger?: ArenaLogger) => OpenRouterClient;
  publishTasks: typeof publishTasks;
  publishJournal: typeof publishJournal;
  resolveApiConfig: typeof resolveApiConfig;
}

const defaultDependencies: CliDependencies = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  createStore: (category) => new ArenaStore(categoryStoreConfig(category)),
  createTaskLoader: (category) => new TaskLoader(category),
  createOpenRouter: (logger) => new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '', logger),
  publishTasks,
  publishJournal,
  resolveApiConfig,
};

function parseCategory(value: string): BenchmarkCategory {
  const parsed = BenchmarkCategorySchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(`expected one of ${CATEGORIES.join(', ')}, received ${value}`);
  }
  return parsed.data;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive number, received ${value}`);
  }
  return parsed;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function arenaRunConfigFromOptions(options: ArenaRunCliOptions): ArenaRunConfig {
  const competitorIds = options.competitor?.length
    ? resolveCompetitorRoster(options.competitor).map((model) => model.id)
    : undefined;
  return {
    category: options.category,
    seed: options.seed,
    matches: options.matches,
    maxCostUsd: options.maxCostUsd,
    competitorIds,
    resume: options.resume,
    healthStop: options.healthStop,
  };
}

function selectedCategories(options: CategorySelection, command: string): BenchmarkCategory[] {
  if (options.category && options.all) {
    throw new Error(`${command} accepts either --category or --all, not both`);
  }
  if (options.category) return [options.category];
  if (options.all) return [...CATEGORIES];
  throw new Error(`${command} requires --category <category> or --all`);
}

function logRoot(category: BenchmarkCategory): string {
  return path.join(ROOT, 'results', category, 'logs');
}

function displayPath(target: string): string {
  const relative = path.relative(ROOT, target);
  return relative.startsWith('..') ? path.basename(target) : relative;
}

export function buildProgram(overrides: Partial<CliDependencies> = {}): Command {
  const dependencies: CliDependencies = { ...defaultDependencies, ...overrides };
  const program = new Command()
    .name(PACKAGE_NAME)
    .description('Autonomous BridgeBench arenas for reasoning and hallucination')
    .version(ENGINE_VERSION)
    .showHelpAfterError()
    .configureHelp({ sortOptions: true, sortSubcommands: true })
    .configureOutput({
      writeOut: (value) => dependencies.stdout(value.replace(/\n$/, '')),
      writeErr: (value) => dependencies.stderr(value.replace(/\n$/, '')),
    });

  const models = program
    .command('models')
    .description('Inspect or validate the pinned model registry');
  models
    .command('list')
    .description('List enabled competitors and judges')
    .action(() => {
      for (const model of listModels()) {
        dependencies.stdout(`${model.role.padEnd(10)} ${model.id.padEnd(40)} ${model.displayName}`);
      }
    });
  models
    .command('validate')
    .description('Validate pinned model IDs and judge capabilities against OpenRouter')
    .action(async () => {
      const client = dependencies.createOpenRouter();
      for (const model of listModels()) {
        await client.validateModel(model);
        dependencies.stdout(`✓ ${model.id} -> ${model.canonicalSlug}`);
      }
    });

  const tasks = program.command('tasks').description('Validate or publish task packs');
  tasks
    .command('validate')
    .description('Validate public task schemas and pack balance')
    .option(
      '-c, --category <category>',
      `limit to one category (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .option('--file <path>', 'validate one public task without pack-balance checks')
    .action(async (options: { category?: BenchmarkCategory; file?: string }) => {
      if (options.file) {
        if (options.category) {
          throw new Error('tasks validate accepts --file or --category, not both');
        }
        const task = await validatePublicTaskFile(options.file);
        dependencies.stdout(
          `✓ ${task.public.id}: public task validated (${task.public.category}/${task.public.cluster})`,
        );
        return;
      }
      const categories = options.category ? [options.category] : CATEGORIES;
      for (const category of categories) {
        const loader = dependencies.createTaskLoader(category);
        const loaded = await loader.loadAll();
        const mode = loader.hasPrivate ? 'public + private halves' : 'public halves only';
        dependencies.stdout(`✓ ${category}: ${loaded.length} tasks validated (${mode})`);
        for (const task of loaded) {
          dependencies.stdout(`  ${task.public.cluster.padEnd(28)} ${task.public.id}`);
        }
      }
    });

  tasks
    .command('publish')
    .description('Publish public and private task halves to the configured API')
    .option(
      '-c, --category <category>',
      `category to publish (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .option('--all', 'publish every category explicitly', false)
    .action(async (options: CategorySelection) => {
      const categories = selectedCategories(options, 'tasks publish');
      const config = dependencies.resolveApiConfig();
      dependencies.stdout(`Publishing ${categories.join(', ')} tasks to ${publishTarget(config)}`);
      for (const category of categories) {
        const result = await dependencies.publishTasks(category, config);
        dependencies.stdout(`✓ ${category}: published ${result.imported} tasks`);
      }
    });

  const arena = program.command('arena').description('Run and inspect arena matches');
  arena
    .command('run')
    .description('Run a paid deterministic match schedule')
    .requiredOption(
      '-c, --category <category>',
      `arena to run (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .option('-n, --matches <count>', 'number of task-level matches', positiveInteger, 12)
    .option('-s, --seed <seed>', 'reproducible scheduling seed', 'bridgebench-v3-mvp')
    .option(
      '--max-cost-usd <amount>',
      'hard stop before the next match after this spend',
      positiveNumber,
      25,
    )
    .option(
      '--competitor <modelId>',
      'limit the run roster; repeat for each competitor (minimum two)',
      collectOption,
    )
    .option('--resume', 'skip match IDs already present in the journal', false)
    .option('--debug', 'mirror structured log entries to the console', false)
    .option('--no-health-stop', 'do not halt when most matches have failed responses')
    .action(async (options: ArenaRunCliOptions) => {
      const config = arenaRunConfigFromOptions(options);
      const logger = new FileArenaLogger({
        dir: logRoot(config.category),
        verbose: options.debug,
      });
      const cancellation = new AbortController();
      const requestCancellation = (): void => {
        if (cancellation.signal.aborted) return;
        dependencies.stderr('Cancellation requested; aborting active model calls.');
        cancellation.abort();
      };
      process.once('SIGINT', requestCancellation);
      try {
        dependencies.stdout(`Run log: ${displayPath(logger.filePath)}`);
        const store = dependencies.createStore(config.category);
        const loaded = await dependencies
          .createTaskLoader(config.category)
          .loadAll({ requirePrivate: true });
        const progressOutput: ArenaEventSink = (event) => {
          if (event.type !== 'match.completed') return;
          dependencies.stdout(
            `[${event.data.completed}/${event.data.total}] ${event.data.taskId}: ${event.data.winnerModelId ?? 'no contest'} (${event.data.outcome}, $${event.data.costUsd.toFixed(4)})`,
          );
        };
        const runner = new ArenaRunner(
          dependencies.createOpenRouter(logger),
          store,
          progressOutput,
          logger,
        );
        const result = await runner.run(config, loaded, { signal: cancellation.signal });
        if (result.cancelled) {
          dependencies.stdout(
            `Cancelled after ${result.completed} new ${config.category} matches; journaled spend $${result.costUsd.toFixed(4)}. Completed matches remain journaled.`,
          );
          dependencies.setExitCode(130);
        } else {
          dependencies.stdout(
            `Completed ${result.completed} new ${config.category} matches; run spend $${result.costUsd.toFixed(4)}.`,
          );
          if (result.stoppedForBudget) {
            dependencies.stdout(
              'Stopped at the cost boundary; rerun the same command with --resume.',
            );
          }
        }
        const runMatches = store.readAll().filter((match) => match.runId === result.runId);
        if (runMatches.length > 0) {
          const triage = triageJournal(runMatches);
          dependencies.stdout(`=== Run health ===\n${formatTriage(triage)}`);
        }
      } finally {
        process.removeListener('SIGINT', requestCancellation);
        dependencies.stdout(`Run log: ${displayPath(logger.filePath)}`);
      }
    });

  arena
    .command('remote-run')
    .description('Run a match schedule against the configured API and stream live arena events')
    .requiredOption(
      '-c, --category <category>',
      `arena to run (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .option('-n, --matches <count>', 'number of task-level matches', positiveInteger, 12)
    .option('-s, --seed <seed>', 'reproducible scheduling seed', 'bridgebench-v3-mvp')
    .option(
      '--max-cost-usd <amount>',
      'hard stop before the next match after this spend',
      positiveNumber,
      25,
    )
    .option(
      '--competitor <modelId>',
      'limit the run roster; repeat for each competitor (minimum two)',
      collectOption,
    )
    .option('--resume', 'skip match IDs already present in the journal', false)
    .option('--debug', 'mirror structured log entries to the console', false)
    .option('--no-health-stop', 'do not halt when most matches have failed responses')
    .option('--mock', 'use deterministic mock model completions instead of OpenRouter', false)
    .option('--no-publish-matches', 'skip publishing match results to the API as they complete')
    .action(async (options: ArenaRunCliOptions & { mock: boolean; publishMatches: boolean }) => {
      const config = arenaRunConfigFromOptions(options);
      const apiConfig = dependencies.resolveApiConfig();
      const logger = new FileArenaLogger({
        dir: logRoot(config.category),
        verbose: options.debug,
      });
      dependencies.stdout(
        `Remote ${config.category} run against ${publishTarget(apiConfig)} (${options.mock ? 'mock' : 'openrouter'})`,
      );
      dependencies.stdout(`Run log: ${displayPath(logger.filePath)}`);
      try {
        const result = await runRemoteArena(apiConfig, {
          config,
          mock: options.mock,
          publishMatches: options.publishMatches,
          logger,
        });
        dependencies.stdout(
          `Remote run ${result.runKey}: ${result.completed} matches, $${result.costUsd.toFixed(4)}`,
        );
        if (result.cancelled) dependencies.setExitCode(130);
      } finally {
        dependencies.stdout(`Run log: ${displayPath(logger.filePath)}`);
      }
    });

  arena
    .command('verify')
    .description('Validate and replay outcomes, points, manifests, and Elo')
    .option(
      '-c, --category <category>',
      `journal category (${CATEGORIES.join(', ')})`,
      parseCategory,
      'reasoning',
    )
    .option('--journal <path>', 'journal file to verify (defaults to the local category journal)')
    .option('--manifests-dir <path>', 'run-manifest directory (defaults to a runs/ sibling)')
    .option('--json', 'emit the machine-readable verification result', false)
    .action(
      (options: {
        category: BenchmarkCategory;
        journal?: string;
        manifestsDir?: string;
        json: boolean;
      }) => {
        const defaults = categoryStoreConfig(options.category);
        const journalPath = options.journal ? path.resolve(options.journal) : defaults.journalPath;
        const runsDir = options.manifestsDir
          ? path.resolve(options.manifestsDir)
          : options.journal
            ? path.join(path.dirname(journalPath), 'runs')
            : defaults.runsDir;
        const store = new ArenaStore({
          ...defaults,
          journalPath,
          runsDir,
          readOnly: true,
        });
        const verified = verifyJournal(store.readAll(), options.category, {
          manifestForRun: (runId) => store.readRunManifest(runId),
          requireManifests: true,
        });
        if (options.json) {
          dependencies.stdout(JSON.stringify(verified, null, 2));
          return;
        }
        dependencies.stdout(
          `✓ ${options.category}: verified ${verified.matches.length} matches across ${verified.runs.length} runs`,
        );
        for (const warning of verified.warnings) {
          dependencies.stderr(`Warning: ${warning}`);
        }
      },
    );

  arena
    .command('publish')
    .description('Publish a verified match journal to the configured API')
    .option(
      '-c, --category <category>',
      `journal to publish (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .option('--all', 'publish every category explicitly', false)
    .option('--allow-empty', 'treat an empty journal as a successful no-op', false)
    .action(async (options: CategorySelection & { allowEmpty: boolean }) => {
      const categories = selectedCategories(options, 'arena publish');
      const config = dependencies.resolveApiConfig();
      dependencies.stdout(
        `Publishing ${categories.join(', ')} journals to ${publishTarget(config)}`,
      );
      for (const category of categories) {
        const store = dependencies.createStore(category);
        verifyJournal(store.readAll(), category, {
          manifestForRun: (runId) => store.readRunManifest(runId),
          requireManifests: true,
        });
        const result = await dependencies.publishJournal(category, config);
        if (result.matches === 0 && !options.allowEmpty) {
          throw new Error(
            `The ${category} journal is empty; pass --allow-empty for an intentional no-op`,
          );
        }
        dependencies.stdout(
          `✓ ${category}: ${result.imported} new, ${result.skipped} already present (of ${result.matches} lines)`,
        );
      }
    });

  arena
    .command('triage')
    .description('Analyze failures, suspicious responses, and judging anomalies')
    .option(
      '-c, --category <category>',
      `journal to analyze (${CATEGORIES.join(', ')})`,
      parseCategory,
      'reasoning',
    )
    .option('--run <runId>', 'limit the report to one run ID')
    .option('--json', 'emit the machine-readable report', false)
    .option('--strict', 'exit nonzero when any anomaly is found', false)
    .option('--allow-empty', 'treat no matching journal lines as success', false)
    .action(
      (options: {
        category: BenchmarkCategory;
        run?: string;
        json: boolean;
        strict: boolean;
        allowEmpty: boolean;
      }) => {
        const results = dependencies
          .createStore(options.category)
          .readAll()
          .filter((match) => !options.run || match.runId === options.run);
        if (results.length === 0) {
          const message = options.run
            ? `No ${options.category} matches found for run ${options.run}.`
            : `The ${options.category} journal is empty.`;
          if (!options.allowEmpty) throw new Error(message);
          dependencies.stdout(message);
          return;
        }
        const reports = triageJournal(results);
        dependencies.stdout(
          options.json ? JSON.stringify(reports, null, 2) : formatTriage(reports),
        );
        const anomalies = reports.reduce((sum, report) => sum + report.anomalies.length, 0);
        if (options.strict && anomalies > 0) {
          dependencies.stderr(`Strict mode: ${anomalies} anomalies found.`);
          dependencies.setExitCode(1);
        }
      },
    );

  arena
    .command('generation <generationId>')
    .description("Fetch OpenRouter's record for a journaled generation")
    .action(async (generationId: string) => {
      const data = await dependencies.createOpenRouter().fetchGeneration(generationId);
      dependencies.stdout(JSON.stringify(data, null, 2));
    });

  program
    .command('report')
    .description('Verify journals and rebuild JSON and Markdown reports')
    .option(
      '-c, --category <category>',
      `limit to one category (${CATEGORIES.join(', ')})`,
      parseCategory,
    )
    .action((options: { category?: BenchmarkCategory }) => {
      const categories = options.category ? [options.category] : CATEGORIES;
      for (const category of categories) {
        const snapshot = writeReports(dependencies.createStore(category));
        dependencies.stdout(`✓ ${category}: wrote reports for ${snapshot.matches.length} matches`);
      }
    });

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  overrides: Partial<CliDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const envResult = loadProjectEnv();
  if (envResult.status === 'error') {
    dependencies.stderr(
      `Warning: project environment file could not be loaded: ${redactSecrets(envResult.reason)}`,
    );
  }
  await buildProgram(dependencies).parseAsync(argv);
}
