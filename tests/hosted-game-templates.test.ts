import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GameProjects } from '../game-projects.ts';
import { buildGameTemplateBundles } from '../scripts/game-template-publication.ts';
import { gameBundleUrl } from '../shared/hosted-game-templates.ts';

test('catalog and cover work offline; play and Remix share a verified, retryable persistent download', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'opengame-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), installed = path.join(root, 'app/templates/games'), workspace = path.join(root, 'workspace');
  const sourceGame = path.join(source, 'demo'), cardDir = path.join(installed, 'demo');
  await mkdir(sourceGame, { recursive: true }); await mkdir(cardDir, { recursive: true });
  const meta = { id: 'demo', title: 'Demo', description: 'demo', genre: 'casual', multiplayer: false, status: 'published', cover: 'cover.webp' };
  for (const dir of [sourceGame, cardDir]) {
    await writeFile(path.join(dir, 'game.json'), JSON.stringify(meta));
    await writeFile(path.join(dir, 'cover.webp'), 'poster');
  }
  await writeFile(path.join(sourceGame, 'index.html'), '<script src="client.js"></script>');
  await writeFile(path.join(sourceGame, 'client.js'), 'document.title="Playable";');
  let zip!: Buffer;
  const games = await buildGameTemplateBundles(source, async (_lock, bytes) => { zip = bytes; });
  assert.deepEqual(await buildGameTemplateBundles(source), games);
  await writeFile(path.join(installed, '../game-downloads.json'), JSON.stringify({ schemaVersion: 1, games }));
  let fail = true;
  const request = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, gameBundleUrl(games.demo.sha256)); assert.equal(init.redirect, 'error');
    return new Response(new Uint8Array(fail ? Buffer.alloc(zip.length) : zip));
  });
  const service = new GameProjects(workspace, installed);
  assert.equal((await service.catalog()).games[0].id, 'demo');
  assert.equal((await service.staticFile('demo', 'cover.webp')).data.toString(), 'poster');
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(service.staticFile('demo', 'index.html'), /Could not download game template demo/);
  assert.deepEqual(await readdir(path.join(workspace, 'game-template-cache')), []);
  fail = false;
  await Promise.all([service.staticFile('demo', 'client.js'), service.staticFile('demo', 'index.html')]);
  assert.equal(request.mock.callCount(), 2);
  fail = true;
  const restarted = new GameProjects(workspace, installed);
  const result = await restarted.remix('demo');
  assert.equal(result.game.source, 'mine');
  assert.equal((await restarted.staticFile(result.game.id, 'client.js')).data.toString(), await readFile(path.join(sourceGame, 'client.js'), 'utf8'));
  assert.equal(request.mock.callCount(), 2);
});
