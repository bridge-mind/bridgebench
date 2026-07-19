import { describe, expect, it } from 'vitest';

import { CANONICAL_IMPORT_MAP_JSON } from '../src/config.js';
import { UiArtifactNormalizer } from '../src/suites/ui/normalizer.js';

const normalizer = new UiArtifactNormalizer();
const meta = { taskTitle: 'Test Task', modelName: 'Test Model' };

describe('UiArtifactNormalizer', () => {
  it('rewrites a typo’d import map version to the canonical pin', () => {
    const html = `<!DOCTYPE html><html><head>
<script type="importmap">{"imports":{"three":"/vendor/three@0.999.0/three.module.min.js","three/addons/":"/vendor/three@0.999.0/addons/"}}</script>
</head><body><script type="module">import * as THREE from 'three';</script></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output).toContain(CANONICAL_IMPORT_MAP_JSON);
    expect(output).not.toContain('0.999.0');
  });

  it('rewrites a CDN import map to the canonical pin', () => {
    const html = `<!DOCTYPE html><html><head>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three/build/three.module.js"}}</script>
</head><body><script type="module">import * as THREE from 'three';</script></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output).toContain(CANONICAL_IMPORT_MAP_JSON);
    expect(output).not.toContain('unpkg.com');
  });

  it('injects the canonical map when three is imported without one', () => {
    const html = `<!DOCTYPE html><html><head><title>x</title></head>
<body><script type="module">import * as THREE from 'three';</script></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output).toContain(CANONICAL_IMPORT_MAP_JSON);
    // Injected into <head>, before the module script.
    expect(output.indexOf('importmap')).toBeLessThan(output.indexOf('type="module"'));
  });

  it('collapses duplicate import maps to one canonical map', () => {
    const map = `<script type="importmap">{"imports":{"three":"/x.js"}}</script>`;
    const html = `<!DOCTYPE html><html><head>${map}${map}</head><body></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output.match(/type="importmap"/g)?.length).toBe(1);
  });

  it('does not touch pure-vanilla artifacts (no three import, no map)', () => {
    const html = `<!DOCTYPE html><html><head><title>v</title></head><body><canvas></canvas><script>1</script></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output).not.toContain('importmap');
  });

  it('adds a title when missing', () => {
    const html = `<!DOCTYPE html><html><head></head><body></body></html>`;
    const output = normalizer.normalize(html, meta);
    expect(output).toContain('<title>Test Task — Test Model | BridgeBench</title>');
  });
});
