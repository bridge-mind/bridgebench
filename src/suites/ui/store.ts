/**
 * Artifact store — one directory per (task, model, run):
 *
 *   results/ui/artifacts/<taskId>/<modelSlug>/<runId>/
 *     artifact.html      raw extracted HTML (audit trail)
 *     normalized.html    canonical-import-map version (evaluated + published)
 *     raw.txt            full model response
 *     metadata.json      UiArtifactRecord
 *     <name>.png         gallery screenshots (hero, motion, …)
 *     probe-<id>.png     per-probe audit shots
 *     determinism-{a,b}.png
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  artifactSlug,
  type UiArtifactValidationResult,
  type UiBenchTask,
} from './types.js';

export interface UiArtifactRecord {
  runId: string;
  createdAt: string;
  modelId: string;
  displayName: string;
  task: Pick<UiBenchTask, 'id' | 'title' | 'category' | 'season'>;
  paths: {
    dir: string;
    html: string;
    normalized: string;
    raw: string;
    metadata: string;
  };
  providerResponseMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  validation: UiArtifactValidationResult;
}

export class UiArtifactStore {
  constructor(private readonly rootDir: string) {}

  async writeArtifact(input: {
    modelId: string;
    displayName: string;
    task: UiBenchTask;
    html: string;
    normalizedHtml: string;
    rawResponse: string;
    providerResponseMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    validation: UiArtifactValidationResult;
  }): Promise<UiArtifactRecord> {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(this.rootDir, input.task.id, artifactSlug(input.modelId), runId);

    await fs.mkdir(runDir, { recursive: true });

    const record: UiArtifactRecord = {
      runId,
      createdAt: new Date().toISOString(),
      modelId: input.modelId,
      displayName: input.displayName,
      task: {
        id: input.task.id,
        title: input.task.title,
        category: input.task.category,
        season: input.task.season,
      },
      paths: {
        dir: runDir,
        html: path.join(runDir, 'artifact.html'),
        normalized: path.join(runDir, 'normalized.html'),
        raw: path.join(runDir, 'raw.txt'),
        metadata: path.join(runDir, 'metadata.json'),
      },
      providerResponseMs: input.providerResponseMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd,
      validation: input.validation,
    };

    await Promise.all([
      fs.writeFile(record.paths.html, input.html, 'utf8'),
      fs.writeFile(record.paths.normalized, input.normalizedHtml, 'utf8'),
      fs.writeFile(record.paths.raw, input.rawResponse, 'utf8'),
      fs.writeFile(record.paths.metadata, JSON.stringify(record, null, 2), 'utf8'),
    ]);

    return record;
  }
}
