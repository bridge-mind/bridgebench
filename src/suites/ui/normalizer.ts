/**
 * Canonicalizes an extracted artifact before validation, evaluation, and
 * publication:
 *
 * 1. Any import map that maps 'three' is rewritten to the byte-exact
 *    canonical pinned map — a typo'd version or CDN mapping cannot escape
 *    the pin. Extra non-three mappings are dropped (and will then fail
 *    validation via their import specifiers).
 * 2. If the code imports 'three' but no import map exists, the canonical
 *    map is injected at the top of <head> (import maps must precede module
 *    scripts).
 * 3. Ensures a <title> exists (used by the gallery).
 *
 * Deliberately NOT a rewrap of the whole document (the legacy normalizer
 * regenerated head/body, which could reorder scripts and break modules).
 */

import { CANONICAL_IMPORT_MAP_JSON } from '../../config.js';
import { buildImportMapBlock } from './prompt-builder.js';

const IMPORT_MAP_RE = /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;

export class UiArtifactNormalizer {
  normalize(html: string, meta: { taskTitle: string; modelName: string }): string {
    let output = html;

    const importsThree =
      /(?:^|[\s;(>])import\s+(?:[\w${},*\s]+from\s+)?["']three(?:\/addons\/[^"']*)?["']/.test(
        output,
      ) || /import\s*\(\s*["']three(?:\/addons\/[^"']*)?["']\s*\)/.test(output);

    const importMaps = output.match(IMPORT_MAP_RE) ?? [];

    if (importMaps.length > 0) {
      // Replace the first import map with the canonical block; delete extras.
      let first = true;
      output = output.replace(IMPORT_MAP_RE, () => {
        if (first) {
          first = false;
          return buildImportMapBlock();
        }
        return '';
      });
    } else if (importsThree) {
      output = this.injectIntoHead(output, buildImportMapBlock());
    }

    if (!/<title[\s>]/i.test(output)) {
      const title = `<title>${escapeHtml(meta.taskTitle)} — ${escapeHtml(meta.modelName)} | BridgeBench</title>`;
      output = this.injectIntoHead(output, title);
    }

    return output;
  }

  /** Insert a block right after <head>, creating one if the document lacks it. */
  private injectIntoHead(html: string, block: string): string {
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
      const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
      return `${html.slice(0, idx)}\n${block}${html.slice(idx)}`;
    }
    const htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const idx = html.indexOf(htmlMatch[0]) + htmlMatch[0].length;
      return `${html.slice(0, idx)}\n<head>\n${block}\n</head>${html.slice(idx)}`;
    }
    return `${block}\n${html}`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { CANONICAL_IMPORT_MAP_JSON };
