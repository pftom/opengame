import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractCommentableElements,
  findCommentableElement,
  groupCloudCommentThreads,
  isGameShareUrl,
  parseCloudShareUrl,
  type CloudComment,
  type CloudCommentAttachmentInput,
  type CloudCommentAttachmentMime,
  type CloudCommentElement,
  type CloudCommentImageInput,
  type CloudCommentPosition,
  type CloudCommentThread,
  type CloudShareRef,
} from '../shared/cloud-comments.ts';
import { webPublishTargetKinds, type WebPublishStatusResponse, type WebPublishTargetKind } from '../shared/web-publish.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { OpenDesignAccount } from './account.ts';
import { webPublishFor, type WebPublishService } from './web-publish.ts';
import { webPublishOperation } from './web-publish-ops.ts';

const MAX_COMMENT_IMAGES = 4;
const MAX_COMMENT_IMAGE_BYTES = 5 * 1024 * 1024;
const GAME_STAGE_ANCHOR = {
  elementId: 'game-stage',
  selector: 'body',
  htmlHint: '<body>',
} as const;
const PAGE_COMMENT_ANCHOR = {
  elementId: 'page-comment',
  selector: 'body',
  htmlHint: '<body>',
} as const;

type ResolvedCloudShareRef = CloudShareRef & { isGame?: boolean };

function sniffLocalImageMime(bytes: Uint8Array): CloudCommentAttachmentMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(
      bytes[0] ?? 0,
      bytes[1] ?? 0,
      bytes[2] ?? 0,
      bytes[3] ?? 0,
      bytes[4] ?? 0,
      bytes[5] ?? 0,
    );
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }
  return null;
}

export type CloudCommentsAccountClient = Pick<
  OpenDesignAccount,
  'cloudApiRequest' | 'cloudPublicRequest' | 'isSignedIn'
> &
  Partial<Pick<OpenDesignAccount, 'cloudApiUpload'>>;

export type CloudCommentsDeps = {
  account?: CloudCommentsAccountClient;
  webPublish?: WebPublishService;
};

type ShareViewerMetadata = {
  slug: string;
  snapshotSlug: string;
  entryPath: string;
  displayName?: string;
  publishedAt?: number;
  version: number;
};

export class CloudCommentsService {
  private readonly account: CloudCommentsAccountClient;
  private readonly webPublish: WebPublishService;
  private readonly store: WorkspaceStore;
  private readonly origin: string;

  constructor(store: WorkspaceStore, origin: string, deps: { account: CloudCommentsAccountClient; webPublish?: WebPublishService }) {
    this.store = store;
    this.origin = origin;
    this.account = deps.account;
    this.webPublish = deps.webPublish ?? webPublishFor((store.workspaceStore ?? store).directory);
  }

  private async hydrateGameShareRef(slug: string, shareUrl?: string): Promise<ResolvedCloudShareRef> {
    const detail = await this.account.cloudPublicRequest<{
      slug?: string;
      projectId?: string;
      entryPath?: string;
      version?: number;
    }>(`/api/v1/public/games/${encodeURIComponent(slug)}`);
    const projectId = typeof detail?.projectId === 'string' ? detail.projectId.trim() : '';
    const resolvedSlug = typeof detail?.slug === 'string' && detail.slug.trim() ? detail.slug.trim() : slug;
    if (!projectId) {
      throw new Error('SHARE_NOT_FOUND: unable to resolve game share metadata');
    }
    return {
      projectId,
      slug: resolvedSlug,
      ...(shareUrl ? { shareUrl } : {}),
      ...(typeof detail.entryPath === 'string' && detail.entryPath.trim() ? { filePath: detail.entryPath.trim() } : {}),
      ...(typeof detail.version === 'number' && Number.isSafeInteger(detail.version) ? { version: detail.version } : {}),
      isGame: true,
    };
  }

