/**
 * Static validation of an artifact BEFORE it reaches a browser.
 *
 * Contract: one self-contained HTML document whose only external references
 * are the pinned same-origin three.js vendor files (via the canonical import
 * map). Anything else — CDNs, other packages, relative files, non-pinned
 * vendor versions — is a hard error. Network APIs are warnings here and
 * blocked at runtime by the evaluator.
 *
 * Run this on the NORMALIZED artifact (normalizer.ts canonicalizes the
 * import map first, so a cosmetically different but equivalent map doesn't
 * fail validation).
 */

import {
  CANONICAL_IMPORT_MAP,
  THREE_VENDOR_WEB_ROOT,
} from '../../config.js';
import type { UiArtifactValidationResult, UiBenchTask } from './types.js';

const MAX_SIZE_WARN = 700 * 1024;
const MAX_SIZE_ERROR = 2 * 1024 * 1024;

const FORBIDDEN_API_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'fetch', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { name: 'EventSource', pattern: /\bnew\s+EventSource\b/ },
  { name: 'sendBeacon', pattern: /\bsendBeacon\s*\(/ },
  { name: 'serviceWorker', pattern: /\bserviceWorker\b/ },
  { name: 'Worker', pattern: /\bnew\s+(?:Shared)?Worker\s*\(/ },
];

export class UiArtifactValidator {
  validateHtml(html: string, task?: UiBenchTask): UiArtifactValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sizeBytes = Buffer.byteLength(html, 'utf8');
    const hasDoctype = /^\s*<!doctype html>/i.test(html);
    const hasHtmlTag = /<html[\s>]/i.test(html);
    const hasManifest = html.includes('BridgeBenchTaskManifest');
    const hasTaskApi = html.includes('BridgeBenchTaskApi');

    if (!hasDoctype) errors.push('Missing <!DOCTYPE html> declaration');
    if (!hasHtmlTag) errors.push('Missing <html> root element');
    if (!hasManifest) errors.push('Missing window.BridgeBenchTaskManifest harness global');
    if (!hasTaskApi) errors.push('Missing window.BridgeBenchTaskApi harness global');

    if (sizeBytes > MAX_SIZE_ERROR) {
      errors.push(`Artifact is ${Math.round(sizeBytes / 1024)}KB (hard limit 2048KB)`);
    } else if (sizeBytes > MAX_SIZE_WARN) {
      warnings.push(`Artifact is ${Math.round(sizeBytes / 1024)}KB (soft limit 700KB)`);
    }

    // ── src / href references ──────────────────────────────────────────
    const externalAssetRefs: string[] = [];
    for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const url = match[1].trim();
      if (/^(?:https?:)?\/\//i.test(url)) {
        externalAssetRefs.push(url);
        errors.push(`External asset reference not allowed: ${url}`);
      } else if (url.startsWith('/')) {
        if (!url.startsWith(`${THREE_VENDOR_WEB_ROOT}/`)) {
          externalAssetRefs.push(url);
          errors.push(
            `Root-relative reference outside the pinned vendor root (${THREE_VENDOR_WEB_ROOT}/): ${url}`,
          );
        }
      }
      // data:, blob:, and fragment refs are fine.
    }

    // ── Import map ─────────────────────────────────────────────────────
    const importMapMatch = html.match(
      /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    const hasImportMap = importMapMatch !== null;
    let importMapCanonical = false;
    if (importMapMatch) {
      try {
        const parsed = JSON.parse(importMapMatch[1]);
        const imports = parsed?.imports ?? {};
        const keys = Object.keys(imports);
        importMapCanonical =
          keys.length === 2 &&
          imports['three'] === CANONICAL_IMPORT_MAP.imports['three'] &&
          imports['three/addons/'] === CANONICAL_IMPORT_MAP.imports['three/addons/'];
        if (!importMapCanonical) {
          errors.push(
            'Import map is not the canonical pinned map (run the normalizer before validating, or the artifact maps something beyond three/three-addons)',
          );
        }
      } catch {
        errors.push('Import map is not valid JSON');
      }
    }

    // ── Module import specifiers ──────────────────────────────────────
    const moduleSpecifiers: string[] = [];
    const scriptBlocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scriptBlocks) {
      if (/type\s*=\s*["']importmap["']/i.test(attrs)) continue;
      for (const match of body.matchAll(
        /(?:^|[\s;(])import\s+(?:[\w${},*\s]+from\s+)?["']([^"']+)["']/g,
      )) {
        moduleSpecifiers.push(match[1]);
      }
      for (const match of body.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        moduleSpecifiers.push(match[1]);
      }
    }

    const usesThree = moduleSpecifiers.some(
      (spec) => spec === 'three' || spec.startsWith('three/addons/'),
    );

    for (const spec of moduleSpecifiers) {
      const allowed = spec === 'three' || spec.startsWith('three/addons/');
      if (!allowed) {
        errors.push(`Module import "${spec}" is not allowed (only 'three' and 'three/addons/…')`);
      }
    }

    if (usesThree && !hasImportMap) {
      errors.push("Imports 'three' but has no import map (normalizer should have injected it)");
    }

    // ── Forbidden network / worker APIs (runtime-blocked; warn here) ──
    const forbiddenApiRefs: string[] = [];
    for (const [, attrs, body] of scriptBlocks) {
      if (/type\s*=\s*["']importmap["']/i.test(attrs)) continue;
      for (const { name, pattern } of FORBIDDEN_API_PATTERNS) {
        if (pattern.test(body) && !forbiddenApiRefs.includes(name)) {
          forbiddenApiRefs.push(name);
          warnings.push(`References restricted API: ${name} (blocked at runtime)`);
        }
      }
    }

    // ── Declared controls present in markup ───────────────────────────
    const declaredControlIds = [
      ...html.matchAll(/data-bb-control\s*=\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);

    if (task) {
      for (const control of task.controls) {
        if (!declaredControlIds.includes(control.id)) {
          warnings.push(
            `Declared control "${control.id}" not found in markup (spec-adherence penalty)`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      metadata: {
        sizeBytes,
        hasDoctype,
        hasHtmlTag,
        hasManifest,
        hasTaskApi,
        hasImportMap,
        importMapCanonical,
        usesThree,
        moduleSpecifiers,
        externalAssetRefs,
        forbiddenApiRefs,
        declaredControlIds,
      },
    };
  }
}
