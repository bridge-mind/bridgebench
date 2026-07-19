/**
 * Gold-set judge calibration.
 *
 * A gold case is a retired or purpose-authored task with a known-correct
 * answer pair: one response the reference marks strong, one it marks weak.
 * The runner shows each case to a single judge in four perturbed variants —
 * both seat orders, and a version where the weak answer is inflated with
 * substance-free verbosity — and a calibrated judge picks the strong answer
 * in all of them. Results persist per judge model beside the journal store
 * so seating can prefer judges with a passing calibration.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

import { buildJudgePayload, judgeSystemPrompt } from './judges.js';
import { getJudgeModel } from './models.js';
import { parseJudgeVerdict, sanitizeError } from './openrouter.js';
import { packageRoot } from './paths.js';
import {
  TaskPrivateSchema,
  TaskPublicSchema,
  type CompleteArenaTask,
  type OpenRouterGateway,
} from './types.js';

const ROOT = packageRoot(import.meta.url);

export function defaultCalibrationRoot(): string {
  return path.join(ROOT, 'calibration');
}

export function defaultCalibrationResultsPath(): string {
  return path.join(ROOT, 'results', 'calibration.json');
}

export const GoldCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    task: z
      .object({
        public: TaskPublicSchema,
        private: TaskPrivateSchema,
      })
      .strict(),
    /** The response the hidden reference marks as clearly stronger. */
    strongResponse: z.string().min(1).max(40_000),
    /** The response containing the citable error the judge must catch. */
    weakResponse: z.string().min(1).max(40_000),
    /** What separates them — kept for reviewers, never sent to the judge. */
    knownDifference: z.string().min(1).max(2_000),
  })
  .strict();
export type GoldCase = z.infer<typeof GoldCaseSchema>;

export async function loadGoldCases(root = defaultCalibrationRoot()): Promise<GoldCase[]> {
  if (!existsSync(root)) return [];
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith('.yaml'))
    .sort();
  const cases: GoldCase[] = [];
  for (const file of files) {
    const filePath = path.join(root, file);
    const raw = await readFile(filePath, 'utf8');
    let value: GoldCase;
    try {
      value = GoldCaseSchema.parse(YAML.parse(raw));
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; ')
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`Invalid gold case ${filePath}: ${detail}`, { cause: error });
    }
    if (path.basename(file, '.yaml') !== value.id) {
      throw new Error(`${filePath} must use the case id ${value.id} as its filename`);
    }
    if (value.task.public.id !== value.id || value.task.private.id !== value.id) {
      throw new Error(`${filePath} task ids must match the case id`);
    }
    cases.push(value);
  }
  const ids = new Set(cases.map((goldCase) => goldCase.id));
  if (ids.size !== cases.length) throw new Error('Duplicate gold case ids in the calibration set');
  return cases;
}

/**
 * Substance-free inflation: wraps a response in confident framing, section
 * headers, and restatement without adding or changing a single claim. A judge
 * swayed by this padding is rewarding presentation, which the rubric forbids.
 */
export function inflateResponse(content: string): string {
  return [
    '## Executive Summary',
    'After a comprehensive, systematic, and rigorous end-to-end review of every artifact provided,',
    'cross-referencing each deliverable against all available evidence and applying industry-standard',
    'best practices throughout, the complete findings are presented below with full supporting detail.',
    '',
    '## Methodology',
    'Each artifact was examined line by line. All findings were validated twice for consistency and',
    'completeness. No stone was left unturned in the pursuit of a thorough and defensible analysis.',
    '',
    '## Detailed Findings',
    content,
    '',
    '## Conclusion',
    'In conclusion, the analysis above stands on a comprehensive review of the provided materials.',
    'The findings are presented with high confidence following the systematic methodology described,',
    'and each conclusion follows directly from the detailed reasoning laid out in the sections above.',
  ].join('\n');
}

export type CalibrationVariantId =
  'seat-a-terse' | 'seat-b-terse' | 'seat-a-verbose' | 'seat-b-verbose';

export const CALIBRATION_VARIANTS: readonly CalibrationVariantId[] = [
  'seat-a-terse',
  'seat-b-terse',
  'seat-a-verbose',
  'seat-b-verbose',
];

export interface CalibrationVariantResult {
  variant: CalibrationVariantId;
  /** Which anonymous label held the strong response for this variant. */
  strongLabel: 'MODEL_A' | 'MODEL_B';
  verdictWinner: 'MODEL_A' | 'MODEL_B' | 'TIE' | 'ABSTAIN' | null;
  confidence: number | null;
  passed: boolean;
  error?: string;
}

export interface CalibrationCaseResult {
  caseId: string;
  category: string;
  variants: CalibrationVariantResult[];
  /** Both terse seat variants picked the same underlying response. */
  seatConsistent: boolean;
  /** Both verbose variants still picked the strong response. */
  verbosityResistant: boolean;
  passed: boolean;
}

export interface CalibrationReport {
  judgeModelId: string;
  runAt: string;
  cases: number;
  variantsRun: number;
  variantsPassed: number;
  passRate: number;
  seatConsistency: number;
  verbosityResistance: number;
  /** Every variant of every case picked the strong response. */
  passed: boolean;
  caseResults: CalibrationCaseResult[];
}

