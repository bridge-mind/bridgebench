/**
 * Recovers the HTML document from raw model output.
 *
 * Ordered regex cascade (ported from the proven legacy extractor):
 * closed fence → unclosed fence → raw document → embedded document →
 * truncated document → trimmed response as-is.
 */

export class UiArtifactExtractor {
  extractHtml(response: string): string {
    // 1. Closed markdown fence — ideal case
    const fencedMatch = response.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    // 2. Unclosed markdown fence (model hit token limit before closing ```)
    const openFenceMatch = response.match(/```(?:html)?\s*\n([\s\S]+)/i);
    if (openFenceMatch?.[1]) {
      const inner = openFenceMatch[1].trim();
      if (/^<!doctype html>/i.test(inner) || /^<html[\s>]/i.test(inner)) {
        return inner;
      }
    }

    // 3. Raw HTML — response starts with DOCTYPE or <html>
    const trimmed = response.trim();
    if (/^<!doctype html>/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return trimmed;
    }

    // 4. HTML embedded in surrounding commentary (complete document)
    const docMatch = response.match(/(<!DOCTYPE[\s\S]*<\/html>)/i);
    if (docMatch?.[1]) {
      return docMatch[1].trim();
    }

    const htmlMatch = response.match(/(<html[\s\S]*<\/html>)/i);
    if (htmlMatch?.[1]) {
      return htmlMatch[1].trim();
    }

    // 5. HTML embedded but truncated (no closing </html>)
    const truncatedDocMatch = response.match(/(<!DOCTYPE[\s\S]+)/i);
    if (truncatedDocMatch?.[1]) {
      return truncatedDocMatch[1].trim();
    }

    const truncatedHtmlMatch = response.match(/(<html[\s\S]+)/i);
    if (truncatedHtmlMatch?.[1]) {
      return truncatedHtmlMatch[1].trim();
    }

    return trimmed;
  }
}
