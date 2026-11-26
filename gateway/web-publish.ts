import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, jsonFile } from '../phase1-versions.ts';
import { withProcessLock } from '../shared/process-lock.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';
import {
  isPaidWebPublishPlan,
  normalizeWebPublishPlanId,
  type WebPublicationRecord,
  type WebPublishAccountState,
  type WebPublishFeedStatus,
  type WebPublishFreshness,
  type WebPublishGameMeta,
  type WebPublishListResponse,
  type WebPublishMode,
  type WebPublishStatusResponse,
  type WebPublishTarget,
  type WebPublishTargetKind,
  type WebPublishVisibility,
} from '../shared/web-publish.ts';
import { OpenDesignAccount, type OpenDesignWorkspaceInfo } from './account.ts';
import { buildPublishBundle, stagePublishFiles, type PublishBundle } from './web-publish-bundle.ts';

type ShareReservation = {
  slug: string;
  sourceFileId: string;
  sourceKey: string;
  workspaceId: string;
  ownerMemberId: string;
  cloudProjectId?: string;
};

type StoredPublishFile = {
  schemaVersion: 1;
  reservations: Record<string, ShareReservation>;
  publications: Record<string, WebPublicationRecord>;
  /** Legacy field preserved when migrating records from design-projects/deployments. */
  deployments?: Record<string, WebPublicationRecord>;
};

type LegacyCloudShareFile = {
  kind?: string;
  projectId?: string;
  cloudProjectId?: string;
  workspaceId?: string;
  ownerMemberId?: string;
  workspaceName?: string;
  slug?: string;
  sourceFileId?: string;
  sourceKey?: string;
  resourceId?: string;
  entryPath?: string;
  status?: 'none' | 'active' | 'stopped';
  url?: string | null;
  version?: number;
  versionId?: string;
  publishedAt?: number;
  contentFingerprint?: string;
  updatedAt?: number;
};

export interface WebPublishAccountClient {
  isSignedIn(): Promise<boolean>;
  listWorkspaces(): Promise<OpenDesignWorkspaceInfo[]>;
  runWithEnv(
    args: string[],
    extraEnv?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number },
  ): Promise<string>;
  summary?: (refresh?: boolean) => Promise<AccountSummary>;
  controlApiJson?: <T = Record<string, unknown>>(
    apiPath: string,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      workspaceId?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) => Promise<T>;
}

type PublishOptions = {
  filePath?: string;
  workspaceId?: string;
  mode?: WebPublishMode;
  name?: string;
  visibility?: WebPublishVisibility;
  allowRemix?: boolean;
};

function isUnsupportedGameListingEndpointError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/PRIVATE_SHARE_REQUIRES_PAID_PLAN|OPENDESIGN_SIGN_IN_REQUIRED/.test(msg)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && (status === 404 || status === 405 || status === 501)) {
    return true;
  }
  return /\bfailed \((?:404|405|501):/.test(msg) || /"status"\s*:\s*(?:404|405|501)\b/.test(msg);
}

function isGameListingNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/PRIVATE_SHARE_REQUIRES_PAID_PLAN|OPENDESIGN_SIGN_IN_REQUIRED/.test(msg)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status === 404;
  }
  return /\bfailed \(404:/.test(msg) || /"status"\s*:\s*404\b/.test(msg);
}

function isPrivateSharePlanError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.trim().toUpperCase() === 'PRIVATE_SHARE_REQUIRES_PAID_PLAN') {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /PRIVATE_SHARE_REQUIRES_PAID_PLAN/.test(msg);
}

function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown }).status;
  return /OPENDESIGN_SIGN_IN_REQUIRED/.test(msg) || status === 401;
}

type GameListingControlResponse = {
  visibility?: WebPublishVisibility;
  feedStatus?: WebPublishFeedStatus;
  allowRemix?: boolean;
  communityPath?: string;
  communityUrl?: string | null;
  canUsePrivateShare?: boolean;
  planTier?: string;
};

function normalizeEntryPath(raw?: string | null, fallback = 'index.html'): string {
  const value = (raw || fallback).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!value || value.includes('\0')) {
    throw new Error('INVALID_ARGUMENT: Entry file path is required');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_ARGUMENT: Entry file path contains invalid segments');
  }
  if (!/\.html?$/i.test(value)) {
    throw new Error('INVALID_ARGUMENT: Web publishing requires an .html or .htm entry file');
  }
  return value;
}

function storageKey(kind: WebPublishTargetKind, targetId: string): string {
  const cleanId = targetId.trim();
  const safeId = /^[a-zA-Z0-9._-]{1,120}$/.test(cleanId)
    ? cleanId
    : createHash('sha256').update(cleanId, 'utf8').digest('hex').slice(0, 32);
  return `${kind}--${safeId}`;
}

/**
 * Resolve the remote OpenDesign project ID associated with a published target.
 * Design targets preserve their native ID; non-Design HTML targets receive a
 * collision-free deterministic UUID derived from (kind, targetId).
 */
export function cloudProjectIdFor(kind: WebPublishTargetKind, targetId: string): string {
  if (kind === 'design') {
    return targetId;
  }
  const digest = createHash('sha256')
    .update(`openmotion:web-publish:${kind}:${targetId}`, 'utf8')
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function publicFileResourceIdFor(scope: {
  workspaceId: string;
  ownerMemberId: string;
  projectId: string;
  filePath: string;
}): string {
  const scoped = Buffer.from(
    JSON.stringify([scope.workspaceId, scope.ownerMemberId, scope.projectId, scope.filePath]),
    'utf8',
  ).toString('base64url');
  return `project-file-${scoped}`;
}

export function commentFileSourceKey(projectId: string, sourceFileId: string): string {
  if (!projectId.trim() || !sourceFileId.trim()) {
    throw new Error('INVALID_ARGUMENT: projectId and sourceFileId are required');
  }
  return `comment-file-v1:${Buffer.from(projectId, 'utf8').toString('base64url')}:${sourceFileId}`;
}

export function verifiedShareUrl(rawUrl: unknown, projectId: string, slug: string): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    const expectedPath = `/artifact/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
    if (parsed.pathname !== expectedPath) {
      return null;
    }
    return `${parsed.origin}${expectedPath}`;
  } catch {
    return null;
  }
}

/**
 * Game shares keep `kind=game` so the cloud viewer launches full-screen for play
 * with the comments rail collapsed by default and the "Made with OpenDesign"
 * remix + Comments toggle bar at the bottom. Users can open the bar to comment,
 * ask follow-up questions, attach images, and reply (1-level) without clutter.
 */
export const SHARE_VIEWER_KIND_PARAM = 'kind';
export const SHARE_VIEWER_GAME_KIND = 'game';

export function shareViewerUrlForTarget(kind: WebPublishTargetKind, url: string | null): string | null {
  if (!url || kind !== 'game') return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(SHARE_VIEWER_KIND_PARAM, SHARE_VIEWER_GAME_KIND);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseShareLinkFromRecord(
  record: Record<string, unknown>,
  projectId: string,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: unknown[] = [
    record.url,
    record.link && typeof record.link === 'object' ? (record.link as Record<string, unknown>).url : undefined,
  ];
  for (const candidate of candidates) {
    const verified = verifiedShareUrl(candidate, projectId, slug);
    if (verified) return verified;
  }
  const overrideOrigin = (env.OD_SHARE_VIEWER_URL || env.OM_CLOUD_SHARE_VIEWER_ORIGIN)?.trim();
  if (overrideOrigin && overrideOrigin.toLowerCase().startsWith('https://')) {
    try {
      const originUrl = new URL(overrideOrigin);
      if (originUrl.protocol === 'https:' && !originUrl.username && !originUrl.password) {
        return `${originUrl.origin}/artifact/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
      }
    } catch {
      // Ignore invalid override origin.
    }
  }
  return null;
}

