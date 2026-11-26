import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesignError, designProjectsFor } from '../design-projects.ts';
import { GameError, GameProjects } from '../game-projects.ts';
import { parseCloudShareUrl } from '../shared/cloud-comments.ts';
import {
  webPublishTargetKinds,
  type WebPublishMode,
  type WebPublishTarget,
  type WebPublishTargetKind,
  type WebPublishVisibility,
} from '../shared/web-publish.ts';
import type { WorkspaceStore } from '../workspace.ts';
import { webPublishFor, type WebPublishService } from './web-publish.ts';

const SENSITIVE_PATH_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.docker',
  '.git-credentials',
  '.netrc',
  '.pypirc',
]);

function isValidTargetKind(value: unknown): value is WebPublishTargetKind {
  return typeof value === 'string' && (webPublishTargetKinds as readonly string[]).includes(value);
}

function slugifyIdPart(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/\.html?$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page'
  );
}

function assertSafeLocalSourcePath(resolved: string): void {
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.some(seg => SENSITIVE_PATH_SEGMENTS.has(seg))) {
    throw new Error('INVALID_ARGUMENT: Source path points inside a restricted credential directory');
  }
}

const SAFE_GAME_TARGET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeEmbedHttpsUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function renderCloudGameWrapperHtml(embedUrl: string, title: string): string {
  const safeTitle = escapeHtmlAttr(title);
  const safeUrl = escapeHtmlAttr(embedUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${safeTitle} · OpenDesign</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0c0f; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #0b0c0f; }
  </style>
</head>
<body>
  <iframe
    src="${safeUrl}"
    title="${safeTitle}"
    sandbox="allow-scripts allow-same-origin allow-pointer-lock"
    allow="fullscreen; gamepad; autoplay"
    allowfullscreen
    referrerpolicy="no-referrer-when-downgrade"
  ></iframe>
</body>
</html>
`;
}

function extractCloudGameWrapperTitle(html: string | null): string | null {
  if (!html) return null;
  const match = html.match(/<title>([^<]*?)\s+·\s+OpenDesign<\/title>/);
  if (!match) return null;
  return match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

async function ensureCloudGameWrapper(
  rootDir: string,
  targetId: string,
  embedUrl: string,
  title: string,
  readOnly = false,
): Promise<{ dir: string; revision: string; virtualHtml?: string }> {
  if (!SAFE_GAME_TARGET_ID.test(targetId)) {
    throw new Error('INVALID_ARGUMENT: Invalid game targetId');
  }
  const wrapperDir = path.join(rootDir, 'web-publish-cache', 'games', targetId);
  const indexFile = path.join(wrapperDir, 'index.html');
  const existing = await readFile(indexFile, 'utf8').catch(() => null);
  const effectiveTitle = title.trim() || extractCloudGameWrapperTitle(existing) || targetId;
  const html = renderCloudGameWrapperHtml(embedUrl, effectiveTitle);
  const revision = createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);
  if (readOnly) {
    return { dir: wrapperDir, revision, virtualHtml: html };
  }
  await mkdir(wrapperDir, { recursive: true });
  if (existing !== html) {
    await writeFile(indexFile, html, 'utf8');
  }
  return { dir: wrapperDir, revision };
}

export async function resolveWebPublishTarget(
  store: WorkspaceStore,
  input: {
    targetKind: WebPublishTargetKind;
    targetId?: string;
    sourcePath?: string;
    filePath?: string;
    title?: string;
    embedUrl?: string;
    readOnly?: boolean;
  },
  origin: string,
): Promise<WebPublishTarget> {
  const rootStore = store.workspaceStore ?? store;
  const rootDir = rootStore.directory;

  if (input.targetKind === 'design') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for design targets');
    }
    const project = await designProjectsFor(rootDir).get(targetId, origin);
    return {
      kind: 'design',
      id: project.id,
      title: input.title?.trim() || project.title || project.id,
      entryPath: input.filePath?.trim() || project.entry || 'index.html',
      sourceRevision: project.revision,
      sourcePath: project.path,
    };
  }

  if (input.targetKind === 'game') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for game targets');
    }
    const games = new GameProjects(rootDir);
    const localGame = await Promise.all([games.locate(targetId), games.get(targetId)]).catch(() => null);
    if (localGame) {
      const [{ dir }, card] = localGame;
      if (!card.external) {
        const entryPath = input.filePath?.trim() || 'index.html';
        const entryStat = await stat(path.join(dir, entryPath)).catch(() => null);
        const sourceRevision = `${card.updatedAt}:${entryStat?.size ?? 0}:${entryStat?.mtimeMs ?? 0}`;
        let coverPath: string | null = null;
        if (card.cover) {
          const playMarker = `/games/${card.id}/play/`;
          const markerIndex = card.cover.indexOf(playMarker);
          const candidate =
            markerIndex >= 0
              ? decodeURIComponent(card.cover.slice(markerIndex + playMarker.length).split(/[?#]/)[0] ?? '')
              : !/^https?:\/\//i.test(card.cover) && !card.cover.startsWith('/')
                ? card.cover
                : '';
          if (candidate && await stat(path.join(dir, candidate)).then(s => s.isFile(), () => false)) {
            coverPath = candidate;
          }
        }
        if (!coverPath) {
          for (const fallback of ['cover.webp', 'cover.png', 'cover.jpg']) {
            if (await stat(path.join(dir, fallback)).then(s => s.isFile(), () => false)) {
              coverPath = fallback;
              break;
            }
          }
        }
        return {
          kind: 'game',
          id: card.id,
          title: input.title?.trim() || card.title || card.id,
          entryPath,
          sourceRevision,
          sourcePath: dir,
          multiplayer: card.multiplayer,
          gameMeta: {
            title: input.title?.trim() || card.title || card.id,
            description: card.description || '',
            genre: card.genre ?? null,
            style: card.style ?? null,
            setting: card.setting ?? null,
            orientation: card.orientation === 'portrait' ? 'portrait' : 'landscape',
            controls: card.controls || '',
            coverPath,
            i18n: card.i18n ?? null,
            templateId: card.source === 'template' ? card.id : null,
            remixOfSlug: card.remixOf ?? null,
          },
        };
      }
    }

    const validEmbedUrl = normalizeEmbedHttpsUrl(input.embedUrl);
    if (validEmbedUrl) {
      const explicitTitle = input.title?.trim() || '';
      const wrapper = await ensureCloudGameWrapper(rootDir, targetId, validEmbedUrl, explicitTitle, input.readOnly === true);
      return {
        kind: 'game',
        id: targetId,
        title: explicitTitle || targetId,
        entryPath: 'index.html',
        sourceRevision: wrapper.revision,
        sourcePath: wrapper.dir,
        ...(wrapper.virtualHtml !== undefined ? { virtualEntryHtml: wrapper.virtualHtml } : {}),
      };
    }

    if (SAFE_GAME_TARGET_ID.test(targetId)) {
      const cachedDir = path.join(rootDir, 'web-publish-cache', 'games', targetId);
      const cachedEntry = await stat(path.join(cachedDir, 'index.html')).catch(() => null);
      if (cachedEntry) {
        const cachedHtml = await readFile(path.join(cachedDir, 'index.html'), 'utf8');
        const revision = createHash('sha256').update(cachedHtml, 'utf8').digest('hex').slice(0, 16);
        return {
          kind: 'game',
          id: targetId,
          title: input.title?.trim() || targetId,
          entryPath: 'index.html',
          sourceRevision: revision,
          sourcePath: cachedDir,
        };
      }
    }

    throw new GameError(`Game "${targetId}" was not found`, 404);
  }

  if (input.targetKind === 'motion') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for motion targets');
    }
    const project = rootStore.projectCatalog().projects.find(item => item.id === targetId && !item.trashedAt);
    if (!project) {
      throw new Error(`NOT_FOUND: Motion project "${targetId}" was not found`);
    }
    const scoped = rootStore.forProject(targetId);
    const entryPath = input.filePath?.trim() || 'index.html';
    const entryStat = await stat(path.join(scoped.directory, entryPath)).catch(() => null);
    const sourceRevision = `${project.openedAt ?? project.createdAt ?? 1}:${entryStat?.size ?? 0}:${entryStat?.mtimeMs ?? 0}`;
    return {
      kind: 'motion',
      id: project.id,
      title: input.title?.trim() || project.title || project.id,
      entryPath,
      sourceRevision,
      sourcePath: scoped.directory,
    };
  }

  // targetKind === 'html' (arbitrary HTML directory or standalone .html/.htm file)
  const rawSourcePath = input.sourcePath?.trim();
  const explicitId = input.targetId?.trim();
  if (!rawSourcePath) {
    throw new Error('INVALID_ARGUMENT: sourcePath is required when publishing html targets');
  }
  const resolved = path.resolve(rawSourcePath);
  assertSafeLocalSourcePath(resolved);

  const info = await lstat(resolved).catch(() => null);
  if (!info) {
    throw new Error(`NOT_FOUND: Publish source "${rawSourcePath}" does not exist`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`INVALID_ARGUMENT: Symlinks cannot be published (${rawSourcePath})`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`INVALID_ARGUMENT: Publish source must be a directory or HTML file (${rawSourcePath})`);
  }
  if (info.isFile() && !/\.html?$/i.test(resolved)) {
    throw new Error('INVALID_ARGUMENT: Single-file web publishing requires an .html or .htm file');
  }

  const derivedId =
    explicitId
    || `${slugifyIdPart(path.basename(resolved))}-${createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 8)}`;

  return {
    kind: 'html',
    id: derivedId,
    title: input.title?.trim() || path.basename(resolved, path.extname(resolved)) || 'HTML Publication',
    entryPath: input.filePath?.trim() || 'index.html',
    sourceRevision: `${info.mtimeMs}:${info.size}`,
    sourcePath: resolved,
  };
}

export function mapWebPublishError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof DesignError) {
    const status =
      error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'INVALID_ARGUMENT'
          ? 400
          : error.code === 'AUTH_REQUIRED'
            ? 401
            : error.code === 'DEPLOY_CONFLICT'
              ? 409
              : 500;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof GameError) {
    const code = error.status === 404 ? 'NOT_FOUND' : error.status === 400 ? 'INVALID_ARGUMENT' : 'DEPLOY_FAILED';
    return { status: error.status || 400, code, message: error.message };
  }

  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith('OPENDESIGN_SIGN_IN_REQUIRED')) {
    return {
      status: 401,
      code: 'AUTH_REQUIRED',
      message: raw.replace(/^OPENDESIGN_SIGN_IN_REQUIRED:\s*/, ''),
    };
  }
  if (raw.startsWith('PRIVATE_SHARE_REQUIRES_PAID_PLAN')) {
    return {
      status: 403,
      code: 'PRIVATE_SHARE_REQUIRES_PAID_PLAN',
      message: raw.replace(/^PRIVATE_SHARE_REQUIRES_PAID_PLAN:\s*/, ''),
    };
  }
  if (raw.startsWith('SHARE_STOPPED_RESUME_REQUIRED')) {
    return {
      status: 409,
      code: 'DEPLOY_CONFLICT',
      message: raw.replace(/^SHARE_STOPPED_RESUME_REQUIRED:\s*/, ''),
    };
  }
  if (raw.startsWith('NOT_FOUND:')) {
    return { status: 404, code: 'NOT_FOUND', message: raw.replace(/^NOT_FOUND:\s*/, '') };
  }
  if (raw.startsWith('INVALID_ARGUMENT:')) {
    return { status: 400, code: 'INVALID_ARGUMENT', message: raw.replace(/^INVALID_ARGUMENT:\s*/, '') };
  }
  if (raw.startsWith('DEPLOY_FAILED:')) {
    return { status: 502, code: 'DEPLOY_FAILED', message: raw.replace(/^DEPLOY_FAILED:\s*/, '') };
  }
  return { status: 500, code: 'DEPLOY_FAILED', message: raw || 'Web publish failed' };
}

export async function webPublishOperation(
  store: WorkspaceStore,
  rawInput: Record<string, unknown> | undefined,
  origin: string,
  serviceOverride?: WebPublishService,
): Promise<unknown> {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const rootStore = store.workspaceStore ?? store;
  const service = serviceOverride ?? webPublishFor(rootStore.directory);

  if (command === 'list') {
    return await service.listAll();
  }

  if (!isValidTargetKind(input.targetKind)) {
    throw new Error(
      `INVALID_ARGUMENT: targetKind must be one of ${webPublishTargetKinds.join(', ')}`,
    );
  }
  const targetKind = input.targetKind;
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : undefined;
  const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath.trim() : undefined;
  const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : undefined;
  const title = typeof input.title === 'string' ? input.title.trim() : undefined;
  const embedUrl = typeof input.embedUrl === 'string' ? input.embedUrl.trim() : undefined;

  if (command === 'status') {
    if (targetKind === 'html' && targetId && !sourcePath) {
      return await service.status(
        { kind: 'html', id: targetId, entryPath: filePath || 'index.html' },
        { filePath, refresh: input.refresh === true },
      );
    }
    try {
      const resolved = await resolveWebPublishTarget(
        store,
        { targetKind, targetId, sourcePath, filePath, title, embedUrl, readOnly: true },
        origin,
      );
      return await service.status(resolved, { filePath, refresh: input.refresh === true });
    } catch (error) {
      if (targetId && /NOT_FOUND|not found/i.test(error instanceof Error ? error.message : String(error))) {
        const storedEntry = await service.findStoredEntryPath(targetKind, targetId, filePath);
        if (storedEntry) {
          return await service.status(
            { kind: targetKind, id: targetId, entryPath: storedEntry },
            { filePath: filePath ?? storedEntry, refresh: input.refresh === true },
          );
        }
      }
      throw error;
    }
  }

  if (command === 'publish') {
    const resolved = await resolveWebPublishTarget(
      store,
      { targetKind, targetId, sourcePath, filePath, title, embedUrl },
      origin,
    );
    const visibility =
      targetKind === 'game' && (input.visibility === 'public' || input.visibility === 'unlisted')
        ? (input.visibility as WebPublishVisibility)
        : undefined;
    const allowRemix =
      targetKind === 'game' && typeof input.allowRemix === 'boolean' ? input.allowRemix : undefined;
    return await service.publish(resolved, {
      filePath,
      workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
      mode: typeof input.deployMode === 'string' ? (input.deployMode as WebPublishMode) : undefined,
      name: title,
      visibility,
      allowRemix,
    });
  }

  if (command === 'visibility') {
    if (targetKind !== 'game') {
      throw new Error('INVALID_ARGUMENT: Visibility controls are only supported for game deployments');
    }
    const visibility =
      input.visibility === 'public' || input.visibility === 'unlisted'
        ? (input.visibility as WebPublishVisibility)
        : null;
    if (!visibility) {
      throw new Error('INVALID_ARGUMENT: visibility must be "public" or "unlisted"');
    }
    const allowRemix = typeof input.allowRemix === 'boolean' ? input.allowRemix : undefined;
    const resolved = await resolveWebPublishTarget(
      store,
      { targetKind, targetId, sourcePath, filePath, title, embedUrl, readOnly: true },
      origin,
    );
    return await service.setVisibility(resolved, { filePath, visibility, allowRemix });
  }

  if (command === 'unpublish') {
    if (targetKind === 'html' && targetId && !sourcePath) {
      return await service.unpublish(
        { kind: 'html', id: targetId, entryPath: filePath || 'index.html' },
        { filePath },
      );
    }
    if (targetId) {
      const storedEntry = await service.findStoredEntryPath(targetKind, targetId, filePath);
      if (storedEntry) {
        return await service.unpublish(
          { kind: targetKind, id: targetId, entryPath: storedEntry },
          { filePath: filePath ?? storedEntry },
        );
      }
    }
    const resolved = await resolveWebPublishTarget(
      store,
      { targetKind, targetId, sourcePath, filePath, title, embedUrl, readOnly: true },
      origin,
    );
    return await service.unpublish(resolved, { filePath });
  }

  throw new Error('INVALID_ARGUMENT: webPublish.command must be publish, status, unpublish, or list');
}

export async function cloudDeployOperation(
  store: WorkspaceStore,
  rawInput: Record<string, unknown> | undefined,
  origin: string,
  serviceOverride?: WebPublishService,
): Promise<unknown> {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const hasTargetInput = Boolean(
    input.targetKind || input.targetId || input.sourcePath || input.embedUrl,
  );
  const command =
    typeof input.action === 'string' && input.action.trim()
      ? input.action.trim()
      : hasTargetInput
        ? 'publish'
        : 'list';
  const targetKind =
    typeof input.targetKind === 'string' && input.targetKind.trim()
      ? input.targetKind.trim()
      : typeof input.sourcePath === 'string' && input.sourcePath.trim()
        ? 'html'
        : undefined;

  const result = await webPublishOperation(
    store,
    {
      ...input,
      command,
      ...(targetKind ? { targetKind } : {}),
    },
    origin,
    serviceOverride,
  );

  if (result && typeof result === 'object') {
    const typed = result as {
      url?: unknown;
      communityUrl?: unknown;
      publication?: { url?: unknown; communityUrl?: unknown; cloudProjectId?: unknown; projectId?: unknown };
      active?: { url?: unknown; communityUrl?: unknown; cloudProjectId?: unknown; projectId?: unknown };
    };
    const pickUrl = (val: unknown) => (typeof val === 'string' && val.trim() ? val.trim() : undefined);
    const candidateUrl =
      pickUrl(typed.url) ??
      pickUrl(typed.communityUrl) ??
      pickUrl(typed.publication?.url) ??
      pickUrl(typed.publication?.communityUrl) ??
      pickUrl(typed.active?.url) ??
      pickUrl(typed.active?.communityUrl);
    if (candidateUrl) {
      try {
        const share = parseCloudShareUrl(candidateUrl);
        if (!share.projectId) {
          const fallbackProjectId =
            pickUrl(typed.publication?.cloudProjectId) ??
            pickUrl(typed.active?.cloudProjectId) ??
            pickUrl(typed.publication?.projectId) ??
            pickUrl(typed.active?.projectId);
          if (fallbackProjectId) {
            share.projectId = fallbackProjectId;
          }
        }
        return { ...result, share };
      } catch {
        return result;
      }
    }
  }
  return result;
}
