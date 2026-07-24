import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = new URL('../out/', import.meta.url);
const repositoryRoot = new URL('../../', import.meta.url);
const basePath = process.env.GITHUB_ACTIONS === 'true' ? '/opencode-cursor' : '';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const rootHtml = readFileSync(new URL('index.html', output), 'utf8');
const docsHtml = readFileSync(new URL('docs/index.html', output), 'utf8');
const configurationHtml = readFileSync(
  new URL('docs/reference/configuration/index.html', output),
  'utf8',
);
const sourceCss = readFileSync(new URL('../app/global.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../app/tokens.css', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('.github/workflows/docs.yml', repositoryRoot), 'utf8');
const occ = readFileSync(new URL('occ-compact.svg', output), 'utf8');
const banner = readFileSync(new URL('banner.svg', output), 'utf8');
const chunkRoot = fileURLToPath(new URL('_next/static/chunks/', output));
const css = files(fileURLToPath(new URL('_next/static/css/', output)))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

for (const path of ['api/search', 'llms.txt', 'llms-full.txt']) {
  const exported = new URL(path, output);
  assert.ok(existsSync(exported), `missing static export: ${path}`);
  assert.ok(statSync(exported).size > 0, `empty static export: ${path}`);
}

for (const asset of ['occ-compact.svg', 'banner.svg']) {
  const exported = new URL(asset, output);
  assert.ok(existsSync(exported), `missing exported asset: ${asset}`);
  assert.ok(statSync(exported).size > 0, `empty exported asset: ${asset}`);
}

assert.doesNotMatch(docsHtml, /Toggle Theme|light theme/i, 'dark-only export contains a theme toggle');
assert.doesNotMatch(docsHtml, /sysc|greeter/i, 'copied template text remains in the docs page');
assert.doesNotMatch(docsHtml, /data-home-ticker/, 'removed ticker is present in the docs page');
assert.doesNotMatch(docsHtml, /MENU\/{4,}/, 'placeholder sidebar title remains in the docs page');
assert.match(docsHtml, /opencode-cursor connects OpenCode/, 'placeholder paragraph is missing');
assert.match(css, /IBM Plex Sans Variable/i, 'exported theme is missing IBM Plex Sans');
assert.match(css, /Fira Code/i, 'exported theme is missing Fira Code');

for (const token of [
  '--color-paper: oklch(17.5% 0.025 279)',
  '--color-ink: oklch(97.4% 0.0158 196.9)',
  '--color-accent: oklch(85.61% 0.1934 156.24)',
  '--color-signal: oklch(79.48% 0.1427 218.32)',
  '--space-md: 1rem',
]) {
  assert.ok(tokensCss.includes(token), `missing locked design token: ${token}`);
}

assert.ok(
  docsHtml.includes(`src="${basePath}/occ-compact.svg"`),
  'compact header mark is missing the deployment base path',
);
assert.doesNotMatch(docsHtml, /src="[^"]*\/banner\.svg"/, 'desktop masthead is still miniaturised');
assert.match(docsHtml, /data-docs-index/, 'home is missing the index-first structure');
assert.match(
  configurationHtml,
  /data-responsive-table="true"/,
  'reference tables are missing the responsive treatment',
);
assert.match(
  configurationHtml,
  /data-label="Variable"/,
  'responsive table cells are missing their column labels',
);
for (const [marker, href] of [
  ['install', `${basePath}/docs/getting-started/installation/`],
  ['troubleshooting', `${basePath}/docs/getting-started/troubleshooting/`],
  ['configuration', `${basePath}/docs/reference/configuration/`],
]) {
  assert.match(
    docsHtml,
    new RegExp(
      `<a\\b(?=[^>]*\\bdata-home-command="${marker}")(?=[^>]*\\bhref="${href}")[^>]*>`,
    ),
    `home link is missing or has the wrong target: ${marker}`,
  );
}

assert.doesNotMatch(occ, /<text|[█▄▀]/, 'OCC mark is not geometry-only');
assert.doesNotMatch(banner, /[█▄▀]/, 'banner block art still depends on font glyphs');
assert.match(occ, /<rect\b/, 'OCC mark has no rectangle geometry');
assert.match(banner, /<rect\b/, 'banner has no rectangle geometry');
assert.match(sourceCss, /designed-as-app/, 'Hallmark app-system stamp is missing');

assert.ok(rootHtml.includes(`href="${basePath}/docs/"`), 'site root does not link to docs');
assert.ok(rootHtml.includes(`url=${basePath}/docs/`), 'site root does not redirect to docs');
assert.ok(
  files(chunkRoot).some(
    (path) => path.endsWith('.js') && readFileSync(path, 'utf8').includes(`${basePath}/api/search`),
  ),
  'search client is missing the deployment base path',
);

assert.match(workflow, /branches:\s*\n\s*-\s*main/, 'docs workflow does not deploy main');
assert.match(workflow, /docs-site\/\*\*/, 'docs workflow does not watch the docs source');
assert.match(workflow, /run:\s*npm ci/, 'docs workflow does not install locked dependencies');
assert.match(workflow, /run:\s*npm run check/, 'docs workflow does not run the full check');
assert.match(workflow, /path:\s*\.\/docs-site\/out/, 'docs workflow does not upload the export');

console.log(`export check passed (base path: ${basePath || '/'})`);
