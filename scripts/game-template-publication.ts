import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isMain } from '../shared/entry.ts';
import { gameBundlePrefix, gameBundleUrl, maxGameBundleBytes, type GameBundle } from '../shared/hosted-game-templates.ts';
import { readProjectZip } from '../shared/project-zip.ts';
import { boundedMediaBody, mediaDigest } from '../shared/repository-media.ts';
import { zip } from './zip.mjs';

export const offlineGame = 'tidebreaker';
const run = promisify(execFile);

export async function buildGameTemplateBundles(root: string, publish?: (lock: GameBundle, bytes: Buffer) => Promise<void>) {
  const games: Record<string, GameBundle> = Object.create(null);
  for (const id of (await readdir(root)).sort()) {
    if (id.startsWith('.') || id === offlineGame) continue;
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id));
    const dir = path.join(root, id);
    assert((await lstat(dir)).isDirectory());
    const entries: { name: string; data: Buffer }[] = [];
    let total = 0;
    async function collect(prefix: string) {
      for (const name of (await readdir(path.join(dir, prefix))).sort()) {
        // Hidden paths and local publish records do not belong in a downloadable game.
        if (name.startsWith('.') || (!prefix && /^(publish|trailer)$/i.test(name))) continue;
        const relative = prefix + name, filename = path.join(dir, relative), stat = await lstat(filename);
        if (stat.isDirectory()) { await collect(relative + '/'); continue; }
        total += stat.size;
        assert(stat.isFile() && total <= maxGameBundleBytes && entries.length < 5000, `Invalid game template source: ${id}/${relative}`);
        const data = await readFile(filename);
        assert(!data.subarray(0, 45).toString().startsWith('version https://git-lfs.github.com/spec/v1'), `Missing LFS bytes: ${id}/${relative}`);
        entries.push({ name: relative, data });
      }
    }
    await collect('');
    const archive = zip(entries);
    assert(archive.length <= maxGameBundleBytes);
    const files = readProjectZip(archive);
    const card = JSON.parse(files.get('game.json')?.toString() ?? 'null');
    assert(card?.id === id && files.has('index.html'), `Invalid template: ${id}`);
    if (card.cover && !/^(?:[a-z]+:|\/)/i.test(card.cover)) assert(files.has(card.cover), `Missing cover for ${id}`);
    const lock = { sha256: mediaDigest(archive), bytes: archive.length };
    games[id] = lock;
    await publish?.(lock, archive);
  }
  return games;
}

/** Upload immutable objects only. Each npm package carries its own small download index. */
async function publish(lock: GameBundle, bytes: Buffer) {
  const url = gameBundleUrl(lock.sha256);
  const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404) {
    const dir = await mkdtemp(path.join(tmpdir(), 'opengame-upload-'));
    try {
      const file = path.join(dir, 'template.zip'); await writeFile(file, bytes);
      const endpoint = new URL(process.env.MOTION_R2_ENDPOINT ?? ''), bucket = process.env.MOTION_R2_BUCKET ?? '';
      assert(endpoint.protocol === 'https:' && endpoint.hostname.endsWith('.r2.cloudflarestorage.com') && endpoint.href === endpoint.origin + '/');
      assert(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket));
      await run('aws', ['--endpoint-url', endpoint.origin, '--region', 'auto', 's3api', 'put-object', '--bucket', bucket,
        '--key', `${gameBundlePrefix}${lock.sha256}.zip`, '--body', file, '--if-none-match', '*', '--content-type', 'application/zip',
        '--cache-control', 'public, max-age=31536000, immutable']).catch(error => { if (!/PreconditionFailed|\(412\)/.test(error.stderr ?? '')) throw error; });
    } finally { await rm(dir, { recursive: true, force: true }); }
  } else assert.equal(response.status, 200, `Game CDN lookup failed: ${url}`);
  await verifyPublicGame(lock);
}

async function verifyPublicGame(lock: GameBundle) {
  const url = gameBundleUrl(lock.sha256);
  assert(Number.isSafeInteger(lock.bytes) && lock.bytes > 0 && lock.bytes <= maxGameBundleBytes);
  const stored = await boundedMediaBody(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }), lock.bytes);
  assert.equal(mediaDigest(stored), lock.sha256, `Public game bundle verification failed: ${url}`);
}

if (isMain(import.meta.url)) {
  if (process.argv[2] === '--verify-release') {
    const release = JSON.parse(await readFile(process.argv[3], 'utf8'));
    // Releases predating lazy download have no remote game dependencies.
    if (release.gameTemplates) {
      assert(release.gameTemplates.schemaVersion === 1 && release.gameTemplates.games);
      for (const lock of Object.values(release.gameTemplates.games)) await verifyPublicGame(lock as GameBundle);
    }
  } else {
    assert(process.argv[2] === '--publish', 'Pass --publish to upload reviewed game bundles');
    const locks = await buildGameTemplateBundles('templates/games', publish);
    console.log(`Verified ${Object.keys(locks).length} immutable game bundles`);
  }
}
