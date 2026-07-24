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
const sourceCss = readFileSync(new URL('../app/global.css', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('.github/workflows/docs.yml', repositoryRoot), 'utf8');
const occ = readFileSync(new URL('occ-mark.svg', output), 'utf8');
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

for (const asset of ['occ-mark.svg', 'banner.svg']) {
  const exported = new URL(asset, output);
  assert.ok(existsSync(exported), `missing exported asset: ${asset}`);
  assert.ok(statSync(exported).size > 0, `empty exported asset: ${asset}`);
}

assert.doesNotMatch(docsHtml, /Toggle Theme|light theme/i, 'dark-only export contains a theme toggle');
assert.doesNotMatch(docsHtml, /sysc|greeter/i, 'copied template text remains in the docs page');
assert.doesNotMatch(docsHtml, /data-home-ticker/, 'removed ticker is present in the docs page');
assert.match(docsHtml, /opencode-cursor connects OpenCode/, 'placeholder paragraph is missing');
assert.match(css, /IBM Plex Sans Variable/i, 'exported theme is missing IBM Plex Sans');
assert.match(css, /Fira Code/i, 'exported theme is missing Fira Code');

for (const token of [
  '--color-fd-background: #212337',
  '--color-fd-foreground: #ebfafa',
  '--color-fd-primary: #37f499',
  '--docs-accent-text: #04d1f9',
  '--docs-accent-secondary: #a48cf2',
]) {
  assert.ok(sourceCss.includes(token), `missing Eldritch token: ${token}`);
}

assert.ok(
  docsHtml.includes(`src="${basePath}/occ-mark.svg"`),
  'header mark is missing the deployment base path',
);
assert.ok(
  docsHtml.includes(`src="${basePath}/banner.svg"`),
  'marquee is missing the deployment base path',
);
for (const [marker, href] of [
  ['install', 'https://github.com/Nomadcxx/opencode-cursor#installation'],
  ['mcp-servers', 'https://github.com/Nomadcxx/opencode-cursor#mcp-tool-bridge'],
  ['architecture', 'https://github.com/Nomadcxx/opencode-cursor#architecture'],
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
assert.match(
  docsHtml,
  /img\.shields\.io\/github\/stars\/Nomadcxx\/opencode-cursor/,
  'header is missing the repository star badge',
);

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
