// Exercise the real npm payload against an isolated, exact-byte CDN fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGameTemplateBundles } from '../scripts/game-template-publication.ts';
import { extractArchive, runFile } from '../scripts/runtime-assets.mjs';
import { gameBundleUrl } from '../shared/hosted-game-templates.ts';
import puppeteer from 'puppeteer-core';
import { browserExecutable } from '../browser.ts';

const tgz = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), 'opengame-installed-'));
const original = globalThis.fetch;
let browser, server;
try {
  const install = path.join(root, 'install');
  await mkdir(install);
  await runFile(process.execPath, [process.env.npm_execpath, 'install', '--prefix', install, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tgz]);
  const payload = path.join(install, 'node_modules/@openmotion/app/payload');
  const release = JSON.parse(await readFile(path.join(payload, 'release-npm.json')));
  const app = path.join(root, 'application');
  await extractArchive(path.join(payload, path.basename(release.application.url)), app);
  await assert.rejects(readFile(path.join(app, 'templates/games/sky-runner/index.html')), { code: 'ENOENT' });
  const service = await import(pathToFileURL(path.join(app, 'game-projects.ts')).href);
  await cp('templates/games/sky-runner', path.join(root, 'origin/sky-runner'), { recursive: true });
  let bytes;
  const objects = await buildGameTemplateBundles(path.join(root, 'origin'), async (_lock, data) => { bytes = data; });
  assert.deepEqual(objects['sky-runner'], release.gameTemplates.games['sky-runner']);
  let offline = false, downloads = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1:')) return original(input, init);
    assert.equal(offline, false, 'No external requests after caching');
    assert.equal(String(input), gameBundleUrl(objects['sky-runner'].sha256));
    downloads++; return new Response(bytes);
  };
  const workspace = path.join(root, 'workspace');
  server = createServer((req, res) => { void service.gameHttp(req, res, new URL(req.url, 'http://localhost'), workspace, async () => ({})); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = await (await fetch(base + '/api/games')).json();
  assert.equal(catalog.games.length, Object.keys(release.gameTemplates.games).length + 1);
  assert.equal((await fetch(base + '/api/games/sky-runner/play/cover.webp')).status, 200);
  assert.equal((await fetch(base + '/api/games/tidebreaker/play/index.html')).status, 200);
  assert.equal(downloads, 0);
  browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  async function play(id) {
    await page.goto(`${base}/api/games/${id}/play/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__omGame?.state().assetsReady === 16);
    await page.click('canvas');
    await page.waitForFunction(() => window.__omGame.state().elapsed > 0);
  }
  await play('sky-runner'); assert.equal(downloads, 1);
  offline = true;
  const copy = await service.gameProjectsFor(workspace).remix('sky-runner');
  await play(copy.game.id); await play('sky-runner'); assert.equal(downloads, 1);
  console.log(JSON.stringify({ cards: catalog.games.length, downloads, bundledStarter: 'passed', coldPlay: 'passed', offlineRemixAndReplay: 'passed' }));
} finally {
  globalThis.fetch = original;
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
