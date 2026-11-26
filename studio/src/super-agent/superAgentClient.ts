import type { BrowserScreenshotResult } from '../../../shared/browser';
import { assetMediaUrl, assetVersion } from '../../../shared/asset-library';
import type { Modality } from '../../../shared/gateway';
import {
  SUPER_AGENT_API,
  type SuperAgentArtifact,
  type SuperAgentChat,
  type SuperAgentChatSummary,
  type SuperAgentEngine,
  type SuperAgentFeedbackReason,
  type SuperAgentFeedbackScene,
  type SuperAgentIntent,
  type SuperAgentModeId,
  type SuperAgentPermissionMode,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCatalog,
  type SuperAgentTurnFeedback,
  type SuperAgentTurnFeedbackAction,
  type SuperAgentTurnInput,
} from '../../../shared/super-agent';
import { uploadLibraryAsset } from '../motion/assetClient';
import { AssetUploadError } from '../motion/assetUploadError';
import { isClientCacheEnabled } from '../utils/clientCacheMode';

const MAX_CACHED_CHATS = 24;
const CHAT_CACHE_TTL_MS = 30_000;
const CHAT_LIST_TTL_MS = 15_000;
const RESOURCES_TTL_MS = 30_000;

let chatCacheGeneration = 0;
let listCacheGeneration = 0;
let resourcesCacheGeneration = 0;

const chatCache = new Map<string, { value: SuperAgentChat; expiresAt: number }>();
const inflightChats = new Map<string, Promise<{ conversation: SuperAgentChat }>>();

let chatListCache: { value: SuperAgentChatSummary[]; expiresAt: number } | null = null;
let inflightChatList: Promise<{ conversations: SuperAgentChatSummary[] }> | null = null;

const resourcesCache = new Map<string, { value: SuperAgentResourceCatalog; expiresAt: number }>();
const inflightResources = new Map<string, Promise<SuperAgentResourceCatalog>>();

type WorkspaceResourceQuery = {
  kind?: string;
  query?: string;
  limit?: number;
  locale?: string;
  modality?: Modality;
  offset?: number;
};

function resourcesCacheKey(params: WorkspaceResourceQuery = {}): string {
  return JSON.stringify([
    params.kind && params.kind !== 'all' ? params.kind : 'all',
    params.query?.trim() ?? '',
    params.limit ?? null,
    params.locale?.trim() ?? '',
    params.modality ?? null,
    params.offset ?? 0,
  ]);
}

function invalidateChatListCache(): void {
  listCacheGeneration++;
  chatListCache = null;
  inflightChatList = null;
}

export function clearSuperAgentCache(): void {
  chatCacheGeneration++;
  listCacheGeneration++;
  resourcesCacheGeneration++;
  chatCache.clear();
  inflightChats.clear();
  chatListCache = null;
  inflightChatList = null;
  resourcesCache.clear();
  inflightResources.clear();
}

export function peekCachedSuperAgentChat(id: string): SuperAgentChat | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return chatCache.get(id)?.value;
}

export function seedCachedSuperAgentChat(chat: SuperAgentChat): void {
  if (!isClientCacheEnabled()) return;
  chatCache.delete(chat.id);
  chatCache.set(chat.id, { value: chat, expiresAt: Date.now() + CHAT_CACHE_TTL_MS });
  while (chatCache.size > MAX_CACHED_CHATS) {
    const oldest = chatCache.keys().next().value;
    if (!oldest) break;
    chatCache.delete(oldest);
  }

  const cachedSummary = chatListCache?.value.find(item => item.id === chat.id);
  if (cachedSummary && chat.updatedAt >= cachedSummary.updatedAt && chat.state !== cachedSummary.state) {
    invalidateChatListCache();
  }
}

export function prefetchSuperAgentChat(id: string): void {
  if (!isClientCacheEnabled() || !id) return;
  const cached = chatCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return;
  void getSuperAgentChat(id).catch(() => {});
}

export function peekCachedSuperAgentChatList(): SuperAgentChatSummary[] | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return chatListCache?.value;
}

export function peekCachedWorkspaceResources(params: WorkspaceResourceQuery = {}): SuperAgentResourceCatalog | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return resourcesCache.get(resourcesCacheKey(params))?.value;
}

