/**
 * Recovers the HTML document from raw model output.
 *
 * Ordered regex cascade (ported from the proven legacy extractor):
 * closed fence → unclosed fence → raw document → embedded document →
 * truncated document → trimmed response as-is.
 */

export type UiExtractionStrategy =
  | 'closed-fence'
  | 'unclosed-fence'
  | 'raw-document'
  | 'embedded-document'
  | 'embedded-html-tag'
  | 'truncated-document'
  | 'truncated-html-tag'
  | 'as-is';

export interface UiExtractionResult {
  html: string;
  /** Which cascade step recovered the document (for debugging/logging). */
  strategy: UiExtractionStrategy;
}

export class UiArtifactExtractor {
  extractHtml(response: string): string {
    return this.extract(response).html;
  }

  extract(response: string): UiExtractionResult {
    // 1. Closed markdown fence — ideal case
    const fencedMatch = response.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return { html: fencedMatch[1].trim(), strategy: 'closed-fence' };
    }

    // 2. Unclosed markdown fence (model hit token limit before closing ```)
    const openFenceMatch = response.match(/```(?:html)?\s*\n([\s\S]+)/i);
    if (openFenceMatch?.[1]) {
      const inner = openFenceMatch[1].trim();
      if (/^<!doctype html>/i.test(inner) || /^<html[\s>]/i.test(inner)) {
        return { html: inner, strategy: 'unclosed-fence' };
      }
    }

    // 3. Raw HTML — response starts with DOCTYPE or <html>
    const trimmed = response.trim();
    if (/^<!doctype html>/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return { html: trimmed, strategy: 'raw-document' };
    }

    // 4. HTML embedded in surrounding commentary (complete document)
    const docMatch = response.match(/(<!DOCTYPE[\s\S]*<\/html>)/i);
    if (docMatch?.[1]) {
      return { html: docMatch[1].trim(), strategy: 'embedded-document' };
    }

    const htmlMatch = response.match(/(<html[\s\S]*<\/html>)/i);
    if (htmlMatch?.[1]) {
      return { html: htmlMatch[1].trim(), strategy: 'embedded-html-tag' };
    }

    // 5. HTML embedded but truncated (no closing </html>)
    const truncatedDocMatch = response.match(/(<!DOCTYPE[\s\S]+)/i);
    if (truncatedDocMatch?.[1]) {
      return { html: truncatedDocMatch[1].trim(), strategy: 'truncated-document' };
    }

    const truncatedHtmlMatch = response.match(/(<html[\s\S]+)/i);
    if (truncatedHtmlMatch?.[1]) {
      return { html: truncatedHtmlMatch[1].trim(), strategy: 'truncated-html-tag' };
    }

    return { html: trimmed, strategy: 'as-is' };
  }
}