function selectTargetWorkspace(
  workspaces: OpenDesignWorkspaceInfo[],
  requestedWorkspaceId?: string,
): OpenDesignWorkspaceInfo {
  if (!workspaces.length) {
    throw new Error('DEPLOY_FAILED: No active OpenDesign workspace found for signed-in account');
  }
  if (requestedWorkspaceId?.trim()) {
    const exact = workspaces.find(w => w.workspaceId === requestedWorkspaceId.trim());
    if (!exact) {
      throw new Error(`INVALID_ARGUMENT: OpenDesign workspace "${requestedWorkspaceId}" not found for account`);
    }
    return exact;
  }
  return (
    workspaces.find(w => w.workspaceType === 'personal' && w.isDefault)
    ?? workspaces.find(w => w.workspaceType === 'personal')
    ?? workspaces[0]
  );
}

function normalizeStoredRecord(
  record: Partial<WebPublicationRecord>,
  fallbackKind: WebPublishTargetKind,
  fallbackId: string,
): WebPublicationRecord {
  const targetKind = record.targetKind ?? fallbackKind;
  const targetId = record.targetId ?? record.projectId ?? fallbackId;
  const cloudProjectId = record.cloudProjectId ?? cloudProjectIdFor(targetKind, targetId);
  return {
    ...(record as WebPublicationRecord),
    schemaVersion: 1,
    targetKind,
    targetId,
    cloudProjectId,
    projectId: record.projectId ?? targetId,
  };
}

function fromLegacyCloudShareRecord(raw: LegacyCloudShareFile): StoredPublishFile | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'game-project' && raw.kind !== 'design-project') return null;
  const targetKind: WebPublishTargetKind = raw.kind === 'game-project' ? 'game' : 'design';
  const targetId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!targetId) return null;

  const entryPath = normalizeEntryPath(raw.entryPath, 'index.html');
  const cloudProjectId = typeof raw.cloudProjectId === 'string' && raw.cloudProjectId.trim()
    ? raw.cloudProjectId.trim()
    : cloudProjectIdFor(targetKind, targetId);

  const reservations: Record<string, ShareReservation> = {};
  if (raw.slug && raw.sourceFileId && raw.sourceKey && raw.workspaceId && raw.ownerMemberId) {
    reservations[entryPath] = {
      slug: raw.slug,
      sourceFileId: raw.sourceFileId,
      sourceKey: raw.sourceKey,
      workspaceId: raw.workspaceId,
      ownerMemberId: raw.ownerMemberId,
      cloudProjectId,
    };
  }

  const publications: Record<string, WebPublicationRecord> = {};
  if (raw.status === 'active' || raw.status === 'stopped') {
    publications[entryPath] = {
      schemaVersion: 1,
      targetKind,
      targetId,
      cloudProjectId,
      projectId: targetId,
      filePath: entryPath,
      entryPath,
      name: raw.workspaceName || targetId,
      workspaceId: raw.workspaceId || '',
      workspaceName: raw.workspaceName,
      ownerMemberId: raw.ownerMemberId || '',
      resourceId: raw.resourceId || '',
      sourceFileId: raw.sourceFileId || '',
      sourceKey: raw.sourceKey || '',
      slug: raw.slug || '',
      version: raw.version ?? 1,
      versionId: raw.versionId || '',
      status: raw.status === 'stopped' ? 'stopped' : 'published',
      url: raw.url ?? null,
      publishedAt: raw.publishedAt ?? raw.updatedAt ?? Date.now(),
      updatedAt: raw.updatedAt ?? Date.now(),
      fileCount: 1,
      totalBytes: 0,
      contentFingerprint: raw.contentFingerprint,
      sourceRevision: '',
    };
  }

  return {
    schemaVersion: 1,
    reservations,
    publications,
  };
}

export class WebPublishService {
  readonly dataDirectory: string;
  readonly storeRoot: string;
  readonly legacyDesignRoot: string;
  readonly legacyCloudShareRoot: string;
  private _account: WebPublishAccountClient;
  private hasExplicitAccount: boolean;