export function prefetchSuperAgentWorkspace(): void {
  if (!isClientCacheEnabled()) return;
  if (!chatListCache || chatListCache.expiresAt <= Date.now()) {
    void listSuperAgentChats().catch(() => {});
  }
  const resKey = resourcesCacheKey({ limit: 48 });
  const resCached = resourcesCache.get(resKey);
  if (!resCached || resCached.expiresAt <= Date.now()) {
    void fetchWorkspaceResources({ limit: 48 }).catch(() => {});
  }
}

async function saRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${SUPER_AGENT_API}${path}`, {
    method,
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`);
  }
  return data as T;
}

export async function fetchWorkspaceResources(params: WorkspaceResourceQuery & { signal?: AbortSignal } = {}) {
  const key = resourcesCacheKey(params);
  if (isClientCacheEnabled()) {
    const cached = resourcesCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  if (!params.signal) {
    const pending = inflightResources.get(key);
    if (pending) return pending;
  }

  const search = new URLSearchParams();
  if (params.kind && params.kind !== 'all') search.set('kind', params.kind);
  if (params.query?.trim()) search.set('query', params.query.trim());
  if (params.limit) search.set('limit', String(params.limit));
  if (params.locale?.trim()) search.set('locale', params.locale.trim());
  if (params.modality) search.set('modality', params.modality);
  if (params.offset) search.set('offset', String(params.offset));
  const qs = search.toString();
  const gen = resourcesCacheGeneration;
  const run = saRequest<SuperAgentResourceCatalog>(`/resources${qs ? `?${qs}` : ''}`, 'GET', undefined, params.signal).then(res => {
    if (isClientCacheEnabled() && gen === resourcesCacheGeneration) {
      resourcesCache.set(key, { value: res, expiresAt: Date.now() + RESOURCES_TTL_MS });
    }
    return res;
  });
  if (params.signal) return run;
  inflightResources.set(key, run);
  return run.finally(() => {
    if (inflightResources.get(key) === run) inflightResources.delete(key);
  });
}

export async function listSuperAgentChats() {
  if (isClientCacheEnabled() && chatListCache && chatListCache.expiresAt > Date.now()) {
    return { conversations: chatListCache.value };
  }
  if (inflightChatList) return inflightChatList;
  const gen = listCacheGeneration;
  const run = saRequest<{ conversations: SuperAgentChatSummary[] }>('/chats').then(res => {
    if (isClientCacheEnabled() && gen === listCacheGeneration && Array.isArray(res?.conversations)) {
      chatListCache = { value: res.conversations, expiresAt: Date.now() + CHAT_LIST_TTL_MS };
    }
    return res;
  });
  inflightChatList = run;
  return run.finally(() => {
    if (inflightChatList === run) inflightChatList = null;
  });
}

export async function createSuperAgentChat(body: {
  title?: string;
  intent?: SuperAgentIntent;
  initialArtifact?: Partial<SuperAgentArtifact>;
  runtimeId?: string;
  engine?: SuperAgentEngine;
  model?: string;
  permissionMode?: SuperAgentPermissionMode;
} = {}) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>('/chats', 'POST', body);
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function getSuperAgentChat(id: string, { fresh = false }: { fresh?: boolean } = {}) {
  if (!fresh && isClientCacheEnabled()) {
    const cached = chatCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return { conversation: cached.value };
    }
  }
  const existing = inflightChats.get(id);
  if (existing) return existing;

  const gen = chatCacheGeneration;
  const run = saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}`).then(res => {
    if (isClientCacheEnabled() && gen === chatCacheGeneration && res?.conversation) {
      seedCachedSuperAgentChat(res.conversation);
    }
    return res;
  });
  inflightChats.set(id, run);
  return run.finally(() => {
    if (inflightChats.get(id) === run) inflightChats.delete(id);
  });
}

export async function updateSuperAgentChat(
  id: string,
  patch: {
    title?: string;
    pinned?: boolean;
    activeArtifactId?: string | null;
    permissionMode?: SuperAgentPermissionMode;
    addArtifact?: Partial<SuperAgentArtifact>;
    removeArtifactId?: string;
  },
) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}`, 'PATCH', patch);
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function deleteSuperAgentChat(id: string) {
  chatCache.delete(id);
  inflightChats.delete(id);
  invalidateChatListCache();
  return saRequest<{ deleted: boolean }>(`/chats/${encodeURIComponent(id)}`, 'DELETE');
}

