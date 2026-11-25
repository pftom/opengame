import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignComment, DesignEditorApp, DesignProjectDetail, DesignVersion } from '../../../shared/design-project';
import { useVisibilityPolling } from '../hooks/useVisibilityPolling';
import { designClient } from './designClient';

export type DesignProjectState = {
  project: DesignProjectDetail | null;
  versions: DesignVersion[];
  currentVersionId: string | null;
  comments: DesignComment[];
  editors: DesignEditorApp[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setProject: (next: DesignProjectDetail) => void;
  setComments: (next: DesignComment[]) => void;
};

/**
 * Loads a Design Studio project and polls its lightweight state endpoint while visible
 * so external Agent writes via MCP automatically refresh the preview, files and comments.
 */
export function useDesignProject(projectId: string): DesignProjectState {
  const [project, setProject] = useState<DesignProjectDetail | null>(null);
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [comments, setComments] = useState<DesignComment[]>([]);
  const [editors, setEditors] = useState<DesignEditorApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const revRef = useRef<string | null>(null);
  const versionRef = useRef<string | null>(null);
  const commentsCountRef = useRef<number | null>(null);

  const applyProject = useCallback((next: DesignProjectDetail) => {
    revRef.current = next.revision;
    versionRef.current = next.versionId;
    commentsCountRef.current = next.openComments;
    setProject(next);
  }, []);

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [{ project: detail }, verRes, comRes] = await Promise.all([
        designClient.getProject(projectId),
        designClient.listVersions(projectId).catch(() => ({ versions: [] as DesignVersion[], currentVersionId: null })),
        designClient.listComments(projectId).catch(() => ({ comments: [] as DesignComment[] })),
      ]);
      applyProject(detail);
      setVersions(Array.isArray(verRes?.versions) ? verRes.versions : []);
      setComments(Array.isArray(comRes?.comments) ? comRes.comments : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load design project');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, applyProject]);

  useEffect(() => {
    void loadAll(false);
    designClient.detectEditors().then(res => setEditors(res.editors)).catch(() => setEditors([]));
  }, [loadAll]);

  useVisibilityPolling(
    async signal => {
      const state = await designClient.getState(projectId);
      if (signal.aborted) return;
      if (state.revision !== revRef.current || state.versionId !== versionRef.current || state.openComments !== commentsCountRef.current) {
        await loadAll(true);
      }
    },
    { enabled: Boolean(projectId), intervalMs: 2500, immediate: false, resetKey: projectId },
  );

  return {
    project, versions, currentVersionId: project?.versionId ?? null, comments, editors, loading, error,
    refresh: () => loadAll(true),
    setProject: applyProject,
    setComments,
  };
}
