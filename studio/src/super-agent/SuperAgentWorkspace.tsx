import { Dialog } from '@base-ui/react/dialog';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { Suspense, useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { LOCAL_DIRECT_RUNTIME_ID, type AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import { pickPreferredLocalAgent } from '../../../shared/local-agents';
import { assetMediaUrl } from '../../../shared/asset-library';
import type { SuperAgentHandoffPayload } from '../../../shared/capability-hub';
import { designRoutes } from '../../../shared/design-project';
import type { GameCard } from '../../../shared/game-contract';
import type { ProviderSetupEntry } from '../../../shared/workspace-url';
import {
  NEW_VIEWER_TAB_ID,
  SUPER_AGENT_API,
  safeBrowserTabId,
  summarizeSuperAgentChat,
  type SuperAgentActionCard,
  type SuperAgentArtifact,
  type SuperAgentChat,
  type SuperAgentDesignModuleId,
  type SuperAgentChatSummary,
  type SuperAgentContextTag,
  type SuperAgentFileOperation,
  type SuperAgentFollowUpMode,
  type SuperAgentIntent,
  type SuperAgentPermissionMode,
  type SuperAgentPromptSegment,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCatalog,
} from '../../../shared/super-agent';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { RouteSurfaceFallback } from '../motion/RouteSurfaceFallback';
import { consumeSuperAgentHandoff, queueSuperAgentHandoff, subscribeSuperAgentHandoff } from '../motion/superAgentHandoff';
import { readSuperAgentPromptLink, withoutSuperAgentPromptLink } from './superAgentPromptLink';
import { bundledGames, communityGames, gameApi } from '../motion/game/gameCatalog';
import { isMultiplayerGameArtifact, localizedGameTitle, toGameArtifact, toGameResourceAttachment } from '../motion/game/gameSuperAgent';
import { gatewayRequest } from '../motion/gatewayClient';
import { openAgentRuntimesSettings, useAgentRuntimes } from '../motion/useAgentRuntimes';
import { notifyAgentsChanged, useLocalAgents } from '../motion/useLocalAgents';
import { preloadableLazyWithChunkReload } from '../utils/chunkReload';
import { savedPermissionMode, savePermissionMode, useFollowUpBehavior } from '../utils/superAgentPreferences';
import { ConversationSidebar } from './ConversationSidebar';
import { useReadTaskResults } from './useReadTaskResults';
import type { ComposerCommandId } from './ComposerMentionMenu';
import { ConversationStream, type AgentSelection } from './ConversationStream';
import type { SuperAgentCreationModeId } from './ModeResourceShowcase';
import { resourceKey } from './ResourcePickerDialog';
import {
  approveSuperAgentAction,
  closeSuperAgentBrowserTab,
  compactSuperAgentChat,
  createSuperAgentChat,
  deleteSuperAgentChat,
  deleteSuperAgentQueuedMessage,
  enqueueSuperAgentMessage,
  fetchWorkspaceResources,
  getSuperAgentChat,
  listSuperAgentChats,
  peekCachedSuperAgentChat,
  peekCachedSuperAgentChatList,
  peekCachedWorkspaceResources,
  prefetchSuperAgentChat,
  seedCachedSuperAgentChat,
  sendSuperAgentQueuedMessageNow,
  startSuperAgentTurn,
  stopSuperAgentChat,
  submitSuperAgentFeedback,
  subscribeSuperAgentChat,
  superAgentSessionExportUrl,
  updateSuperAgentChat,
  updateSuperAgentQueuedMessage,
} from './superAgentClient';
import './superAgent.css';

function modeChatIntent(mode?: SuperAgentCreationModeId | null): SuperAgentIntent | undefined {
  if (mode === 'game') return 'game';
  if (mode === 'design') return 'design';
  if (mode === 'research') return 'research';
  if (mode === 'visualization') return 'visualization';
  if (mode === 'motion' || mode === 'media') return 'video';
  return undefined;
}

function presentChatArtifacts(artifacts: SuperAgentArtifact[]) {
  const motionExports = artifacts.filter((item): item is SuperAgentArtifact & { projectId: string } =>
    item.kind === 'motion-export' && Boolean(item.projectId && item.downloadUrl));
  const latestByProject = new Map<string, SuperAgentArtifact>();
  for (const item of motionExports) {
    const latest = latestByProject.get(item.projectId);
    if (!latest || (item.exportRequestedAt ?? item.createdAt) >= (latest.exportRequestedAt ?? latest.createdAt)) {
      latestByProject.set(item.projectId, item);
    }
  }
  const replaced = new Map<string, string>();
  for (const item of motionExports) {
    const latest = latestByProject.get(item.projectId);
    if (latest && latest.id !== item.id) replaced.set(item.id, latest.id);
  }
  return {
    artifacts: replaced.size ? artifacts.filter(item => !replaced.has(item.id)) : artifacts,
    replaced,
  };
}

const ArtifactBrowserPane = preloadableLazyWithChunkReload(() =>
  import('./ArtifactBrowserPane').then(m => ({ default: m.ArtifactBrowserPane })),
);

export const preloadArtifactBrowserPane = ArtifactBrowserPane.preload;

const MIN_CENTER_WIDTH = 300;
const MIN_VIEWER_WIDTH = 320;
const RESIZER_SIZE = 1;
const COMPACT_THREE_PANE_WIDTH = 1180;
const COMPACT_STAGE_THREE_PANE_WIDTH = 1440;
const MIN_STACKED_CHAT_HEIGHT = 220;
const MIN_STACKED_VIEWER_HEIGHT = 160;
const STACKED_MOTION_EDITOR_HEIGHT = 480;

export function clampSuperAgentViewerWidth(
  desiredWidth: number,
  totalWidth: number,
  sidebarWidth: number,
): number {
  const desired = Math.round(desiredWidth);
  if (totalWidth <= 0) {
    return Math.max(MIN_VIEWER_WIDTH, Math.min(960, desired));
  }
  const available = Math.max(0, Math.floor(totalWidth - sidebarWidth - RESIZER_SIZE));
  if (available <= MIN_CENTER_WIDTH + MIN_VIEWER_WIDTH) {
    return Math.max(240, Math.floor(available * 0.55));
  }
  const maxViewer = Math.max(
    MIN_VIEWER_WIDTH,
    Math.min(Math.floor(available * 0.72), available - MIN_CENTER_WIDTH),
  );
  return Math.max(MIN_VIEWER_WIDTH, Math.min(maxViewer, desired));
}

export function stackedArtifactViewerHeight(totalHeight: number, preferredHeight: number | null, motionEditor = false) {
  const available = Math.max(0, totalHeight - RESIZER_SIZE);
  // On short screens, let both panes share the available height.
  const min = Math.min(MIN_STACKED_VIEWER_HEIGHT, Math.floor(available * 0.35));
  const max = available - Math.min(MIN_STACKED_CHAT_HEIGHT, Math.floor(available * 0.58));
  const defaultHeight = Math.max(available * 0.52, motionEditor ? STACKED_MOTION_EDITOR_HEIGHT : 0);
  const value = Math.max(min, Math.min(max, Math.round(preferredHeight ?? defaultHeight)));
  return { min, max, value };
}

function upsertSummary(list: SuperAgentChatSummary[], chat: SuperAgentChat): SuperAgentChatSummary[] {
  const next = list.filter(item => item.id !== chat.id);
  next.push(summarizeSuperAgentChat(chat));
  next.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  return next;
}

function isTaskInProgress({ state }: SuperAgentChatSummary): boolean {
  return state === 'running' || state === 'waiting';
}

function resourceToArtifactPatch(
  item: SuperAgentResourceAttachment,
): Partial<SuperAgentArtifact> | null {
  if (item.kind === 'design-project') {
    return {
      id: `design:${item.id}`,
      kind: 'design-project',
      title: item.title,
      subtitle: item.subtitle,
      projectId: item.id,
      scenario: item.scenario,
      entry: 'index.html',
      url: item.previewUrl || designRoutes.raw(item.id, 'index.html'),
    };
  }
  if (item.kind === 'motion-project') {
    return {
      id: `motion:${item.id}`,
      kind: 'motion-project',
      title: item.title,
      subtitle: item.subtitle || 'Motion Studio',
      projectId: item.id,
    };
  }
  if (item.kind === 'asset' && item.versionId) {
    const kind = item.modality === 'video' ? 'asset-video' : item.modality === 'audio' ? 'asset-audio' : 'asset-image';
    const url = assetMediaUrl(item.id, item.versionId);
    return {
      id: `asset:${item.id}:${item.versionId}`,
      kind,
      title: item.title,
      subtitle: item.subtitle,
      assetId: item.id,
      versionId: item.versionId,
      url,
      downloadUrl: `${url}?download=1`,
    };
  }
  if (item.kind === 'brand-kit') {
    return {
      id: `brand:${item.id}`,
      kind: 'brand-kit',
      title: item.title,
      subtitle: item.subtitle,
      kitId: item.id,
    };
  }
  if (item.kind === 'game-project') {
    return {
      id: `game:${item.id}`,
      kind: 'game-project',
      title: item.title,
      subtitle: item.subtitle || 'Game Studio',
      playableAd: item.playableAd,
      projectId: item.id,
      url: `/motion-api/games/${encodeURIComponent(item.id)}/play/index.html`,
    };
  }
  if (item.kind === 'file' && (item.filePath || item.rootKey === 'upload')) {
    const uploadId = item.rootKey === 'upload' ? item.id : undefined;
    const url = uploadId ? `${SUPER_AGENT_API}/uploads/${encodeURIComponent(uploadId)}` : item.previewUrl;
    return {
      id: `file:${item.id}`,
      kind: 'workspace-file',
      title: item.title,
      subtitle: item.filePath || item.subtitle,
      ...(uploadId ? { projectId: uploadId } : {}),
      ...(item.filePath ? { filePath: item.filePath } : {}),
      ...(item.rootKey ? { rootKey: item.rootKey } : {}),
      ...(typeof item.sizeBytes === 'number' ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(url ? { url, downloadUrl: `${url}${url.includes('?') ? '&' : '?'}download=1` } : {}),
    };
  }
  return null;
}

function artifactToResourceAttachment(artifact: SuperAgentArtifact): SuperAgentResourceAttachment | null {
  if (artifact.kind === 'workspace-file') {
    return {
      id: artifact.id.startsWith('file:') ? artifact.id.slice('file:'.length) : artifact.id,
      kind: 'file',
      title: artifact.title,
      subtitle: artifact.subtitle || artifact.filePath,
      filePath: artifact.filePath,
      rootKey: artifact.rootKey,
      artifactId: artifact.id,
      sizeBytes: artifact.sizeBytes,
      mimeType: artifact.mimeType,
      previewUrl: artifact.url,
    };
  }
  if (artifact.assetId && (artifact.kind === 'asset-image' || artifact.kind === 'asset-video' || artifact.kind === 'asset-audio')) {
    return {
      id: artifact.assetId,
      kind: 'asset',
      title: artifact.title,
      subtitle: artifact.subtitle,
      modality: artifact.kind === 'asset-video' ? 'video' : artifact.kind === 'asset-audio' ? 'audio' : 'image',
      versionId: artifact.versionId,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'brand-kit' && artifact.kitId) {
    return {
      id: artifact.kitId,
      kind: 'brand-kit',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'design-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'design-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
      scenario: artifact.scenario,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'motion-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'motion-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'game-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'game-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
      playableAd: artifact.playableAd,
    };
  }
  return null;
}

export function SuperAgentWorkspace({
  active,
  chatId,
  requestedMode = null,
  requestedDesignModule = null,
  requestedGameId = null,
  onBack,
  onChangeRequestedMode,
  onChatIdChange,
  onOpenDesignProject,
  onOpenMotionProject,
  onOpenGameStudio,
  onOpenAsset,
  onOpenBrandKit,
  onOpenAgentSettings,
  onOpenModelSettings,
  onOpenProviderSettings,
  onOpenAccountSettings,
  onOpenMcp,
}: {
  active: boolean;
  chatId: string | null;
  requestedMode?: SuperAgentCreationModeId | null;
  requestedDesignModule?: SuperAgentDesignModuleId | null;
  requestedGameId?: string | null;
  onBack?: () => void;
  onChangeRequestedMode?: (mode: SuperAgentCreationModeId | null) => void;
  onChatIdChange: (id: string | null, replace?: boolean) => void;
  onOpenDesignProject: (projectId: string) => void;
  onOpenMotionProject: (projectId: string) => void;
  onOpenGameStudio?: (gameId?: string) => void;
  onOpenAsset: (assetId: string, versionId?: string) => void;
  onOpenBrandKit: (kitId?: string) => void;
  onOpenAgentSettings: () => void;
  onOpenModelSettings?: () => void;
  onOpenProviderSettings?: (provider?: string, entryFrom?: ProviderSetupEntry) => void;
  onOpenAccountSettings?: () => void;
  onOpenMcp: () => void;
}) {
  const { t, locale } = useI18n();
  const { toasts, showToast, dismissToast } = useToast();
  const { data: agentDir, refresh: refreshAgents } = useLocalAgents();
  const { data: runtimesDir, refresh: refreshRuntimes } = useAgentRuntimes();
  const agents = agentDir?.agents ?? [];

  const availableRuntimes = useMemo<AgentRuntimeInfo[]>(() => {
    if (runtimesDir?.runtimes) {
      return runtimesDir.runtimes.map(rt =>
        rt.kind === 'local-direct' && agents.length > 0
          ? {
              ...rt,
              agents,
              runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
            }
          : rt,
      );
    }
    return [
      {
        id: LOCAL_DIRECT_RUNTIME_ID,
        kind: 'local-direct',
        name: 'This computer',
        status: 'online',
        agents,
        runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
      },
    ];
  }, [runtimesDir, agents]);

  const initialCachedConversations = peekCachedSuperAgentChatList();
  const initialCachedChat = chatId ? peekCachedSuperAgentChat(chatId) ?? null : null;
  const [conversations, setConversations] = useState<SuperAgentChatSummary[]>(() => initialCachedConversations ?? []);
  const [loadingList, setLoadingList] = useState(() => Boolean(active) && !initialCachedConversations);
  const hasLoadedListRef = useRef(Boolean(initialCachedConversations));
  const lastActivationRefreshRef = useRef(0);
  const [activeChat, setActiveChat] = useState<SuperAgentChat | null>(initialCachedChat);
  const [loadingChat, setLoadingChat] = useState(() => Boolean(active && chatId && !initialCachedChat));
  const [loadFailed, setLoadFailed] = useState(false);
  const [chatRetry, setChatRetry] = useState(0);
  const [sending, setSending] = useState(false);

  const [resourcesCatalog, setResourcesCatalog] = useState<SuperAgentResourceCatalog | null>(() =>
    peekCachedWorkspaceResources({ limit: 48 }) ?? null,
  );
  const [attachments, setAttachments] = useState<SuperAgentResourceAttachment[]>([]);
  const [draftSeed, setDraftSeed] = useState<{
    id: number;
    text: string;
    hiddenInstructions?: string;
    contextTags?: SuperAgentContextTag[];
    mode?: SuperAgentCreationModeId;
    designModule?: SuperAgentDesignModuleId;
  } | null>(null);
  const [gameTemplateSeed, setGameTemplateSeed] = useState<{ id: number; game: GameCard } | null>(null);
  const playedGamesRef = useRef<Map<string, GameCard>>(new Map());
  const handoffSeqRef = useRef(0);
  const [pendingAutoSend, setPendingAutoSend] = useState<{ id: number; payload: SuperAgentHandoffPayload } | null>(null);
  const dispatchedHandoffIdsRef = useRef<Set<number>>(new Set());

  const [selection, setSelection] = useState<AgentSelection>({
    engine: 'antigravity',
    model: 'default',
    reasoning: 'default',
  });
  const userPickedEngineRef = useRef(false);
  const preflightCheckedRef = useRef(false);
  const [permissionMode, setPermissionMode] = useState<SuperAgentPermissionMode>(() => savedPermissionMode());
  const [followUpBehavior] = useFollowUpBehavior();

  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : false,
  );
  const [{ width: containerWidth, height: containerHeight }, setContainerSize] = useState({ width: 0, height: 0 });
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const viewerPaneId = useId();
  const [viewerWidth, setViewerWidth] = useState<number | null>(null);
  const [viewerHeight, setViewerHeight] = useState<number | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>(NEW_VIEWER_TAB_ID);
  const [previewArtifacts, setPreviewArtifacts] = useState<SuperAgentArtifact[]>([]);
  const previewArtifactIdsRef = useRef<Set<string>>(new Set());
  const chatArtifacts = useMemo(() => presentChatArtifacts(activeChat?.artifacts ?? []), [activeChat?.artifacts]);
  const presentedChat = useMemo(() => activeChat && chatArtifacts.replaced.size
    ? { ...activeChat, artifacts: chatArtifacts.artifacts }
    : activeChat, [activeChat, chatArtifacts]);
  const viewerArtifacts = useMemo(() => {
    if (!previewArtifacts.length) return chatArtifacts.artifacts;
    const existingIds = new Set(chatArtifacts.artifacts.map(item => item.id));
    const extras = previewArtifacts.filter(item => !existingIds.has(item.id));
    return extras.length ? [...chatArtifacts.artifacts, ...extras] : chatArtifacts.artifacts;
  }, [chatArtifacts.artifacts, previewArtifacts]);
  const [pendingDeployArtifactId, setPendingDeployArtifactId] = useState<string | null>(null);
  const [pendingCodeFile, setPendingCodeFile] = useState<{ artifactId: string; filePath: string; seq: number } | null>(null);
  const handledRequestedGameRef = useRef<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarDockedRef = useRef(true);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const heightDragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const lastArtifactStateRef = useRef<{
    chatId: string | null;
    activeId?: string;
    sig: string;
    artifactIds: string[];
    presentedById: Record<string, number>;
  }>({
    chatId: null,
    sig: '',
    artifactIds: [],
    presentedById: {},
  });
  const prevBusyRef = useRef(false);

  const currentViewerArtifact = useMemo(
    () => (activeTabId !== NEW_VIEWER_TAB_ID ? viewerArtifacts.find(item => item.id === activeTabId) ?? null : null),
    [activeTabId, viewerArtifacts],
  );
  const isStageViewerActive = Boolean(
    viewerOpen
    && currentViewerArtifact
    && (
      currentViewerArtifact.kind === 'game-project'
      || currentViewerArtifact.kind === 'design-project'
      || currentViewerArtifact.kind === 'motion-project'
      || currentViewerArtifact.kind === 'motion-export'
      || currentViewerArtifact.kind === 'asset-video'
    ),
  );

  const sidebarAsDrawer = narrow || (
    viewerOpen
    && !viewerExpanded
    && containerWidth > 0
    && containerWidth < (isStageViewerActive ? COMPACT_STAGE_THREE_PANE_WIDTH : COMPACT_THREE_PANE_WIDTH)
  );
  const sidebarDocked = !sidebarAsDrawer && sidebarOpen;
  sidebarDockedRef.current = sidebarDocked;

  const prevSidebarAsDrawerRef = useRef(sidebarAsDrawer);
  useEffect(() => {
    if (sidebarAsDrawer && !prevSidebarAsDrawerRef.current) {
      setSidebarOpen(false);
    }
    prevSidebarAsDrawerRef.current = sidebarAsDrawer;
  }, [sidebarAsDrawer]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      setNarrow(mq.matches);
      if (mq.matches) setSidebarOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let frame: number | null = null;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width > 0) {
        setContainerSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null;
    observer?.observe(el);
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [active]);

  // Proactively run pre-flight connection check for installed Local Agents when Super Agent activates.
  useEffect(() => {
    if (!active || !agentDir || preflightCheckedRef.current) return;
    const hasUncheckedInstalled = agents.some(item => item.installed && !item.checkedAt && !item.connectedAt);
    if (!hasUncheckedInstalled) return;
    preflightCheckedRef.current = true;
    void gatewayRequest('settings/agents/check', 'POST', {})
      .then(() => notifyAgentsChanged())
      .catch(() => { /* keep initial directory if pre-flight check is unavailable */ });
  }, [active, agentDir, agents]);

  // Sync engine/model selection with Settings → Local Agents default (both on initial load and after user changes it)
  const engineInitialized = useRef(false);
  const lastDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!agentDir || !agents.length) return;
    const def = agentDir.default;
    const nextKey = def ? `${def.agent}:${def.model || 'default'}:${def.reasoning || 'default'}` : '__none__';
    const prevKey = lastDefaultKeyRef.current;
    const defaultChangedByUser = prevKey !== null && nextKey !== prevKey;
    lastDefaultKeyRef.current = nextKey;

    if (def && agents.some(item => item.id === def.agent)) {
      const canAdopt = defaultChangedByUser
        || (!userPickedEngineRef.current && (prevKey === null || !activeChat || activeChat.messages.length === 0));
      const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
      if (canAdopt && !busy) {
        engineInitialized.current = true;
        setSelection({
          engine: def.agent,
          model: def.model?.trim() ? def.model : 'default',
          reasoning: def.reasoning?.trim() ? def.reasoning : 'default',
        });
        return;
      }
    }
    if (userPickedEngineRef.current || activeChat) return;
    const preferred = pickPreferredLocalAgent(agents, null);
    if (preferred) {
      engineInitialized.current = true;
      setSelection(prev => (
        prev.engine === preferred.id && prev.model === 'default' && prev.reasoning === 'default'
          ? prev
          : {
              engine: preferred.id,
              model: 'default',
              reasoning: 'default',
            }
      ));
    }
  }, [agentDir, agents, activeChat]);

  const refreshResources = useCallback(() => {
    void fetchWorkspaceResources({ limit: 48 })
      .then(setResourcesCatalog)
      .catch(() => { /* keep previous counts */ });
  }, []);

  const refreshConversations = useCallback(() => {
    if (!hasLoadedListRef.current) setLoadingList(true);
    void listSuperAgentChats()
      .then(result => {
        hasLoadedListRef.current = true;
        setConversations(Array.isArray(result?.conversations) ? result.conversations : []);
      })
      .catch(() => { /* non-blocking sidebar refresh */ })
      .finally(() => setLoadingList(false));
  }, []);

  const backgroundTasks = conversations.filter(item => item.id !== chatId && isTaskInProgress(item));
  const hasBackgroundTask = backgroundTasks.length > 0;
  const getBackgroundTaskIds = useEffectEvent(() => backgroundTasks.map(item => item.id));

  useEffect(() => {
    if (!active || !hasBackgroundTask) return;
    let cancelled = false;
    let timer = window.setTimeout(refreshBackgroundTasks, 2000);

    async function refreshBackgroundTasks() {
      const outcomes = await Promise.allSettled(getBackgroundTaskIds().map(id => getSuperAgentChat(id, { fresh: true })));
      if (cancelled) return;
      const latestById = new Map<string, SuperAgentChat>();
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value?.conversation) {
          const chat = outcome.value.conversation;
          latestById.set(chat.id, chat);
        }
      }
      setConversations(previous => {
        const next = previous.map(item => {
          const latest = latestById.get(item.id);
          return isTaskInProgress(item) && latest && latest.updatedAt >= item.updatedAt && latest.state !== item.state
            ? summarizeSuperAgentChat(latest)
            : item;
        });
        return next.some((item, index) => item !== previous[index]) ? next : previous;
      });
      timer = window.setTimeout(refreshBackgroundTasks, 2000);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, chatId, hasBackgroundTask]);

  useEffect(() => {
    if (!runtimesDir) return;
    const online = runtimesDir.runtimes.filter(item => item.status === 'online');
    if (!online.length) return;
    const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
    if (busy) return;

    const currentValid = selection.runtimeId && online.some(item => item.id === selection.runtimeId);
    if (currentValid) return;

    const preferred =
      (runtimesDir.defaultRuntimeId && online.find(item => item.id === runtimesDir.defaultRuntimeId))
      ?? (!runtimesDir.localDirectAvailable ? online.find(item => item.runnableAgentIds.length > 0) ?? online[0] : undefined);
    if (!preferred) return;

    const firstEngine = preferred.runnableAgentIds[0] ?? preferred.agents[0]?.id ?? selection.engine;
    setSelection({
      runtimeId: preferred.id,
      engine: firstEngine,
      model: 'default',
      reasoning: 'default',
    });
  }, [runtimesDir, activeChat, selection.runtimeId, selection.engine]);

  useEffect(() => {
    if (!active) {
      for (const item of toasts) {
        if (!item.action) dismissToast(item.id);
      }
      return;
    }
    const now = Date.now();
    const stale = lastActivationRefreshRef.current === 0 || now - lastActivationRefreshRef.current > 15_000;
    refreshConversations();
    if (stale) {
      lastActivationRefreshRef.current = now;
      refreshResources();
      refreshAgents();
      refreshRuntimes();
    }
  }, [active, refreshConversations, refreshResources, refreshAgents, refreshRuntimes]);

  // Apply chat snapshot and sync tabs / agent choices
  const applyChatSnapshot = useCallback((next: SuperAgentChat, isInitialLoad = false) => {
    seedCachedSuperAgentChat(next);
    setActiveChat(next);
    setConversations(prev => upsertSummary(prev, next));
    setPermissionMode(next.permissionMode);

    if (isInitialLoad && next.messages.length > 0) {
      setSelection({
        ...(next.runtimeId ? { runtimeId: next.runtimeId } : {}),
        engine: next.engine,
        model: next.model || 'default',
        reasoning: next.reasoning || 'default',
      });
    }

    const { artifacts, replaced } = presentChatArtifacts(next.artifacts);
    const activeId = next.activeArtifactId
      ? replaced.get(next.activeArtifactId) ?? next.activeArtifactId
      : undefined;
    const allIds = artifacts.map(item => item.id);
    const presentedById: Record<string, number> = {};
    for (const item of artifacts) {
      if (typeof item.presentedAt === 'number') {
        presentedById[item.id] = item.presentedAt;
      }
    }
    const sig = artifacts
      .map(item => `${item.id}:${item.revision ?? ''}:${item.presentedAt ?? item.updatedAt}`)
      .join('|');
    const prev = lastArtifactStateRef.current;
    const chatSwitched = prev.chatId !== next.id;
    const switchedBetweenChats = prev.chatId !== null && prev.chatId !== next.id;

    if (switchedBetweenChats) {
      previewArtifactIdsRef.current.clear();
      setPreviewArtifacts([]);
    }

    if (chatSwitched) {
      lastArtifactStateRef.current = {
        chatId: next.id,
        activeId,
        sig,
        artifactIds: allIds,
        presentedById,
      };
      const localIds = switchedBetweenChats
        ? []
        : [...previewArtifactIdsRef.current].filter(id => !allIds.includes(id));
      const mergedOpenIds = [...allIds, ...localIds];
      setOpenTabIds(mergedOpenIds);
      const initialActive = activeId && allIds.includes(activeId)
        ? activeId
        : allIds.at(-1) ?? localIds.at(-1) ?? NEW_VIEWER_TAB_ID;
      setActiveTabId(current => (!switchedBetweenChats && previewArtifactIdsRef.current.has(current) ? current : initialActive));
    } else if (sig !== prev.sig || activeId !== prev.activeId) {
      const newIds = allIds.filter(id => !prev.artifactIds.includes(id));
      const activePresentedAt = activeId ? presentedById[activeId] : undefined;
      const prevActivePresentedAt = activeId ? (prev.presentedById[activeId] ?? 0) : 0;
      const activeRePresented = activePresentedAt !== undefined && activePresentedAt > prevActivePresentedAt;
      const activeChanged = Boolean(activeId && activeId !== prev.activeId);
      const shouldPresent = Boolean(activeId) && (
        activeRePresented
        || activeChanged
        || (activeId ? newIds.includes(activeId) : false)
      );
      lastArtifactStateRef.current = {
        chatId: next.id,
        activeId,
        sig,
        artifactIds: allIds,
        presentedById,
      };
      setOpenTabIds(current => {
        const merged = [...new Set(current.map(id => replaced.get(id) ?? id))]
          .filter(id => allIds.includes(id) || previewArtifactIdsRef.current.has(id));
        for (const id of newIds) {
          if (!merged.includes(id)) merged.push(id);
        }
        if (shouldPresent && activeId && allIds.includes(activeId) && !merged.includes(activeId)) {
          merged.push(activeId);
        }
        return merged;
      });
      if (shouldPresent && activeId) {
        setActiveTabId(activeId);
        setViewerOpen(true);
      } else if (replaced.size) {
        setActiveTabId(current => replaced.get(current) ?? current);
      }
    }

    const busy = next.state === 'running' || next.state === 'waiting';
    if (prevBusyRef.current && !busy) {
      refreshResources();
    }
    prevBusyRef.current = busy;
  }, [refreshResources]);

  // Load selected chat & subscribe to SSE when active
  useEffect(() => {
    if (!active) return;
    if (!chatId) {
      setActiveChat(null);
      setLoadingChat(false);
      setLoadFailed(false);
      if (lastArtifactStateRef.current.chatId !== null) {
        setOpenTabIds([]);
        setActiveTabId(NEW_VIEWER_TAB_ID);
        lastArtifactStateRef.current = { chatId: null, sig: '', artifactIds: [], presentedById: {} };
      }
      return;
    }

    let cancelled = false;
    const cached = chatRetry === 0 ? peekCachedSuperAgentChat(chatId) : undefined;
    if (cached) {
      applyChatSnapshot(cached, true);
      setLoadingChat(false);
    } else {
      setLoadingChat(true);
    }
    setLoadFailed(false);
    void getSuperAgentChat(chatId)
      .then(result => {
        if (!cancelled && result.conversation !== cached) applyChatSnapshot(result.conversation, true);
      })
      .catch(() => {
        if (!cancelled && !cached) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingChat(false);
      });

    let resyncTimer: number | null = null;
    const resyncChat = () => {
      if (cancelled) return;
      void getSuperAgentChat(chatId)
        .then(result => {
          if (!cancelled) applyChatSnapshot(result.conversation, false);
        })
        .catch(() => { /* keep last known state while offline */ });
    };
    const scheduleResync = () => {
      if (cancelled || resyncTimer !== null) return;
      resyncTimer = window.setTimeout(() => {
        resyncTimer = null;
        resyncChat();
      }, 1500);
    };
    const onVisibilityChange = () => {
      if (!document.hidden && prevBusyRef.current) {
        resyncChat();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const unsubscribe = subscribeSuperAgentChat(
      chatId,
      next => {
        if (resyncTimer !== null) {
          window.clearTimeout(resyncTimer);
          resyncTimer = null;
        }
        if (!cancelled) applyChatSnapshot(next, false);
      },
      scheduleResync,
    );

    return () => {
      cancelled = true;
      if (resyncTimer !== null) window.clearTimeout(resyncTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
    };
  }, [active, chatId, chatRetry, applyChatSnapshot]);

  useEffect(() => {
    if (viewerOpen || (activeChat?.artifacts.length ?? 0) > 0) {
      void ArtifactBrowserPane.preload().catch(() => {});
      return;
    }
    if (!active || requestedMode !== 'game') return;
    // Preload the lazy browser pane during idle time in Game Studio so Surprise me / Try game open without chunk flashes.
    const timer = window.setTimeout(() => {
      void ArtifactBrowserPane.preload().catch(() => {});
    }, 650);
    return () => window.clearTimeout(timer);
  }, [active, requestedMode, viewerOpen, activeChat?.artifacts.length]);

  const applyPendingHandoff = useCallback(() => {
    if (!active) return;
    const payload = consumeSuperAgentHandoff();
    if (!payload) return;
    const seq = ++handoffSeqRef.current;
    const mergedAttachments = (() => {
      const next: SuperAgentResourceAttachment[] = payload.newChat === false ? [...attachments] : [];
      for (const att of payload.attachments ?? []) {
        if (!next.some(existing => resourceKey(existing) === resourceKey(att))) {
          next.push(att);
        }
      }
      return next.slice(0, 30);
    })();

    setAttachments(mergedAttachments);

    if (payload.autoSend) {
      setPendingAutoSend({
        id: seq,
        payload: {
          ...payload,
          attachments: mergedAttachments,
        },
      });
      return;
    }

    if (payload.newChat !== false && !payload.initialArtifact) {
      setActiveChat(null);
      setViewerOpen(false);
    }

    setDraftSeed({
      id: seq,
      text: payload.prompt,
      ...(payload.hiddenInstructions ? { hiddenInstructions: payload.hiddenInstructions } : {}),
      ...(payload.contextTags?.length ? { contextTags: payload.contextTags } : {}),
      mode: payload.mode,
      ...(payload.designModule ? { designModule: payload.designModule } : {}),
    });

    if (payload.initialArtifact) {
      const intent = modeChatIntent(payload.mode);
      void createSuperAgentChat({
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model !== 'default' ? selection.model : undefined,
        permissionMode,
        ...(intent ? { intent } : {}),
        ...(payload.title ? { title: payload.title } : {}),
        initialArtifact: payload.initialArtifact,
      })
        .then(created => {
          applyChatSnapshot(created.conversation, true);
          if (created.conversation.artifacts.length > 0) setViewerOpen(true);
          onChatIdChange(created.conversation.id, true);
        })
        .catch(() => { /* composer still holds draft + attachments */ });
    }

    if (payload.prompt.trim() || payload.mode || mergedAttachments.length > 0 || payload.initialArtifact) {
      showToast(t('Loaded into Super Agent'), 'info', 'feedback');
    }
  }, [active, attachments, selection.runtimeId, selection.engine, selection.model, permissionMode, applyChatSnapshot, onChatIdChange, showToast, t]);

  // `/agent?prompt=…` (from an external Agent or a share page): queue it as a
  // new-chat handoff, prefilled but not sent, and drop it from the address bar.
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const link = readSuperAgentPromptLink(window.location.search);
    if (!link) return;
    window.history.replaceState(window.history.state, '', withoutSuperAgentPromptLink(window.location.href));
    // A prompt link always starts a new chat: leave any routed conversation first
    // so its in-flight load is cancelled and cannot reclaim the composer.
    if (chatId) onChatIdChange(null, true);
    queueSuperAgentHandoff(link);
  }, [active, chatId, onChatIdChange]);
  useEffect(() => {
    applyPendingHandoff();
    return subscribeSuperAgentHandoff(applyPendingHandoff);
  }, [applyPendingHandoff]);

  const ensureChatCreated = useCallback(async (init?: {
    intent?: SuperAgentIntent;
    title?: string;
    initialArtifact?: Partial<SuperAgentArtifact>;
  }): Promise<SuperAgentChat> => {
    if (activeChat) {
      if (init?.initialArtifact && !activeChat.artifacts.some(a => a.id === init.initialArtifact!.id)) {
        try {
          const res = await updateSuperAgentChat(activeChat.id, { addArtifact: init.initialArtifact });
          applyChatSnapshot(res.conversation, false);
          setViewerOpen(true);
          return res.conversation;
        } catch { /* fall through and return activeChat */ }
      }
      return activeChat;
    }
    const created = await createSuperAgentChat({
      ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
      engine: selection.engine,
      model: selection.model !== 'default' ? selection.model : undefined,
      permissionMode,
      ...(init?.intent ? { intent: init.intent } : {}),
      ...(init?.title ? { title: init.title } : {}),
      ...(init?.initialArtifact ? { initialArtifact: init.initialArtifact } : {}),
    });
    applyChatSnapshot(created.conversation, true);
    if (created.conversation.artifacts.length > 0) setViewerOpen(true);
    onChatIdChange(created.conversation.id, true);
    return created.conversation;
  }, [activeChat, selection.runtimeId, selection.engine, selection.model, permissionMode, applyChatSnapshot, onChatIdChange]);

  const handleCreateConversation = () => {
    setActiveChat(null);
    setPermissionMode(savedPermissionMode());
    previewArtifactIdsRef.current.clear();
    setPreviewArtifacts([]);
    setLoadingChat(false);
    setLoadFailed(false);
    setAttachments([]);
    setOpenTabIds([]);
    setActiveTabId(NEW_VIEWER_TAB_ID);
    setViewerOpen(false);
    setViewerExpanded(false);
    lastArtifactStateRef.current = { chatId: null, sig: '', artifactIds: [], presentedById: {} };
    setDraftSeed({ id: ++handoffSeqRef.current, text: '' });
    if (chatId !== null || requestedMode) {
      onChatIdChange(null);
    }
    if (sidebarAsDrawer) setSidebarOpen(false);
  };

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const updated = await updateSuperAgentChat(id, { pinned });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update conversation'));
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      const updated = await updateSuperAgentChat(id, { title });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not rename conversation'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      if (activeChat?.id === id) {
        for (const item of activeChat.artifacts) {
          if (item.kind === 'web') {
            void closeSuperAgentBrowserTab(id, safeBrowserTabId(item.id));
          }
        }
      }
      await deleteSuperAgentChat(id);
      setConversations(prev => prev.filter(item => item.id !== id));
      if (chatId === id) {
        onChatIdChange(null, true);
      }
      showToast(t('Conversation deleted'), 'info', 'feedback');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not delete conversation'));
    }
  };

  const handleChangePermissionMode = async (nextMode: SuperAgentPermissionMode) => {
    setPermissionMode(nextMode);
    savePermissionMode(nextMode);
    if (!activeChat) return;
    try {
      const updated = await updateSuperAgentChat(activeChat.id, { permissionMode: nextMode });
      setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update approval mode'));
    }
  };

  const resumeRequestIds = useRef(new Map<string, string>());
  const handleSend = async (
    text: string,
    meta?: {
      segments?: SuperAgentPromptSegment[];
      hiddenInstructions?: string;
      contextTags?: SuperAgentContextTag[];
      mode?: SuperAgentCreationModeId;
      workingDir?: string;
      overrideAttachments?: SuperAgentResourceAttachment[];
      initialArtifact?: Partial<SuperAgentArtifact>;
      followUpBehavior?: SuperAgentFollowUpMode;
      /** Reuse a caller-owned requestId so retries of the same logical send are deduplicated by the gateway. */
      requestId?: string;
      /** Leave the composer's draft attachments untouched (system-initiated sends such as account resume). */
      keepDraftAttachments?: boolean;
    },
  ): Promise<boolean> => {
    setSending(true);
    try {
      const requestId = meta?.requestId ?? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const outgoingAttachments = meta?.overrideAttachments ?? attachments;
      const turnPayload = {
        requestId,
        text,
        ...(meta?.segments?.length ? { segments: meta.segments } : {}),
        ...(meta?.hiddenInstructions?.trim() ? { hiddenInstructions: meta.hiddenInstructions.trim() } : {}),
        ...(meta?.contextTags?.length ? { contextTags: meta.contextTags } : {}),
        ...(meta?.mode ? { mode: meta.mode } : {}),
        ...(meta?.workingDir ? { workingDir: meta.workingDir } : {}),
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model,
        reasoning: selection.reasoning,
        permissionMode,
        attachments: outgoingAttachments,
      };
      if (activeChat?.state === 'running' && !(activeChat.approvals?.length)) {
        const effectiveBehavior = meta?.followUpBehavior ?? followUpBehavior;
        if (effectiveBehavior === 'queue') {
          const result = await enqueueSuperAgentMessage(activeChat.id, turnPayload);
          applyChatSnapshot(result.conversation, false);
          if (!meta?.keepDraftAttachments) setAttachments([]);
          showToast(t('Queued for next turn'), 'info', 'feedback');
          return true;
        }
        const result = await startSuperAgentTurn(activeChat.id, {
          ...turnPayload,
          followUpBehavior: 'steer',
        });
        applyChatSnapshot(result.conversation, false);
        if (!meta?.keepDraftAttachments) setAttachments([]);
        return true;
      }
      const targetIntent = modeChatIntent(meta?.mode);
      const target = await ensureChatCreated(
        targetIntent || meta?.initialArtifact
          ? {
              ...(targetIntent ? { intent: targetIntent } : {}),
              ...(meta?.initialArtifact ? { initialArtifact: meta.initialArtifact } : {}),
            }
          : undefined,
      );
      const result = await startSuperAgentTurn(target.id, turnPayload);
      applyChatSnapshot(result.conversation, false);
      if (!meta?.keepDraftAttachments) setAttachments([]);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not start Super Agent'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await stopSuperAgentChat(activeChat.id);
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not stop Agent'));
    } finally {
      setSending(false);
    }
  };

  const handleApprove = async (approvalId: string, accepted: boolean, alwaysAllow = false) => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await approveSuperAgentAction(activeChat.id, approvalId, accepted, alwaysAllow);
      if (accepted && alwaysAllow) {
        setPermissionMode('auto');
      }
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Approval failed'));
    } finally {
      setSending(false);
    }
  };

  const handleUpdateQueued = async (
    queueId: string,
    patch: {
      text: string;
      segments?: SuperAgentPromptSegment[];
      attachments: SuperAgentResourceAttachment[];
      contextTags?: SuperAgentContextTag[];
      hiddenInstructions?: string;
      mode?: SuperAgentCreationModeId | null;
      workingDir?: string;
    },
  ): Promise<boolean> => {
    if (!activeChat) return false;
    setSending(true);
    try {
      const res = await updateSuperAgentQueuedMessage(activeChat.id, queueId, {
        text: patch.text,
        ...(patch.segments !== undefined ? { segments: patch.segments } : {}),
        attachments: patch.attachments,
        contextTags: patch.contextTags ?? [],
        hiddenInstructions: patch.hiddenInstructions ?? '',
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.workingDir !== undefined ? { workingDir: patch.workingDir } : {}),
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model,
        reasoning: selection.reasoning,
        permissionMode,
      });
      applyChatSnapshot(res.conversation, false);
      showToast(t('Queued message updated'), 'info', 'feedback');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update queued message'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleDeleteQueued = async (queueId: string) => {
    if (!activeChat) return;
    setSending(true);
    try {
      const res = await deleteSuperAgentQueuedMessage(activeChat.id, queueId);
      applyChatSnapshot(res.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not delete queued message'));
    } finally {
      setSending(false);
    }
  };

  const handleSendQueuedNow = async (queueId: string) => {
    if (!activeChat) return;
    setSending(true);
    try {
      const res = await sendSuperAgentQueuedMessageNow(activeChat.id, queueId);
      applyChatSnapshot(res.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not send queued message'));
    } finally {
      setSending(false);
    }
  };

  const handleOpenArtifactId = async (requestedId: string) => {
    const artifactId = chatArtifacts.replaced.get(requestedId) ?? requestedId;
    setOpenTabIds(prev => (prev.includes(artifactId) ? prev : [...prev, artifactId]));
    setActiveTabId(artifactId);
    setViewerOpen(true);
    if (activeChat && activeChat.activeArtifactId !== artifactId && !previewArtifactIdsRef.current.has(artifactId)) {
      void updateSuperAgentChat(activeChat.id, { activeArtifactId: artifactId })
        .then(res => {
          if (res?.conversation) setActiveChat(res.conversation);
        })
        .catch(() => { /* local tab already focused */ });
    }
  };

  const openLocalPreviewArtifact = useCallback((artifact: SuperAgentArtifact) => {
    previewArtifactIdsRef.current.add(artifact.id);
    setPreviewArtifacts(prev => {
      const next = prev.filter(entry => entry.id !== artifact.id);
      next.push(artifact);
      return next;
    });
    setOpenTabIds(prev => (prev.includes(artifact.id) ? prev : [...prev, artifact.id]));
    setActiveTabId(artifact.id);
    setViewerOpen(true);
  }, []);

  const resolveInternalArtifactRouteId = useCallback((rawTarget: string): string | null => {
    const trimmed = rawTarget.trim();
    const gameMatch = trimmed.match(/^\/(?:motion-api|api)\/games\/([^/?#]+)\//i);
    if (gameMatch) {
      let decoded = gameMatch[1];
      try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      const existing = viewerArtifacts.find(
        item => item.kind === 'game-project' && (item.projectId === decoded || item.id === `game:${decoded}`),
      );
      if (existing) return existing.id;
    }
    const designMatch = trimmed.match(/^\/(?:motion-api|api)\/design\/raw\/([^/?#]+)\//i);
    if (designMatch) {
      let decoded = designMatch[1];
      try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      const existing = viewerArtifacts.find(
        item => item.kind === 'design-project' && (item.projectId === decoded || item.id === `design:${decoded}`),
      );
      if (existing) return existing.id;
    }
    const directMatch = viewerArtifacts.find(item => {
      if (!item.url) return false;
      const cleanItemUrl = item.url.split(/[?#]/)[0];
      const cleanTarget = trimmed.split(/[?#]/)[0];
      return Boolean(cleanItemUrl && cleanItemUrl === cleanTarget);
    });
    return directMatch?.id ?? null;
  }, [viewerArtifacts]);

  const handleOpenFilePath = useCallback((rawPath: string, label?: string) => {
    const trimmed = rawPath.trim().replace(/^file:\/\//i, '');
    const hashIdx = trimmed.indexOf('#');
    const cleanPath = (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).trim();
    if (!cleanPath) return;

    const routedArtifactId = resolveInternalArtifactRouteId(cleanPath);
    if (routedArtifactId) {
      void handleOpenArtifactId(routedArtifactId);
      return;
    }

    const existing = viewerArtifacts.find(item =>
      item.kind === 'workspace-file' && (item.filePath === cleanPath || item.id === `file:ref:${cleanPath}`),
    );
    if (existing) {
      void handleOpenArtifactId(existing.id);
      return;
    }

    const baseName = cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath;
    const displayTitle = label?.trim() || baseName;
    const isMarkdown = /\.(?:md|markdown|mdx)$/i.test(cleanPath);
    const now = Date.now();
    openLocalPreviewArtifact({
      id: `file:ref:${cleanPath}`,
      kind: 'workspace-file',
      title: displayTitle,
      subtitle: cleanPath,
      filePath: cleanPath,
      ...(isMarkdown ? { mimeType: 'text/markdown' } : {}),
      createdAt: now,
      updatedAt: now,
      presentedAt: now,
    });
  }, [viewerArtifacts, openLocalPreviewArtifact, resolveInternalArtifactRouteId]);

  const handleOpenChangedFile = (file: SuperAgentFileOperation) => {
    const inspectable = activeChat?.artifacts.filter(
      a => a.kind === 'game-project' || a.kind === 'design-project' || a.kind === 'motion-project',
    ) ?? [];
    const targetId =
      (file.artifactId && inspectable.some(a => a.id === file.artifactId) ? file.artifactId : undefined)
      ?? inspectable.find(a => a.id === activeChat?.activeArtifactId)?.id
      ?? inspectable.at(-1)?.id;
    if (!targetId) {
      handleOpenFilePath(file.path);
      return;
    }
    setPendingCodeFile({ artifactId: targetId, filePath: file.path, seq: Date.now() });
    void handleOpenArtifactId(targetId);
  };

  const handleOpenWebUrl = async (url: string, options?: { id?: string; title?: string }) => {
    const routedArtifactId = resolveInternalArtifactRouteId(url);
    if (routedArtifactId) {
      await handleOpenArtifactId(routedArtifactId);
      return;
    }
    const resolvedUrl = url.startsWith('/') && typeof window !== 'undefined'
      ? `${window.location.origin}${url}`
      : url;
    const openLocalWebPreview = () => {
      const now = Date.now();
      let fallbackTitle = resolvedUrl;
      try {
        fallbackTitle = new URL(resolvedUrl).hostname || resolvedUrl;
      } catch {
        /* keep raw url as title */
      }
      const tabId = options?.id || `web:${now}`;
      const existing = previewArtifacts.find(item => item.id === tabId);
      const presentedAt = Math.max(now, (existing?.presentedAt ?? 0) + 1);
      openLocalPreviewArtifact({
        id: tabId,
        kind: 'web',
        title: options?.title || fallbackTitle,
        url: resolvedUrl,
        createdAt: existing?.createdAt ?? now,
        updatedAt: presentedAt,
        presentedAt,
      });
    };
    if (!activeChat) {
      openLocalWebPreview();
      return;
    }
    try {
      const res = await updateSuperAgentChat(activeChat.id, {
        addArtifact: {
          kind: 'web',
          url: resolvedUrl,
          ...(options?.id ? { id: options.id } : {}),
          ...(options?.title ? { title: options.title } : {}),
        },
      });
      applyChatSnapshot(res.conversation, false);
      setViewerOpen(true);
    } catch {
      /* Keep live web browsing unblocked via the ephemeral preview session if chat persistence fails. */
      openLocalWebPreview();
    }
  };

  const handleOpenResource = async (item: SuperAgentResourceAttachment) => {
    if (item.kind === 'chat') {
      const targetChatId = item.chatId || item.id;
      if (targetChatId) {
        onChatIdChange(targetChatId);
        if (sidebarAsDrawer) setSidebarOpen(false);
      }
      return;
    }
    if (item.kind === 'browser-annotation') {
      if (item.annotation?.artifactId && activeChat?.artifacts.some(a => a.id === item.annotation!.artifactId)) {
        void handleOpenArtifactId(item.annotation.artifactId);
        return;
      }
      if (item.annotation?.pageUrl && /^https?:\/\//i.test(item.annotation.pageUrl)) {
        void handleOpenWebUrl(item.annotation.pageUrl);
        return;
      }
    }
    if (item.kind === 'file' && item.artifactId && item.filePath) {
      const projectArtifact = viewerArtifacts.find(a => a.id === item.artifactId);
      if (
        projectArtifact
        && (projectArtifact.kind === 'design-project' || projectArtifact.kind === 'game-project' || projectArtifact.kind === 'motion-project')
      ) {
        setPendingCodeFile({ artifactId: projectArtifact.id, filePath: item.filePath, seq: Date.now() });
        void handleOpenArtifactId(projectArtifact.id);
        return;
      }
    }
    if (item.kind === 'folder') {
      if (item.artifactId && viewerArtifacts.some(a => a.id === item.artifactId)) {
        void handleOpenArtifactId(item.artifactId);
        return;
      }
      if (!attachments.some(existing => resourceKey(existing) === resourceKey(item))) {
        setAttachments(prev => [...prev, item].slice(0, 30));
        showToast(t('Attached "{title}" to prompt', { title: item.filePath || item.title }), 'info', 'feedback');
      } else {
        showToast(`${t('Folder')}: ${item.filePath || item.title}`, 'info', 'feedback');
      }
      return;
    }
    const patch = resourceToArtifactPatch(item);
    if (!patch) {
      if (attachments.some(existing => resourceKey(existing) === resourceKey(item))) {
        showToast(item.subtitle ? `${item.title} · ${item.subtitle}` : item.title, 'info', 'feedback');
      } else {
        setAttachments(prev => [...prev, item].slice(0, 30));
        showToast(t('Attached "{title}" to prompt', { title: item.title }), 'info', 'feedback');
      }
      return;
    }

    const patchId = patch.id || `${patch.kind}:${Date.now()}`;
    const buildLocalArtifact = (): SuperAgentArtifact => {
      const now = Date.now();
      return {
        id: patchId,
        kind: patch.kind!,
        title: patch.title || item.title,
        ...(patch.subtitle ? { subtitle: patch.subtitle } : {}),
        ...(patch.projectId ? { projectId: patch.projectId } : {}),
        ...(patch.scenario ? { scenario: patch.scenario } : {}),
        ...(patch.entry ? { entry: patch.entry } : {}),
        ...(patch.assetId ? { assetId: patch.assetId } : {}),
        ...(patch.versionId ? { versionId: patch.versionId } : {}),
        ...(patch.kitId ? { kitId: patch.kitId } : {}),
        ...(patch.url ? { url: patch.url } : {}),
        ...(patch.downloadUrl ? { downloadUrl: patch.downloadUrl } : {}),
        ...(patch.filePath ? { filePath: patch.filePath } : {}),
        ...(patch.rootKey ? { rootKey: patch.rootKey } : {}),
        ...(typeof patch.sizeBytes === 'number' ? { sizeBytes: patch.sizeBytes } : {}),
        ...(patch.mimeType ? { mimeType: patch.mimeType } : {}),
        createdAt: now,
        updatedAt: now,
        presentedAt: now,
      };
    };

    if (patch.kind === 'workspace-file') {
      if (viewerArtifacts.some(a => a.id === patchId)) {
        void handleOpenArtifactId(patchId);
        return;
      }
      openLocalPreviewArtifact(buildLocalArtifact());
      return;
    }

    if (activeChat) {
      if (viewerArtifacts.some(a => a.id === patchId)) {
        void handleOpenArtifactId(patchId);
        return;
      }
      try {
        const res = await updateSuperAgentChat(activeChat.id, { addArtifact: patch });
        applyChatSnapshot(res.conversation, false);
        setViewerOpen(true);
      } catch (error) {
        showToast(error instanceof Error ? error.message : t('Could not preview resource'));
      }
      return;
    }

    openLocalPreviewArtifact(buildLocalArtifact());
  };

  const handleAttachArtifact = (artifact: SuperAgentArtifact) => {
    const att = artifactToResourceAttachment(artifact);
    if (!att) return;
    setAttachments(prev =>
      prev.some(existing => resourceKey(existing) === resourceKey(att))
        ? prev
        : [...prev, att].slice(0, 30),
    );
    showToast(t('Attached "{title}" to prompt', { title: att.title }), 'info', 'feedback');
  };

  const handleAttachBrowserAnnotation = (
    attachment: SuperAgentResourceAttachment,
    sendImmediately = false,
  ) => {
    const nextAttachments = attachments.some(existing => resourceKey(existing) === resourceKey(attachment))
      ? attachments
      : [...attachments, attachment].slice(0, 30);
    setAttachments(nextAttachments);
    const waitingApproval = activeChat?.state === 'waiting' || Boolean(activeChat?.approvals?.length);
    if (sendImmediately && !waitingApproval && !sending) {
      const fallbackPrompt =
        attachment.annotation?.artifactKind === 'motion-project' || attachment.annotation?.mode === 'motion-selection'
          ? t('Update the Motion project based on the attached editor selection.')
          : attachment.annotation?.mode === 'code-selection'
            ? t('Update the selected code in the editor.')
            : t('Update the page based on the attached browser preview annotation.');
      const promptText = attachment.annotation?.comment?.trim() || fallbackPrompt;
      void handleSend(promptText, { overrideAttachments: nextAttachments });
      return;
    }
    showToast(t('Attached "{title}" to prompt', { title: attachment.title }), 'info', 'feedback');
  };

  const handlePlayGame = useCallback(async (game: GameCard, options?: { requirePersist?: boolean }) => {
    playedGamesRef.current.set(game.id, game);
    const displayTitle = localizedGameTitle(game, locale);
    const patch = toGameArtifact(game, displayTitle);
    const artifactId = patch.id || `game:${game.id}`;
    const normalizeCompareUrl = (value?: string) => (value ? value.replace(/\/+$/, '') : '');
    if (game.external?.embeddable && viewerOpen && activeTabId === artifactId
      && (activeChat?.artifacts ?? previewArtifacts).some(
        item => item.id === artifactId && normalizeCompareUrl(item.url) === normalizeCompareUrl(patch.url),
      )) {
      return artifactId;
    }
    const now = Date.now();
    const fullArtifact: SuperAgentArtifact = {
      id: artifactId,
      kind: 'game-project',
      title: patch.title || displayTitle,
      subtitle: patch.subtitle,
      playableAd: patch.playableAd,
      ...(patch.projectId ? { projectId: patch.projectId } : {}),
      scenario: patch.scenario,
      revision: patch.revision,
      url: patch.url,
      createdAt: now,
      updatedAt: now,
      presentedAt: now,
    };

    if (activeChat) {
      try {
        const res = await updateSuperAgentChat(activeChat.id, { addArtifact: patch });
        applyChatSnapshot(res.conversation, false);
        setViewerOpen(true);
        return artifactId;
      } catch (error) {
        if (options?.requirePersist) {
          showToast(error instanceof Error ? error.message : t('Could not preview resource'));
          return null;
        }
        /* Fall back to local preview artifact state so Try game stays playable even if chat persistence fails. */
      }
    }

    openLocalPreviewArtifact(fullArtifact);
    return fullArtifact.id;
  }, [activeChat, activeTabId, applyChatSnapshot, locale, openLocalPreviewArtifact, previewArtifacts, showToast, t, viewerOpen]);

  const handleDeployGame = useCallback(async (game: GameCard) => {
    const openedArtifactId = await handlePlayGame(game, { requirePersist: true });
    if (openedArtifactId) {
      setPendingDeployArtifactId(openedArtifactId);
    }
  }, [handlePlayGame]);

  const handleResumeAfterAccount = async (card: SuperAgentActionCard, { plan, key }: { plan?: string; key: string }) => {
    // One stable requestId per card instance: a retry after a lost response replays instead of enqueueing twice.
    let requestId = resumeRequestIds.current.get(key);
    if (!requestId) {
      requestId = `sa-resume-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36)}`;
      resumeRequestIds.current.set(key, requestId);
    }
    const publish = card.kind === 'web_publish_sign_in';
    const target = publish
      ? [card.targetKind, card.targetId].filter(Boolean).join(' ')
      : '';
    const continued = await handleSend(t(publish ? 'Signed in — please publish again.' : 'Signed in — please continue.'), {
      requestId,
      hiddenInstructions: publish
        ? 'The user just signed in to OpenDesign. Retry the web publish that failed with sign-in required in the previous turn'
          + (target ? ` (target: ${target})` : '')
          + ', calling the same publish tool with the same target and arguments. Do not regenerate, rebuild or edit the content first; publish it as it is now and share the resulting link. Do not ask the user to reply again.'
        : 'The user just signed in to OpenDesign' + (plan ? ` (plan: ${plan})` : '')
          + '. Retry the media generation that was blocked by sign-in or plan in the previous turn, with the same brief and settings. Before any paid generation, still state the expected cost as the existing rules require; do not ask the user to reply again.',
      followUpBehavior: 'queue',
      overrideAttachments: [],
      keepDraftAttachments: true,
    });
    if (!continued) throw new Error(t('Could not continue the conversation. Try again.'));
  };

  const handleOpenActionCardSettings = (card: SuperAgentActionCard, target: 'account' | 'api_key') => {
    if (target === 'api_key') {
      // The account detail has no key form; open the provider list where a media provider key can be added.
      if (onOpenProviderSettings) onOpenProviderSettings(undefined, card.entry);
      else onOpenModelSettings?.();
      return;
    }
    if (onOpenProviderSettings) onOpenProviderSettings('account', card.entry);
    else onOpenAccountSettings?.();
  };

  const handleTriggerActionCard = useCallback(async (card: SuperAgentActionCard) => {
    // Account cards (including publish sign-in) complete inside the card and resume via handleResumeAfterAccount.
    if (card.kind === 'sign_in' || card.kind === 'upgrade_free' || card.kind === 'upgrade_go' || card.kind === 'web_publish_sign_in') return;
    if (card.kind === 'configure_key') {
      if (onOpenProviderSettings) {
        onOpenProviderSettings(card.provider, card.entry);
      } else {
        onOpenModelSettings?.();
      }
      return;
    }

    if (onOpenProviderSettings) {
      onOpenProviderSettings(card.provider ?? 'account', card.entry);
    } else if (onOpenAccountSettings) {
      onOpenAccountSettings();
    } else {
      onOpenModelSettings?.();
    }
  }, [onOpenAccountSettings, onOpenModelSettings, onOpenProviderSettings]);

  const handleUseGameInAgent = useCallback(async (artifact: SuperAgentArtifact) => {
    if (isMultiplayerGameArtifact(artifact)) return;
    const gameId = artifact.projectId || (artifact.id.startsWith('game:') ? artifact.id.slice('game:'.length) : '');
    let game: GameCard | null =
      (gameId ? playedGamesRef.current.get(gameId) ?? null : null)
      ?? (gameId ? [...communityGames, ...bundledGames].find(item => item.id === gameId) ?? null : null);

    if (!game && gameId) {
      try {
        const res = await gameApi.catalog();
        game = res.games?.find(item => item.id === gameId) ?? null;
        if (game) playedGamesRef.current.set(game.id, game);
      } catch {
        /* ignore offline catalog lookup */
      }
    }

    if (game?.multiplayer) return;
    if (game && game.source !== 'mine') {
      const displayTitle = localizedGameTitle(game, locale);
      setGameTemplateSeed({ id: ++handoffSeqRef.current, game });
      showToast(t('Remix · {title}', { title: displayTitle }), 'info', 'feedback');
      return;
    }

    const att = game
      ? toGameResourceAttachment(game, localizedGameTitle(game, locale))
      : artifactToResourceAttachment(artifact);
    if (!att) return;
    setAttachments(prev =>
      prev.some(existing => resourceKey(existing) === resourceKey(att))
        ? prev
        : [...prev, att].slice(0, 30),
    );
    showToast(t('Attached "{title}" to prompt', { title: att.title }), 'info', 'feedback');
  }, [locale, showToast, t]);

  useEffect(() => {
    if (!active || !requestedGameId) {
      if (!requestedGameId) handledRequestedGameRef.current = null;
      return;
    }
    if (handledRequestedGameRef.current === requestedGameId) return;
    handledRequestedGameRef.current = requestedGameId;

    let cancelled = false;
    const staticMatch = [...communityGames, ...bundledGames].find(item => item.id === requestedGameId);
    if (staticMatch) {
      void handlePlayGame(staticMatch);
      return;
    }

    void gameApi.catalog()
      .then(res => {
        if (cancelled) return;
        const found = res.games?.find(item => item.id === requestedGameId);
        if (found) {
          void handlePlayGame(found);
        }
      })
      .catch(() => { /* ignore if game service is offline */ });

    return () => {
      cancelled = true;
    };
  }, [active, requestedGameId, handlePlayGame]);

  const playingGameId = useMemo(() => {
    if (!viewerOpen || activeTabId === NEW_VIEWER_TAB_ID) return null;
    const current = viewerArtifacts.find(item => item.id === activeTabId);
    if (!current || current.kind !== 'game-project') return null;
    if (current.projectId) return current.projectId;
    return current.id.startsWith('game:') ? current.id.slice('game:'.length) : null;
  }, [viewerOpen, activeTabId, viewerArtifacts]);

  const handleCloseTab = (tabId: string) => {
    const target = viewerArtifacts.find(item => item.id === tabId);
    if (target?.kind === 'web') {
      const persistedInChat = Boolean(activeChat?.id && activeChat.artifacts.some(item => item.id === tabId));
      void closeSuperAgentBrowserTab(persistedInChat ? activeChat!.id : null, safeBrowserTabId(tabId));
    }
    previewArtifactIdsRef.current.delete(tabId);
    setPreviewArtifacts(prev => prev.filter(item => item.id !== tabId));
    setOpenTabIds(prev => {
      const next = prev.filter(id => id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next.at(-1) ?? NEW_VIEWER_TAB_ID);
      }
      if (next.length === 0 && (target?.kind === 'game-project' || !activeChat)) {
        setViewerOpen(false);
      }
      return next;
    });
  };

  const handleCopyText = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('Copied to clipboard'), 'info', 'feedback');
    } catch {
      showToast(t('Could not copy to clipboard'));
    }
  };

  const agentsLoaded = agentDir !== null || runtimesDir !== null;
  const openRuntimes = useCallback(() => {
    openAgentRuntimesSettings();
    onOpenAgentSettings();
  }, [onOpenAgentSettings]);

  const agentStatus = useMemo(() => {
    if (!agentsLoaded) {
      return { label: t('Local Agents'), detail: t('Checking Agent runtimes…'), ready: false, count: 0, loading: true };
    }
    const readyOnlineRuntimes = availableRuntimes.filter(rt => rt.status === 'online' && rt.runnableAgentIds.length > 0);
    const selectedRuntime = availableRuntimes.find(rt => rt.id === selection.runtimeId && rt.status === 'online');
    const targetRuntime = selectedRuntime ?? readyOnlineRuntimes[0] ?? availableRuntimes.find(rt => rt.status === 'online');
    const readyAgents = targetRuntime
      ? targetRuntime.agents.filter(item => item.installed && item.auth !== 'signed-out')
      : [];

    if (readyOnlineRuntimes.length > 0 && readyAgents.length > 0) {
      const activeFirst = [
        ...readyAgents.filter(item => item.id === selection.engine),
        ...readyAgents.filter(item => item.id !== selection.engine),
      ];
      const label = activeFirst.length <= 2
        ? activeFirst.map(a => a.label).join(' · ')
        : `${activeFirst[0].label} · +${activeFirst.length - 1}`;
      const detail =
        readyOnlineRuntimes.length > 1
          ? t('{count} runtimes connected', { count: readyOnlineRuntimes.length })
          : targetRuntime?.kind === 'local-bridge'
            ? t('Bridge · {name}', { name: targetRuntime.name })
            : targetRuntime?.kind === 'remote-service'
              ? t('Hosted · {name}', { name: targetRuntime.name })
              : t('Local Agent connected');
      return {
        label,
        detail,
        ready: true,
        count: readyAgents.length,
        loading: false,
      };
    }

    return {
      label: t('No Agent connected'),
      detail: runtimesDir && !runtimesDir.localDirectAvailable
        ? t('Connect local machine or service')
        : t('Configure Local Agent'),
      ready: false,
      count: 0,
      loading: false,
    };
  }, [availableRuntimes, agentsLoaded, selection.runtimeId, selection.engine, runtimesDir, t]);

  useEffect(() => {
    if (!active || !pendingAutoSend || !agentsLoaded) return;
    const needsAgentSync = agentStatus.ready && Boolean(
      !lastDefaultKeyRef.current
      && !userPickedEngineRef.current
      && agentDir
      && ((agentDir.default && agents.some(item => item.id === agentDir.default!.agent))
        || (!activeChat && agents.some(item => item.installed && item.auth !== 'signed-out'))),
    );
    const needsRuntimeSync = agentStatus.ready && Boolean(
      runtimesDir
      && !selection.runtimeId
      && (runtimesDir.defaultRuntimeId || !runtimesDir.localDirectAvailable)
      && runtimesDir.runtimes.some(item => item.status === 'online'),
    );
    if (needsAgentSync || needsRuntimeSync) return;
    if (dispatchedHandoffIdsRef.current.has(pendingAutoSend.id)) return;
    dispatchedHandoffIdsRef.current.add(pendingAutoSend.id);
    setPendingAutoSend(null);

    const { payload } = pendingAutoSend;
    const handoffAttachments = payload.attachments ?? [];

    if (!agentStatus.ready) {
      setDraftSeed({
        id: pendingAutoSend.id,
        text: payload.prompt,
        ...(payload.hiddenInstructions ? { hiddenInstructions: payload.hiddenInstructions } : {}),
        mode: payload.mode,
        ...(payload.designModule ? { designModule: payload.designModule } : {}),
      });
      if (payload.initialArtifact) {
        const intent = modeChatIntent(payload.mode);
        void createSuperAgentChat({
          ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
          engine: selection.engine,
          model: selection.model !== 'default' ? selection.model : undefined,
          permissionMode,
          ...(intent ? { intent } : {}),
          ...(payload.title ? { title: payload.title } : {}),
          initialArtifact: payload.initialArtifact,
        })
          .then(created => {
            applyChatSnapshot(created.conversation, true);
            if (created.conversation.artifacts.length > 0) setViewerOpen(true);
            onChatIdChange(created.conversation.id, true);
          })
          .catch(() => { /* keep draft seed only */ });
      }
      if (payload.prompt.trim() || handoffAttachments.length > 0 || payload.initialArtifact) {
        showToast(t('Loaded into Super Agent'), 'info', 'feedback');
      }
      return;
    }

    void (async () => {
      setSending(true);
      try {
        const useExisting = payload.newChat === false && activeChat && !payload.initialArtifact;
        const intent = modeChatIntent(payload.mode);
        const target = useExisting
          ? activeChat
          : (
              await createSuperAgentChat({
                ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                engine: selection.engine,
                model: selection.model !== 'default' ? selection.model : undefined,
                permissionMode,
                ...(intent ? { intent } : {}),
                ...(payload.title ? { title: payload.title } : {}),
                ...(payload.initialArtifact ? { initialArtifact: payload.initialArtifact } : {}),
              })
            ).conversation;

        if (target.id !== activeChat?.id) {
          applyChatSnapshot(target, true);
          if (target.artifacts.length > 0) setViewerOpen(true);
          onChatIdChange(target.id, true);
        }

        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        setAttachments([]);
        setDraftSeed({ id: ++handoffSeqRef.current, text: '' });
        const result = await startSuperAgentTurn(target.id, {
          requestId,
          text: payload.prompt,
          ...(payload.hiddenInstructions?.trim() ? { hiddenInstructions: payload.hiddenInstructions.trim() } : {}),
          ...(payload.contextTags?.length ? { contextTags: payload.contextTags } : {}),
          ...(payload.mode ? { mode: payload.mode } : {}),
          ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
          engine: selection.engine,
          model: selection.model,
          reasoning: selection.reasoning,
          permissionMode,
          attachments: handoffAttachments,
        });
        applyChatSnapshot(result.conversation, false);
      } catch (error) {
        setAttachments(handoffAttachments);
        setDraftSeed({
          id: ++handoffSeqRef.current,
          text: payload.prompt,
          ...(payload.hiddenInstructions ? { hiddenInstructions: payload.hiddenInstructions } : {}),
          ...(payload.contextTags?.length ? { contextTags: payload.contextTags } : {}),
          mode: payload.mode,
          ...(payload.designModule ? { designModule: payload.designModule } : {}),
        });
        showToast(error instanceof Error ? error.message : t('Could not start Super Agent'));
      } finally {
        setSending(false);
      }
    })();
  }, [
    active,
    pendingAutoSend,
    agentsLoaded,
    agentDir,
    agents,
    runtimesDir,
    agentStatus.ready,
    activeChat,
    selection.runtimeId,
    selection.engine,
    selection.model,
    selection.reasoning,
    permissionMode,
    applyChatSnapshot,
    onChatIdChange,
    showToast,
    t,
  ]);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<'positive' | 'negative' | 'note'>('note');
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackIncludeLogs, setFeedbackIncludeLogs] = useState(true);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  const handleExportSessionLogs = useCallback(() => {
    if (!activeChat) {
      showToast(t('Start a conversation first to export its session log.'), 'info', 'feedback');
      return;
    }
    const url = superAgentSessionExportUrl(activeChat.id);
    const link = document.createElement('a');
    link.href = url;
    link.download = `openmotion-session-${activeChat.id.slice(0, 12)}.zip`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(t('Downloading session log ZIP…'), 'info', 'feedback');
  }, [activeChat, showToast, t]);

  const handleCompactSession = useCallback(async () => {
    if (!activeChat) {
      showToast(t('Start a conversation first to compact history.'), 'info', 'feedback');
      return;
    }
    if (activeChat.state === 'running') {
      showToast(t('Wait for the current run to finish before compacting.'), 'info', 'feedback');
      return;
    }
    try {
      const result = await compactSuperAgentChat(activeChat.id);
      if (result.conversation) {
        applyChatSnapshot(result.conversation);
      }
      showToast(
        t('Compacted {count} messages into a concise summary.', { count: result.compactedCount }),
        'info',
        'feedback',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Failed to compact conversation'), 'error', 'feedback');
    }
  }, [activeChat, applyChatSnapshot, showToast, t]);

  const handleComposerCommand = useCallback(
    (command: ComposerCommandId) => {
      if (command === 'compact') {
        void handleCompactSession();
        return;
      }
      if (command === 'export-logs') {
        handleExportSessionLogs();
        return;
      }
      if (command === 'feedback') {
        setFeedbackRating('note');
        setFeedbackNote('');
        setFeedbackIncludeLogs(Boolean(activeChat));
        setFeedbackOpen(true);
      }
    },
    [activeChat, handleCompactSession, handleExportSessionLogs],
  );

  const turnFeedbackSeqRef = useRef<Record<string, number>>({});

  const handleRateTurn = useCallback(async (input: import('./ExecutionTimeline').SuperAgentTurnFeedbackSubmit) => {
    const chatId = activeChat?.id;
    const seqKey = `${chatId ?? 'draft'}:${input.turnId}`;
    const seq = (turnFeedbackSeqRef.current[seqKey] ?? 0) + 1;
    turnFeedbackSeqRef.current[seqKey] = seq;
    const prevEntry = activeChat?.turnFeedback?.[input.turnId];
    if (chatId) {
      setActiveChat(prev => {
        if (!prev || prev.id !== chatId) return prev;
        const nextMap = { ...(prev.turnFeedback ?? {}) };
        if (input.rating === 'clear') {
          delete nextMap[input.turnId];
        } else {
          nextMap[input.turnId] = {
            rating: input.rating,
            ...(input.reasons?.length ? { reasons: input.reasons } : {}),
            ...(input.note ? { note: input.note } : {}),
            scene: input.scene,
            updatedAt: Date.now(),
          };
        }
        return {
          ...prev,
          turnFeedback: Object.keys(nextMap).length > 0 ? nextMap : undefined,
        };
      });
    }
    try {
      const res = await submitSuperAgentFeedback({
        chatId: chatId ?? null,
        turnId: input.turnId,
        rating: input.rating,
        reasons: input.reasons,
        note: input.note,
        scene: input.scene,
        artifactKind: input.artifactKind,
        action: input.action,
        includeLogs: input.action === 'update_reason' && input.rating === 'negative',
      });
      if (chatId && turnFeedbackSeqRef.current[seqKey] === seq && res.turnFeedback !== undefined) {
        const savedFeedback = res.turnFeedback;
        setActiveChat(prev => {
          if (!prev || prev.id !== chatId) return prev;
          const nextMap = { ...(prev.turnFeedback ?? {}) };
          if (savedFeedback === null) delete nextMap[input.turnId];
          else nextMap[input.turnId] = savedFeedback;
          return {
            ...prev,
            turnFeedback: Object.keys(nextMap).length > 0 ? nextMap : undefined,
          };
        });
      }
    } catch (err) {
      if (chatId && turnFeedbackSeqRef.current[seqKey] === seq) {
        setActiveChat(prev => {
          if (!prev || prev.id !== chatId) return prev;
          const nextMap = { ...(prev.turnFeedback ?? {}) };
          if (prevEntry) nextMap[input.turnId] = prevEntry;
          else delete nextMap[input.turnId];
          return {
            ...prev,
            turnFeedback: Object.keys(nextMap).length > 0 ? nextMap : undefined,
          };
        });
      }
      showToast(err instanceof Error ? err.message : t('Failed to submit feedback'), 'error', 'feedback');
      throw err;
    }
  }, [activeChat, showToast, t]);

  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = feedbackNote.trim();
    if (!trimmed || feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    try {
      await submitSuperAgentFeedback({
        chatId: activeChat?.id ?? null,
        rating: feedbackRating,
        note: trimmed,
        includeLogs: Boolean(activeChat) && feedbackIncludeLogs,
      });
      setFeedbackOpen(false);
      setFeedbackNote('');
      showToast(t('Feedback saved with session diagnostics.'), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Failed to submit feedback'), 'error', 'feedback');
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [activeChat, feedbackIncludeLogs, feedbackNote, feedbackRating, feedbackSubmitting, showToast, t]);

  const getDockedSidebarWidth = useCallback(() => {
    if (!sidebarDockedRef.current) return 0;
    const sidebarEl = rootRef.current?.querySelector<HTMLElement>('.om-sa-sidebar-slot');
    const measured = sidebarEl ? Math.round(sidebarEl.getBoundingClientRect().width) : 0;
    return measured > 0 ? measured : 240;
  }, []);

  const effectiveViewerWidth =
    viewerExpanded || narrow || viewerWidth === null
      ? null
      : clampSuperAgentViewerWidth(viewerWidth, containerWidth, getDockedSidebarWidth());

  const maxViewerWidth = clampSuperAgentViewerWidth(10_000, containerWidth, getDockedSidebarWidth());
  const activeViewerArtifact = viewerArtifacts.find(item => item.id === activeTabId);
  const motionEditor = activeViewerArtifact?.kind === 'motion-project' && Boolean(activeViewerArtifact.projectId);
  const stackedViewer = stackedArtifactViewerHeight(containerHeight, viewerHeight, motionEditor);
  const viewerSizeStyle = narrow && !viewerExpanded && containerHeight > 0
    ? { flexBasis: stackedViewer.value }
    : effectiveViewerWidth === null
      ? undefined
      : { width: effectiveViewerWidth, flexBasis: effectiveViewerWidth, flexGrow: 0, flexShrink: 1, maxWidth: '100%' };

  const startResize = (clientX: number) => {
    const currentWidth = effectiveViewerWidth
      ?? Math.round(rootRef.current?.querySelector<HTMLElement>('.om-sa-viewer-slot')?.getBoundingClientRect().width || clampSuperAgentViewerWidth(560, containerWidth, getDockedSidebarWidth()));
    dragStartRef.current = { startX: clientX, startWidth: currentWidth };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      const totalWidth = rootRef.current?.clientWidth ?? 0;
      const dockedSidebar = getDockedSidebarWidth();
      const delta = drag.startX - event.clientX;
      setViewerWidth(clampSuperAgentViewerWidth(drag.startWidth + delta, totalWidth, dockedSidebar));
    };
    const onUp = () => {
      dragStartRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [getDockedSidebarWidth]);

  const handlePrefetchChat = useCallback((id: string) => {
    prefetchSuperAgentChat(id);
    const summary = conversations.find(item => item.id === id);
    if ((summary?.artifactCount ?? 0) > 0) {
      void ArtifactBrowserPane.preload().catch(() => {});
    }
  }, [conversations]);

  const taskResultRead = useReadTaskResults(
    active && !loadingChat && !loadFailed && activeChat?.id === chatId
      ? activeChat
      : null,
  );

  const sidebarNode = (
    <ConversationSidebar
      conversations={conversations}
      taskResultRead={taskResultRead}
      activeId={chatId}
      loading={loadingList}
      agentStatus={agentStatus}
      onSelect={id => {
        onChatIdChange(id);
        if (sidebarAsDrawer) setSidebarOpen(false);
      }}
      onPrefetch={handlePrefetchChat}
      onCreate={handleCreateConversation}
      onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
      onRename={(id, title) => handleRename(id, title)}
      onDelete={id => void handleDelete(id)}
      onCollapse={() => setSidebarOpen(false)}
      onOpenAgentSettings={() => {
        if (!agentStatus.ready && runtimesDir && !runtimesDir.localDirectAvailable) {
          openRuntimes();
        } else {
          onOpenAgentSettings();
        }
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className="om-super-agent"
      data-viewer-open={viewerOpen || undefined}
      data-viewer-expanded={viewerExpanded || undefined}
      data-stage-viewer={isStageViewerActive || undefined}
    >
      <StudioToastViewport toasts={toasts} dismissToast={dismissToast} />

      {!sidebarAsDrawer && sidebarOpen && (
        <div className="om-sa-sidebar-slot">
          {sidebarNode}
        </div>
      )}

      {/* Release the modal focus and pointer handling as soon as the drawer closes. */}
      {sidebarAsDrawer && sidebarOpen && (
        <Dialog.Root open onOpenChange={setSidebarOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="om-sa-dialog-backdrop" />
            <Dialog.Popup className="om-sa-sidebar-drawer" aria-label={t('Conversations')} onKeyDown={e => e.stopPropagation()}>
              {sidebarNode}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {!(viewerOpen && viewerExpanded) && (
        <div className="om-sa-center-slot">
          <ConversationStream
            active={active}
            chat={presentedChat}
            conversations={conversations}
            activeArtifacts={viewerArtifacts}
            requestedMode={requestedMode}
            requestedDesignModule={requestedDesignModule}
            playingGameId={playingGameId}
            loading={loadingChat}
            loadFailed={loadFailed}
            sending={sending}
            sidebarOpen={!sidebarAsDrawer && sidebarOpen}
            viewerOpen={viewerOpen}
            activeViewerArtifactId={viewerOpen ? (activeViewerArtifact?.id ?? null) : null}
            counts={resourcesCatalog?.counts ?? null}
            attachments={attachments}
            draftSeed={draftSeed}
            gameTemplateSeed={gameTemplateSeed}
            agents={agents}
            agentsLoaded={agentsLoaded}
            runtimes={availableRuntimes}
            localDirectAvailable={runtimesDir?.localDirectAvailable ?? true}
            selection={selection}
            permissionMode={permissionMode}
            followUpBehavior={followUpBehavior}
            onBack={onBack}
            onChangeRequestedMode={onChangeRequestedMode}
            onPlayGame={game => void handlePlayGame(game)}
            onDeployGame={game => void handleDeployGame(game)}
            onRetryLoad={() => setChatRetry(value => value + 1)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onToggleViewer={() => {
              setViewerOpen(open => {
                const next = !open;
                if (!next) setViewerExpanded(false);
                return next;
              });
            }}
            onRenameChat={title => (activeChat ? handleRename(activeChat.id, title) : undefined)}
            onChangeSelection={next => {
              userPickedEngineRef.current = true;
              setSelection(next);
            }}
            onChangePermissionMode={mode => void handleChangePermissionMode(mode)}
            onSend={handleSend}
            onUpdateQueued={handleUpdateQueued}
            onDeleteQueued={queueId => void handleDeleteQueued(queueId)}
            onSendQueuedNow={queueId => void handleSendQueuedNow(queueId)}
            onStop={() => void handleStop()}
            onApprove={(approvalId, accepted, alwaysAllow) => void handleApprove(approvalId, accepted, alwaysAllow)}
            onResourcesUploaded={refreshResources}
            onAttachmentsChange={setAttachments}
            onOpenArtifactId={artifactId => void handleOpenArtifactId(artifactId)}
            onOpenChangedFile={handleOpenChangedFile}
            onPreviewAttachment={att => void handleOpenResource(att)}
            onOpenFilePath={handleOpenFilePath}
            onOpenWebUrl={(url, options) => void handleOpenWebUrl(url, options)}
            onCopyText={code => void handleCopyText(code)}
            onNotify={(msg, tone) => showToast(msg, tone === 'error' ? 'error' : 'info', 'feedback')}
            onRateTurn={handleRateTurn}
            onRunCommand={handleComposerCommand}
            onOpenAccountSettings={onOpenAccountSettings}
            onTriggerActionCard={card => void handleTriggerActionCard(card)}
            onResumeAfterAccount={handleResumeAfterAccount}
            onOpenActionCardSettings={handleOpenActionCardSettings}
            onOpenInDesignStudio={onOpenDesignProject}
            onOpenInMotionStudio={onOpenMotionProject}
            onOpenInAssets={onOpenAsset}
            onOpenInBrandKit={onOpenBrandKit}
            onOpenAgentSettings={onOpenAgentSettings}
            onOpenRuntimeSettings={openRuntimes}
            onOpenModelSettings={onOpenModelSettings}
            onOpenGameStudio={onOpenGameStudio ? () => onOpenGameStudio() : undefined}
            onOpenMcp={onOpenMcp}
            onError={message => showToast(message)}
          />
        </div>
      )}

      {viewerOpen && !viewerExpanded && !narrow && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('Resize Artifact Viewer')}
          aria-valuemin={MIN_VIEWER_WIDTH}
          aria-valuemax={maxViewerWidth}
          aria-valuenow={effectiveViewerWidth ?? clampSuperAgentViewerWidth(560, containerWidth, getDockedSidebarWidth())}
          className="om-sa-resizer"
          onPointerDown={event => {
            event.preventDefault();
            startResize(event.clientX);
          }}
          onKeyDown={event => {
            const totalWidth = rootRef.current?.clientWidth ?? containerWidth;
            const dockedSidebar = getDockedSidebarWidth();
            const current = effectiveViewerWidth
              ?? Math.round(rootRef.current?.querySelector<HTMLElement>('.om-sa-viewer-slot')?.getBoundingClientRect().width || clampSuperAgentViewerWidth(560, totalWidth, dockedSidebar));
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setViewerWidth(clampSuperAgentViewerWidth(current + 24, totalWidth, dockedSidebar));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              setViewerWidth(clampSuperAgentViewerWidth(current - 24, totalWidth, dockedSidebar));
            }
          }}
        />
      )}

      {viewerOpen && !viewerExpanded && narrow && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t('Resize Artifact Viewer height')}
          aria-controls={viewerPaneId}
          aria-valuemin={stackedViewer.min}
          aria-valuemax={stackedViewer.max}
          aria-valuenow={stackedViewer.value}
          className="om-sa-resizer om-sa-resizer--horizontal"
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            heightDragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startHeight: stackedViewer.value,
            };
          }}
          onPointerMove={event => {
            const drag = heightDragRef.current;
            if (drag?.pointerId !== event.pointerId) return;
            const height = drag.startHeight + drag.startY - event.clientY;
            setViewerHeight(stackedArtifactViewerHeight(containerHeight, height).value);
          }}
          onLostPointerCapture={event => {
            if (heightDragRef.current?.pointerId === event.pointerId) heightDragRef.current = null;
          }}
          onKeyDown={event => {
            const { key } = event;
            const { min, max, value } = stackedViewer;
            if (key === 'ArrowUp' || key === 'ArrowDown') {
              event.preventDefault();
              setViewerHeight(stackedArtifactViewerHeight(containerHeight, value + (key === 'ArrowUp' ? 24 : -24)).value);
            } else if (key === 'Home' || key === 'End') {
              event.preventDefault();
              setViewerHeight(key === 'Home' ? min : max);
            }
          }}
        />
      )}

      {viewerOpen && (
        <div
          id={viewerPaneId}
          className="om-sa-viewer-slot"
          style={viewerSizeStyle}
        >
          <Suspense fallback={<RouteSurfaceFallback compact />}>
            <ArtifactBrowserPane
              active={active}
              chatId={activeChat?.id ?? null}
              webBrowserChatId={
                activeViewerArtifact?.kind === 'web' && !activeChat?.artifacts.some(item => item.id === activeViewerArtifact.id)
                  ? null
                  : (activeChat?.id ?? null)
              }
              workingDir={activeChat?.workingDir}
              artifacts={viewerArtifacts}
              openTabIds={openTabIds}
              activeTabId={activeTabId}
              expanded={viewerExpanded}
              workspaceItems={resourcesCatalog?.items ?? []}
              onSelectTab={id => void handleOpenArtifactId(id)}
              onCloseTab={handleCloseTab}
              onNewTab={() => setActiveTabId(NEW_VIEWER_TAB_ID)}
              onOpenWebUrl={(url, options) => void handleOpenWebUrl(url, options)}
              onOpenFilePath={handleOpenFilePath}
              onOpenArtifact={id => void handleOpenArtifactId(id)}
              onOpenResource={item => void handleOpenResource(item)}
              onToggleExpand={() => setViewerExpanded(v => !v)}
              onClosePane={() => {
                setPendingDeployArtifactId(null);
                setViewerExpanded(false);
                setViewerOpen(false);
              }}
              onAttachArtifact={handleAttachArtifact}
              onUseGameInAgent={artifact => void handleUseGameInAgent(artifact)}
              pendingDeployArtifactId={pendingDeployArtifactId}
              onConsumeDeployRequest={() => setPendingDeployArtifactId(null)}
              pendingCodeFile={pendingCodeFile}
              onConsumePendingCodeFile={() => setPendingCodeFile(null)}
              onOpenAccountSettings={onOpenAccountSettings}
              onAttachBrowserAnnotation={handleAttachBrowserAnnotation}
              onNotify={(msg, tone) => showToast(msg, tone === 'error' ? 'error' : 'info', 'feedback')}
              onOpenInDesignStudio={onOpenDesignProject}
              onOpenInMotionStudio={onOpenMotionProject}
              onOpenInGameStudio={onOpenGameStudio}
              onOpenInAssets={onOpenAsset}
              onOpenInBrandKit={onOpenBrandKit}
            />
          </Suspense>
        </div>
      )}

      <Dialog.Root open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="om-sa-feedback-backdrop" />
          <Dialog.Popup className="om-sa-feedback-dialog" aria-label={t('Session feedback')}>
            <div className="om-sa-feedback-head">
              <Dialog.Title className="om-sa-feedback-title">{t('Session feedback')}</Dialog.Title>
              <IconButton
                variant="plain"
                aria-label={t('Close')}
                onClick={() => setFeedbackOpen(false)}
                icon={<RemixIcon name="close-line" size={16} />}
              />
            </div>

            <div className="om-sa-feedback-ratings" role="radiogroup" aria-label={t('Feedback type')}>
              {(
                [
                  { id: 'positive', label: t('Helpful'), icon: 'thumb-up-line' },
                  { id: 'negative', label: t('Issue'), icon: 'thumb-down-line' },
                  { id: 'note', label: t('Note'), icon: 'chat-1-line' },
                ] as const
              ).map(opt => (
                <Button
                  key={opt.id}
                  variant="plain"
                  type="button"
                  role="radio"
                  aria-checked={feedbackRating === opt.id}
                  data-selected={feedbackRating === opt.id || undefined}
                  className="om-sa-feedback-pill"
                  onClick={() => setFeedbackRating(opt.id)}
                >
                  <RemixIcon name={opt.icon} size={14} />
                  <span>{opt.label}</span>
                </Button>
              ))}
            </div>

            <textarea
              className="om-sa-feedback-input"
              rows={4}
              value={feedbackNote}
              placeholder={t('Share what worked well or what went wrong in this session…')}
              onChange={event => setFeedbackNote(event.target.value)}
              onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleSubmitFeedback();
                }
              }}
            />

            {activeChat && (
              <label className="om-sa-feedback-check">
                <input
                  type="checkbox"
                  checked={feedbackIncludeLogs}
                  onChange={event => setFeedbackIncludeLogs(event.target.checked)}
                />
                <span>{t('Include current session log for debugging')}</span>
              </label>
            )}

            <div className="om-sa-feedback-actions">
              {activeChat && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-feedback-export-btn"
                  onClick={handleExportSessionLogs}
                >
                  <RemixIcon name="download-2-line" size={14} />
                  <span>{t('Download log ZIP')}</span>
                </Button>
              )}
              <div className="om-sa-feedback-actions-right">
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-feedback-cancel-btn"
                  onClick={() => setFeedbackOpen(false)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  disabled={!feedbackNote.trim() || feedbackSubmitting}
                  onClick={() => void handleSubmitFeedback()}
                >
                  {feedbackSubmitting ? t('Saving…') : t('Submit feedback')}
                </Button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