export async function startSuperAgentTurn(id: string, input: SuperAgentTurnInput) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/turn`, 'POST', input);
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function enqueueSuperAgentMessage(id: string, input: SuperAgentTurnInput) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/queue`, 'POST', input);
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function updateSuperAgentQueuedMessage(
  id: string,
  queueId: string,
  patch: Omit<Partial<SuperAgentTurnInput>, 'mode'> & { mode?: SuperAgentModeId | null },
) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(
    `/chats/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}`,
    'PATCH',
    patch,
  );
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function deleteSuperAgentQueuedMessage(id: string, queueId: string) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(
    `/chats/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}`,
    'DELETE',
  );
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function sendSuperAgentQueuedMessageNow(id: string, queueId: string) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(
    `/chats/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}/send`,
    'POST',
    {},
  );
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function stopSuperAgentChat(id: string) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/stop`, 'POST', {});
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export async function approveSuperAgentAction(
  id: string,
  approvalId: string,
  accepted: boolean,
  alwaysAllow = false,
) {
  invalidateChatListCache();
  const res = await saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/approve`, 'POST', {
    approvalId,
    accepted,
    ...(alwaysAllow ? { alwaysAllow: true } : {}),
  });
  if (res?.conversation) seedCachedSuperAgentChat(res.conversation);
  return res;
}

