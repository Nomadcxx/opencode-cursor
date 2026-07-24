import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const contentRoot = fileURLToPath(new URL('../content/docs/', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const cliSource = readFileSync(new URL('../../src/cli/opencode-cursor.ts', import.meta.url), 'utf8');

const sections = {
  'getting-started': ['installation', 'authentication', 'quick-start', 'troubleshooting'],
  guides: ['choosing-a-model', 'mcp-servers', 'permissions', 'session-resume', 'subagents'],
  reference: ['configuration', 'cli', 'opencode-json', 'alternatives', 'roadmap'],
  architecture: ['overview', 'stream-translation', 'tool-loop', 'acp-and-mcp', 'cursor-agent-tools'],
  development: ['building', 'testing', 'releasing', 'contributing'],
};

const expectedPages = [
  'index.mdx',
  ...Object.entries(sections).flatMap(([section, pages]) =>
    pages.map((page) => `${section}/${page}.mdx`),
  ),
].sort();
const indexPath = join(contentRoot, 'index.mdx');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pages = files(contentRoot).filter((file) => ['.md', '.mdx'].includes(extname(file)));
assert.deepEqual(
  pages.map((path) => relative(contentRoot, path)).sort(),
  expectedPages,
  'documentation page inventory differs from the approved 24-page corpus',
);

assert.deepEqual(
  readJson(join(contentRoot, 'meta.json')).pages,
  ['index', ...Object.keys(sections)],
  'root navigation order is wrong',
);
assert.equal(readJson(join(contentRoot, 'meta.json')).title, 'open-cursor', 'public brand is wrong');

const indexContent = readFileSync(indexPath, 'utf8');
assert.match(indexContent, /^title:\s*["']open-cursor["']$/m, 'home title uses the wrong brand');
assert.match(indexContent, /^open-cursor connects OpenCode/m, 'home introduction uses the wrong brand');
for (const [section, sectionPages] of Object.entries(sections)) {
  for (const page of sectionPages) {
    assert.ok(
      indexContent.includes(`](/docs/${section}/${page})`),
      `home index is missing /docs/${section}/${page}`,
    );
  }
}

for (const [section, expected] of Object.entries(sections)) {
  assert.deepEqual(
    readJson(join(contentRoot, section, 'meta.json')).pages,
    expected,
    `${section} navigation order is wrong`,
  );
}

const routeSet = new Set([
  '/docs',
  ...expectedPages.map((page) => `/docs/${page.replace(/(?:\/index)?\.mdx$/, '')}`),
]);

for (const path of pages) {
  const content = readFileSync(path, 'utf8');
  const rel = relative(contentRoot, path);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

  assert.match(frontmatter, /^title:\s*["']?.+?["']?$/m, `missing title in ${rel}`);
  assert.match(frontmatter, /^description:\s*["']?.+?["']?$/m, `missing description in ${rel}`);
  assert.doesNotMatch(content, /\]\([^)]*\.md(?:#[^)]*)?\)/, `stale .md link in ${rel}`);
  assert.doesNotMatch(content, /^!!!/m, `legacy admonition syntax in ${rel}`);
  assert.doesNotMatch(content, /docs-src|mkdocs/i, `stale documentation system reference in ${rel}`);
  assert.doesNotMatch(content, /sysc|greeter/i, `copied template content remains in ${rel}`);

  for (const match of content.matchAll(/\]\((\/docs(?:\/[^)#\s]*)?)(?:#[^)\s]+)?\)/g)) {
    const route = match[1].replace(/\/$/, '') || '/docs';
    assert.ok(routeSet.has(route), `broken internal link in ${rel}: ${match[0]}`);
  }
}

const configurationPath = join(contentRoot, 'reference/configuration.mdx');
assert.ok(existsSync(configurationPath), 'configuration reference is missing');

const variablePattern = /CURSOR_ACP_[A-Z0-9_]+/g;
const sourceVariables = new Set(
  files(sourceRoot)
    .flatMap((path) => readFileSync(path, 'utf8').match(variablePattern) ?? []),
);
const documentedVariables = new Set(readFileSync(configurationPath, 'utf8').match(variablePattern) ?? []);

assert.deepEqual(
  [...documentedVariables].sort(),
  [...sourceVariables].sort(),
  'configuration reference and source CURSOR_ACP_* variables differ',
);

const cliPath = join(contentRoot, 'reference/cli.mdx');
assert.ok(existsSync(cliPath), 'CLI reference is missing');
const cliDocs = readFileSync(cliPath, 'utf8');
for (const flag of ['--install-cursor-bridge', '--cursor-bridge-scope']) {
  assert.ok(cliSource.includes(flag), `required CLI flag is missing from source: ${flag}`);
  assert.ok(cliDocs.includes(flag), `required CLI flag is undocumented: ${flag}`);
}

console.log(`content check passed (${expectedPages.length} pages, ${sourceVariables.size} variables)`);
