import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../src/config.js';
import { UiArtifactValidator } from '../src/suites/ui/validator.js';

const validator = new UiArtifactValidator();

function fixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, 'fixtures', name), 'utf8');
}

describe('UiArtifactValidator', () => {
  it('accepts the golden-correct fixture', () => {
    const result = validator.validateHtml(fixture('golden-correct.html'));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.metadata.usesThree).toBe(true);
    expect(result.metadata.importMapCanonical).toBe(true);
    expect(result.metadata.declaredControlIds).toContain('heat-slider');
    expect(result.metadata.declaredControlIds).toContain('color-cycle');
  });

  it('accepts the runtime-broken fixture statically (it dies in the browser, not here)', () => {
    const result = validator.validateHtml(fixture('golden-broken.html'));
    expect(result.valid).toBe(true);
  });

  it('hard-rejects CDN scripts (golden-cheating)', () => {
    const result = validator.validateHtml(fixture('golden-cheating.html'));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cdn.jsdelivr.net'))).toBe(true);
  });

  it('rejects missing harness globals', () => {
    const result = validator.validateHtml('<!DOCTYPE html><html><body></body></html>');
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('BridgeBenchTaskManifest');
    expect(result.errors.join()).toContain('BridgeBenchTaskApi');
  });

  it('rejects non-three module imports', () => {
    const html = `<!DOCTYPE html><html><body>
      <script>window.BridgeBenchTaskManifest={};window.BridgeBenchTaskApi={};</script>
      <script type="module">import confetti from 'canvas-confetti';</script>
      </body></html>`;
    const result = validator.validateHtml(html);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('canvas-confetti'))).toBe(true);
  });

  it('rejects root-relative refs outside the pinned vendor root', () => {
    const html = `<!DOCTYPE html><html><body>
      <script>window.BridgeBenchTaskManifest={};window.BridgeBenchTaskApi={};</script>
      <img src="/images/logo.png">
      </body></html>`;
    const result = validator.validateHtml(html);
    expect(result.valid).toBe(false);
  });

  it('warns (not errors) on restricted network APIs', () => {
    const html = `<!DOCTYPE html><html><body>
      <script>window.BridgeBenchTaskManifest={};window.BridgeBenchTaskApi={};
      fetch('/api/x');</script>
      </body></html>`;
    const result = validator.validateHtml(html);
    expect(result.valid).toBe(true);
    expect(result.metadata.forbiddenApiRefs).toContain('fetch');
  });
});
