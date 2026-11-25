import {
  designRoutes,
  type DesignComment, type DesignCommentAnchor, type DesignDeployMode,
  type DesignDeploymentRecord, type DesignDeployStatusResponse, type DesignEditorApp,
  type DesignExportFormat, type DesignProject, type DesignProjectDetail, type DesignScenarioId,
  type DesignSkillSummary, type DesignSystemSummary, type DesignTemplateSummary,
  type DesignVersion,
} from '../../../shared/design-project';
import { isClientCacheEnabled } from '../utils/clientCacheMode';

export class DesignApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function makeRequestId(prefix = 'design') {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readCommentPreviewSlideIndex(response: Response): number | undefined {
  const header = response.headers.get('X-OpenMotion-Slide-Index');
  const index = header === null ? NaN : Number(header);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let code = 'REQUEST_FAILED';
    let message = `Request failed (${res.status})`;
    try {
      const payload = await res.json();
      if (payload?.error?.code) code = String(payload.error.code);
      if (payload?.error?.message) message = String(payload.error.message);
      else if (typeof payload?.error === 'string') message = payload.error;
    } catch { /* non-JSON error body */ }
    throw new DesignApiError(code, message, res.status);
  }
  return res.json() as Promise<T>;
}

export type DesignScenarioCatalogEntry = {
  id: DesignScenarioId; label: string; icon: string; hint: string; mode: string; entry: string;
  examples: readonly string[]; guide: string;
};

export type DesignTemplatesResponse = { items: DesignTemplateSummary[]; nextCursor: string | null };
export type DesignSkillsResponse = { skills: DesignSkillSummary[] };

const DESIGN_CATALOG_CACHE_TTL_MS = 60_000;
const designTemplatesCache = new Map<string, { value: DesignTemplatesResponse; expiresAt: number }>();
const inflightDesignTemplates = new Map<string, Promise<DesignTemplatesResponse>>();
const designSkillsCache = new Map<string, { value: DesignSkillsResponse; expiresAt: number }>();
const inflightDesignSkills = new Map<string, Promise<DesignSkillsResponse>>();

function designTemplatesKey(params: { scenario?: string; q?: string; limit?: number; cursor?: string } = {}): string {
  return JSON.stringify([params.scenario ?? null, params.q?.trim() || null, params.limit ?? null, params.cursor ?? null]);
}

function designSkillsKey(params: { scenario?: string; q?: string } = {}): string {
  return JSON.stringify([params.scenario ?? null, params.q?.trim() || null]);
}

export function peekCachedDesignTemplates(params: { scenario?: string; q?: string; limit?: number; cursor?: string } = {}): DesignTemplatesResponse | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return designTemplatesCache.get(designTemplatesKey(params))?.value;
}

export function peekCachedDesignSkills(params: { scenario?: string; q?: string } = {}): DesignSkillSummary[] | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return designSkillsCache.get(designSkillsKey(params))?.value.skills;
}

export function clearDesignCatalogCache(): void {
  designTemplatesCache.clear();
  inflightDesignTemplates.clear();
  designSkillsCache.clear();
  inflightDesignSkills.clear();
}

export function prefetchDesignScene(scenario?: string): void {
  if (!isClientCacheEnabled()) return;
  const tplParams = { scenario: scenario ?? 'prototype', limit: 24 };
  const tplCached = designTemplatesCache.get(designTemplatesKey(tplParams));
  if (!tplCached || tplCached.expiresAt <= Date.now()) {
    void designClient.listTemplates(tplParams).catch(() => {});
  }
  const skillCached = designSkillsCache.get(designSkillsKey());
  if (!skillCached || skillCached.expiresAt <= Date.now()) {
    void designClient.listSkills().catch(() => {});
  }
}