export function subscribeSuperAgentChat(
  id: string,
  onChat: (chat: SuperAgentChat) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`${SUPER_AGENT_API}/chats/${encodeURIComponent(id)}/events`);
  source.addEventListener('chat', event => {
    try {
      const next = JSON.parse((event as MessageEvent).data) as SuperAgentChat;
      seedCachedSuperAgentChat(next);
      onChat(next);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.onerror = () => {
    onError?.();
  };
  return () => source.close();
}

export function superAgentBrowserEndpoint(chatId: string | null | undefined, tabId: string) {
  if (!chatId) {
    return `${SUPER_AGENT_API}/browser/tabs/${encodeURIComponent(tabId)}`;
  }
  return `${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/browser/${encodeURIComponent(tabId)}`;
}

/** Releases the server-side headless browser tab when the viewer closes or deletes a web tab. */
export function closeSuperAgentBrowserTab(chatId: string | null | undefined, tabId: string): Promise<void> {
  return fetch(superAgentBrowserEndpoint(chatId, tabId), { method: 'DELETE' }).then(
    () => undefined,
    () => undefined,
  );
}

/** Uploads a PNG annotation screenshot for a Super Agent conversation and returns its serving URL + workspace path. */
export async function uploadSuperAgentAnnotationImage(
  chatId: string,
  dataUrl: string,
): Promise<{ id: string; screenshotUrl: string; screenshotPath: string }> {
  const response = await fetch(`${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value as { id: string; screenshotUrl: string; screenshotPath: string };
}

/** Captures a server-rendered PNG snapshot of a same-origin Design or Game HTML preview. */
export async function captureSuperAgentPreviewSnapshot(
  chatId: string,
  previewPath: string,
  width?: number,
  height?: number,
): Promise<BrowserScreenshotResult> {
  const response = await fetch(`${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/preview-snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: previewPath,
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
    }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value as BrowserScreenshotResult;
}

function isMediaLibraryCandidate(file: File): boolean {
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) return false;
  if (/^image\/(?:png|jpeg|jpg|webp|gif|avif)$/.test(mime)) return true;
  if (/^(?:video|audio)\//.test(mime)) return true;
  return /\.(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
}

/** Uploads any file: raster images/video/audio go to Asset Library when supported, other files go to general Super Agent uploads. */
export async function uploadSuperAgentFile(file: File): Promise<SuperAgentResourceAttachment> {
  if (isMediaLibraryCandidate(file)) {
    try {
      const asset = await uploadLibraryAsset(file);
      const current = assetVersion(asset);
      return {
        id: asset.id,
        kind: 'asset',
        title: asset.name,
        subtitle: current?.model || current?.source || asset.modality,
        modality: asset.modality,
        versionId: asset.currentVersionId,
        previewUrl: assetMediaUrl(asset.id, asset.currentVersionId),
      };
    } catch (error) {
      if (error instanceof AssetUploadError && (error.reason === 'size' || error.reason === 'unreadable')) {
        throw error;
      }
      // Fall through to general file upload when media library doesn't accept this file variant
    }
  }

  if (!file.size) {
    throw new Error('Uploaded file cannot be empty');
  }
  const response = await fetch(`${SUPER_AGENT_API}/uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'uploaded-file.txt'),
    },
    body: file,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.attachment) {
    throw new Error(value?.error || `HTTP ${response.status}`);
  }
  return value.attachment as SuperAgentResourceAttachment;
}

export async function fetchSuperAgentWorkspaceFiles(params: {
  chatId?: string | null;
  workingDir?: string;
  query?: string;
  limit?: number;
} = {}): Promise<SuperAgentResourceAttachment[]> {
  const sp = new URLSearchParams();
  if (params.chatId) sp.set('chatId', params.chatId);
  if (params.workingDir?.trim()) sp.set('workingDir', params.workingDir.trim());
  if (params.query?.trim()) sp.set('query', params.query.trim());
  if (typeof params.limit === 'number') sp.set('limit', String(params.limit));
  const qs = sp.toString();
  const data = await saRequest<{ items: SuperAgentResourceAttachment[] }>(`/files${qs ? `?${qs}` : ''}`);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function readSuperAgentFileContent(params: {
  chatId?: string | null;
  workingDir?: string;
  rootKey?: string;
  path?: string;
  uploadId?: string;
}): Promise<{
  path: string;
  content?: string;
  binary: boolean;
  sizeBytes: number;
  mimeType: string;
  previewUrl?: string;
}> {
  if (params.rootKey === 'upload' && params.uploadId) {
    return saRequest(`${`/uploads/${encodeURIComponent(params.uploadId)}?format=json`}`);
  }
  const sp = new URLSearchParams();
  if (params.chatId) sp.set('chatId', params.chatId);
  if (params.workingDir?.trim()) sp.set('workingDir', params.workingDir.trim());
  if (params.rootKey) sp.set('rootKey', params.rootKey);
  if (params.path) sp.set('path', params.path);
  return saRequest(`/file-content?${sp.toString()}`);
}

export async function compactSuperAgentChat(chatId: string): Promise<{
  conversation: SuperAgentChat;
  compactedCount: number;
  summary: string;
}> {
  const result = await saRequest<{
    conversation: SuperAgentChat;
    compactedCount: number;
    summary: string;
  }>(`/chats/${encodeURIComponent(chatId)}/compact`, 'POST', {});
  if (result?.conversation) {
    seedCachedSuperAgentChat(result.conversation);
  }
  return result;
}

export function superAgentSessionExportUrl(chatId: string): string {
  return `${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/export`;
}

export async function submitSuperAgentFeedback(input: {
  chatId?: string | null;
  turnId?: string;
  rating?: 'positive' | 'negative' | 'note' | 'clear';
  reasons?: SuperAgentFeedbackReason[];
  note?: string;
  scene?: SuperAgentFeedbackScene;
  artifactKind?: string;
  action?: SuperAgentTurnFeedbackAction;
  includeLogs?: boolean;
}): Promise<{ id: string; createdAt: number; filePath: string; turnFeedback?: SuperAgentTurnFeedback | null }> {
  const result = await saRequest<{ id: string; createdAt: number; filePath: string; turnFeedback?: SuperAgentTurnFeedback | null }>('/feedback', 'POST', {
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    rating: input.rating ?? 'note',
    ...(input.reasons?.length ? { reasons: input.reasons } : {}),
    note: input.note ?? '',
    ...(input.scene ? { scene: input.scene } : {}),
    ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.includeLogs !== undefined ? { includeLogs: input.includeLogs } : input.turnId ? {} : { includeLogs: true }),
  });
  if (input.chatId && input.turnId) {
    chatCache.delete(input.chatId);
  }
  return result;
}
