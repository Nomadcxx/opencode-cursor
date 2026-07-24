import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../content/docs/', import.meta.url));
const expectedPages = ['index.mdx'];

function contentFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? contentFiles(path) : [path];
  });
}

const pages = contentFiles(root).filter((file) => ['.md', '.mdx'].includes(extname(file)));
assert.deepEqual(
  pages.map((path) => relative(root, path)).sort(),
  expectedPages,
  'placeholder deploy must contain exactly one documentation page',
);

for (const path of pages) {
  const content = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  assert.doesNotMatch(content, /\]\([^)]*\.md(?:#[^)]*)?\)/, `stale .md link in ${rel}`);
  assert.doesNotMatch(content, /^!!!/m, `legacy admonition syntax in ${rel}`);
  assert.doesNotMatch(content, /docs-src|mkdocs/i, `stale documentation system reference in ${rel}`);
  assert.doesNotMatch(content, /sysc|greeter/i, `copied template content remains in ${rel}`);
}

console.log(`content check passed (${expectedPages.length} pages)`);
