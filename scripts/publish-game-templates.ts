#!/usr/bin/env node
/**
 * Cold-start cloud deployer for all built-in OpenMotion game templates (`templates/games/*`).
 *
 * Publishes every game template on the current branch into persistent OpenDesign Cloud
 * deployments using deterministic target IDs so re-runs update existing persistent links
 * rather than creating duplicates, and writes a manifest JSON recording every persistent
 * `/games/:slug` and `/artifact/:projectId/:slug` URL.
 *
 * Usage:
 *   node --experimental-strip-types scripts/publish-game-templates.ts \
 *     [--data-dir <workspaceDir>] \
 *     [--only sky-runner,comet-guard] \
 *     [--output <manifest.json>] \
 *     [--dry-run]
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenDesignAccount } from '../gateway/account.ts';
import { WebPublishService, cloudProjectIdFor } from '../gateway/web-publish.ts';
import type { WebPublishGameMeta, WebPublishTarget } from '../shared/web-publish.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const templatesRoot = path.join(repoRoot, 'templates', 'games');

type TemplateGameJson = {
  id: string;
  title: string;
  description?: string;
  genre?: string | null;
  style?: string | null;
  setting?: string | null;
  multiplayer?: boolean;
  orientation?: 'landscape' | 'portrait';
  controls?: string;
  cover?: string | null;
  entry?: string;
  i18n?: Record<string, { title?: string; description?: string; controls?: string }>;
  updatedAt?: string;
};

export type PublishedTemplateEntry = {
  templateId: string;
  title: string;
  genre: string | null;
  orientation: 'landscape' | 'portrait';
  slug: string;
  cloudProjectId: string;
  communityUrl: string | null;
  artifactUrl: string | null;
  url: string | null;
  version: number;
  fileCount: number;
  totalBytes: number;
};

export async function loadBuiltinGameTemplates(onlyIds?: ReadonlySet<string>): Promise<WebPublishTarget[]> {
  const entries = (await readdir(templatesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const targets: WebPublishTarget[] = [];
  for (const entry of entries) {
    if (onlyIds && onlyIds.size > 0 && !onlyIds.has(entry.name)) continue;
    const dir = path.join(templatesRoot, entry.name);
    const metaPath = path.join(dir, 'game.json');
    if (!existsSync(metaPath)) continue;
    const raw = JSON.parse(await readFile(metaPath, 'utf8')) as TemplateGameJson;
    const entryPath = raw.entry?.trim() || 'index.html';
    const entryStat = await stat(path.join(dir, entryPath)).catch(() => null);
    if (!entryStat?.isFile()) continue;

    let coverPath: string | null = null;
    if (raw.cover && await stat(path.join(dir, raw.cover)).then(s => s.isFile(), () => false)) {
      coverPath = raw.cover;
    } else {
      for (const fallback of ['cover.webp', 'cover.png', 'cover.jpg']) {
        if (await stat(path.join(dir, fallback)).then(s => s.isFile(), () => false)) {
          coverPath = fallback;
          break;
        }
      }
    }

    const gameMeta: WebPublishGameMeta = {
      title: raw.title || entry.name,
      description: raw.description || '',
      genre: raw.genre ?? null,
      style: raw.style ?? null,
      setting: raw.setting ?? null,
      orientation: raw.orientation === 'portrait' ? 'portrait' : 'landscape',
      controls: raw.controls || '',
      coverPath,
      i18n: raw.i18n ?? null,
      creatorName: 'OpenMotion',
      templateId: raw.id || entry.name,
      remixOfSlug: null,
    };

    targets.push({
      kind: 'game',
      id: raw.id || entry.name,
      title: gameMeta.title,
      entryPath,
      sourceRevision: `${raw.updatedAt ?? 'template'}:${entryStat.size}:${entryStat.mtimeMs}`,
      sourcePath: dir,
      multiplayer: Boolean(raw.multiplayer),
      gameMeta,
    });
  }
  return targets;
}

export type FailedTemplateEntry = {
  templateId: string;
  title: string;
  error: string;
};

export function defaultTemplateDeployDataDir(): string {
  const envDir = process.env.OPENMOTION_TEMPLATE_DEPLOY_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'OpenMotion', 'template-deploy');
  }
  const stateBase = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.openmotion');
  return path.join(stateBase, 'template-deploy');
}

export async function publishAllBuiltinTemplates(options: {
  dataDirectory: string;
  account?: OpenDesignAccount;
  onlyIds?: ReadonlySet<string>;
  workspaceId?: string;
  dryRun?: boolean;
}): Promise<{
  totalTemplates: number;
  published: PublishedTemplateEntry[];
  failed: FailedTemplateEntry[];
}> {
  const targets = await loadBuiltinGameTemplates(options.onlyIds);
  if (options.dryRun) {
    return {
      totalTemplates: targets.length,
      published: targets.map(target => ({
        templateId: target.id,
        title: target.title,
        genre: target.gameMeta?.genre ?? null,
        orientation: target.gameMeta?.orientation ?? 'landscape',
        slug: `dry-run-${target.id}`,
        cloudProjectId: cloudProjectIdFor('game', target.id),
        communityUrl: null,
        artifactUrl: null,
        url: null,
        version: 0,
        fileCount: 0,
        totalBytes: 0,
      })),
      failed: [],
    };
  }

  const service = new WebPublishService(options.dataDirectory, options.account);
  const published: PublishedTemplateEntry[] = [];
  const failed: FailedTemplateEntry[] = [];

  for (const target of targets) {
    try {
      const result = await service.publish(target, {
        workspaceId: options.workspaceId,
        mode: 'publish',
        name: target.title,
        visibility: 'public',
        allowRemix: true,
      });
      published.push({
        templateId: target.id,
        title: target.title,
        genre: target.gameMeta?.genre ?? null,
        orientation: target.gameMeta?.orientation ?? 'landscape',
        slug: result.publication.slug,
        cloudProjectId: result.publication.cloudProjectId,
        communityUrl: result.publication.communityUrl ?? null,
        artifactUrl: result.publication.artifactUrl ?? null,
        url: result.url,
        version: result.publication.version,
        fileCount: result.publication.fileCount,
        totalBytes: result.publication.totalBytes,
      });
    } catch (error) {
      failed.push({
        templateId: target.id,
        title: target.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { totalTemplates: targets.length, published, failed };
}

function readArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const inline = args.find(a => a.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dataDirectory = path.resolve(readArg(args, '--data-dir') ?? defaultTemplateDeployDataDir());
  const onlyRaw = readArg(args, '--only');
  const onlyIds = onlyRaw
    ? new Set(onlyRaw.split(',').map(v => v.trim()).filter(Boolean))
    : undefined;
  const outputPath = readArg(args, '--output');
  const workspaceId = readArg(args, '--workspace-id');
  const dryRun = args.includes('--dry-run');

  publishAllBuiltinTemplates({ dataDirectory, onlyIds, workspaceId, dryRun })
    .then(async summary => {
      const payload = {
        generatedAt: new Date().toISOString(),
        dryRun,
        totalTemplates: summary.totalTemplates,
        published: summary.published,
        failed: summary.failed,
      };
      if (outputPath) {
        await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
        await writeFile(path.resolve(outputPath), JSON.stringify(payload, null, 2) + '\n', 'utf8');
      }
      console.log(JSON.stringify(payload, null, 2));
      if (summary.failed.length > 0) {
        process.exitCode = 1;
      }
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
