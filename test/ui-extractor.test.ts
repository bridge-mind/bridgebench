import { describe, expect, it } from 'vitest';

import { UiArtifactExtractor } from '../src/suites/ui/extractor.js';

const extractor = new UiArtifactExtractor();
const DOC = '<!DOCTYPE html>\n<html><body>hi</body></html>';

describe('UiArtifactExtractor', () => {
  it('extracts from a closed html fence', () => {
    expect(extractor.extractHtml('Sure!\n```html\n' + DOC + '\n```\nDone.')).toBe(DOC);
  });

  it('extracts from an unclosed fence when the body is a document', () => {
    expect(extractor.extractHtml('```html\n' + DOC)).toBe(DOC);
  });

  it('passes through a raw document', () => {
    expect(extractor.extractHtml('\n' + DOC + '\n')).toBe(DOC);
  });

  it('recovers a document embedded in commentary', () => {
    expect(extractor.extractHtml('Here is your file:\n\n' + DOC + '\n\nEnjoy!')).toBe(DOC);
  });

  it('recovers a truncated document', () => {
    const truncated = '<!DOCTYPE html>\n<html><body><script>let x = 1;';
    expect(extractor.extractHtml('prose before\n' + truncated)).toBe(truncated);
  });
});