function goldTask(goldCase: GoldCase): CompleteArenaTask {
  const publicJson = JSON.stringify(goldCase.task.public);
  const privateJson = JSON.stringify(goldCase.task.private);
  return {
    public: goldCase.task.public,
    private: goldCase.task.private,
    publicHash: createHash('sha256').update(publicJson).digest('hex'),
    privateHash: createHash('sha256').update(privateJson).digest('hex'),
  };
}

export async function runCalibration(
  gateway: OpenRouterGateway,
  judgeModelId: string,
  cases: GoldCase[],
  signal?: AbortSignal,
): Promise<CalibrationReport> {
  if (cases.length === 0) throw new Error('The calibration gold set is empty');
  const judge = getJudgeModel(judgeModelId);
  const caseResults: CalibrationCaseResult[] = [];

  for (const goldCase of cases) {
    const task = goldTask(goldCase);
    const variants: CalibrationVariantResult[] = [];
    for (const variant of CALIBRATION_VARIANTS) {
      const verbose = variant.endsWith('verbose');
      const strongInSeatA = variant.startsWith('seat-a');
      const weak = verbose ? inflateResponse(goldCase.weakResponse) : goldCase.weakResponse;
      const [answerA, answerB] = strongInSeatA
        ? [goldCase.strongResponse, weak]
        : [weak, goldCase.strongResponse];
      const strongLabel = strongInSeatA ? 'MODEL_A' : 'MODEL_B';
      try {
        const completion = await gateway.complete({
          model: judge,
          system: judgeSystemPrompt(task.public.category),
          user: buildJudgePayload(task, answerA, answerB),
          structured: true,
          signal,
        });
        const verdict = parseJudgeVerdict(completion.content, {
          artifactIds: task.public.artifacts.map((artifact) => artifact.id),
        });
        variants.push({
          variant,
          strongLabel,
          verdictWinner: verdict.winner,
          confidence: verdict.confidence,
          passed: verdict.winner === strongLabel,
        });
      } catch (error) {
        variants.push({
          variant,
          strongLabel,
          verdictWinner: null,
          confidence: null,
          passed: false,
          error: sanitizeError(error),
        });
      }
    }
    const terse = variants.filter((entry) => entry.variant.endsWith('terse'));
    const verboseVariants = variants.filter((entry) => entry.variant.endsWith('verbose'));
    const pickedResponse = (entry: CalibrationVariantResult): string | null =>
      entry.verdictWinner === 'MODEL_A' || entry.verdictWinner === 'MODEL_B'
        ? entry.verdictWinner === entry.strongLabel
          ? 'strong'
          : 'weak'
        : null;
    const tersePicks = terse.map(pickedResponse);
    caseResults.push({
      caseId: goldCase.id,
      category: goldCase.task.public.category,
      variants,
      seatConsistent: tersePicks[0] !== null && tersePicks[0] === tersePicks[1],
      verbosityResistant: verboseVariants.every((entry) => entry.passed),
      passed: variants.every((entry) => entry.passed),
    });
  }

  const variantsRun = caseResults.reduce((sum, entry) => sum + entry.variants.length, 0);
  const variantsPassed = caseResults.reduce(
    (sum, entry) => sum + entry.variants.filter((variant) => variant.passed).length,
    0,
  );
  return {
    judgeModelId,
    runAt: new Date().toISOString(),
    cases: caseResults.length,
    variantsRun,
    variantsPassed,
    passRate: variantsPassed / variantsRun,
    seatConsistency:
      caseResults.filter((entry) => entry.seatConsistent).length / caseResults.length,
    verbosityResistance:
      caseResults.filter((entry) => entry.verbosityResistant).length / caseResults.length,
    passed: caseResults.every((entry) => entry.passed),
    caseResults,
  };
}

/** Stored beside the journal snapshots: judge id → latest calibration report. */
export type CalibrationLedger = Record<string, CalibrationReport>;

export function readCalibrationLedger(
  filePath = defaultCalibrationResultsPath(),
): CalibrationLedger {
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, 'utf8')) as CalibrationLedger;
}

export function recordCalibration(
  report: CalibrationReport,
  filePath = defaultCalibrationResultsPath(),
): CalibrationLedger {
  const ledger = readCalibrationLedger(filePath);
  ledger[report.judgeModelId] = report;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

/**
 * The seating-facing view: judges with a recorded passing calibration rank
 * ahead of unknown or failing ones (see rankEligibleJudges).
 */
export function calibrationPassSet(ledger: CalibrationLedger): Set<string> {
  return new Set(
    Object.values(ledger)
      .filter((report) => report.passed)
      .map((report) => report.judgeModelId),
  );
}

const asPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    `=== Calibration: ${report.judgeModelId} ===`,
    `  ${report.cases} cases × ${CALIBRATION_VARIANTS.length} variants — ${report.variantsPassed}/${report.variantsRun} passed (${asPct(report.passRate)})`,
    `  seat consistency ${asPct(report.seatConsistency)}, verbosity resistance ${asPct(report.verbosityResistance)}`,
    `  verdict: ${report.passed ? 'PASS' : 'FAIL'}`,
  ];
  for (const entry of report.caseResults.filter((caseResult) => !caseResult.passed)) {
    const failed = entry.variants.filter((variant) => !variant.passed);
    lines.push(
      `  ✗ ${entry.caseId} (${entry.category}): ${failed
        .map(
          (variant) =>
            `${variant.variant} → ${variant.verdictWinner ?? `error: ${variant.error ?? 'unknown'}`}`,
        )
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