  constructor(dataDirectory: string, account?: WebPublishAccountClient) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.storeRoot = path.join(this.dataDirectory, 'web-publications');
    this.legacyDesignRoot = path.join(this.dataDirectory, 'design-projects', 'deployments');
    this.legacyCloudShareRoot = path.join(this.dataDirectory, 'cloud-shares');
    this.hasExplicitAccount = Boolean(account);
    this._account = account ?? new OpenDesignAccount(this.dataDirectory);
  }

  get account(): WebPublishAccountClient {
    return this._account;
  }

  bindAccount(account: WebPublishAccountClient): void {
    if (!this.hasExplicitAccount) {
      this._account = account;
      this.hasExplicitAccount = true;
    }
  }

  private stateFile(kind: WebPublishTargetKind, targetId: string): string {
    return path.join(this.storeRoot, `${storageKey(kind, targetId)}.json`);
  }

  private legacyStateFile(targetId: string): string {
    return path.join(this.legacyDesignRoot, `${targetId}.json`);
  }

  private legacyCloudShareFile(kind: WebPublishTargetKind, targetId: string): string | null {
    if (kind !== 'game' && kind !== 'design') return null;
    const legacyKind = kind === 'game' ? 'game-project' : 'design-project';
    const safeKey = Buffer.from(`${legacyKind}:${targetId}`, 'utf8').toString('base64url');
    return path.join(this.legacyCloudShareRoot, `${legacyKind}__${safeKey}.json`);
  }

  private lockFile(kind: WebPublishTargetKind, targetId: string): string {
    return path.join(this.storeRoot, `${storageKey(kind, targetId)}.lock`);
  }

  private operationLock(target: Pick<WebPublishTarget, 'kind' | 'id'>, filePath: string): string {
    const entry = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    return path.join(this.storeRoot, `${storageKey(target.kind, target.id)}-${entry}.operation.lock`);
  }

  private async readState(kind: WebPublishTargetKind, targetId: string): Promise<StoredPublishFile> {
    const state = await this.readStoredState(kind, targetId);
    if (kind !== 'game') return state;
    for (const record of Object.values(state.publications)) {
      if (record.communityUrl) {
        record.url = record.communityUrl;
      } else {
        record.url = shareViewerUrlForTarget(kind, record.url);
      }
    }
    return state;
  }

  private async readStoredState(kind: WebPublishTargetKind, targetId: string): Promise<StoredPublishFile> {
    const primary = this.stateFile(kind, targetId);
    if (!existsSync(primary)) {
      if (kind === 'design' && existsSync(this.legacyStateFile(targetId))) {
        const raw = await jsonFile<Partial<StoredPublishFile>>(this.legacyStateFile(targetId), {});
        return this.parseStoredPublishFile(raw, kind, targetId);
      }
      const legacyCloud = this.legacyCloudShareFile(kind, targetId);
      if (legacyCloud && existsSync(legacyCloud)) {
        const raw = await jsonFile<LegacyCloudShareFile>(legacyCloud, {});
        return fromLegacyCloudShareRecord(raw) ?? { schemaVersion: 1, reservations: {}, publications: {} };
      }
    }
    const raw = await jsonFile<Partial<StoredPublishFile>>(primary, {});
    return this.parseStoredPublishFile(raw, kind, targetId);
  }

  private parseStoredPublishFile(
    raw: Partial<StoredPublishFile>,
    kind: WebPublishTargetKind,
    targetId: string,
  ): StoredPublishFile {
    const mapSource =
      raw.publications && typeof raw.publications === 'object'
        ? raw.publications
        : raw.deployments && typeof raw.deployments === 'object'
          ? raw.deployments
          : {};
    const publications: Record<string, WebPublicationRecord> = {};
    for (const [entryKey, item] of Object.entries(mapSource)) {
      if (item && typeof item === 'object') {
        publications[entryKey] = normalizeStoredRecord(item, kind, targetId);
      }
    }
    return {
      schemaVersion: 1,
      reservations: raw.reservations && typeof raw.reservations === 'object' ? { ...raw.reservations } : {},
      publications,
    };
  }

  private async saveState(kind: WebPublishTargetKind, targetId: string, state: StoredPublishFile): Promise<void> {
    await mkdir(this.storeRoot, { recursive: true, mode: 0o700 });
    await atomicJson(this.stateFile(kind, targetId), {
      schemaVersion: 1,
      reservations: state.reservations,
      publications: state.publications,
    });
  }

  private async runVelaJson(
    args: string[],
    workspaceId: string,
  ): Promise<Record<string, unknown>> {
    const stdout = await this.account.runWithEnv(
      args,
      {
        VELA_INVOCATION_SOURCE: 'open-design',
        ...(workspaceId ? { VELA_WORKSPACE_ID: workspaceId } : {}),
      },
      { timeoutMs: 120_000 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`DEPLOY_FAILED: OpenDesign CLI returned non-JSON output for "${args.slice(0, 2).join(' ')}"`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`DEPLOY_FAILED: Unexpected OpenDesign CLI response for "${args.slice(0, 2).join(' ')}"`);
    }
    return parsed as Record<string, unknown>;
  }

  private async admitCommentFileReceipt(params: {
    cloudProjectId: string;
    workspaceId: string;
    ownerMemberId: string;
    resourceId: string;
    versionId: string;
    filePath: string;
    sourceFileId: string;
  }): Promise<void> {
    const parseCommentFiles = (raw: unknown): { revision: number; files: Array<Record<string, unknown>> } => {
      if (raw === undefined || raw === null) {
        return { revision: 0, files: [] };
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('DEPLOY_FAILED: Invalid OpenDesign comment-files catalog state');
      }
      const state = raw as Record<string, unknown>;
      if (
        state.schemaVersion !== 1
        || typeof state.revision !== 'number'
        || !Number.isSafeInteger(state.revision)
        || state.revision < 0
        || !Array.isArray(state.files)
      ) {
        throw new Error('DEPLOY_FAILED: Invalid OpenDesign comment-files catalog state');
      }
      return {
        revision: state.revision,
        files: state.files.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')),
      };
    };

    const readCatalog = async () => {
      const row = await this.runVelaJson(
        ['team-projects', 'get', params.cloudProjectId, '--json'],
        params.workspaceId,
      );
      const rootResourceId = typeof row.resourceId === 'string' ? row.resourceId.trim() : '';
      if (
        row.projectId !== params.cloudProjectId
        || row.workspaceId !== params.workspaceId
        || row.ownerMemberId !== params.ownerMemberId
        || !rootResourceId
      ) {
        throw new Error('DEPLOY_FAILED: OpenDesign project catalog ownership mismatch');
      }
      const metadata =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const state = parseCommentFiles(metadata._commentFiles);
      return { rootResourceId, metadata, state };
    };

    const matches = (files: Array<Record<string, unknown>>) =>
      files.some(
        fact =>
          fact.sourceFileId === params.sourceFileId
          && fact.sourceFilePath === params.filePath
          && fact.entryPath === params.filePath
          && fact.resourceId === params.resourceId
          && fact.versionId === params.versionId
          && fact.retired === false,
      );

    const { rootResourceId, metadata, state } = await readCatalog();
    if (matches(state.files)) {
      return;
    }

    const mutation = {
      schemaVersion: 1,
      baseRevision: state.revision,
      resourceId: params.resourceId,
      versionId: params.versionId,
      files: [
        {
          sourceFilePath: params.filePath,
          entryPath: params.filePath,
          sourceFileId: params.sourceFileId,
          retired: false,
        },
      ],
    };

    let failure: unknown;
    try {
      await this.account.runWithEnv(
        [
          'team-projects',
          'upsert',
          params.cloudProjectId,
          '--resource-id',
          rootResourceId,
          '--metadata-json',
          JSON.stringify({ ...metadata, _commentFiles: mutation }),
        ],
        {
          VELA_INVOCATION_SOURCE: 'open-design',
          VELA_WORKSPACE_ID: params.workspaceId,
        },
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      failure = error;
    }

    const admitted = await readCatalog();
    if (!matches(admitted.state.files)) {
      if (failure instanceof Error) {
        throw failure;
      }
      throw new Error('DEPLOY_FAILED: OpenDesign file receipt admission failed');
    }
  }

  async status(
    target: Pick<WebPublishTarget, 'kind' | 'id' | 'entryPath'>
      & Partial<Pick<WebPublishTarget, 'sourcePath' | 'title' | 'multiplayer' | 'virtualEntryHtml' | 'gameMeta'>>,
    options: { filePath?: string; refresh?: boolean } = {},
  ): Promise<WebPublishStatusResponse> {
    const accountSignedIn = await this.account.isSignedIn();
    let accountSummary = this.account.summary ? await this.account.summary().catch(() => null) : null;
    if (
      target.kind === 'game'
      && accountSignedIn
      && this.account.summary
      && !normalizeWebPublishPlanId(accountSummary?.plan as string | { id?: string | null } | null | undefined)
      && accountSummary?.billingUnavailable !== true
    ) {
      accountSummary = (await this.account.summary(true).catch(() => null)) ?? accountSummary;
    }
    const accountState: WebPublishAccountState =
      accountSummary?.state ?? (accountSignedIn ? 'signed-in' : 'signed-out');
    const accountEmail = accountSummary?.user?.email;

    const state = await this.readState(target.kind, target.id);
    const targetEntry = options.filePath
      ? normalizeEntryPath(options.filePath, target.entryPath)
      : normalizeEntryPath(target.entryPath, 'index.html');
    const defaultCloudProjectId = cloudProjectIdFor(target.kind, target.id);

    const accountPlan = normalizeWebPublishPlanId(
      accountSummary?.plan as string | { id?: string | null } | null | undefined,
    );
    let entitlementResolved = Boolean(accountPlan);
    let canUsePrivateShare = isPaidWebPublishPlan(accountPlan);
    let resolvedPlan = accountPlan;

    if (target.kind === 'game' && accountSignedIn && this.account.controlApiJson) {
      const currentPub = state.publications[targetEntry];
      let hydratedFromListing = false;
      if (currentPub?.slug && currentPub.status === 'published') {
        const remoteProjectId = currentPub.cloudProjectId || defaultCloudProjectId;
        let remoteListing: GameListingControlResponse | null = null;
        let remoteListingMissing = false;
        try {
          remoteListing = await this.account.controlApiJson<GameListingControlResponse>(
            `/api/v1/collab/shares/${encodeURIComponent(currentPub.slug)}/game-listing?projectId=${encodeURIComponent(remoteProjectId)}`,
            { method: 'GET', workspaceId: currentPub.workspaceId, timeoutMs: 6_000 },
          );
        } catch (error) {
          remoteListingMissing = isGameListingNotFoundError(error);
        }
        let keepListingSyncPending = false;
        // Only heal publications that actually attempted PUT /game-listing on publish/resume
        // and failed transiently, and only when GET confirms 404 (never on 5xx/timeout or
        // pre-existing shares published by earlier builds without listingSyncPending).
        if (!remoteListing && remoteListingMissing && currentPub.listingSyncPending) {
          const desiredVisibility = currentPub.pendingVisibility ?? currentPub.visibility ?? 'public';
          remoteListing = await this.syncGameListing({
            target,
            cloudProjectId: remoteProjectId,
            workspaceId: currentPub.workspaceId,
            slug: currentPub.slug,
            displayName: (target.gameMeta?.title || target.title || currentPub.name).trim().slice(0, 120) || currentPub.name,
            visibility: desiredVisibility,
            allowRemix: currentPub.allowRemix,
          }).catch(() => null);
        } else if (
          remoteListing
          && currentPub.listingSyncPending
          && currentPub.pendingVisibility
          && remoteListing.visibility
          && remoteListing.visibility !== currentPub.pendingVisibility
        ) {
          try {
            const retried = await this.syncGameListing({
              target,
              cloudProjectId: remoteProjectId,
              workspaceId: currentPub.workspaceId,
              slug: currentPub.slug,
              displayName: (target.gameMeta?.title || target.title || currentPub.name).trim().slice(0, 120) || currentPub.name,
              visibility: currentPub.pendingVisibility,
              allowRemix: currentPub.allowRemix,
            });
            if (retried) {
              remoteListing = retried;
            } else {
              keepListingSyncPending = true;
            }
          } catch (retryError) {
            if (!isPrivateSharePlanError(retryError)) {
              keepListingSyncPending = true;
            }
          }
        }
        if (remoteListing) {
          hydratedFromListing = true;
          if (typeof remoteListing.canUsePrivateShare === 'boolean') {
            entitlementResolved = true;
            canUsePrivateShare = remoteListing.canUsePrivateShare;
          }
          if (typeof remoteListing.planTier === 'string' && remoteListing.planTier.trim()) {
            resolvedPlan = remoteListing.planTier.trim();
            entitlementResolved = true;
          }
          const changed =
            (remoteListing.visibility && remoteListing.visibility !== currentPub.visibility)
            || (remoteListing.feedStatus && remoteListing.feedStatus !== currentPub.feedStatus)
            || (typeof remoteListing.allowRemix === 'boolean' && remoteListing.allowRemix !== currentPub.allowRemix)
            || (remoteListing.communityUrl && remoteListing.communityUrl !== currentPub.communityUrl)
            || (!keepListingSyncPending && (Boolean(currentPub.listingSyncPending) || Boolean(currentPub.pendingVisibility)));
          if (changed) {
            await withProcessLock(this.lockFile(target.kind, target.id), async () => {
              const latest = await this.readState(target.kind, target.id);
              const entry = latest.publications[targetEntry];
              if (entry && entry.slug === currentPub.slug) {
                if (remoteListing.visibility) entry.visibility = remoteListing.visibility;
                if (remoteListing.feedStatus) entry.feedStatus = remoteListing.feedStatus;
                if (typeof remoteListing.allowRemix === 'boolean') entry.allowRemix = remoteListing.allowRemix;
                if (remoteListing.communityUrl) {
                  entry.communityUrl = remoteListing.communityUrl;
                  entry.url = remoteListing.communityUrl;
                }
                if (!keepListingSyncPending) {
                  delete entry.listingSyncPending;
                  delete entry.pendingVisibility;
                }
                entry.updatedAt = Date.now();
                await this.saveState(target.kind, target.id, latest);
              }
            });
          }
        }
      }
      if (!hydratedFromListing) {
        const workspaceId = currentPub?.workspaceId;
        const entitlement = await this.account
          .controlApiJson<{ canUsePrivateShare?: boolean; planTier?: string }>(
            '/api/v1/collab/game-share-entitlement',
            { method: 'GET', ...(workspaceId ? { workspaceId } : {}), timeoutMs: 6_000 },
          )
          .catch(() => null);
        if (entitlement && typeof entitlement.canUsePrivateShare === 'boolean') {
          entitlementResolved = true;
          canUsePrivateShare = entitlement.canUsePrivateShare;
          if (typeof entitlement.planTier === 'string' && entitlement.planTier.trim()) {
            resolvedPlan = entitlement.planTier.trim();
          }
        }
      }
    }

    if (options.refresh && accountSignedIn) {
      const current = state.publications[targetEntry];
      if (current) {
        try {
          const remoteProjectId = current.cloudProjectId || defaultCloudProjectId;
          const remote = await this.runVelaJson(
            ['share', 'status', current.slug, '--project-id', remoteProjectId, '--json'],
            current.workspaceId,
          );
          const remoteListing =
            target.kind === 'game' && this.account.controlApiJson
              ? await this.account
                  .controlApiJson<GameListingControlResponse>(
                    `/api/v1/collab/shares/${encodeURIComponent(current.slug)}/game-listing?projectId=${encodeURIComponent(remoteProjectId)}`,
                    { method: 'GET', workspaceId: current.workspaceId, timeoutMs: 8_000 },
                  )
                  .catch(() => null)
              : null;
          if (remoteListing && typeof remoteListing.canUsePrivateShare === 'boolean') {
            entitlementResolved = true;
            canUsePrivateShare = remoteListing.canUsePrivateShare;
            if (remoteListing.planTier) resolvedPlan = remoteListing.planTier;
          }
          if (remote.status === 'active' || remote.status === 'stopped') {
            const nextStatus = remote.status === 'stopped' ? 'stopped' : 'published';
            const artifactUrl = shareViewerUrlForTarget(
              target.kind,
              parseShareLinkFromRecord(remote, remoteProjectId, current.slug) ?? current.artifactUrl ?? current.url,
            );
            const communityUrl = remoteListing?.communityUrl ?? current.communityUrl ?? null;
            await withProcessLock(this.lockFile(target.kind, target.id), async () => {
              const latest = await this.readState(target.kind, target.id);
              const entry = latest.publications[targetEntry];
              if (entry && entry.slug === current.slug) {
                entry.status = nextStatus;
                entry.artifactUrl = artifactUrl;
                if (communityUrl) entry.communityUrl = communityUrl;
                entry.url = communityUrl ?? artifactUrl;
                if (remoteListing?.visibility) entry.visibility = remoteListing.visibility;
                if (remoteListing?.feedStatus) entry.feedStatus = remoteListing.feedStatus;
                if (typeof remoteListing?.allowRemix === 'boolean') entry.allowRemix = remoteListing.allowRemix;
                if (remoteListing) {
                  if (!entry.pendingVisibility || !remoteListing.visibility || remoteListing.visibility === entry.pendingVisibility) {
                    delete entry.listingSyncPending;
                    delete entry.pendingVisibility;
                  }
                }
                entry.updatedAt = Date.now();
                await this.saveState(target.kind, target.id, latest);
              }
            });
          }
        } catch {
          // Non-fatal: preserve locally persisted status if live refresh fails.
        }
      }
    }

    const updated = await this.readState(target.kind, target.id);
    const publications = Object.values(updated.publications).sort((a, b) => b.updatedAt - a.updatedAt);
    const active =
      publications.find(item => item.filePath === targetEntry && item.status === 'published')
      ?? publications.find(item => item.status === 'published')
      ?? publications.find(item => item.filePath === targetEntry)
      ?? null;

    let bundle: PublishBundle | null = null;
    if (target.sourcePath || target.virtualEntryHtml !== undefined) {
      bundle = await buildPublishBundle({
        dataDirectory: this.dataDirectory,
        kind: target.kind,
        targetId: target.id,
        sourcePath: target.sourcePath ?? '',
        entryPath: targetEntry,
        ...(target.virtualEntryHtml !== undefined ? { virtualEntryHtml: target.virtualEntryHtml } : {}),
      }).catch(() => null);
    }

    const freshness: WebPublishFreshness =
      !active || !active.contentFingerprint || !bundle
        ? 'unknown'
        : active.contentFingerprint === bundle.contentFingerprint
          ? 'fresh'
          : 'outdated';

    return {
      targetKind: target.kind,
      targetId: target.id,
      projectId: target.id,
      ...(target.title ? { title: target.title } : active?.name ? { title: active.name } : {}),
      entryPath: bundle?.entryPath ?? active?.entryPath ?? targetEntry,
      accountSignedIn,
      accountState,
      ...(accountEmail ? { accountEmail } : {}),
      ...(resolvedPlan ? { accountPlan: resolvedPlan } : {}),
      ...(target.kind === 'game' && entitlementResolved ? { canUsePrivateShare } : {}),
      freshness,
      fileCount: bundle?.fileCount ?? active?.fileCount ?? 0,
      totalBytes: bundle?.totalBytes ?? active?.totalBytes ?? 0,
      bundledAssetCount: bundle?.bundledAssetCount ?? active?.bundledAssetCount ?? 0,
      ...(target.multiplayer !== undefined
        ? { multiplayer: target.multiplayer }
        : active?.multiplayer !== undefined
          ? { multiplayer: active.multiplayer }
          : {}),
      publications,
      deployments: publications,
      active,
    };
  }

  private async syncGameListing(params: {
    target: Pick<WebPublishTarget, 'kind' | 'gameMeta'>;
    cloudProjectId: string;
    workspaceId: string;
    slug: string;
    displayName: string;
    visibility: WebPublishVisibility;
    allowRemix?: boolean;
  }): Promise<GameListingControlResponse | null> {
    if (params.target.kind !== 'game' || !this.account.controlApiJson) {
      return null;
    }
    const meta: WebPublishGameMeta = {
      title: params.displayName,
      description: params.target.gameMeta?.description ?? '',
      genre: params.target.gameMeta?.genre ?? null,
      style: params.target.gameMeta?.style ?? null,
      setting: params.target.gameMeta?.setting ?? null,
      orientation: params.target.gameMeta?.orientation ?? 'landscape',
      controls: params.target.gameMeta?.controls ?? '',
      coverPath: params.target.gameMeta?.coverPath ?? null,
      i18n: params.target.gameMeta?.i18n ?? null,
      creatorName: params.target.gameMeta?.creatorName ?? null,
      templateId: params.target.gameMeta?.templateId ?? null,
      remixOfSlug: params.target.gameMeta?.remixOfSlug ?? null,
    };
    return this.account.controlApiJson<GameListingControlResponse>(
      `/api/v1/collab/shares/${encodeURIComponent(params.slug)}/game-listing`,
      {
        method: 'PUT',
        workspaceId: params.workspaceId,
        body: {
          projectId: params.cloudProjectId,
          visibility: params.visibility,
          ...(params.allowRemix !== undefined ? { allowRemix: params.allowRemix } : {}),
          gameMeta: meta,
        },
        timeoutMs: 20_000,
      },
    );
  }

  async publish(target: WebPublishTarget, options: PublishOptions = {}) {
    const filePath = normalizeEntryPath(options.filePath, target.entryPath || 'index.html');
    return withProcessLock(this.operationLock(target, filePath), () =>
      this.publishEntry(target, filePath, options),
    );
  }

  async setVisibility(
    target: Pick<WebPublishTarget, 'kind' | 'id' | 'entryPath'> & Partial<Pick<WebPublishTarget, 'title' | 'gameMeta'>>,
    options: { filePath?: string; visibility: WebPublishVisibility; allowRemix?: boolean },
  ): Promise<{ publication: WebPublicationRecord; deployment: WebPublicationRecord }> {
    if (target.kind !== 'game') {
      throw new Error('INVALID_ARGUMENT: Visibility controls are only supported for game deployments');
    }
    const filePath = normalizeEntryPath(options.filePath, target.entryPath || 'index.html');
    return withProcessLock(this.operationLock(target, filePath), async () => {
      const state = await this.readState(target.kind, target.id);
      const current = state.publications[filePath];
      if (!current) {
        throw new Error(`NOT_FOUND: No live publication found for "${filePath}"`);
      }
      if (!this.account.controlApiJson) {
        throw new Error('DEPLOY_FAILED: OpenDesign account API client is unavailable');
      }
      const remoteProjectId = current.cloudProjectId || cloudProjectIdFor(target.kind, target.id);
      let res: GameListingControlResponse;
      try {
        res = await this.account.controlApiJson<GameListingControlResponse>(
          `/api/v1/collab/shares/${encodeURIComponent(current.slug)}/visibility`,
          {
            method: 'PATCH',
            workspaceId: current.workspaceId,
            body: {
              projectId: remoteProjectId,
              visibility: options.visibility,
              ...(options.allowRemix !== undefined ? { allowRemix: options.allowRemix } : {}),
            },
            timeoutMs: 20_000,
          },
        );
      } catch (error) {
        if (!isUnsupportedGameListingEndpointError(error)) {
          throw error;
        }
        // A 404 on PATCH /visibility can mean the listing row was never created
        // (for example after a transient post-publish sync failure). Retry once
        // via syncGameListing (PUT /game-listing) with full target.gameMeta so
        // the remote control plane heals or updates the listing without
        // overwriting cover, description, translations, or template attribution.
        try {
          const synced = await this.syncGameListing({
            target,
            cloudProjectId: remoteProjectId,
            workspaceId: current.workspaceId,
            slug: current.slug,
            displayName: (target.gameMeta?.title || target.title || current.name).trim().slice(0, 120) || current.name,
            visibility: options.visibility,
            allowRemix: options.allowRemix ?? current.allowRemix ?? true,
          });
          if (!synced) {
            throw new Error(
              'DEPLOY_FAILED: OpenDesign Cloud did not apply the game visibility change because the visibility endpoint is unavailable.',
            );
          }
          res = synced;
        } catch (putError) {
          if (!isUnsupportedGameListingEndpointError(putError)) {
            throw putError;
          }
          if (options.visibility === 'unlisted' && this.account.summary) {
            let summary = await this.account.summary().catch(() => null);
            if (
              !normalizeWebPublishPlanId(summary?.plan as string | { id?: string | null } | null | undefined)
              && summary?.billingUnavailable !== true
            ) {
              summary = (await this.account.summary(true).catch(() => null)) ?? summary;
            }
            if (!isPaidWebPublishPlan(summary?.plan as string | { id?: string | null } | null | undefined)) {
              throw new Error(
                'PRIVATE_SHARE_REQUIRES_PAID_PLAN: Unlisted/private game sharing requires a paid OpenDesign plan (Go or above).',
              );
            }
          }
          throw new Error(
            'DEPLOY_FAILED: OpenDesign Cloud did not apply the game visibility change because the visibility endpoint is unavailable.',
          );
        }
      }
      const {
        listingSyncPending: _prevListingSyncPending,
        pendingVisibility: _prevPendingVisibility,
        ...baseCurrent
      } = current;
      const next: WebPublicationRecord = {
        ...baseCurrent,
        visibility: res.visibility ?? options.visibility,
        allowRemix: typeof res.allowRemix === 'boolean' ? res.allowRemix : (options.allowRemix ?? current.allowRemix),
        feedStatus: res.feedStatus ?? current.feedStatus,
        communityUrl: res.communityUrl ?? current.communityUrl ?? null,
        url: res.communityUrl ?? current.communityUrl ?? current.url,
        updatedAt: Date.now(),
      };
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        latest.publications[filePath] = next;
        await this.saveState(target.kind, target.id, latest);
      });
      return { publication: next, deployment: next };
    });
  }

  private async confirmUnlistedBeforeReopen(params: {
    target: Pick<WebPublishTarget, 'kind' | 'gameMeta'>;
    cloudProjectId: string;
    workspaceId: string;
    slug: string;
    displayName: string;
    allowRemix?: boolean;
    hasCommunityUrl: boolean;
  }): Promise<{ listing: GameListingControlResponse | null; legacyUnsupported: boolean }> {
    const preResumeError =
      'DEPLOY_FAILED: Could not confirm Unlisted visibility on OpenDesign Cloud before reopening the stopped share link. Please retry.';
    const fetchCurrentListing = async () =>
      this.account.controlApiJson
        ? await this.account
            .controlApiJson<GameListingControlResponse>(
              `/api/v1/collab/shares/${encodeURIComponent(params.slug)}/game-listing?projectId=${encodeURIComponent(params.cloudProjectId)}`,
              { method: 'GET', workspaceId: params.workspaceId, timeoutMs: 8_000 },
            )
            .catch(() => null)
        : null;
    if (!this.account.controlApiJson) {
      throw new Error(preResumeError);
    }
    let listing: GameListingControlResponse | null = null;
    let legacyUnsupported = false;
    try {
      listing = await this.syncGameListing({
        target: params.target,
        cloudProjectId: params.cloudProjectId,
        workspaceId: params.workspaceId,
        slug: params.slug,
        displayName: params.displayName,
        visibility: 'unlisted',
        allowRemix: params.allowRemix,
      });
    } catch (syncError) {
      if (isPrivateSharePlanError(syncError) || isAuthRequiredError(syncError)) {
        throw syncError;
      }
      if (isUnsupportedGameListingEndpointError(syncError) && !params.hasCommunityUrl) {
        legacyUnsupported = true;
      } else {
        const probed = await fetchCurrentListing();
        if (probed?.visibility === 'unlisted') {
          listing = probed;
        } else {
          throw new Error(preResumeError);
        }
      }
    }
    if (!legacyUnsupported && listing?.visibility !== 'unlisted') {
      throw new Error(preResumeError);
    }
    return { listing, legacyUnsupported };
  }

  private async publishEntry(target: WebPublishTarget, filePath: string, options: PublishOptions): Promise<{
    publication: WebPublicationRecord;
    deployment: WebPublicationRecord;
    url: string | null;
    updated: boolean;
  }> {
    const mode: WebPublishMode = options.mode ?? 'publish';
    const displayName = (options.name || target.title || filePath).trim().slice(0, 120) || 'OpenMotion Web';

    const workspaces = await this.account.listWorkspaces();
    const workspace = selectTargetWorkspace(workspaces, options.workspaceId);

    const existingState = await this.readState(target.kind, target.id);
    const existingPublication = existingState.publications[filePath];
    const requestedVisibility: WebPublishVisibility =
      options.visibility ?? existingPublication?.visibility ?? 'public';

    // Fail fast before uploading blobs if a Free workspace asks for unlisted/private game sharing.
    if (target.kind === 'game' && requestedVisibility === 'unlisted' && this.account.controlApiJson) {
      const entitlement = await this.account
        .controlApiJson<{ canUsePrivateShare?: boolean }>(
          '/api/v1/collab/game-share-entitlement',
          { method: 'GET', workspaceId: workspace.workspaceId, timeoutMs: 8_000 },
        )
        .catch(() => null);
      if (entitlement && entitlement.canUsePrivateShare === false) {
        throw new Error('PRIVATE_SHARE_REQUIRES_PAID_PLAN: Unlisted/private game sharing requires a paid OpenDesign plan (Go or above).');
      }
    }

    if (existingPublication?.status === 'stopped' && mode === 'publish') {
      throw new Error(
        'SHARE_STOPPED_RESUME_REQUIRED: Existing share link is stopped. Pass deployMode="resume" to reopen it or deployMode="new_link" to create a new link.',
      );
    }

    const existingProjectId = existingPublication?.cloudProjectId || cloudProjectIdFor(target.kind, target.id);

    const bundle = await buildPublishBundle({
      dataDirectory: this.dataDirectory,
      kind: target.kind,
      targetId: target.id,
      sourcePath: target.sourcePath,
      entryPath: filePath,
    });

    const contentMatches =
      existingPublication?.contentFingerprint
        ? existingPublication.contentFingerprint === bundle.contentFingerprint
        : existingPublication?.sourceRevision === target.sourceRevision;

    // Fast path: resume an existing stopped share link when content hasn't changed.
    if (
      existingPublication
      && existingPublication.status === 'stopped'
      && mode === 'resume'
      && contentMatches
      && existingPublication.workspaceId === workspace.workspaceId
    ) {
      const displayGameTitle = options.name?.trim() || existingPublication.name || target.title;
      const requestedAllowRemix = options.allowRemix ?? existingPublication.allowRemix;
      const fetchCurrentListing = async () =>
        this.account.controlApiJson
          ? await this.account
              .controlApiJson<GameListingControlResponse>(
                `/api/v1/collab/shares/${encodeURIComponent(existingPublication.slug)}/game-listing?projectId=${encodeURIComponent(existingProjectId)}`,
                { method: 'GET', workspaceId: workspace.workspaceId, timeoutMs: 8_000 },
              )
              .catch(() => null)
          : null;

      // Never reactivate a stopped share as public before confirming `unlisted` on the server:
      // if an author previously had a public/curated game, stopping and reopening as Unlisted must
      // persist/confirm `unlisted` BEFORE `share resume-existing` makes the slug reachable again.
      let preResumeListing: GameListingControlResponse | null = null;
      let preResumeLegacyUnsupported = false;
      if (target.kind === 'game' && requestedVisibility === 'unlisted') {
        const confirmed = await this.confirmUnlistedBeforeReopen({
          target,
          cloudProjectId: existingProjectId,
          workspaceId: workspace.workspaceId,
          slug: existingPublication.slug,
          displayName: displayGameTitle,
          allowRemix: requestedAllowRemix,
          hasCommunityUrl: Boolean(existingPublication.communityUrl),
        });
        preResumeListing = confirmed.listing;
        preResumeLegacyUnsupported = confirmed.legacyUnsupported;
      }

      const resumedRecord = await this.runVelaJson(
        [
          'share',
          'resume-existing',
          existingPublication.slug,
          '--project-id',
          existingProjectId,
          '--source-file-path',
          filePath,
          '--json',
        ],
        workspace.workspaceId,
      );
      if (resumedRecord.status !== 'active') {
        throw new Error('DEPLOY_FAILED: OpenDesign could not resume the stopped share link');
      }
      const resumedUrl = shareViewerUrlForTarget(
        target.kind,
        parseShareLinkFromRecord(resumedRecord, existingProjectId, existingPublication.slug)
          ?? existingPublication.artifactUrl
          ?? existingPublication.url,
      );

      let resumedListing: GameListingControlResponse | null = preResumeListing;
      let resumedSyncPending = false;
      let resumedPendingVisibility: WebPublishVisibility | undefined;
      if (target.kind === 'game' && requestedVisibility !== 'unlisted') {
        try {
          resumedListing = await this.syncGameListing({
            target,
            cloudProjectId: existingProjectId,
            workspaceId: workspace.workspaceId,
            slug: existingPublication.slug,
            displayName: displayGameTitle,
            visibility: requestedVisibility,
            allowRemix: requestedAllowRemix,
          });
        } catch (syncError) {
          if (!isUnsupportedGameListingEndpointError(syncError)) {
            const probed = await fetchCurrentListing();
            if (probed?.visibility === requestedVisibility) {
              resumedListing = probed;
            } else {
              resumedListing = probed;
              resumedSyncPending = true;
              resumedPendingVisibility = requestedVisibility;
            }
          }
        }
      }

      const resumedCommunityUrl =
        target.kind === 'game'
          ? (resumedListing?.communityUrl ?? existingPublication.communityUrl ?? null)
          : null;
      const {
        listingSyncPending: _prevListingSyncPending,
        pendingVisibility: _prevPendingVisibility,
        ...baseExistingPublication
      } = existingPublication;
      const resumedVisibility: WebPublishVisibility =
        resumedListing?.visibility
        ?? (preResumeLegacyUnsupported
          ? 'unlisted'
          : (resumedSyncPending ? (existingPublication.visibility ?? 'public') : requestedVisibility));
      const resumedPublication: WebPublicationRecord = {
        ...baseExistingPublication,
        cloudProjectId: existingProjectId,
        status: 'published',
        url: resumedCommunityUrl ?? resumedUrl,
        ...(target.kind === 'game' && resumedUrl ? { artifactUrl: resumedUrl } : {}),
        ...(resumedCommunityUrl ? { communityUrl: resumedCommunityUrl } : {}),
        ...(target.kind === 'game'
          ? {
              visibility: resumedVisibility,
              feedStatus: resumedListing?.feedStatus ?? existingPublication.feedStatus ?? 'pending',
              allowRemix: resumedListing?.allowRemix ?? requestedAllowRemix ?? true,
              ...(resumedSyncPending ? { listingSyncPending: true, pendingVisibility: resumedPendingVisibility } : {}),
            }
          : {}),
        fileCount: bundle.fileCount,
        totalBytes: bundle.totalBytes,
        bundledAssetCount: bundle.bundledAssetCount,
        contentFingerprint: bundle.contentFingerprint,
        ...(target.multiplayer !== undefined ? { multiplayer: target.multiplayer } : {}),
        updatedAt: Date.now(),
        publishedAt:
          typeof resumedRecord.publishedAt === 'number'
            ? resumedRecord.publishedAt
            : existingPublication.publishedAt,
      };
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        latest.publications[filePath] = resumedPublication;
        await this.saveState(target.kind, target.id, latest);
      });
      return {
        publication: resumedPublication,
        deployment: resumedPublication,
        url: resumedPublication.url,
        updated: true,
      };
    }

    // A cloud file path has one live file identity and that identity has one share
    // binding. A replacement uses a separate cloud project and keeps its reservation on retry.
    const rotating = mode === 'new_link' && Boolean(existingPublication);
    const reservation = await withProcessLock(this.lockFile(target.kind, target.id), async () => {
      const latest = await this.readState(target.kind, target.id);
      const matchesWorkspace = (record: Pick<ShareReservation, 'workspaceId' | 'ownerMemberId'>) =>
        record.workspaceId === workspace.workspaceId && record.ownerMemberId === workspace.workspaceMemberId;
      const current = latest.reservations[filePath];
      if (!rotating && existingPublication?.slug && existingPublication.sourceFileId
          && existingPublication.sourceKey && matchesWorkspace(existingPublication)) {
        const { slug, sourceFileId, sourceKey, workspaceId, ownerMemberId } = existingPublication;
        return { slug, sourceFileId, sourceKey, workspaceId, ownerMemberId, cloudProjectId: existingProjectId };
      }
      if (
        current && matchesWorkspace(current)
        && (rotating
          ? current.cloudProjectId && current.cloudProjectId !== existingProjectId && current.slug !== existingPublication?.slug
          : !current.cloudProjectId || current.cloudProjectId === existingProjectId)
      ) {
        return current;
      }
      const cloudProjectId = rotating ? randomUUID() : existingProjectId;
      const nextSourceFileId = randomUUID();
      const next: ShareReservation = {
        slug: randomUUID(),
        sourceFileId: nextSourceFileId,
        sourceKey: commentFileSourceKey(cloudProjectId, nextSourceFileId),
        workspaceId: workspace.workspaceId,
        ownerMemberId: workspace.workspaceMemberId,
        cloudProjectId,
      };
      latest.reservations[filePath] = next;
      await this.saveState(target.kind, target.id, latest);
      return next;
    });
    const cloudProjectId = reservation.cloudProjectId || existingProjectId;

    const resumingStoppedSlugAsUnlisted =
      target.kind === 'game'
      && mode === 'resume'
      && existingPublication?.status === 'stopped'
      && reservation.slug === existingPublication.slug
      && requestedVisibility === 'unlisted';
    let preReopenListing: GameListingControlResponse | null = null;
    let preReopenLegacyUnsupported = false;
    if (resumingStoppedSlugAsUnlisted) {
      const confirmed = await this.confirmUnlistedBeforeReopen({
        target,
        cloudProjectId,
        workspaceId: workspace.workspaceId,
        slug: reservation.slug,
        displayName,
        allowRemix: options.allowRemix ?? existingPublication?.allowRemix,
        hasCommunityUrl: Boolean(existingPublication?.communityUrl),
      });
      preReopenListing = confirmed.listing;
      preReopenLegacyUnsupported = confirmed.legacyUnsupported;
    }

    const resourceId = publicFileResourceIdFor({
      workspaceId: workspace.workspaceId,
      ownerMemberId: workspace.workspaceMemberId,
      projectId: cloudProjectId,
      filePath,
    });

    // 1. Register project & resource association under the pinned OpenDesign workspace.
    const ensured = await this.runVelaJson(
      ['team-projects', 'ensure-private', cloudProjectId],
      workspace.workspaceId,
    );
    if (ensured.projectId !== cloudProjectId) {
      throw new Error('DEPLOY_FAILED: OpenDesign workspace project verification mismatch');
    }

    const registered = await this.runVelaJson(
      ['team-projects', 'register-resource', cloudProjectId, resourceId],
      workspace.workspaceId,
    );
    if (registered.ok !== true) {
      throw new Error('DEPLOY_FAILED: Could not register project resource in OpenDesign workspace');
    }

    // 2. Stage bundled files (rewriting local media assets & internal URLs) & push content-addressed tree.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'om-web-publish-'));
    try {
      await stagePublishFiles(tempDir, bundle.files);
      const uploadKey = createHash('sha256')
        .update(JSON.stringify([workspace.workspaceId, cloudProjectId, filePath, reservation.slug, bundle.contentFingerprint]))
        .digest('hex');

      const pushResult = await this.runVelaJson(
        [
          'resource',
          'push',
          'project',
          resourceId,
          tempDir,
          '--public-upload-key',
          uploadKey,
          '--metadata-json',
          JSON.stringify({
            source: 'open-design',
            projectId: cloudProjectId,
            targetKind: target.kind,
            targetId: target.id,
            fileName: filePath,
          }),
          '--json',
        ],
        workspace.workspaceId,
      );
      const versionId = typeof pushResult.id === 'string' && pushResult.id.trim() ? pushResult.id.trim() : '';
      if (!versionId) {
        throw new Error('DEPLOY_FAILED: OpenDesign resource push did not return a version ID');
      }

      // 3. Admit the immutable file receipt into the project catalog before publishing.
      await this.admitCommentFileReceipt({
        cloudProjectId,
        workspaceId: workspace.workspaceId,
        ownerMemberId: workspace.workspaceMemberId,
        resourceId,
        versionId,
        filePath,
        sourceFileId: reservation.sourceFileId,
      });

      // If resuming a stopped share whose contents changed, resume the remote slug first.
      if (existingPublication?.status === 'stopped' && mode === 'resume') {
        await this.runVelaJson(
          [
            'share',
            'resume-existing',
            reservation.slug,
            '--project-id',
            cloudProjectId,
            '--source-file-path',
            filePath,
            '--json',
          ],
          workspace.workspaceId,
        ).catch(() => {});
      }

      // 4. Publish immutable version behind the reserved stable share slug.
      const publishResult = await this.runVelaJson(
        [
          'share',
          'publish',
          resourceId,
          '--project-id',
          cloudProjectId,
          '--source-file-path',
          filePath,
          '--slug',
          reservation.slug,
          '--source-key',
          reservation.sourceKey,
          '--entry-path',
          filePath,
          '--name',
          displayName,
          '--version-id',
          versionId,
          '--json',
        ],
        workspace.workspaceId,
      );

      if (publishResult.status !== 'published') {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish did not confirm published status');
      }
      if (publishResult.slug !== reservation.slug) {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish returned mismatched slug');
      }
      const snapshot = publishResult.snapshot as Record<string, unknown> | undefined;
      if (!snapshot || snapshot.versionId !== versionId) {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish returned mismatched version snapshot');
      }

      const publishedVersion =
        typeof publishResult.version === 'number' && Number.isSafeInteger(publishResult.version)
          ? publishResult.version
          : (existingPublication?.version ?? 0) + 1;
      const publishedAt =
        typeof publishResult.publishedAt === 'number' && Number.isSafeInteger(publishResult.publishedAt)
          ? publishResult.publishedAt
          : Date.now();
      const shareUrl = shareViewerUrlForTarget(
        target.kind,
        parseShareLinkFromRecord(publishResult, cloudProjectId, reservation.slug),
      );

      if (rotating && !shareUrl) {
        throw new Error('DEPLOY_FAILED: OpenDesign did not return a valid URL for the new link');
      }
      if (rotating && existingPublication?.status === 'published') {
        await this.stopPublication(existingPublication, existingProjectId);
      }

      // Best-effort community listing sync after `share publish` has already succeeded:
      // keep legacy 404 compatibility for paid plans on pre-community backends, reject Free 403
      // mislabeling immediately, and probe/mark pending on transient 5xx/timeout errors.
      let listingSync: GameListingControlResponse | null = preReopenListing;
      let listingSyncPending = false;
      let pendingVisibility: WebPublishVisibility | undefined;
      let legacyListingUnsupported = preReopenLegacyUnsupported;
      let listingPlanRejection: unknown = null;
      if (target.kind === 'game' && !resumingStoppedSlugAsUnlisted) {
        try {
          listingSync = await this.syncGameListing({
            target,
            cloudProjectId,
            workspaceId: workspace.workspaceId,
            slug: reservation.slug,
            displayName,
            visibility: requestedVisibility,
            allowRemix: options.allowRemix,
          });
        } catch (syncError) {
          if (isPrivateSharePlanError(syncError)) {
            listingPlanRejection = syncError;
          } else if (isUnsupportedGameListingEndpointError(syncError)) {
            legacyListingUnsupported = true;
          } else {
            const probed = this.account.controlApiJson
              ? await this.account
                  .controlApiJson<GameListingControlResponse>(
                    `/api/v1/collab/shares/${encodeURIComponent(reservation.slug)}/game-listing?projectId=${encodeURIComponent(cloudProjectId)}`,
                    { method: 'GET', workspaceId: workspace.workspaceId, timeoutMs: 6_000 },
                  )
                  .catch(() => null)
              : null;
            if (probed && (!probed.visibility || probed.visibility === requestedVisibility)) {
              listingSync = probed;
            } else {
              listingSync = probed;
              listingSyncPending = true;
              pendingVisibility = requestedVisibility;
            }
          }
        }
      }

      const resolvedCommunityUrl =
        target.kind === 'game' ? (listingSync?.communityUrl ?? null) : null;
      const existingVisibilityForSlug =
        existingPublication && existingPublication.slug === reservation.slug
          ? existingPublication.visibility
          : undefined;
      const savedVisibility: WebPublishVisibility = listingPlanRejection
        ? (existingVisibilityForSlug ?? 'public')
        : (listingSync?.visibility
          ?? (legacyListingUnsupported
            ? requestedVisibility
            : (listingSyncPending ? (existingVisibilityForSlug ?? 'public') : requestedVisibility)));

      const record: WebPublicationRecord = {
        schemaVersion: 1,
        targetKind: target.kind,
        targetId: target.id,
        cloudProjectId,
        projectId: target.id,
        filePath,
        entryPath: filePath,
        name: displayName,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        ownerMemberId: workspace.workspaceMemberId,
        resourceId,
        sourceFileId: reservation.sourceFileId,
        sourceKey: reservation.sourceKey,
        slug: reservation.slug,
        version: publishedVersion,
        versionId,
        status: 'published',
        url: resolvedCommunityUrl ?? shareUrl,
        ...(target.kind === 'game' && shareUrl ? { artifactUrl: shareUrl } : {}),
        ...(resolvedCommunityUrl ? { communityUrl: resolvedCommunityUrl } : {}),
        ...(target.kind === 'game'
          ? {
              visibility: savedVisibility,
              allowRemix: listingSync?.allowRemix ?? options.allowRemix ?? true,
              feedStatus: listingSync?.feedStatus ?? 'pending',
              ...(listingSyncPending ? { listingSyncPending: true, pendingVisibility } : {}),
            }
          : {}),
        publishedAt,
        updatedAt: Date.now(),
        fileCount: bundle.fileCount,
        totalBytes: bundle.totalBytes,
        bundledAssetCount: bundle.bundledAssetCount,
        contentFingerprint: bundle.contentFingerprint,
        ...(target.multiplayer !== undefined ? { multiplayer: target.multiplayer } : {}),
        sourceRevision: target.sourceRevision,
      };

      const wasExisting = Boolean(existingPublication && existingPublication.slug === reservation.slug);
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        latest.publications[filePath] = record;
        await this.saveState(target.kind, target.id, latest);
      });

      if (listingPlanRejection) {
        throw listingPlanRejection;
      }

      return { publication: record, deployment: record, url: record.url, updated: wasExisting };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async findStoredEntryPath(
    kind: WebPublishTargetKind,
    id: string,
    filePath?: string,
  ): Promise<string | undefined> {
    const state = await this.readState(kind, id);
    if (filePath) {
      const normalized = normalizeEntryPath(filePath, 'index.html');
      if (state.publications[normalized]) return normalized;
    }
    const records = Object.values(state.publications);
    const active = records.find(r => r.status === 'published');
    const chosen = active ?? records[0];
    return chosen?.filePath || chosen?.entryPath;
  }

  async unpublish(
    target: Pick<WebPublishTarget, 'kind' | 'id' | 'entryPath'>,
    options: { filePath?: string } = {},
  ): Promise<{ publication: WebPublicationRecord; deployment: WebPublicationRecord }> {
    const filePath = normalizeEntryPath(options.filePath, target.entryPath || 'index.html');
    return withProcessLock(this.operationLock(target, filePath), () => this.unpublishEntry(target, filePath));
  }

  private async stopPublication(current: WebPublicationRecord, cloudProjectId: string) {
    const receipt = await this.runVelaJson(
      ['share', 'stop', current.slug, '--project-id', cloudProjectId, '--json'],
      current.workspaceId,
    );
    if (receipt.status !== 'stopped' || receipt.slug !== current.slug) {
      throw new Error('DEPLOY_FAILED: OpenDesign share stop confirmation failed');
    }
  }

  private async unpublishEntry(target: Pick<WebPublishTarget, 'kind' | 'id'>, filePath: string) {
    const state = await this.readState(target.kind, target.id);
    const current = state.publications[filePath];
    if (!current) {
      throw new Error(`NOT_FOUND: No live publication found for "${filePath}"`);
    }

    if (current.status === 'stopped') {
      return { publication: current, deployment: current };
    }

    const remoteProjectId = current.cloudProjectId || cloudProjectIdFor(target.kind, target.id);
    await this.stopPublication(current, remoteProjectId);

    const stopped: WebPublicationRecord = {
      ...current,
      status: 'stopped',
      updatedAt: Date.now(),
    };

    await withProcessLock(this.lockFile(target.kind, target.id), async () => {
      const latest = await this.readState(target.kind, target.id);
      latest.publications[filePath] = stopped;
      await this.saveState(target.kind, target.id, latest);
    });

    return { publication: stopped, deployment: stopped };
  }

  async listAll(): Promise<WebPublishListResponse> {
    const accountSignedIn = await this.account.isSignedIn();
    const collected = new Map<string, WebPublicationRecord>();

    const recordCandidate = (normalized: WebPublicationRecord) => {
      normalized.url = shareViewerUrlForTarget(normalized.targetKind, normalized.url);
      const key = `${normalized.targetKind}:${normalized.targetId}:${normalized.filePath}`;
      const prev = collected.get(key);
      if (!prev || normalized.updatedAt >= prev.updatedAt) {
        collected.set(key, normalized);
      }
    };

    const absorbDir = async (dir: string, defaultKind: WebPublishTargetKind) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const raw = await jsonFile<Partial<StoredPublishFile>>(path.join(dir, entry.name), {});
        const mapSource =
          raw.publications && typeof raw.publications === 'object'
            ? raw.publications
            : raw.deployments && typeof raw.deployments === 'object'
              ? raw.deployments
              : {};
        const stem = entry.name.slice(0, -5);
        const sep = stem.indexOf('--');
        const inferredKind = sep > 0 ? (stem.slice(0, sep) as WebPublishTargetKind) : defaultKind;
        const inferredId = sep > 0 ? stem.slice(sep + 2) : stem;
        for (const item of Object.values(mapSource)) {
          if (!item || typeof item !== 'object') continue;
          recordCandidate(normalizeStoredRecord(item, inferredKind, inferredId));
        }
      }
    };

    const absorbLegacyCloudShares = async () => {
      const entries = await readdir(this.legacyCloudShareRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const raw = await jsonFile<LegacyCloudShareFile>(path.join(this.legacyCloudShareRoot, entry.name), {});
        const converted = fromLegacyCloudShareRecord(raw);
        if (!converted) continue;
        for (const pub of Object.values(converted.publications)) {
          recordCandidate(pub);
        }
      }
    };

    await absorbDir(this.legacyDesignRoot, 'design');
    await absorbLegacyCloudShares();
    await absorbDir(this.storeRoot, 'html');

    const publications = [...collected.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return { accountSignedIn, publications };
  }
}

const publishServices = new Map<string, WebPublishService>();

export function webPublishFor(
  dataDirectory: string,
  account?: WebPublishAccountClient,
): WebPublishService {
  const key = path.resolve(dataDirectory);
  let instance = publishServices.get(key);
  if (!instance) {
    instance = new WebPublishService(key, account);
    publishServices.set(key, instance);
  } else if (account) {
    instance.bindAccount(account);
  }
  return instance;
}

export function closeWebPublishFor(dataDirectory: string): void {
  publishServices.delete(path.resolve(dataDirectory));
}
