import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readProjectZip } from './project-zip.ts';
import { boundedMediaBody, mediaDigest, mediaOrigin } from './repository-media.ts';

export const gameBundlePrefix = 'open-game/games/objects/';
export const maxGameBundleBytes = 150 * 1024 * 1024;
export type GameBundle = { sha256: string; bytes: number };
export type GameDownloadIndex = { schemaVersion: 1; games: Record<string, GameBundle> };
export function gameBundleUrl(hash: string) {
  assert(/^[a-f0-9]{64}$/.test(hash), 'Invalid game bundle hash');
  return `${mediaOrigin}/${gameBundlePrefix}${hash}.zip`;
}

/** The npm application pins its own index. Source checkouts and full ZIPs have no index. */
export class HostedGameTemplates {
  private index?: Promise<GameDownloadIndex>;
  private pending = new Map<string, Promise<string>>();
  private readonly indexPath: string;
  private readonly cache: string;
  constructor(indexPath: string, cache: string) { this.indexPath = indexPath; this.cache = cache; }

  private async loadIndex(): Promise<GameDownloadIndex> {
    let text: string;
    try { text = await readFile(this.indexPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, games: {} }; throw error; }
    const index = JSON.parse(text) as GameDownloadIndex;
    assert(index.schemaVersion === 1 && index.games && typeof index.games === 'object' && !Array.isArray(index.games), 'Invalid game template index');
    return index;
  }

  async directory(id: string, installed: string) {
    const { games } = await (this.index ??= this.loadIndex());
    if (!Object.hasOwn(games, id)) return installed;
    const bundle = games[id];
    const url = gameBundleUrl(bundle.sha256);
    assert(Number.isSafeInteger(bundle.bytes) && bundle.bytes > 0 && bundle.bytes <= maxGameBundleBytes, 'Invalid game bundle length');
    let ready = this.pending.get(bundle.sha256);
    if (!ready) {
      ready = this.materialize(id, bundle, url).finally(() => this.pending.delete(bundle.sha256));
      this.pending.set(bundle.sha256, ready);
    }
    return ready;
  }

  private async materialize(id: string, bundle: GameBundle, url: string) {
    await mkdir(this.cache, { recursive: true });
    assert((await lstat(this.cache)).isDirectory(), 'Invalid game template cache');
    const dest = path.join(this.cache, bundle.sha256);
    const existing = await lstat(dest).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) { assert(existing.isDirectory(), 'Invalid cached game template'); return dest; }
    const temp = await mkdtemp(path.join(this.cache, '.download-'));
    try {
      const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(120_000) });
      const bytes = await boundedMediaBody(response, bundle.bytes);
      assert(bytes.length === bundle.bytes && mediaDigest(bytes) === bundle.sha256, 'Downloaded game template failed integrity verification');
      const files = readProjectZip(bytes);
      assert(JSON.parse(files.get('game.json')?.toString() ?? 'null')?.id === id && files.has('index.html'), 'Invalid game template contents');
      for (const [name, data] of files) {
        const target = path.join(temp, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data, { flag: 'wx' });
      }
      try { await rename(temp, dest); } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') || !(await lstat(dest)).isDirectory()) throw error;
      }
      return dest;
    } catch (error) {
      throw new Error(`Could not download game template ${id}. Check the connection and retry.`, { cause: error });
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
}