export const designClient = {
  // Catalog
  listScenarios: () => requestJson<{ scenarios: DesignScenarioCatalogEntry[] }>(designRoutes.catalogScenarios),
  listTemplates: (params: { scenario?: string; q?: string; limit?: number; cursor?: string } = {}) => {
    const key = designTemplatesKey(params);
    if (isClientCacheEnabled()) {
      const cached = designTemplatesCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.value);
      }
    }
    const pending = inflightDesignTemplates.get(key);
    if (pending) return pending;

    const search = new URLSearchParams();
    if (params.scenario) search.set('scenario', params.scenario);
    if (params.q) search.set('q', params.q);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cursor) search.set('cursor', params.cursor);
    const qs = search.toString();
    const run = requestJson<DesignTemplatesResponse>(`${designRoutes.catalogTemplates}${qs ? `?${qs}` : ''}`).then(res => {
      if (isClientCacheEnabled()) {
        designTemplatesCache.set(key, { value: res, expiresAt: Date.now() + DESIGN_CATALOG_CACHE_TTL_MS });
      }
      return res;
    });
    inflightDesignTemplates.set(key, run);
    return run.finally(() => {
      if (inflightDesignTemplates.get(key) === run) inflightDesignTemplates.delete(key);
    });
  },
  listSystems: (params: { q?: string; category?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.category) search.set('category', params.category);
    const qs = search.toString();
    return requestJson<{ systems: DesignSystemSummary[] }>(`${designRoutes.catalogSystems}${qs ? `?${qs}` : ''}`);
  },
  listSkills: (params: { scenario?: string; q?: string } = {}) => {
    const key = designSkillsKey(params);
    if (isClientCacheEnabled()) {
      const cached = designSkillsCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.value);
      }
    }
    const pending = inflightDesignSkills.get(key);
    if (pending) return pending;

    const search = new URLSearchParams();
    if (params.scenario) search.set('scenario', params.scenario);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    const run = requestJson<DesignSkillsResponse>(`${designRoutes.catalogSkills}${qs ? `?${qs}` : ''}`).then(res => {
      if (isClientCacheEnabled()) {
        designSkillsCache.set(key, { value: res, expiresAt: Date.now() + DESIGN_CATALOG_CACHE_TTL_MS });
      }
      return res;
    });
    inflightDesignSkills.set(key, run);
    return run.finally(() => {
      if (inflightDesignSkills.get(key) === run) inflightDesignSkills.delete(key);
    });
  },

  // Projects
  listProjects: (params: { scenario?: string; trashed?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.scenario) search.set('scenario', params.scenario);
    if (params.trashed) search.set('trashed', '1');
    const qs = search.toString();
    return requestJson<{ projects: DesignProject[] }>(`${designRoutes.projects}${qs ? `?${qs}` : ''}`);
  },
  createProject: (input: { scenario?: DesignScenarioId; title?: string; templateId?: string | null; designSystemId?: string | null; requestId?: string }) =>
    requestJson<{ project: DesignProjectDetail }>(designRoutes.projects, {
      method: 'POST',
      body: JSON.stringify({ ...input, requestId: input.requestId ?? makeRequestId('create') }),
    }),
  getProject: (id: string) => requestJson<{ project: DesignProjectDetail }>(designRoutes.project(id)),
  getState: (id: string) => requestJson<{ revision: string; versionId: string | null; openComments: number; updatedAt: number }>(designRoutes.events(id)),
  renameProject: (id: string, title: string, expectedTitle?: string) =>
    requestJson<{ project: DesignProjectDetail }>(designRoutes.project(id), {
      method: 'PATCH',
      body: JSON.stringify({ title, expectedTitle, requestId: makeRequestId('rename') }),
    }),
  duplicateProject: (id: string, title?: string) =>
    requestJson<{ project: DesignProjectDetail }>(designRoutes.projectAction(id, 'duplicate'), {
      method: 'POST',
      body: JSON.stringify({ title, requestId: makeRequestId('dup') }),
    }),
  trashProject: (id: string) =>
    requestJson<{ project: DesignProjectDetail }>(designRoutes.projectAction(id, 'trash'), {
      method: 'POST',
      body: JSON.stringify({ requestId: makeRequestId('trash') }),
    }),
  restoreProject: (id: string) =>
    requestJson<{ project: DesignProjectDetail }>(designRoutes.projectAction(id, 'restore'), {
      method: 'POST',
      body: JSON.stringify({ requestId: makeRequestId('restore') }),
    }),
  deleteProject: (id: string) =>
    requestJson<{ deletedId: string }>(`${designRoutes.project(id)}?requestId=${encodeURIComponent(makeRequestId('del'))}`, { method: 'DELETE' }),

  // Files & Versions
  readFile: (id: string, path: string, offset = 0) =>
    requestJson<{ path: string; content: string; revision: string; size: number; nextOffset: number | null }>(
      `${designRoutes.file(id, path)}${offset ? `?offset=${offset}` : ''}`,
    ),
  writeFiles: (id: string, input: { expectedRevision: string; files: { path: string; content: string }[]; deletes?: string[]; summary?: string; source?: 'manual' | 'agent'; requestId?: string }) =>
    requestJson<{ project: DesignProjectDetail; version: DesignVersion }>(designRoutes.write(id), {
      method: 'POST',
      body: JSON.stringify({ ...input, source: input.source ?? 'manual', requestId: input.requestId ?? makeRequestId('write') }),
    }),
  importAsset: (id: string, input: { expectedRevision: string; assetId: string; versionId: string; path?: string; requestId?: string }) =>
    requestJson<{ project: DesignProjectDetail; version: DesignVersion; path: string }>(designRoutes.importAsset(id), {
      method: 'POST',
      body: JSON.stringify({ ...input, requestId: input.requestId ?? makeRequestId('import-asset') }),
    }),
  listVersions: (id: string, cursor?: string) =>
    requestJson<{ versions: DesignVersion[]; currentVersionId: string | null; nextCursor: string | null }>(
      `${designRoutes.versions(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  restoreVersion: (id: string, versionId: string, expectedRevision: string) =>
    requestJson<{ project: DesignProjectDetail; version: DesignVersion; changed: boolean }>(designRoutes.restore(id, versionId), {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, requestId: makeRequestId('restore-ver') }),
    }),

  // Comments
  listComments: (id: string) => requestJson<{ comments: DesignComment[]; sourceRevision: string }>(designRoutes.comments(id)),
  getCommentPreviewSlideIndex: async (projectId: string, commentId: string) => {
    const response = await fetch(designRoutes.commentPreview(projectId, commentId), { method: 'HEAD', cache: 'no-store' });
    return response.ok ? readCommentPreviewSlideIndex(response) : undefined;
  },
  createComment: (id: string, input: { text: string; anchor: DesignCommentAnchor; expectedRevision: string; requestId?: string }) =>
    requestJson<{ comment: DesignComment; comments: DesignComment[] }>(designRoutes.comments(id), {
      method: 'POST',
      body: JSON.stringify({ ...input, requestId: input.requestId ?? makeRequestId('comment') }),
    }),
  updateComment: (id: string, commentId: string, input: { status?: 'open' | 'resolved'; text?: string; expectedCommentRevision: number }) =>
    requestJson<{ comment: DesignComment }>(designRoutes.comment(id, commentId), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteComment: (id: string, commentId: string) =>
    requestJson<{ deletedId: string }>(designRoutes.comment(id, commentId), { method: 'DELETE' }),

  // Export, Import, Editors
  downloadExport: async (id: string, input: { format: DesignExportFormat; versionId?: string | null; filePath?: string | null }) => {
    const res = await fetch(designRoutes.exportProject(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      let code = 'EXPORT_FAILED', message = `Export failed (${res.status})`;
      try { const p = await res.json(); code = p?.error?.code ?? code; message = p?.error?.message ?? message; } catch {}
      throw new DesignApiError(code, message, res.status);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/i.exec(disposition);
    const filename = match?.[1] ?? `design.${input.format === 'open-design' ? 'zip' : input.format}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  },
  importZipFile: async (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return requestJson<{ projects: DesignProjectDetail[] }>(designRoutes.importProjects, { method: 'POST', body: form });
  },
  detectEditors: () => requestJson<{ editors: DesignEditorApp[] }>(designRoutes.editors),
  openIn: (id: string, editorId: string) =>
    requestJson<{ ok: true }>(designRoutes.projectAction(id, 'open-in'), {
      method: 'POST',
      body: JSON.stringify({ editorId }),
    }),
  getDeployment: (id: string, options?: { filePath?: string; refresh?: boolean }) => {
    const query = new URLSearchParams();
    if (options?.filePath) query.set('filePath', options.filePath);
    if (options?.refresh) query.set('refresh', '1');
    const suffix = query.toString();
    return requestJson<DesignDeployStatusResponse>(
      suffix ? `${designRoutes.deploy(id)}?${suffix}` : designRoutes.deploy(id),
    );
  },
  deployProject: (
    id: string,
    payload: { filePath?: string; workspaceId?: string; deployMode?: DesignDeployMode; name?: string } = {},
  ) =>
    requestJson<{
      deployment: DesignDeploymentRecord;
      url: string | null;
      updated: boolean;
    }>(designRoutes.deploy(id), {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  unpublishProject: (id: string, payload: { filePath?: string } = {}) =>
    requestJson<{ deployment: DesignDeploymentRecord }>(
      designRoutes.deploy(id),
      {
        method: 'DELETE',
        body: JSON.stringify(payload),
      },
    ),
};
