import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS_ROOT = path.join(ROOT, 'docs');
const ENTRYPOINTS = [path.join(ROOT, 'README.md'), path.join(DOCS_ROOT, 'README.md')];
const EXTERNAL_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;

interface PackageManifest {
  scripts?: Record<string, string>;
}

interface DocumentLink {
  href: string;
  line: number;
}

function walkMarkdown(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
}

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function documentLinks(content: string): DocumentLink[] {
  const links: DocumentLink[] = [];
  const patterns = [
    /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    /(?:href|src)=["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const href = match[1];
      if (href) links.push({ href, line: lineNumber(content, match.index ?? 0) });
    }
  }
  return links;
}

function githubSlug(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function headingAnchors(file: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const content = readFileSync(file, 'utf8');

  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match?.[2]) continue;
    const base = githubSlug(match[2]);
    const count = counts.get(base) ?? 0;
    anchors.add(count === 0 ? base : base + '-' + String(count));
    counts.set(base, count + 1);
  }
  return anchors;
}

function parseLocalTarget(
  source: string,
  rawHref: string,
): { file: string; fragment: string | null } | null {
  if (EXTERNAL_PROTOCOL.test(rawHref) || rawHref.startsWith('//')) return null;

  const [rawPath = '', rawFragment] = rawHref.split('#', 2);
  let decodedPath: string;
  let decodedFragment: string | null;
  try {
    decodedPath = decodeURIComponent(rawPath.split('?', 1)[0] ?? '');
    decodedFragment = rawFragment ? decodeURIComponent(rawFragment).toLowerCase() : null;
  } catch {
    throw new Error('contains invalid URL encoding: ' + rawHref);
  }

  const file = decodedPath.length > 0 ? path.resolve(path.dirname(source), decodedPath) : source;
  const relative = path.relative(ROOT, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('escapes the repository root: ' + rawHref);
  }
  return { file, fragment: decodedFragment };
}

function validateLinks(files: readonly string[]): string[] {
  const failures: string[] = [];

  for (const source of files) {
    const content = readFileSync(source, 'utf8');
    for (const { href, line } of documentLinks(content)) {
      let target: ReturnType<typeof parseLocalTarget>;
      try {
        target = parseLocalTarget(source, href);
      } catch (error) {
        failures.push(
          path.relative(ROOT, source) +
            ':' +
            String(line) +
            ' ' +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      if (!target) continue;
      if (!existsSync(target.file)) {
        failures.push(
          path.relative(ROOT, source) + ':' + String(line) + ' missing link target ' + href,
        );
        continue;
      }
      if (
        target.fragment &&
        target.file.endsWith('.md') &&
        !headingAnchors(target.file).has(target.fragment)
      ) {
        failures.push(
          path.relative(ROOT, source) +
            ':' +
            String(line) +
            ' missing heading #' +
            target.fragment +
            ' in ' +
            path.relative(ROOT, target.file),
        );
      }
    }
  }
  return failures;
}

function localMarkdownTargets(source: string): string[] {
  const targets: string[] = [];
  const content = readFileSync(source, 'utf8');
  for (const { href } of documentLinks(content)) {
    const target = parseLocalTarget(source, href);
    if (target?.file.endsWith('.md') && existsSync(target.file)) targets.push(target.file);
  }
  return targets;
}

function validateDocsReachability(docsFiles: readonly string[]): string[] {
  const visited = new Set<string>();
  const queue = [...ENTRYPOINTS];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    queue.push(...localMarkdownTargets(file));
  }

  return docsFiles
    .filter((file) => !visited.has(file))
    .map(
      (file) => path.relative(ROOT, file) + ' is not reachable from README.md or docs/README.md',
    );
}

function validateDocumentedCommands(files: readonly string[]): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as PackageManifest;
  const scripts = manifest.scripts ?? {};
  const failures: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\bnpm run ([a-zA-Z\d:_-]+)/g)) {
      const script = match[1];
      if (script && !(script in scripts)) {
        failures.push(
          path.relative(ROOT, file) +
            ':' +
            String(lineNumber(content, match.index ?? 0)) +
            ' references missing npm script ' +
            script,
        );
      }
    }
    for (const match of content.matchAll(/\btest\/fixtures\/[a-zA-Z\d_./-]+/g)) {
      const fixture = match[0].replace(/[.,;:]+$/, '');
      if (!existsSync(path.join(ROOT, fixture))) {
        failures.push(
          path.relative(ROOT, file) +
            ':' +
            String(lineNumber(content, match.index ?? 0)) +
            ' references missing fixture ' +
            fixture,
        );
      }
    }
  }
  return failures;
}

function main(): void {
  const docsFiles = walkMarkdown(DOCS_ROOT).sort();
  const rootDocs = readdirSync(ROOT)
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.join(ROOT, file))
    .sort();
  const files = [...rootDocs, ...docsFiles];
  const failures = [
    ...validateLinks(files),
    ...validateDocsReachability(docsFiles),
    ...validateDocumentedCommands(files),
  ];

  if (failures.length > 0) {
    console.error(
      'Documentation check failed:\n' + failures.map((failure) => '- ' + failure).join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    '✓ documentation check passed (' +
      String(files.length) +
      ' files, relative links, navigation, commands, fixtures)',
  );
}

main();