  private async resolveShareRef(rawInput: Record<string, unknown>): Promise<ResolvedCloudShareRef> {
    const shareUrlRaw = typeof rawInput.shareUrl === 'string' ? rawInput.shareUrl.trim() : '';
    if (shareUrlRaw) {
      const parsed = parseCloudShareUrl(shareUrlRaw);
      const isGame = parsed.isGame || isGameShareUrl(shareUrlRaw);
      if (!parsed.projectId) {
        return await this.hydrateGameShareRef(parsed.slug, parsed.shareUrl);
      }
      return {
        projectId: parsed.projectId,
        slug: parsed.slug,
        shareUrl: parsed.shareUrl,
        ...(isGame ? { isGame: true } : {}),
      };
    }
    const projectId = typeof rawInput.projectId === 'string' ? rawInput.projectId.trim() : '';
    const slug = typeof rawInput.slug === 'string' ? rawInput.slug.trim() : '';
    if (projectId && slug) {
      return {
        projectId,
        slug,
        ...(rawInput.targetKind === 'game' ? { isGame: true } : {}),
      };
    }
    if (!projectId && slug && rawInput.targetKind === 'game') {
      return await this.hydrateGameShareRef(slug);
    }
    if (projectId || slug) {
      throw new Error('INVALID_ARGUMENT: provide both projectId and slug together, or shareUrl');
    }
    const targetKindRaw = typeof rawInput.targetKind === 'string' ? rawInput.targetKind.trim() : '';
    const targetId = typeof rawInput.targetId === 'string' ? rawInput.targetId.trim() : undefined;
    const sourcePath = typeof rawInput.sourcePath === 'string' ? rawInput.sourcePath.trim() : undefined;
    const filePath = typeof rawInput.filePath === 'string' ? rawInput.filePath.trim() : undefined;
    if (!targetKindRaw && !targetId && !sourcePath) {
      throw new Error('INVALID_ARGUMENT: specify shareUrl, projectId + slug, or targetKind / sourcePath');
    }
    const targetKind: WebPublishTargetKind =
      targetKindRaw && (webPublishTargetKinds as readonly string[]).includes(targetKindRaw)
        ? (targetKindRaw as WebPublishTargetKind)
        : 'html';
    const status = (await webPublishOperation(
      this.store,
      {
        command: 'status',
        targetKind,
        ...(targetId ? { targetId } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(filePath ? { filePath } : {}),
      },
      this.origin,
      this.webPublish,
    )) as WebPublishStatusResponse;
    const publication =
      status.active ??
      status.publications.find((item) => item.status === 'published') ??
      status.publications[0];
    const candidateUrl = publication?.url || publication?.communityUrl;
    if (!candidateUrl) {
      throw new Error('SHARE_NOT_PUBLISHED: deploy the target first with openmotion_cloud_deploy');
    }
    const parsed = parseCloudShareUrl(candidateUrl);
    const resolvedProjectId = parsed.projectId || publication?.cloudProjectId || publication?.projectId || '';
    if (!resolvedProjectId) {
      return await this.hydrateGameShareRef(parsed.slug, candidateUrl);
    }
    return {
      projectId: resolvedProjectId,
      slug: parsed.slug,
      shareUrl: candidateUrl,
      filePath: publication?.entryPath,
      version: publication?.version,
      ...(targetKind === 'game' ||
      publication?.targetKind === 'game' ||
      parsed.isGame ||
      isGameShareUrl(candidateUrl)
        ? { isGame: true }
        : {}),
    };
  }

  private parseImageInputs(rawInput: Record<string, unknown>): Array<{ path: string; alt?: string }> {
    const out: Array<{ path: string; alt?: string }> = [];
    const appendItem = (entry: unknown) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) throw new Error('INVALID_ARGUMENT: image file path must not be empty');
        out.push({ path: trimmed });
        return;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as CloudCommentImageInput;
        const candidate =
          typeof record.path === 'string' && record.path.trim()
            ? record.path.trim()
            : typeof record.filePath === 'string' && record.filePath.trim()
              ? record.filePath.trim()
              : '';
        if (!candidate) {
          throw new Error('INVALID_ARGUMENT: image entry requires a non-empty path or filePath');
        }
        const alt = typeof record.alt === 'string' && record.alt.trim() ? record.alt.trim().slice(0, 240) : undefined;
        out.push({ path: candidate, ...(alt ? { alt } : {}) });
        return;
      }
      throw new Error('INVALID_ARGUMENT: images entries must be file paths or { path, alt } objects');
    };
    if (Array.isArray(rawInput.images)) {
      for (const item of rawInput.images) appendItem(item);
    }
    if (Array.isArray(rawInput.imagePaths)) {
      for (const item of rawInput.imagePaths) appendItem(item);
    }
    if (out.length > MAX_COMMENT_IMAGES) {
      throw new Error(`INVALID_ARGUMENT: up to ${MAX_COMMENT_IMAGES} image attachments are allowed per comment`);
    }
    return out;
  }

  private async uploadImageInputs(
    ref: ResolvedCloudShareRef,
    items: readonly { path: string; alt?: string }[],
    filePath?: string,
  ): Promise<CloudCommentAttachmentInput[]> {
    if (items.length === 0) return [];
    if (typeof this.account.cloudApiUpload !== 'function') {
      throw new Error('UPLOAD_UNAVAILABLE: current account client does not support image attachment uploads');
    }
    const baseDir = (this.store.workspaceStore ?? this.store).directory;
    const uploaded: CloudCommentAttachmentInput[] = [];
    for (const item of items) {
      const resolvedPath = path.isAbsolute(item.path) ? item.path : path.resolve(baseDir, item.path);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolvedPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`INVALID_ATTACHMENT: unable to read image file "${item.path}" (${msg})`);
      }
      if (bytes.byteLength === 0) {
        throw new Error(`INVALID_ATTACHMENT: image file "${item.path}" is empty`);
      }
      if (bytes.byteLength > MAX_COMMENT_IMAGE_BYTES) {
        throw new Error(`PAYLOAD_TOO_LARGE: image file "${item.path}" exceeds 5 MiB limit`);
      }
      const mimeType = sniffLocalImageMime(bytes);
      if (!mimeType) {
        throw new Error(
          `INVALID_ATTACHMENT: "${item.path}" is not a valid PNG, JPEG, WebP, or GIF image`,
        );
      }
      const response = await this.account.cloudApiUpload<{
        attachment?: { uploadToken?: string };
      }>(`/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/attachments`, {
        bytes,
        contentType: mimeType,
        query: {
          projectId: ref.projectId,
          ...(filePath ? { filePath } : {}),
        },
      });
      const uploadToken = response?.attachment?.uploadToken;
      if (typeof uploadToken !== 'string' || !uploadToken) {
        throw new Error('UPLOAD_FAILED: cloud attachment upload did not return an uploadToken');
      }
      uploaded.push({
        uploadToken,
        ...(item.alt ? { alt: item.alt } : {}),
      });
    }
    return uploaded;
  }

  private async fetchMetadata(ref: CloudShareRef): Promise<ShareViewerMetadata> {
    const meta = await this.account.cloudPublicRequest<ShareViewerMetadata>(
      `/api/v1/public/snapshots/${encodeURIComponent(ref.slug)}`,
      { query: { projectId: ref.projectId, shareAlias: '1' } },
    );
    if (!meta?.snapshotSlug || !meta?.entryPath || !Number.isSafeInteger(meta.version)) {
      throw new Error('SHARE_NOT_FOUND: share viewer metadata is unavailable');
    }
    return meta;
  }

  private async fetchEntryHtml(ref: CloudShareRef): Promise<{ meta: ShareViewerMetadata; html: string }> {
    const meta = await this.fetchMetadata(ref);
    const encodedEntryPath = meta.entryPath
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
    const html = await this.account.cloudPublicRequest<string>(
      `/api/v1/public/snapshots/${encodeURIComponent(meta.snapshotSlug)}/files/${encodedEntryPath}`,
      {
        query: { projectId: ref.projectId, shareSlug: ref.slug },
        responseType: 'text',
      },
    );
    return { meta, html };
  }

  async inspectElements(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const { meta, html } = await this.fetchEntryHtml(ref);
    const query = typeof rawInput.query === 'string' ? rawInput.query : undefined;
    const limit = typeof rawInput.limit === 'number' ? rawInput.limit : undefined;
    const extracted = extractCommentableElements(html, { query, limit });
    return {
      action: 'inspect_elements',
      share: {
        projectId: ref.projectId,
        slug: ref.slug,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
        filePath: meta.entryPath,
        version: meta.version,
        ...(meta.displayName ? { displayName: meta.displayName } : {}),
        ...(meta.publishedAt !== undefined ? { publishedAt: meta.publishedAt } : {}),
      },
      elements: extracted.elements,
      totalElements: extracted.totalElements,
    };
  }

  async list(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const sinceSeq = typeof rawInput.sinceSeq === 'number' ? rawInput.sinceSeq : undefined;
    const includeResolved = rawInput.includeResolved === true;
    const signedIn = await this.account.isSignedIn();
    if (signedIn) {
      const response = await this.account.cloudApiRequest<{
        share: CloudShareRef;
        viewer: { authorKey: string; displayName?: string; isOwner: boolean };
        comments: CloudComment[];
        threads: CloudCommentThread[];
        latestSeq: number;
        unresolvedTotal: number;
      }>(`/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/comments`, {
        method: 'GET',
        query: {
          projectId: ref.projectId,
          ...(sinceSeq !== undefined ? { sinceSeq } : {}),
          ...(includeResolved ? { includeResolved: 'true' } : {}),
        },
      });
      return {
        action: 'list',
        share: {
          ...response.share,
          ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
        },
        viewer: response.viewer,
        comments: response.comments,
        threads: response.threads ?? groupCloudCommentThreads(response.comments),
        latestSeq: response.latestSeq,
        unresolvedTotal: response.unresolvedTotal,
      };
    }

    if (includeResolved) {
      throw new Error('ACCOUNT_NOT_SIGNED_IN: sign in to view resolved comments');
    }
    const meta = await this.fetchMetadata(ref);
    const filePath = (typeof rawInput.filePath === 'string' && rawInput.filePath.trim()) || meta.entryPath;
    const response = await this.account.cloudPublicRequest<{
      comments: CloudComment[];
      latestSeq: number;
      unresolvedTotal: number;
    }>(`/api/v1/collab/share/${encodeURIComponent(ref.slug)}/comments`, {
      query: {
        projectId: ref.projectId,
        filePath,
        ...(sinceSeq !== undefined ? { since: sinceSeq } : {}),
      },
    });
    return {
      action: 'list',
      share: {
        projectId: ref.projectId,
        slug: ref.slug,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
        filePath,
        version: meta.version,
      },
      viewer: null,
      comments: response.comments,
      threads: groupCloudCommentThreads(response.comments),
      latestSeq: response.latestSeq,
      unresolvedTotal: response.unresolvedTotal,
    };
  }

  async comment(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const note = typeof rawInput.note === 'string' ? rawInput.note.trim() : '';
    const imageInputs = this.parseImageInputs(rawInput);
    if (!note && imageInputs.length === 0) {
      throw new Error('INVALID_ARGUMENT: provide note and/or up to 4 images for action="comment"');
    }

    let elementId = typeof rawInput.elementId === 'string' ? rawInput.elementId.trim() : '';
    let selector = typeof rawInput.selector === 'string' ? rawInput.selector.trim() : '';
    let htmlHint = typeof rawInput.htmlHint === 'string' ? rawInput.htmlHint.trim() : '';
    const explicitTargetType = typeof rawInput.targetType === 'string' ? rawInput.targetType.trim() : '';
    let inspectedShare: { filePath?: string; version?: number } | undefined;

    if (!elementId || !selector || !htmlHint) {
      if (!elementId && !selector) {
        if (explicitTargetType === 'element') {
          throw new Error(
            'INVALID_ARGUMENT: provide selector or elementId when targetType="element" (or use action="inspect_elements")',
          );
        }
        const stageAnchor =
          ref.isGame || explicitTargetType === 'game' ? GAME_STAGE_ANCHOR : PAGE_COMMENT_ANCHOR;
        elementId = stageAnchor.elementId;
        selector = stageAnchor.selector;
        htmlHint = stageAnchor.htmlHint;
      } else {
        const { meta, html } = await this.fetchEntryHtml(ref);
        inspectedShare = { filePath: meta.entryPath, version: meta.version };
        const match = findCommentableElement(html, { selector, elementId });
        if (!match && (!selector || !elementId)) {
          throw new Error(`COMMENT_TARGET_NOT_FOUND: element "${selector || elementId}" was not found in published HTML`);
        }
        if (match) {
          elementId = elementId || match.elementId;
          selector = selector || match.selector;
          htmlHint = htmlHint || match.htmlHint;
        } else {
          htmlHint = htmlHint || selector;
        }
      }
    }

    const filePath =
      (typeof rawInput.filePath === 'string' && rawInput.filePath.trim()) ||
      inspectedShare?.filePath ||
      ref.filePath;
    const expectedVersion =
      typeof rawInput.expectedVersion === 'number'
        ? rawInput.expectedVersion
        : inspectedShare?.version ?? ref.version;

    const attachments = await this.uploadImageInputs(ref, imageInputs, filePath);

    const response = await this.account.cloudApiRequest<{
      comment: CloudComment;
      share: CloudShareRef;
    }>(`/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/comments`, {
      method: 'POST',
      query: { projectId: ref.projectId },
      body: {
        note,
        ...(attachments.length > 0 ? { attachments } : {}),
        elementId,
        selector,
        htmlHint,
        ...(filePath ? { filePath } : {}),
        ...(expectedVersion ? { expectedVersion } : {}),
        ...(typeof rawInput.label === 'string' && rawInput.label.trim() ? { label: rawInput.label.trim() } : {}),
        ...(rawInput.position ? { position: rawInput.position as CloudCommentPosition } : {}),
        idempotencyKey:
          (typeof rawInput.idempotencyKey === 'string' && rawInput.idempotencyKey.trim()) || randomUUID(),
      },
    });
    return {
      action: 'comment',
      comment: response.comment,
      share: {
        ...response.share,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
      },
    };
  }

  async reply(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const parentCommentId = typeof rawInput.parentCommentId === 'string' ? rawInput.parentCommentId.trim() : '';
    const note = typeof rawInput.note === 'string' ? rawInput.note.trim() : '';
    const imageInputs = this.parseImageInputs(rawInput);
    if (!parentCommentId) throw new Error('INVALID_ARGUMENT: parentCommentId is required for action="reply"');
    if (!note && imageInputs.length === 0) {
      throw new Error('INVALID_ARGUMENT: provide note and/or up to 4 images for action="reply"');
    }

    const filePath = typeof rawInput.filePath === 'string' && rawInput.filePath.trim() ? rawInput.filePath.trim() : ref.filePath;
    const attachments = await this.uploadImageInputs(ref, imageInputs, filePath);

    const response = await this.account.cloudApiRequest<{
      comment: CloudComment;
      share: CloudShareRef;
    }>(`/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/comments`, {
      method: 'POST',
      query: { projectId: ref.projectId },
      body: {
        parentCommentId,
        ...(typeof rawInput.replyToCommentId === 'string' && rawInput.replyToCommentId.trim()
          ? { replyToCommentId: rawInput.replyToCommentId.trim() }
          : {}),
        note,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(filePath ? { filePath } : {}),
        ...(typeof rawInput.expectedVersion === 'number' ? { expectedVersion: rawInput.expectedVersion } : {}),
        idempotencyKey:
          (typeof rawInput.idempotencyKey === 'string' && rawInput.idempotencyKey.trim()) || randomUUID(),
      },
    });
    return {
      action: 'reply',
      comment: response.comment,
      share: {
        ...response.share,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
      },
    };
  }

  async update(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const commentId = typeof rawInput.commentId === 'string' ? rawInput.commentId.trim() : '';
    if (!commentId) throw new Error('INVALID_ARGUMENT: commentId is required for action="update"');
    const note = typeof rawInput.note === 'string' ? rawInput.note.trim() : undefined;
    const status = rawInput.status === 'open' || rawInput.status === 'resolved' ? rawInput.status : undefined;
    if (note === undefined && status === undefined) {
      throw new Error('INVALID_ARGUMENT: provide note and/or status for action="update"');
    }
    const response = await this.account.cloudApiRequest<{
      comment: CloudComment;
      share: CloudShareRef;
    }>(
      `/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'PATCH',
        query: { projectId: ref.projectId },
        body: {
          ...(note !== undefined ? { note } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(typeof rawInput.filePath === 'string' && rawInput.filePath.trim() ? { filePath: rawInput.filePath.trim() } : {}),
          ...(typeof rawInput.expectedVersion === 'number' ? { expectedVersion: rawInput.expectedVersion } : {}),
          idempotencyKey:
            (typeof rawInput.idempotencyKey === 'string' && rawInput.idempotencyKey.trim()) || randomUUID(),
        },
      },
    );
    return {
      action: 'update',
      comment: response.comment,
      share: {
        ...response.share,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
      },
    };
  }

  async remove(rawInput: Record<string, unknown>) {
    const ref = await this.resolveShareRef(rawInput);
    const commentId = typeof rawInput.commentId === 'string' ? rawInput.commentId.trim() : '';
    if (!commentId) throw new Error('INVALID_ARGUMENT: commentId is required for action="delete"');
    const response = await this.account.cloudApiRequest<{
      comment: CloudComment;
      share: CloudShareRef;
    }>(
      `/api/v1/collab/client-share/${encodeURIComponent(ref.slug)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'DELETE',
        query: {
          projectId: ref.projectId,
          ...(typeof rawInput.filePath === 'string' && rawInput.filePath.trim() ? { filePath: rawInput.filePath.trim() } : {}),
          ...(typeof rawInput.expectedVersion === 'number' ? { expectedVersion: rawInput.expectedVersion } : {}),
          idempotencyKey:
            (typeof rawInput.idempotencyKey === 'string' && rawInput.idempotencyKey.trim()) || randomUUID(),
        },
      },
    );
    return {
      action: 'delete',
      comment: response.comment,
      share: {
        ...response.share,
        ...(ref.shareUrl ? { shareUrl: ref.shareUrl } : {}),
      },
    };
  }
}

export async function cloudCommentsOperation(
  store: WorkspaceStore,
  rawInput: Record<string, unknown> | undefined,
  origin: string,
  deps: CloudCommentsDeps = {},
): Promise<unknown> {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const action = typeof input.action === 'string' ? input.action : '';
  const rootStore = store.workspaceStore ?? store;
  const account = deps.account ?? new (await import('./account.ts')).OpenDesignAccount(rootStore.directory);
  const service = new CloudCommentsService(store, origin, {
    account,
    webPublish: deps.webPublish ?? webPublishFor(rootStore.directory),
  });

  if (action === 'inspect_elements') return service.inspectElements(input);
  if (action === 'list') return service.list(input);
  if (action === 'comment') return service.comment(input);
  if (action === 'reply') return service.reply(input);
  if (action === 'update') return service.update(input);
  if (action === 'delete') return service.remove(input);
  throw new Error('INVALID_ARGUMENT: cloud comments action must be inspect_elements, list, comment, reply, update, or delete');
}
