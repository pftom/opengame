/**
 * Generalized web publishing contract shared by domain services, HTTP routes,
 * public MCP tools, and Studio surfaces (Design, Game, Motion, or any standalone HTML bundle).
 */

export const WEB_PUBLISH_API = '/motion-api/web-publish';

export const webPublishTargetKinds = ['design', 'game', 'html', 'motion'] as const;
export type WebPublishTargetKind = typeof webPublishTargetKinds[number];

export type WebPublishMode = 'publish' | 'resume' | 'new_link';
export type WebPublishStatus = 'published' | 'stopped';
export type WebPublishFreshness = 'fresh' | 'outdated' | 'unknown';
export type WebPublishAccountState = 'signed-out' | 'authorizing' | 'signed-in' | 'reauth-required' | 'unavailable';
export type WebPublishVisibility = 'public' | 'unlisted';
export type WebPublishFeedStatus = 'pending' | 'approved' | 'featured' | 'rejected';

export type WebPublishGameMeta = {
  title: string;
  description?: string;
  genre?: string | null;
  style?: string | null;
  setting?: string | null;
  orientation?: 'landscape' | 'portrait';
  controls?: string;
  coverPath?: string | null;
  i18n?: Record<string, { title?: string; description?: string; controls?: string }> | null;
  creatorName?: string | null;
  templateId?: string | null;
  remixOfSlug?: string | null;
};

/** Extract a normalized lowercase plan slug from either a plan string or legacy `{ id }` object. */
export function normalizeWebPublishPlanId(
  plan?: string | { id?: string | null } | null,
): string | undefined {
  if (typeof plan === 'string') {
    const trimmed = plan.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
  }
  if (plan && typeof plan === 'object' && typeof plan.id === 'string') {
    const trimmed = plan.id.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
  }
  return undefined;
}

/** Any paid OpenDesign plan (starting at `go`, up through `plus`, `pro`, `max`, and paid `team_*` tiers) unlocks unlisted/private game shares. */
export function isPaidWebPublishPlan(plan?: string | { id?: string | null } | null): boolean {
  const normalized = normalizeWebPublishPlanId(plan);
  if (!normalized) return false;
  return normalized !== 'free' && normalized !== 'team_free' && !normalized.endsWith('_free');
}

export type WebPublishTarget = {
  kind: WebPublishTargetKind;
  id: string;
  title: string;
  entryPath: string;
  sourceRevision: string;
  /** Directory containing the HTML bundle, or a direct .html / .htm file path. */
  sourcePath: string;
  /** Optional in-memory entry HTML used for read-only freshness checks without mutating disk cache. */
  virtualEntryHtml?: string;
  multiplayer?: boolean;
  /** Structured game metadata passed to OpenDesign Cloud when publishing a game. */
  gameMeta?: WebPublishGameMeta;
};

export type WebPublicationRecord = {
  schemaVersion: 1;
  targetKind: WebPublishTargetKind;
  targetId: string;
  /** Remote OpenDesign project UUID used for cloud resource registration and share URLs. */
  cloudProjectId: string;
  /** Compatibility alias preserved for Design Studio consumers (= targetId). */
  projectId: string;
  filePath: string;
  entryPath: string;
  name: string;
  workspaceId: string;
  workspaceName?: string;
  ownerMemberId: string;
  resourceId: string;
  sourceFileId: string;
  sourceKey: string;
  slug: string;
  version: number;
  versionId: string;
  status: WebPublishStatus;
  url: string | null;
  /** Legacy artifact share URL preserved alongside community `/games/:slug` URLs. */
  artifactUrl?: string | null;
  /** Short SEO-friendly community URL (`/games/:slug`) for game shares. */
  communityUrl?: string | null;
  visibility?: WebPublishVisibility;
  allowRemix?: boolean;
  feedStatus?: WebPublishFeedStatus;
  /** True only when a publish/resume attempted `PUT /game-listing` and remote sync failed transiently. */
  listingSyncPending?: boolean;
  /** Target visibility awaiting remote confirmation when `listingSyncPending` is true. */
  pendingVisibility?: WebPublishVisibility;
  publishedAt: number;
  updatedAt: number;
  fileCount: number;
  totalBytes: number;
  bundledAssetCount?: number;
  contentFingerprint?: string;
  multiplayer?: boolean;
  sourceRevision: string;
};

export type WebPublishStatusResponse = {
  targetKind: WebPublishTargetKind;
  targetId: string;
  /** Compatibility alias preserved for Design Studio consumers (= targetId). */
  projectId: string;
  title?: string;
  entryPath?: string;
  accountSignedIn: boolean;
  accountState?: WebPublishAccountState;
  accountEmail?: string;
  accountPlan?: string;
  /** True when the signed-in account can switch game visibility to `unlisted` (any paid plan, Go+). */
  canUsePrivateShare?: boolean;
  freshness?: WebPublishFreshness;
  fileCount?: number;
  totalBytes?: number;
  bundledAssetCount?: number;
  multiplayer?: boolean;
  publications: WebPublicationRecord[];
  /** Compatibility alias preserved for Design Studio consumers (= publications). */
  deployments: WebPublicationRecord[];
  active: WebPublicationRecord | null;
};

export type WebPublishListResponse = {
  accountSignedIn: boolean;
  publications: WebPublicationRecord[];
};

export const webPublishRoutes = {
  list: WEB_PUBLISH_API,
  target: (kind: WebPublishTargetKind, id: string) =>
    `${WEB_PUBLISH_API}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
} as const;

export const webPublishToolDescription =
  ' Use action=web_publish with webPublish={command:"publish"|"status"|"visibility"|"unpublish"|"list", targetKind:"design"|"game"|"html"|"motion", ...} to bundle local referenced assets and publish any HTML-expressed project, playable game (including embedUrl for community HTTPS games), or standalone HTML file/folder to a unique Open Design Cloud share link. For targetKind="game", pass visibility ("public"|"unlisted") and allowRemix on publish or command="visibility" (unlisted requires a paid OpenDesign Go+ plan).';

export const webPublishToolArguments = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: {
      enum: ['publish', 'status', 'unpublish', 'list', 'visibility'],
      description: 'Operation to run: publish/update a live HTTPS link, inspect status and content freshness, update visibility, stop sharing, or list all publications.',
    },
    targetKind: {
      enum: ['design', 'game', 'html', 'motion'],
      description: 'What is being published: a Design Studio project, Game Studio game, Motion project HTML bundle, or standalone HTML file/folder.',
    },
    targetId: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Target project or game ID (optional for targetKind="html" when sourcePath is provided).',
    },
    sourcePath: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      description: 'Local HTML file or static directory path when targetKind is "html".',
    },
    embedUrl: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      description: 'Public HTTPS URL to wrap and publish as an embeddable community game when targetKind is "game".',
    },
    filePath: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Entry HTML path relative to the bundle root (default index.html).',
    },
    workspaceId: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Optional OpenDesign workspace ID override.',
    },
    deployMode: {
      enum: ['publish', 'resume', 'new_link'],
      description: 'publish (create or update live link), resume (reopen stopped link), or new_link (rotate to a fresh share URL).',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Optional public display title for the published web link.',
    },
    refresh: {
      type: 'boolean',
      description: 'When command="status", refresh live status from Open Design Cloud.',
    },
    visibility: {
      enum: ['public', 'unlisted'],
      description: 'Game share visibility: public (default, eligible for offline community curation) or unlisted (paid plans Go+, link-only and excluded from community feeds/SEO).',
    },
    allowRemix: {
      type: 'boolean',
      description: 'Whether viewers may use one-click Remix on this game share.',
    },
  },
};
