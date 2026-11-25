import { createPortal } from 'react-dom';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import { designRoutes, findDesignScenario, isDesignScenario } from '../../../shared/design-project';
import { designClient } from '../design/designClient';
import type { GameCard } from '../../../shared/game-contract';
import type { GatewayStatus, Model } from '../../../shared/gateway';
import type { LocalAgent } from '../../../shared/local-agents';
import {
  modeToSuperAgentIntent,
  superAgentChatPresentation,
  superAgentIntentMeta,
  type SuperAgentActionCard,
  type SuperAgentArtifact,
  type SuperAgentChat,
  type SuperAgentChatSummary,
  type SuperAgentContextTag,
  type SuperAgentDesignModuleId,
  type SuperAgentEngine,
  type SuperAgentFileOperation,
  type SuperAgentFollowUpMode,
  type SuperAgentMessage,
  type SuperAgentPermissionMode,
  type SuperAgentPromptSegment,
  type SuperAgentQueuedMessage,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCounts,
} from '../../../shared/super-agent';
import { OpenDesignLoadingMark } from '../components/ui/OpenDesignLoadingMark';
import { Popover } from '../components/ui/Popover';
import { Select } from '../components/ui/Select';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { DockableModeComposer, type DockableComposerHandle } from './DockableModeComposer';
import { uploadSuperAgentFile } from './superAgentClient';
import {
  ComposerMentionMenu,
  mapResourceTabToMentionCategory,
  type ComposerCommandId,
  type ComposerMentionMenuHandle,
  type MentionMenuCategory,
} from './ComposerMentionMenu';
import {
  ComposerPromptEditor,
  type ComposerMentionTrigger,
  type ComposerPromptEditorHandle,
  type ComposerSnapshot,
} from './ComposerPromptEditor';
import {
  communityRemixPrompt,
  composeBrief,
  coverUrl,
  gameApi,
  genreLabels,
  rememberInstruction,
  settingLabels,
  styleLabels,
} from '../motion/game/gameCatalog';
import {
  buildGameContextTags,
  buildGameHiddenInstructions,
  buildGameUserPrompt,
  localizedGameTitle,
  toGameArtifact,
  toGameResourceAttachment,
} from '../motion/game/gameSuperAgent';
import { gatewayRequest } from '../motion/gatewayClient';
import { inspectBridgeAgent, notifyRuntimesChanged } from '../motion/useAgentRuntimes';
import { notifyAgentsChanged } from '../motion/useLocalAgents';
import { WorkspaceBack } from '../motion/WorkspaceBack';
import { AgentModelPicker } from './AgentModelPicker';
import { compactDirLabel, isInternalManagedStorageDir } from './ChangedFilesTree';
import { ApprovalCard, ExecutionTimeline } from './ExecutionTimeline';
import {
  ResourceThumbImage,
  resourceIcon,
  resourceImagePreviewUrl,
  resourceKey,
  type ResourceCategoryTab,
} from './ResourcePickerDialog';
import {
  findSuperAgentMode,
  ModeResourceShowcase,
  type PickPromptMeta,
  type SuperAgentCreationModeId,
} from './ModeResourceShowcase';
import {
  buildModeContextTags,
  buildModeHiddenDirective,
  DEFAULT_MODE_COMPOSER_OPTIONS,
  designScenarioOptionsPatch,
  formatModePromptPrefix,
  getModeComposerPlaceholder,
  ModeComposerControls,
  ModeComposerTopBar,
  isPlayableAd,
  researchDesignScenario,
  visualizationDesignScenario,
  type MediaPromptExtra,
  type ModeComposerOptions,
} from './ModeComposerControls';
import { GamePublishThread } from './gamePublish/GamePublishThread';
import { gamePublishActions, useGamePublishThread } from './gamePublish/gamePublishStore';

export function resolveCreationModeEntry(
  mode: SuperAgentCreationModeId | null,
  designModule?: SuperAgentDesignModuleId | null,
): { modeId: SuperAgentCreationModeId | null; optionsPatch?: Partial<ModeComposerOptions> } {
  if (mode === 'design') {
    if (designModule && isDesignScenario(designModule)) {
      return { modeId: 'design', optionsPatch: designScenarioOptionsPatch(designModule) };
    }
    return { modeId: 'design', optionsPatch: { designFormat: 'image', imageScene: 'text-to-image' } };
  }
  if (mode === 'website') {
    return { modeId: 'design', optionsPatch: designScenarioOptionsPatch('prototype') };
  }
  if (mode === 'deck') {
    return { modeId: 'design', optionsPatch: designScenarioOptionsPatch('deck') };
  }
  if (mode === 'document') {
    return { modeId: 'design', optionsPatch: designScenarioOptionsPatch('document') };
  }
  if (mode === 'image') {
    return { modeId: 'design', optionsPatch: { designFormat: 'image', imageScene: 'text-to-image' } };
  }
  if (mode === 'motion') {
    return { modeId: 'motion', optionsPatch: { motionEngine: DEFAULT_MODE_COMPOSER_OPTIONS.motionEngine } };
  }
  if (mode === 'media') {
    return { modeId: 'media', optionsPatch: { mediaSubMode: DEFAULT_MODE_COMPOSER_OPTIONS.mediaSubMode } };
  }
  if (mode === 'audio') {
    return {
      modeId: 'audio',
      optionsPatch: {
        audioType: DEFAULT_MODE_COMPOSER_OPTIONS.audioType,
        audioModelId: DEFAULT_MODE_COMPOSER_OPTIONS.audioModelId,
      },
    };
  }
  return { modeId: mode };
}

const PRIMARY_STARTERS: {
  key?: string;
  id: SuperAgentCreationModeId;
  designModule?: SuperAgentDesignModuleId;
  optionsPatch?: Partial<ModeComposerOptions>;
  tone: 'coding' | 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  title: string;
  featured?: boolean;
  badge?: string;
}[] = [
  { id: 'game', tone: 'agent', icon: 'gamepad-line', title: 'Build a game', featured: true, badge: 'New' },
  { key: 'design', id: 'design', tone: 'image', icon: 'palette-line', title: 'Design Studio', badge: 'New' },
  { key: 'motion-graphics', id: 'motion', optionsPatch: { motionEngine: 'motion' }, tone: 'video', icon: 'movie-line', title: 'Motion graphics' },
  { key: 'video', id: 'motion', optionsPatch: { motionEngine: 'video-model' }, tone: 'video', icon: 'clapperboard-line', title: 'Make a video' },
  { key: 'deck', id: 'design', designModule: 'deck', tone: 'audio', icon: 'slideshow-line', title: 'Create slides' },
];

const EXTRA_STARTERS: {
  key: string;
  id: SuperAgentCreationModeId;
  designModule?: SuperAgentDesignModuleId;
  optionsPatch?: Partial<ModeComposerOptions>;
  tone: 'coding' | 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  title: string;
}[] = [
  { key: 'research', id: 'research', tone: 'agent', icon: 'book-open-line', title: 'Research a topic' },
  { key: 'visualization', id: 'visualization', tone: 'coding', icon: 'bar-chart-box-line', title: 'Visualization' },
  { key: 'document', id: 'design', designModule: 'document', tone: 'image', icon: 'file-text-line', title: 'Document' },
  { key: 'image', id: 'design', designModule: 'image', tone: 'image', icon: 'image-line', title: 'Generate image' },
  { key: 'website', id: 'design', designModule: 'prototype', tone: 'image', icon: 'layout-line', title: 'Build a website' },
  { key: 'audio', id: 'audio', tone: 'audio', icon: 'music-2-line', title: 'Create audio' },
  { key: 'coding', id: 'coding', tone: 'coding', icon: 'code-s-slash-line', title: 'Coding' },
];

const COMPOSER_MODES = (['game', 'design', 'motion', 'research', 'visualization', 'audio', 'media', 'coding'] satisfies SuperAgentCreationModeId[])
  .map(findSuperAgentMode)
  .filter(mode => mode !== null);

export type AgentSelection = {
  runtimeId?: string;
  engine: SuperAgentEngine;
  model: string;
  reasoning: string;
};

type MinimalFsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: MinimalFsEntry[]) => void, error?: (err: unknown) => void) => void };
};

async function collectDroppedFiles(dataTransfer: DataTransfer | null): Promise<File[]> {
  if (!dataTransfer) return [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entryGetters = items
    .map(item => (typeof (item as unknown as { webkitGetAsEntry?: () => MinimalFsEntry | null }).webkitGetAsEntry === 'function'
      ? (item as unknown as { webkitGetAsEntry: () => MinimalFsEntry | null }).webkitGetAsEntry()
      : null))
    .filter((entry): entry is MinimalFsEntry => Boolean(entry));

  if (entryGetters.length > 0) {
    const collected: File[] = [];
    const maxFiles = 30;
    const readEntry = async (entry: MinimalFsEntry, prefix = ''): Promise<void> => {
      if (collected.length >= maxFiles) return;
      if (entry.isFile && typeof entry.file === 'function') {
        const file = await new Promise<File | null>(resolve => {
          entry.file!(f => resolve(f), () => resolve(null));
        });
        if (file) {
          const nextName = prefix ? `${prefix}/${file.name}` : file.name;
          collected.push(nextName !== file.name ? new File([file], nextName, { type: file.type, lastModified: file.lastModified }) : file);
        }
        return;
      }
      if (entry.isDirectory && typeof entry.createReader === 'function') {
        const reader = entry.createReader();
        const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        while (collected.length < maxFiles) {
          const batch = await new Promise<MinimalFsEntry[]>(resolve => {
            reader.readEntries(entries => resolve(entries), () => resolve([]));
          });
          if (!batch.length) break;
          for (const child of batch) {
            if (collected.length >= maxFiles) break;
            await readEntry(child, dirPrefix);
          }
        }
      }
    };
    for (const entry of entryGetters) {
      if (collected.length >= maxFiles) break;
      await readEntry(entry);
    }
    if (collected.length > 0) return collected;
  }

  return dataTransfer.files ? Array.from(dataTransfer.files).slice(0, 30) : [];
}

export function ConversationStream({
  active = true,
  chat,
  conversations = [],
  activeArtifacts = [],
  requestedMode = null,
  requestedDesignModule = null,
  playingGameId = null,
  loading,
  loadFailed,
  sending,
  sidebarOpen,
  viewerOpen,
  counts,
  attachments,
  draftSeed = null,
  gameTemplateSeed = null,
  agents,
  agentsLoaded = true,
  runtimes,
  localDirectAvailable = true,
  selection,
  permissionMode,
  followUpBehavior = 'steer',
  onBack,
  onChangeRequestedMode,
  onPlayGame,
  onDeployGame,
  onRetryLoad,
  onOpenSidebar,
  onToggleViewer,
  onRenameChat,
  onChangeSelection,
  onChangePermissionMode,
  onSend,
  onUpdateQueued,
  onDeleteQueued,
  onSendQueuedNow,
  onStop,
  onApprove,
  onResourcesUploaded,
  onAttachmentsChange,
  onOpenArtifactId,
  onOpenChangedFile,
  onPreviewAttachment,
  onOpenFilePath,
  onOpenWebUrl,
  onCopyText,
  onNotify,
  onRunCommand,
  onOpenAccountSettings,
  onTriggerActionCard,
  onOpenInDesignStudio,
  onOpenInMotionStudio,
  onOpenInAssets,
  onOpenInBrandKit,
  onOpenAgentSettings,
  onOpenRuntimeSettings,
  onOpenModelSettings,
  onOpenGameStudio,
  onOpenMcp,
  onError,
}: {
  active?: boolean;
  chat: SuperAgentChat | null;
  conversations?: SuperAgentChatSummary[];
  activeArtifacts?: SuperAgentArtifact[];
  requestedMode?: SuperAgentCreationModeId | null;
  requestedDesignModule?: SuperAgentDesignModuleId | null;
  playingGameId?: string | null;
  loading: boolean;
  loadFailed: boolean;
  sending: boolean;
  sidebarOpen: boolean;
  viewerOpen: boolean;
  counts: SuperAgentResourceCounts | null;
  attachments: SuperAgentResourceAttachment[];
  draftSeed?: {
    id: number;
    text: string;
    hiddenInstructions?: string;
    contextTags?: SuperAgentContextTag[];
    mode?: SuperAgentCreationModeId;
    designModule?: SuperAgentDesignModuleId;
  } | null;
  gameTemplateSeed?: { id: number; game: GameCard } | null;
  agents: LocalAgent[];
  agentsLoaded?: boolean;
  runtimes?: AgentRuntimeInfo[];
  localDirectAvailable?: boolean;
  selection: AgentSelection;
  permissionMode: SuperAgentPermissionMode;
  followUpBehavior?: SuperAgentFollowUpMode;
  onBack?: () => void;
  onChangeRequestedMode?: (mode: SuperAgentCreationModeId | null) => void;
  onPlayGame?: (game: GameCard) => void;
  onDeployGame?: (game: GameCard) => void;
  onRetryLoad: () => void;
  onOpenSidebar: () => void;
  onToggleViewer: () => void;
  onRenameChat: (title: string) => Promise<void> | void;
  onChangeSelection: (next: AgentSelection) => void;
  onChangePermissionMode: (next: SuperAgentPermissionMode) => void;
  onSend: (
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
    },
  ) => Promise<boolean>;
  onUpdateQueued?: (
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
  ) => Promise<boolean>;
  onDeleteQueued?: (queueId: string) => Promise<void> | void;
  onSendQueuedNow?: (queueId: string) => Promise<void> | void;
  onStop: () => void;
  onApprove: (approvalId: string, accepted: boolean, alwaysAllow?: boolean) => void;
  onResourcesUploaded?: () => void;
  onAttachmentsChange: (next: SuperAgentResourceAttachment[]) => void;
  onOpenArtifactId: (artifactId: string) => void;
  onOpenChangedFile?: (file: SuperAgentFileOperation) => void;
  onPreviewAttachment: (attachment: SuperAgentResourceAttachment) => void;
  onOpenFilePath?: (filePath: string, label?: string) => void;
  onOpenWebUrl?: (url: string) => void;
  onCopyText: (text: string) => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
  onRunCommand?: (command: ComposerCommandId) => void;
  onOpenAccountSettings?: () => void;
  onTriggerActionCard?: (card: SuperAgentActionCard) => void;
  onOpenInDesignStudio?: (projectId: string) => void;
  onOpenInMotionStudio?: (projectId: string) => void;
  onOpenInAssets?: (assetId: string, versionId?: string) => void;
  onOpenInBrandKit?: (kitId?: string) => void;
  onOpenAgentSettings: () => void;
  onOpenRuntimeSettings?: () => void;
  onOpenModelSettings?: () => void;
  onOpenGameStudio?: () => void;
  onOpenMcp: () => void;
  onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  // Publish activity counts as conversation: show it instead of the welcome page.
  const publishEntries = useGamePublishThread(chat?.id);
  const [text, setText] = useState('');
  const [segments, setSegments] = useState<SuperAgentPromptSegment[]>([]);
  const [inlineMentions, setInlineMentions] = useState<SuperAgentResourceAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const cancelRenameRef = useRef(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionMenuSource, setMentionMenuSource] = useState<'at' | 'plus' | 'slash'>('plus');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionCategory, setMentionCategory] = useState<MentionMenuCategory>('all');
  const mentionMenuOpenRef = useRef(mentionMenuOpen);
  mentionMenuOpenRef.current = mentionMenuOpen;
  const mentionMenuSourceRef = useRef(mentionMenuSource);
  mentionMenuSourceRef.current = mentionMenuSource;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const prevInlineKeysRef = useRef<Set<string>>(new Set());
  const prevChatIdRef = useRef<string | undefined>(chat?.id);
  const [moreStartersOpen, setMoreStartersOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [browsingEngine, setBrowsingEngine] = useState<SuperAgentEngine>(selection.engine);
  const [inspectingEngine, setInspectingEngine] = useState<SuperAgentEngine | null>(null);
  const inspectedEnginesRef = useRef<Set<SuperAgentEngine>>(new Set());
  const initialResolvedMode = resolveCreationModeEntry(requestedMode, requestedDesignModule);
  const [activeModeId, setActiveModeId] = useState<SuperAgentCreationModeId | null>(() => initialResolvedMode.modeId);
  const previousRequestedMode = useRef(requestedMode);
  const [modeOptions, setModeOptions] = useState<ModeComposerOptions>(() => ({
    ...DEFAULT_MODE_COMPOSER_OPTIONS,
    ...initialResolvedMode.optionsPatch,
  }));
  const [scaffoldingGame, setScaffoldingGame] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{
    id: string;
    text: string;
    segments?: SuperAgentPromptSegment[];
    attachments: SuperAgentResourceAttachment[];
    contextTags?: SuperAgentContextTag[];
    startedAt: number;
  } | null>(null);
  const [previewingChipKey, setPreviewingChipKey] = useState<string | null>(null);
  const mediaModelsRef = useRef<Model[]>([]);
  const mediaRoutesRef = useRef<GatewayStatus['routes']>({});
  const mediaProvidersRef = useRef<GatewayStatus['providers']>([]);
  const sampleReferenceCacheRef = useRef<Map<string, SuperAgentResourceAttachment>>(new Map());
  const autoSampleKeyRef = useRef<string | null>(null);
  const sampleAttachSeqRef = useRef(0);
  const pendingSampleUploadRef = useRef<Promise<void> | null>(null);
  const submittingRef = useRef(false);
  const activeMode = findSuperAgentMode(activeModeId);
  const headerPresentation = chat ? superAgentChatPresentation(chat) : {
    intent: activeMode?.id === 'design' && modeOptions.designFormat === 'image'
      ? 'image' as const
      : modeToSuperAgentIntent(activeMode?.id),
    designScenario: activeMode?.id === 'design' && modeOptions.designFormat === 'html' ? modeOptions.designScenario : undefined,
    isGeneratedVideo: (activeMode?.id === 'motion' && modeOptions.motionEngine === 'video-model')
      || (activeMode?.id === 'media' && modeOptions.mediaSubMode === 'video'),
  };
  const headerIntentMeta = superAgentIntentMeta(headerPresentation.intent, headerPresentation);
  const modeOptionsRef = useRef<ModeComposerOptions>(modeOptions);
  modeOptionsRef.current = modeOptions;
  const [templateRevision, setTemplateRevision] = useState(0);
  const updateModeOptions = useCallback((patch: Partial<ModeComposerOptions>) => {
    setModeOptions(prev => {
      const next = { ...prev, ...patch };
      modeOptionsRef.current = next;
      return next;
    });
  }, []);
  const enterMode = useCallback((
    mode: SuperAgentCreationModeId | null,
    designModule?: SuperAgentDesignModuleId | null,
    extraOptions?: Partial<ModeComposerOptions>,
  ) => {
    const resolved = resolveCreationModeEntry(mode, designModule);
    setActiveModeId(resolved.modeId);
    const mergedPatch = {
      ...(resolved.optionsPatch ?? {}),
      ...(extraOptions ?? {}),
    };
    if (Object.keys(mergedPatch).length > 0) {
      updateModeOptions(mergedPatch);
    }
  }, [updateModeOptions]);
  const handleCatalogChange = useCallback((cat: {
    models: Model[];
    routes: GatewayStatus['routes'];
    providers?: GatewayStatus['providers'];
  }) => {
    mediaModelsRef.current = cat.models;
    mediaRoutesRef.current = cat.routes;
    mediaProvidersRef.current = cat.providers ?? [];
  }, []);

  useEffect(() => {
    setBrowsingEngine(selection.engine);
  }, [selection.engine]);

  const appliedDraftSeedRef = useRef<number | null>(null);
  const pendingHiddenInstructionsRef = useRef<string | undefined>(undefined);
  const pendingContextTagsRef = useRef<SuperAgentContextTag[] | undefined>(undefined);
  useEffect(() => {
    if (!draftSeed || appliedDraftSeedRef.current === draftSeed.id) return;
    appliedDraftSeedRef.current = draftSeed.id;
    setText(draftSeed.text);
    setSegments([]);
    setInlineMentions([]);
    prevInlineKeysRef.current = new Set();
    composerRef.current?.setPlainText(draftSeed.text);
    pendingHiddenInstructionsRef.current = draftSeed.hiddenInstructions?.trim() || undefined;
    pendingContextTagsRef.current = draftSeed.contextTags?.length ? draftSeed.contextTags : undefined;
    if (draftSeed.mode && !chat?.messages.length) {
      enterMode(draftSeed.mode, draftSeed.designModule);
    } else if (!draftSeed.mode) {
      setActiveModeId(null);
      setModeOptions(prev => (prev.gameTemplate ? { ...prev, gameTemplate: null } : prev));
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [draftSeed, chat?.messages.length, enterMode]);

  const appliedGameTemplateSeedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!gameTemplateSeed || appliedGameTemplateSeedRef.current === gameTemplateSeed.id) return;
    appliedGameTemplateSeedRef.current = gameTemplateSeed.id;
    const picked = gameTemplateSeed.game;
    if (picked.multiplayer) return;
    if (!chat?.messages.length) {
      setActiveModeId('game');
      updateModeOptions({
        gameTemplate: picked,
      });
    } else {
      if (!text.trim()) {
        const remixPrompt = t('Remix · {title}', { title: localizedGameTitle(picked, locale) });
        setText(remixPrompt);
        composerRef.current?.setPlainText(remixPrompt);
      }
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [gameTemplateSeed, chat?.messages.length, locale, t, updateModeOptions]);

  useEffect(() => {
    if (!active) {
      setMentionMenuOpen(false);
      setMoreStartersOpen(false);
      setModelMenuOpen(false);
      setApprovalMenuOpen(false);
      setPreviewingChipKey(null);
    }
  }, [active]);

  useEffect(() => {
    if (previewingChipKey && !attachments.some(att => resourceKey(att) === previewingChipKey)) {
      setPreviewingChipKey(null);
    }
  }, [attachments, previewingChipKey]);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const mentionMenuRef = useRef<ComposerMentionMenuHandle>(null);
  const composerRef = useRef<ComposerPromptEditorHandle>(null);
  const dockRef = useRef<DockableComposerHandle>(null);
  // A single portal keeps the Lexical editor, mentions and undo history alive as its placement changes.
  const [composerHost] = useState(() => {
    const host = document.createElement('div');
    host.className = 'om-sa-composer-placement';
    return host;
  });
  const mountComposer = useCallback((node: HTMLDivElement | null) => {
    if (node) node.appendChild(composerHost);
  }, [composerHost]);
  const focusEditor = useCallback(() => composerRef.current?.focus(), []);
  const focusModeComposer = useCallback(() => {
    if (dockRef.current) dockRef.current.focus();
    else focusEditor();
  }, [focusEditor]);
  const composerShellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const activeRuntime = useMemo(() => {
    if (!runtimes?.length) return undefined;
    return runtimes.find(rt => rt.id === selection.runtimeId)
      ?? runtimes.find(rt => rt.status === 'online')
      ?? runtimes[0];
  }, [runtimes, selection.runtimeId]);

  const effectiveAgents = activeRuntime ? activeRuntime.agents : agents;
  const runtimeOnline = !activeRuntime || (activeRuntime.status !== 'offline' && activeRuntime.status !== 'disabled');

  const runnableEngines = useMemo(
    () => (runtimeOnline ? effectiveAgents.filter(item => item.installed && item.auth !== 'signed-out') : []),
    [effectiveAgents, runtimeOnline],
  );
  const activeAgent = effectiveAgents.find(item => item.id === selection.engine) ?? effectiveAgents[0];
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const pendingApprovals = chat?.approvals ?? [];
  const hasPendingApproval = pendingApprovals.length > 0;
  const approvalKey = pendingApprovals.map(item => item.id).join(',');
  const busy = chat?.state === 'running' || chat?.state === 'waiting';
  const isRunning = chat?.state === 'running' && !hasPendingApproval;
  const queuedMessages = chat?.queuedMessages ?? [];

  useEffect(() => {
    setEditingQueuedId(null);
  }, [chat?.id]);

  useEffect(() => {
    if (editingQueuedId && !queuedMessages.some(item => item.id === editingQueuedId)) {
      setEditingQueuedId(null);
    }
  }, [editingQueuedId, queuedMessages]);

  const hasBrowserAnnotation = attachments.some(att => att.kind === 'browser-annotation');
  const hasAttachedGameProject = attachments.some(att => att.kind === 'game-project');
  const gameBrief = activeMode?.id === 'game'
    ? composeBrief({
        prompt: text,
        genre: modeOptions.gameGenre,
        style: modeOptions.gameStyle,
        setting: modeOptions.gameSetting,
        multiplayer: false,
      })
    : '';
  const hasGameStudioBrief = activeMode?.id === 'game' && !hasAttachedGameProject && Boolean(modeOptions.gameTemplate || gameBrief);
  const hasInlineMentions = inlineMentions.length > 0;
  const hasDraft = Boolean(text.trim()) || hasInlineMentions || hasBrowserAnnotation || hasGameStudioBrief;
  const canSubmit = hasDraft && !sending && !scaffoldingGame && !hasPendingApproval && !loading && (Boolean(editingQueuedId) || runnableEngines.length > 0);

  const engineChoices = useMemo(() => {
    if (activeRuntime?.kind === 'remote-service') {
      return effectiveAgents.map(agent => ({
        id: agent.id as SuperAgentEngine,
        label: agent.label,
        agent: agent as LocalAgent | undefined,
        ready: Boolean(runtimeOnline && agent.installed && agent.auth !== 'signed-out'),
      }));
    }
    const installed = effectiveAgents.filter(item => item.installed || item.id === selection.engine);
    const list = installed.length > 0
      ? installed
      : effectiveAgents.filter(item => item.id === 'codex' || item.id === 'claude');
    if (list.length === 0) {
      return [
        { id: 'codex', label: 'Codex', agent: undefined as LocalAgent | undefined, ready: false },
        { id: 'claude', label: 'Claude Code', agent: undefined as LocalAgent | undefined, ready: false },
      ];
    }
    return list.map(agent => ({
      id: agent.id as SuperAgentEngine,
      label: agent.label,
      agent: agent as LocalAgent | undefined,
      ready: Boolean(runtimeOnline && agent.installed && agent.auth !== 'signed-out'),
    }));
  }, [activeRuntime?.kind, effectiveAgents, runtimeOnline, selection.engine]);

  const browsingChoice = engineChoices.find(item => item.id === browsingEngine) ?? engineChoices[0];

  // Proactively prewarm installed un-inspected local agents (e.g. Antigravity, Codex, Claude)
  // in the background when Super Agent becomes active so switching agents in the picker is instant.
  useEffect(() => {
    if (!active) return;
    if (activeRuntime?.kind === 'remote-service') return;
    if (activeRuntime?.kind === 'local-bridge' && activeRuntime.status !== 'online') return;
    const runtimeKey = activeRuntime?.id ?? 'local';
    const candidates = engineChoices
      .map(item => item.agent)
      .filter((agent): agent is LocalAgent => Boolean(
        agent
        && agent.installed
        && !agent.checkedAt
        && agent.models.length === 0
        && !inspectedEnginesRef.current.has(`${runtimeKey}:${agent.id}`),
      ))
      .slice(0, 4);
    if (!candidates.length) return;
    let cancelled = false;
    for (const target of candidates) {
      inspectedEnginesRef.current.add(`${runtimeKey}:${target.id}`);
      const req = activeRuntime?.kind === 'local-bridge'
        ? inspectBridgeAgent(activeRuntime.id, target.id).then(() => { if (!cancelled) notifyRuntimesChanged(); })
        : gatewayRequest(`settings/agents/${target.id}/inspect`, 'POST', {}).then(() => { if (!cancelled) notifyAgentsChanged(); });
      void req.catch(() => { /* keep fallback default option */ });
    }
    return () => {
      cancelled = true;
    };
  }, [active, activeRuntime?.id, activeRuntime?.kind, activeRuntime?.status, engineChoices]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    if (activeRuntime?.kind === 'remote-service') return;
    if (activeRuntime?.kind === 'local-bridge' && activeRuntime.status !== 'online') return;
    const target = browsingChoice?.agent;
    const inspectKey = `${activeRuntime?.id ?? 'local'}:${browsingChoice?.id ?? ''}`;
    if (!target?.installed || target.checkedAt || target.models.length > 0 || inspectedEnginesRef.current.has(inspectKey)) {
      return;
    }
    inspectedEnginesRef.current.add(inspectKey);
    setInspectingEngine(browsingChoice.id);
    let cancelled = false;
    const req = activeRuntime?.kind === 'local-bridge'
      ? inspectBridgeAgent(activeRuntime.id, target.id).then(() => { if (!cancelled) notifyRuntimesChanged(); })
      : gatewayRequest(`settings/agents/${target.id}/inspect`, 'POST', {}).then(() => { if (!cancelled) notifyAgentsChanged(); });
    void req
      .catch(() => { /* keep fallback default option */ })
      .finally(() => {
        if (!cancelled) setInspectingEngine(current => (current === browsingChoice.id ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [modelMenuOpen, activeRuntime?.id, activeRuntime?.kind, activeRuntime?.status, browsingChoice?.id, browsingChoice?.agent]);

  useEffect(() => {
    if (requestedMode && !chat?.messages.length) {
      enterMode(requestedMode, requestedDesignModule);
    } else if (!requestedMode && previousRequestedMode.current && !chat?.id && !draftSeed?.mode) {
      setActiveModeId(null);
    }
    previousRequestedMode.current = requestedMode;
  }, [requestedMode, requestedDesignModule, chat?.id, chat?.messages.length, draftSeed?.mode, enterMode]);

  useEffect(() => {
    const prevId = prevChatIdRef.current;
    prevChatIdRef.current = chat?.id;
    setRenaming(false);
    setMentionMenuOpen(false);
    setEditingQueuedId(null);
    if (prevId && prevId !== chat?.id) {
      setText('');
      setSegments([]);
      setInlineMentions([]);
      prevInlineKeysRef.current = new Set();
      composerRef.current?.clear();
    }
    if (requestedMode && !chat?.messages.length) {
      enterMode(requestedMode, requestedDesignModule);
    } else if (
      (Boolean(prevId) || Boolean(chat?.messages.length))
      && (!draftSeed || appliedDraftSeedRef.current !== draftSeed.id || !draftSeed.mode)
    ) {
      setActiveModeId(null);
      pendingHiddenInstructionsRef.current = undefined;
      pendingContextTagsRef.current = undefined;
      setModeOptions(prev => (prev.gameTemplate ? { ...prev, gameTemplate: null } : prev));
    }
    followRef.current = true;
  }, [chat?.id]);

  const handleComposerSnapshotChange = useCallback(
    (snap: ComposerSnapshot) => {
      setText(snap.text);
      setSegments(snap.segments);
      setInlineMentions(snap.mentions);

      const nextKeys = new Set(snap.mentions.map(resourceKey));
      const removed = new Set<string>();
      for (const k of prevInlineKeysRef.current) {
        if (!nextKeys.has(k)) removed.add(k);
      }
      prevInlineKeysRef.current = nextKeys;

      const currentAtts = attachmentsRef.current;
      const existingKeys = new Set(currentAtts.map(resourceKey));
      const added = snap.mentions.filter(item => !existingKeys.has(resourceKey(item)));
      if (removed.size > 0 || added.length > 0) {
        const filtered = currentAtts.filter(item => !removed.has(resourceKey(item)));
        onAttachmentsChange([...filtered, ...added].slice(0, 30));
      }
    },
    [onAttachmentsChange],
  );

  const handleComposerTriggerChange = useCallback((trig: ComposerMentionTrigger) => {
    if (trig?.active) {
      setMentionQuery(trig.query);
      setMentionMenuSource(trig.kind);
      setMentionMenuOpen(prev => {
        if (!prev) setMentionCategory('all');
        return true;
      });
    } else if (
      mentionMenuOpenRef.current
      && (mentionMenuSourceRef.current === 'at' || mentionMenuSourceRef.current === 'slash')
    ) {
      setMentionMenuOpen(false);
    }
  }, []);

  const handleSelectMentionItem = useCallback(
    (item: SuperAgentResourceAttachment) => {
      const replaceTrigger = mentionMenuSourceRef.current === 'at';
      composerRef.current?.insertMention(item, { replaceTrigger });
      const key = resourceKey(item);
      if (!attachmentsRef.current.some(existing => resourceKey(existing) === key)) {
        onAttachmentsChange([...attachmentsRef.current, item].slice(0, 30));
      }
      if (item.kind === 'motion-template') {
        if (activeModeId === 'motion') updateModeOptions({ motionEngine: 'motion' });
        else if (activeModeId === 'media') updateModeOptions({ mediaSubMode: 'motion' });
      }
      setMentionMenuOpen(false);
      setMentionQuery('');
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [onAttachmentsChange, activeModeId, updateModeOptions],
  );

  const handleMenuKey = useCallback((action: 'up' | 'down' | 'confirm' | 'escape') => {
    if (action === 'up') mentionMenuRef.current?.move(-1);
    else if (action === 'down') mentionMenuRef.current?.move(1);
    else if (action === 'confirm') mentionMenuRef.current?.confirm();
    else if (action === 'escape') {
      setMentionMenuOpen(false);
      composerRef.current?.focus();
    }
  }, []);

  const toggleResourceAttachment = (item: SuperAgentResourceAttachment) => {
    const key = resourceKey(item);
    const exists = attachments.some(existing => resourceKey(existing) === key);
    if (exists) {
      onAttachmentsChange(attachments.filter(existing => resourceKey(existing) !== key));
      return false;
    }
    if (attachments.length >= 30) return false;
    onAttachmentsChange([...attachments, item]);
    if (item.kind === 'motion-template') {
      if (activeModeId === 'motion') updateModeOptions({ motionEngine: 'motion' });
      else if (activeModeId === 'media') updateModeOptions({ mediaSubMode: 'motion' });
    }
    return true;
  };

  useEffect(() => {
    const hasTimeline = Boolean(chat?.messages.length || chat?.approvals.length);
    if (hasTimeline && followRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [chat?.updatedAt, chat?.messages.length, chat?.approvals.length]);

  useEffect(() => {
    if (!approvalKey) return;
    followRef.current = true;
    const raf = window.requestAnimationFrame(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [approvalKey]);

  useEffect(() => {
    if (!chat?.messages.length && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [activeModeId, chat?.id, chat?.messages.length]);

  const focusComposerAfterModeChange = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const exitActiveMode = useCallback(() => {
    sampleAttachSeqRef.current += 1;
    autoSampleKeyRef.current = null;
    pendingSampleUploadRef.current = null;
    setActiveModeId(null);
    updateModeOptions({ gameTemplate: null });
    if (requestedMode) onChangeRequestedMode?.(null);
    focusComposerAfterModeChange();
  }, [requestedMode, onChangeRequestedMode, updateModeOptions, focusComposerAfterModeChange]);

  const applyPickedPromptMeta = useCallback((meta?: PickPromptMeta) => {
    const seq = ++sampleAttachSeqRef.current;
    if (meta?.optionsPatch) {
      updateModeOptions(meta.optionsPatch);
    }
    const prevAutoKey = autoSampleKeyRef.current;
    const ref = meta?.referenceImage ?? null;
    if (!ref) {
      pendingSampleUploadRef.current = null;
      if (prevAutoKey && attachmentsRef.current.some(att => resourceKey(att) === prevAutoKey)) {
        const next = attachmentsRef.current.filter(att => resourceKey(att) !== prevAutoKey);
        attachmentsRef.current = next;
        onAttachmentsChange(next);
      }
      autoSampleKeyRef.current = null;
      return;
    }

    const inferSampleMime = (filename: string) => {
      const lower = filename.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
      if (lower.endsWith('.webp')) return 'image/webp';
      return 'image/png';
    };

    const attachUploaded = (uploaded: SuperAgentResourceAttachment) => {
      if (seq !== sampleAttachSeqRef.current) return;
      const nextKey = resourceKey(uploaded);
      const base = prevAutoKey && prevAutoKey !== nextKey
        ? attachmentsRef.current.filter(att => resourceKey(att) !== prevAutoKey)
        : [...attachmentsRef.current];
      if (!base.some(att => resourceKey(att) === nextKey)) {
        base.push(uploaded);
      }
      const capped = base.slice(0, 30);
      autoSampleKeyRef.current = nextKey;
      attachmentsRef.current = capped;
      onAttachmentsChange(capped);
    };

    const cached = sampleReferenceCacheRef.current.get(ref.url);
    if (cached) {
      pendingSampleUploadRef.current = null;
      attachUploaded(cached);
      return;
    }

    const uploadTask = (async () => {
      try {
        let res = await fetch(ref.url).catch(() => null);
        if ((!res || !res.ok) && ref.fallbackUrl) {
          res = await fetch(ref.fallbackUrl).catch(() => null);
        }
        if (!res || !res.ok) {
          throw new Error(`HTTP ${res?.status ?? 0}`);
        }
        const blob = await res.blob();
        if (!blob.size) throw new Error('Reference sample image was empty');
        const mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : inferSampleMime(ref.filename);
        const file = new File([blob], ref.filename, { type: mime });
        const uploaded = await uploadSuperAgentFile(file);
        const titled: SuperAgentResourceAttachment = ref.title
          ? { ...uploaded, title: uploaded.title || ref.title }
          : uploaded;
        sampleReferenceCacheRef.current.set(ref.url, titled);
        if (seq !== sampleAttachSeqRef.current) return;
        attachUploaded(titled);
        if (titled.kind === 'asset') onResourcesUploaded?.();
      } catch (error) {
        if (seq !== sampleAttachSeqRef.current) return;
        onError(error instanceof Error ? error.message : t('Could not attach reference sample'));
      } finally {
        if (seq === sampleAttachSeqRef.current) {
          pendingSampleUploadRef.current = null;
        }
      }
    })();
    pendingSampleUploadRef.current = uploadTask;
  }, [onAttachmentsChange, onError, onResourcesUploaded, t, updateModeOptions]);

  const switchActiveMode = (value: string) => {
    const mode = findSuperAgentMode(value);
    if (!mode) return;
    setActiveModeId(mode.id);
    onChangeRequestedMode?.(mode.id);
    focusComposerAfterModeChange();
  };

  const handleStartEditQueued = (item: SuperAgentQueuedMessage) => {
    setEditingQueuedId(item.id);
    setText(item.text);
    setSegments(item.segments ?? []);
    const itemAtts = item.attachments ? [...item.attachments] : [];
    onAttachmentsChange(itemAtts);
    const mentionKeys = new Set(
      (item.segments ?? []).filter(seg => seg.type === 'mention').map(seg => seg.attachmentKey),
    );
    const matchedInline = itemAtts.filter(att => mentionKeys.has(resourceKey(att)));
    setInlineMentions(matchedInline);
    prevInlineKeysRef.current = new Set(matchedInline.map(resourceKey));
    composerRef.current?.setStructuredContent(item.text, item.segments, itemAtts);
    pendingHiddenInstructionsRef.current = item.hiddenInstructions;
    pendingContextTagsRef.current = item.contextTags;
    if (item.mode && findSuperAgentMode(item.mode)) {
      setActiveModeId(item.mode);
      if (item.workingDir) {
        updateModeOptions({ codingWorkdir: item.workingDir });
      }
    } else {
      setActiveModeId(null);
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleCancelEditQueued = () => {
    setEditingQueuedId(null);
    setText('');
    setSegments([]);
    setInlineMentions([]);
    prevInlineKeysRef.current = new Set();
    composerRef.current?.clear();
    onAttachmentsChange([]);
    pendingHiddenInstructionsRef.current = undefined;
    pendingContextTagsRef.current = undefined;
    setActiveModeId(null);
  };

  const clearComposerAfterSubmit = (options?: { clearAttachments?: boolean; resetMode?: boolean }) => {
    setText('');
    setSegments([]);
    setInlineMentions([]);
    prevInlineKeysRef.current = new Set();
    composerRef.current?.clear();
    setMentionMenuOpen(false);
    autoSampleKeyRef.current = null;
    pendingHiddenInstructionsRef.current = undefined;
    pendingContextTagsRef.current = undefined;
    if (options?.clearAttachments) {
      attachmentsRef.current = [];
      onAttachmentsChange([]);
    }
    if (options?.resetMode) {
      setActiveModeId(null);
      updateModeOptions({ gameTemplate: null });
    }
  };

  const restoreComposerDraft = (snapshot: {
    text: string;
    segments: SuperAgentPromptSegment[];
    mentions: SuperAgentResourceAttachment[];
    attachments: SuperAgentResourceAttachment[];
    hiddenInstructions?: string;
    contextTags?: SuperAgentContextTag[];
    modeId: SuperAgentCreationModeId | null;
    gameTemplate: ModeComposerOptions['gameTemplate'];
    editingQueuedId?: string | null;
  }) => {
    const currentSnap = composerRef.current?.getSnapshot();
    if (currentSnap && (currentSnap.text.trim() || currentSnap.mentions.length > 0)) {
      return;
    }
    if (snapshot.editingQueuedId !== undefined) {
      setEditingQueuedId(snapshot.editingQueuedId);
    }
    setText(snapshot.text);
    setSegments(snapshot.segments);
    setInlineMentions(snapshot.mentions);
    prevInlineKeysRef.current = new Set(snapshot.mentions.map(resourceKey));
    composerRef.current?.setStructuredContent(snapshot.text, snapshot.segments, snapshot.attachments);
    attachmentsRef.current = snapshot.attachments;
    onAttachmentsChange(snapshot.attachments);
    pendingHiddenInstructionsRef.current = snapshot.hiddenInstructions;
    pendingContextTagsRef.current = snapshot.contextTags;
    if (snapshot.modeId) {
      setActiveModeId(snapshot.modeId);
    }
    if (snapshot.gameTemplate) {
      updateModeOptions({ gameTemplate: snapshot.gameTemplate });
    }
  };

  const handleSubmit = async (overrideBehavior?: SuperAgentFollowUpMode) => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    try {
      if (pendingSampleUploadRef.current) {
        await pendingSampleUploadRef.current;
      }
      const activeModeOptions = modeOptionsRef.current;
      const snap = composerRef.current?.getSnapshot() ?? { text, segments, mentions: inlineMentions };
      const snapText = snap.text || text;
      const snapHasMentions = snap.segments.some(seg => seg.type === 'mention');
      const outgoingSegments = snapHasMentions ? snap.segments : undefined;
      const mergedAttachments: SuperAgentResourceAttachment[] = [...attachmentsRef.current];
      for (const m of snap.mentions) {
        if (!mergedAttachments.some(existing => resourceKey(existing) === resourceKey(m))) {
          mergedAttachments.push(m);
        }
      }
      const cappedAttachments = mergedAttachments.slice(0, 30);
      const draftSnapshot = {
        text: snap.text || text,
        segments: snap.segments,
        mentions: snap.mentions,
        attachments: cappedAttachments,
        hiddenInstructions: pendingHiddenInstructionsRef.current,
        contextTags: pendingContextTagsRef.current,
        modeId: activeModeId,
        gameTemplate: activeModeOptions.gameTemplate ?? null,
      };

      if (!editingQueuedId && activeMode?.id === 'game' && !chat?.messages.length && !cappedAttachments.some(att => att.kind === 'game-project')) {
        const selectedTemplate = activeModeOptions.gameTemplate?.multiplayer ? null : activeModeOptions.gameTemplate;
        setScaffoldingGame(true);
        let gameScaffoldSent = false;
        try {
          const localRemixOverrides = selectedTemplate && !selectedTemplate.external
            ? {
                ...(activeModeOptions.gameGenre ? { genre: activeModeOptions.gameGenre } : {}),
                ...(activeModeOptions.gameStyle ? { style: activeModeOptions.gameStyle } : {}),
                ...(activeModeOptions.gameSetting ? { setting: activeModeOptions.gameSetting } : {}),
                ...(activeModeOptions.gameOrientation ? { orientation: activeModeOptions.gameOrientation } : {}),
              }
            : undefined;
          const created = selectedTemplate && !selectedTemplate.external
            ? await gameApi.remix(selectedTemplate.id, localRemixOverrides)
            : await gameApi.create(
                selectedTemplate?.external
                  ? {
                      prompt: [communityRemixPrompt(selectedTemplate), snapText.trim()].filter(Boolean).join('\n\n'),
                      genre: activeModeOptions.gameGenre ?? selectedTemplate.genre,
                      style: activeModeOptions.gameStyle ?? selectedTemplate.style,
                      setting: activeModeOptions.gameSetting ?? selectedTemplate.setting,
                      multiplayer: false,
                      orientation: activeModeOptions.gameOrientation ?? selectedTemplate.orientation ?? 'landscape',
                      playableAd: isPlayableAd(activeModeOptions) || (activeModeOptions.gameOrientation === null && Boolean(selectedTemplate.playableAd)),
                    }
                  : {
                      prompt: snapText.trim() || gameBrief,
                      genre: activeModeOptions.gameGenre,
                      style: activeModeOptions.gameStyle,
                      setting: activeModeOptions.gameSetting,
                      multiplayer: false,
                      ...(activeModeOptions.gameOrientation ? { orientation: activeModeOptions.gameOrientation } : {}),
                      playableAd: isPlayableAd(activeModeOptions),
                    },
              );
          rememberInstruction(created.game.id, created.agentInstruction);
          const displayTitle = localizedGameTitle(created.game, locale);
          const ready = created.game.status === 'ready' || created.game.status === 'published';
          const userVisiblePrompt = snapText.trim()
            || (selectedTemplate
              ? t('Remix · {title}', { title: localizedGameTitle(selectedTemplate, locale) })
              : buildGameUserPrompt(created.game, locale));
          const remixOverrideParts = selectedTemplate && !selectedTemplate.external
            ? [
                activeModeOptions.gameGenre && activeModeOptions.gameGenre !== selectedTemplate.genre
                  ? `Genre: ${genreLabels[activeModeOptions.gameGenre]}`
                  : '',
                activeModeOptions.gameStyle && activeModeOptions.gameStyle !== selectedTemplate.style
                  ? `Style: ${styleLabels[activeModeOptions.gameStyle]}`
                  : '',
                activeModeOptions.gameSetting && activeModeOptions.gameSetting !== selectedTemplate.setting
                  ? `Setting: ${settingLabels[activeModeOptions.gameSetting]}`
                  : '',
                activeModeOptions.gameOrientation && activeModeOptions.gameOrientation !== (selectedTemplate.orientation ?? 'landscape')
                  ? `Layout: ${activeModeOptions.gameOrientation === 'portrait' ? 'Portrait (9:16)' : 'Landscape (16:9)'}`
                  : '',
              ].filter(Boolean)
            : [];
          const remixUserNotes = [
            remixOverrideParts.length > 0 ? `Requested remix overrides: ${remixOverrideParts.join(', ')}.` : '',
            snapText.trim(),
          ].filter(Boolean).join('\n');
          const effectiveGameForInstructions = selectedTemplate && !selectedTemplate.external
            ? {
                ...created.game,
                genre: activeModeOptions.gameGenre ?? created.game.genre,
                style: activeModeOptions.gameStyle ?? created.game.style,
                setting: activeModeOptions.gameSetting ?? created.game.setting,
                orientation: activeModeOptions.gameOrientation ?? created.game.orientation,
                playableAd: (activeModeOptions.gameOrientation ?? created.game.orientation) === 'landscape'
                  ? false
                  : created.game.playableAd,
              }
            : created.game;
          const hiddenInstructions = buildGameHiddenInstructions(
            effectiveGameForInstructions,
            created.agentInstruction,
            selectedTemplate && remixUserNotes ? remixUserNotes : undefined,
          );
          const contextTags: SuperAgentContextTag[] = [
            ...buildGameContextTags(
              { ...effectiveGameForInstructions, playableAd: isPlayableAd(activeModeOptions) || Boolean(effectiveGameForInstructions.playableAd) },
              t,
            ),
            ...(selectedTemplate
              ? [{ kind: 'param' as const, label: `${t('Remix')} · ${localizedGameTitle(selectedTemplate, locale)}` }]
              : []),
          ];
          const nextAttachments = [...cappedAttachments, toGameResourceAttachment(effectiveGameForInstructions, displayTitle)];
          clearComposerAfterSubmit({ clearAttachments: true, resetMode: true });
          followRef.current = true;
          gameScaffoldSent = true;
          const ok = await onSend(userVisiblePrompt, {
            ...(outgoingSegments ? { segments: outgoingSegments } : {}),
            hiddenInstructions,
            contextTags,
            mode: 'game',
            overrideAttachments: nextAttachments,
            ...(ready ? { initialArtifact: toGameArtifact(effectiveGameForInstructions, displayTitle) } : {}),
          });
          if (!ok) {
            restoreComposerDraft(draftSnapshot);
          }
          return;
        } catch {
          if (gameScaffoldSent) {
            restoreComposerDraft(draftSnapshot);
            return;
          }
          // Fall back to prompt prefix when offline or local game service is unavailable.
        } finally {
          setScaffoldingGame(false);
        }
      }

      const attachedImageReferences = cappedAttachments
        .filter((att): att is SuperAgentResourceAttachment & { versionId: string } =>
          att.kind === 'asset' && att.modality === 'image' && Boolean(att.versionId))
        .map(att => ({ assetId: att.id, versionId: att.versionId }));
      const hasInputImage = attachedImageReferences.length > 0
        || cappedAttachments.some(att => att.kind === 'asset' && att.modality === 'image');
      const mediaExtra: MediaPromptExtra = {
        routes: mediaRoutesRef.current,
        providers: mediaProvidersRef.current,
        hasInputImage,
        attachedImageReferences,
      };
      const prefix = activeMode
        ? formatModePromptPrefix(activeMode, activeModeOptions, mediaModelsRef.current, mediaExtra)
        : '';
      const modeDirective = activeMode
        ? buildModeHiddenDirective(activeMode, activeModeOptions, mediaModelsRef.current, mediaExtra)
        : undefined;
      const annotationSummary = cappedAttachments
        .filter(att => att.kind === 'browser-annotation')
        .map(att => att.annotation?.comment?.trim() || '')
        .filter(Boolean)
        .join('\n')
        || (hasBrowserAnnotation ? t('Update the page based on the attached browser preview annotations.') : '');
      const rawBody = snapText.trim() || annotationSummary || prefix;
      let outgoingAttachments = cappedAttachments;
      let scaffoldNote = '';
      let initialArtifact: Partial<SuperAgentArtifact> | undefined;

      const deriveDraftTitle = (fallback: string) => {
        const line = snapText.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() || '';
        if (!line) return fallback;
        return line.length > 48 ? `${line.slice(0, 47).trim()}…` : line;
      };

      const scaffoldDesignScenario =
        activeMode?.id === 'design' && activeModeOptions.designFormat === 'html'
          ? activeModeOptions.designScenario
          : activeMode?.id === 'research'
            ? researchDesignScenario(activeModeOptions.researchFormat)
            : activeMode?.id === 'visualization'
              ? visualizationDesignScenario(activeModeOptions.vizType)
              : null;

      if (
        !editingQueuedId
        && !chat?.messages.length
        && scaffoldDesignScenario
        && !cappedAttachments.some(att => att.kind === 'design-project')
      ) {
        try {
          const tpl = cappedAttachments.find(att => att.kind === 'design-template');
          const scenarioLabel = findDesignScenario(scaffoldDesignScenario)?.label || 'Design project';
          const { project } = await designClient.createProject({
            scenario: scaffoldDesignScenario,
            title: deriveDraftTitle(t(scenarioLabel)),
            ...(tpl ? { templateId: tpl.id } : {}),
          });
          if (project?.id) {
            initialArtifact = {
              id: `design:${project.id}`,
              kind: 'design-project',
              title: project.title,
              subtitle: project.scenario,
              projectId: project.id,
              scenario: project.scenario,
              entry: project.entry,
              revision: project.revision,
              url: `${designRoutes.raw(project.id, project.entry)}?rev=${encodeURIComponent(project.revision || '')}`,
            };
            outgoingAttachments = [
              ...cappedAttachments,
              {
                id: project.id,
                kind: 'design-project' as const,
                title: project.title,
                subtitle: project.scenario,
                scenario: project.scenario,
              },
            ].slice(0, 30);
            scaffoldNote = `An editable Design Studio project is already created and open in the right-hand editor: projectId="${project.id}" (scenario="${project.scenario}", entry="${project.entry}", revision="${project.revision}"). Edit this existing project directly with openmotion_design_edit instead of creating a duplicate project.`;
          }
        } catch {
          // Fall back cleanly to Agent tool creation when offline or mocked.
        }
      } else if (
        !editingQueuedId
        && !chat?.messages.length
        && ((activeMode?.id === 'motion' && activeModeOptions.motionEngine !== 'video-model')
          || (activeMode?.id === 'media' && activeModeOptions.mediaSubMode === 'motion'))
        && !cappedAttachments.some(att => att.kind === 'motion-project')
      ) {
        try {
          const statusRes = await fetch('/motion-api/project/status');
          if (statusRes.ok) {
            const status = (await statusRes.json()) as { revision?: string; projectId?: string };
            if (typeof status?.revision === 'string' && /^[a-f0-9]{64}$/.test(status.revision)) {
              const tpl = cappedAttachments.find(att => att.kind === 'motion-template');
              const createRes = await fetch('/motion-api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  expectedRevision: status.revision,
                  ...(status.projectId ? { expectedProjectId: status.projectId } : {}),
                  title: deriveDraftTitle(t('Motion Video')),
                  instruction: snapText.trim() || prefix,
                  ...(tpl ? { templateId: tpl.id } : {}),
                }),
              });
              if (createRes.ok) {
                const created = (await createRes.json()) as {
                  projectId?: string;
                  projectTitle?: string;
                  sessionId?: string;
                  revision?: string;
                };
                if (created?.projectId) {
                  const title = created.projectTitle || deriveDraftTitle(t('Motion Video'));
                  initialArtifact = {
                    id: `motion:${created.projectId}`,
                    kind: 'motion-project',
                    title,
                    subtitle: 'Motion Studio',
                    projectId: created.projectId,
                    ...(created.sessionId ? { sessionId: created.sessionId } : {}),
                    ...(created.revision ? { revision: created.revision } : {}),
                  };
                  outgoingAttachments = [
                    ...cappedAttachments,
                    {
                      id: created.projectId,
                      kind: 'motion-project' as const,
                      title,
                      subtitle: 'Motion Studio',
                    },
                  ].slice(0, 30);
                  scaffoldNote = `An editable Motion Studio project is already created and open in the right-hand editor: projectId="${created.projectId}". Edit this existing project directly with openmotion_edit_project instead of creating a duplicate project.`;
                }
              }
            }
          }
        } catch {
          // Fall back cleanly to Agent tool creation when offline, uninitialized, or mocked.
        }
      }

      const hiddenInstructions = [
        scaffoldNote,
        rawBody === prefix ? '' : prefix,
        modeDirective,
        pendingHiddenInstructionsRef.current,
      ].filter(Boolean).join('\n\n') || undefined;
      const contextTags = activeMode
        ? buildModeContextTags(activeMode, activeModeOptions, mediaModelsRef.current, t, locale, mediaExtra)
        : pendingContextTagsRef.current;
      if (editingQueuedId && onUpdateQueued) {
        const targetQueuedId = editingQueuedId;
        const patch = {
          text: rawBody,
          ...(outgoingSegments ? { segments: outgoingSegments } : { segments: [] }),
          attachments: outgoingAttachments,
          contextTags: contextTags ?? [],
          hiddenInstructions: hiddenInstructions ?? '',
          mode: activeMode?.id ?? null,
          ...(activeMode?.id === 'coding' ? { workingDir: activeModeOptions.codingWorkdir.trim() } : {}),
        };
        setEditingQueuedId(null);
        clearComposerAfterSubmit({ clearAttachments: true, resetMode: true });
        const ok = await onUpdateQueued(targetQueuedId, patch);
        if (!ok) {
          restoreComposerDraft({ ...draftSnapshot, editingQueuedId: targetQueuedId });
        }
        return;
      }

      const effectiveFollowUp = isRunning ? (overrideBehavior ?? followUpBehavior) : undefined;
      const isImmediateTurn = effectiveFollowUp !== 'queue';
      if (isImmediateTurn) {
        setPendingSubmission({
          id: `optimistic-${Date.now()}`,
          text: rawBody,
          ...(outgoingSegments ? { segments: outgoingSegments } : {}),
          attachments: outgoingAttachments,
          contextTags,
          startedAt: Date.now(),
        });
        followRef.current = true;
      }
      clearComposerAfterSubmit({ clearAttachments: true, resetMode: true });
      try {
        const ok = await onSend(rawBody, {
          ...(outgoingSegments ? { segments: outgoingSegments } : {}),
          overrideAttachments: outgoingAttachments,
          ...(hiddenInstructions ? { hiddenInstructions } : {}),
          ...(contextTags?.length ? { contextTags } : {}),
          ...(activeMode ? { mode: activeMode.id } : {}),
          ...(activeMode?.id === 'coding' && activeModeOptions.codingWorkdir.trim()
            ? { workingDir: activeModeOptions.codingWorkdir.trim() }
            : {}),
          ...(initialArtifact ? { initialArtifact } : {}),
          ...(effectiveFollowUp ? { followUpBehavior: effectiveFollowUp } : {}),
        });
        if (!ok) {
          restoreComposerDraft(draftSnapshot);
        }
      } finally {
        if (isImmediateTurn) {
          setPendingSubmission(null);
        }
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const handleFilesUpload = async (input: File[] | FileList | null) => {
    const fileList = input ? Array.from(input).slice(0, 30) : [];
    if (!fileList.length || uploading) return;
    setUploading(true);
    try {
      const added: SuperAgentResourceAttachment[] = [];
      let uploadedMedia = false;
      for (const file of fileList) {
        const attachment = await uploadSuperAgentFile(file);
        if (attachment.kind === 'asset') uploadedMedia = true;
        added.push(attachment);
        composerRef.current?.insertMention(attachment, { replaceTrigger: false });
      }
      const next = [...attachmentsRef.current];
      for (const item of added) {
        if (!next.some(existing => resourceKey(existing) === resourceKey(item))) {
          next.push(item);
        }
      }
      onAttachmentsChange(next.slice(0, 30));
      if (uploadedMedia) onResourcesUploaded?.();
      setMentionMenuOpen(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      onError(error instanceof Error ? error.message : t('Could not upload file'));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const hasModeLanding = Boolean(activeMode && !chat?.messages.length && !pendingSubmission && !loading && !loadFailed);
  const hasInlineModeComposer = hasModeLanding && activeMode?.id !== 'game';
  const sendAction = (!busy || Boolean(editingQueuedId) || (isRunning && hasDraft)) && (
    <IconButton
      variant="plain"
      className="om-sa-send-btn"
      data-ready={canSubmit || undefined}
      data-sending={(sending || scaffoldingGame) || undefined}
      aria-label={
        editingQueuedId
          ? t('Save queued message')
          : isRunning
            ? t(followUpBehavior === 'queue' ? 'Queue message' : 'Steer')
            : t('Send')
      }
      disabled={!canSubmit}
      onClick={() => void handleSubmit()}
      icon={
        <RemixIcon
          name={
            (sending || scaffoldingGame)
              ? 'loader-4-line'
              : editingQueuedId
                ? 'check-line'
                : 'arrow-right-line'
          }
          size={18}
        />
      }
    />
  );
  const artifactCount = chat?.artifacts.length ?? 0;

  return (
    <section
      className="om-sa-stream"
      data-mode={activeMode?.id || undefined}
      aria-label={t('Super Agent conversation')}
      onDragOver={event => {
        if (hasPendingApproval) return;
        if (event.dataTransfer?.types?.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        if (hasPendingApproval) return;
        void collectDroppedFiles(event.dataTransfer).then(files => handleFilesUpload(files));
      }}
    >
      {dragging && (
        <div className="om-sa-drop-overlay" aria-hidden="true">
          <RemixIcon name="upload-2-line" size={28} />
          <strong>{t('Drop files or folders to attach to this conversation')}</strong>
        </div>
      )}

      <header
        className="om-sa-stream-head"
        data-compact-landing={(!chat && activeMode?.id === 'game' && !pendingSubmission && !loading && !loadFailed) || undefined}
      >
        <div className="om-sa-stream-head-left">
          {onBack && <WorkspaceBack inline fallback={onBack} />}
          {!sidebarOpen && (
            <Tooltip label={t('Open sidebar')}>
              <IconButton
                variant="ghost"
                className="motion-icon-button"
                aria-label={t('Open sidebar')}
                onClick={onOpenSidebar}
                icon={<RemixIcon name="side-bar-line" size={16} />}
              />
            </Tooltip>
          )}
          {chat && renaming ? (
            <form
              className="om-sa-head-rename"
              onSubmit={event => {
                event.preventDefault();
                const next = draftTitle.trim();
                setRenaming(false);
                if (next && next !== chat.title) void onRenameChat(next);
              }}
            >
              <span
                className="om-sa-stream-title-icon"
                data-tone={headerIntentMeta.tone}
                title={t(headerIntentMeta.label)}
                aria-hidden="true"
              >
                <RemixIcon name={headerIntentMeta.icon} size={15} />
              </span>
              <input
                autoFocus
                maxLength={100}
                value={draftTitle}
                aria-label={t('Conversation name')}
                onFocus={event => event.currentTarget.select()}
                onChange={event => setDraftTitle(event.target.value)}
                onBlur={() => {
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  const next = draftTitle.trim();
                  setRenaming(false);
                  if (next && next !== chat.title) void onRenameChat(next);
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    cancelRenameRef.current = true;
                    setRenaming(false);
                  }
                }}
              />
            </form>
          ) : (chat || activeMode?.id !== 'game' || Boolean(pendingSubmission) || loading || loadFailed) ? (
            <Button
              variant="plain"
              type="button"
              className="om-sa-stream-title"
              disabled={!chat}
              onClick={() => {
                if (!chat) return;
                setDraftTitle(chat.title);
                setRenaming(true);
              }}
            >
              <span
                className="om-sa-stream-title-icon"
                data-tone={headerIntentMeta.tone}
                title={t(headerIntentMeta.label)}
                aria-hidden="true"
              >
                <RemixIcon name={headerIntentMeta.icon} size={15} />
              </span>
              <span>{chat ? chat.title : t('New conversation')}</span>
              {chat && <RemixIcon name="edit-line" size={12} />}
            </Button>
          ) : null}
          {chat && !renaming && chat.projectDir && !isInternalManagedStorageDir(chat.projectDir) && (
            chat.intent === 'coding'
            || Boolean(chat.workingDir)
            || !/^(?:games|design|projects|work)\/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(compactDirLabel(chat.projectDir))
          ) && (
            <Tooltip label={t('Project directory: {path}', { path: chat.projectDir })}>
              <Button
                variant="plain"
                type="button"
                className="om-sa-head-dir-btn"
                aria-label={t('Copy project directory')}
                onClick={() => onCopyText(chat.projectDir!)}
              >
                <RemixIcon name="folder-line" size={13} />
                <span>{compactDirLabel(chat.projectDir)}</span>
              </Button>
            </Tooltip>
          )}
          {chat && (chat.state !== 'idle' || hasPendingApproval) && (() => {
            const headerState = hasPendingApproval ? 'waiting' : chat.state;
            if (headerState === 'running') return null;
            return (
              <span
                className="om-badge om-sa-head-status-badge"
                data-state={headerState}
              >
                {headerState === 'waiting' && (
                  <span className="om-sa-head-status-icon" aria-hidden="true">
                    <RemixIcon name="shield-check-line" size={12} />
                  </span>
                )}
                <span>{t(headerState === 'waiting' ? 'Approval needed' : headerState === 'failed' ? 'Stopped' : 'Cancelled')}</span>
              </span>
            );
          })()}
        </div>

        <div className="om-sa-stream-head-actions">
          <Tooltip label={artifactCount > 0 ? `${t('Artifact Viewer')} (${artifactCount})` : t('Artifact Viewer')}>
            <IconButton
              variant="plain"
              className="om-sa-head-icon-btn"
              aria-label={t('Artifact Viewer')}
              aria-pressed={viewerOpen}
              data-active={viewerOpen || undefined}
              onClick={onToggleViewer}
              icon={<RemixIcon name="layout-column-line" size={16} />}
            />
          </Tooltip>
        </div>
      </header>

      <div
        ref={listRef}
        className="om-sa-messages"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
      >
        {loading ? (
          <div className="om-sa-loading" role="status" aria-label={t('Loading conversation…')}>
            <OpenDesignLoadingMark height={26} />
            <span className="om-muted">{t('Loading conversation…')}</span>
          </div>
        ) : loadFailed ? (
          <div className="om-empty om-sa-empty-state" role="alert">
            <RemixIcon name="error-warning-line" size={28} />
            <h2>{t('Could not load conversation')}</h2>
            <Button variant="ghost" className="om-button h-auto" onClick={onRetryLoad}>
              <RemixIcon name="refresh-line" size={15} />
              <span>{t('Retry')}</span>
            </Button>
          </div>
        ) : (() => {
          const optimisticMessage: SuperAgentMessage | null = pendingSubmission
            ? {
                id: pendingSubmission.id,
                role: 'user',
                text: pendingSubmission.text,
                createdAt: pendingSubmission.startedAt,
                ...(pendingSubmission.segments?.length ? { segments: pendingSubmission.segments } : {}),
                ...(pendingSubmission.attachments.length ? { attachments: pendingSubmission.attachments } : {}),
                ...(pendingSubmission.contextTags?.length ? { contextTags: pendingSubmission.contextTags } : {}),
              }
            : null;
          const displayChat: SuperAgentChat | null = (() => {
            if (!optimisticMessage) return chat;
            if (!chat) {
              return {
                id: pendingSubmission!.id,
                title: pendingSubmission!.text.slice(0, 60) || t('New conversation'),
                engine: selection.engine,
                model: selection.model,
                permissionMode,
                createdAt: pendingSubmission!.startedAt,
                updatedAt: pendingSubmission!.startedAt,
                state: 'running',
                turnActivity: {
                  phase: 'connecting',
                  label: activeAgent?.label ?? selection.engine,
                  startedAt: pendingSubmission!.startedAt,
                  updatedAt: pendingSubmission!.startedAt,
                },
                messages: [optimisticMessage],
                artifacts: [],
                approvals: [],
              };
            }
            const lastMsg = chat.messages[chat.messages.length - 1];
            const alreadyPresent = lastMsg?.role === 'user' && lastMsg.text.trim() === optimisticMessage.text.trim();
            if (alreadyPresent) return chat;
            return {
              ...chat,
              messages: [...chat.messages, optimisticMessage],
              turnActivity: chat.turnActivity ?? {
                phase: 'connecting',
                label: activeAgent?.label ?? chat.engine,
                startedAt: pendingSubmission!.startedAt,
                updatedAt: pendingSubmission!.startedAt,
              },
            };
          })();
          return (
          <div key={displayChat?.id ?? (activeMode?.id ?? 'welcome')} className="om-sa-stream-transition">
            {!displayChat?.messages.length && !publishEntries.length ? (
              activeMode ? (
            <ModeResourceShowcase
              active={active}
              mode={activeMode}
              attachments={attachments}
              modeOptions={modeOptions}
              playingGameId={playingGameId}
              onChangeModeOptions={updateModeOptions}
              onToggleAttachment={toggleResourceAttachment}
              onPlayGame={onPlayGame}
              onDeployGame={onDeployGame}
              composer={activeMode.id === 'game'
                ? null
                : activeMode.id === 'coding'
                  ? <div className="om-sa-composer-placement" ref={mountComposer} />
                  : <DockableModeComposer ref={dockRef} scrollRef={listRef} mountEditor={mountComposer}
                      focusEditor={focusEditor} templateRevision={templateRevision}
                      preview={text.trim() || getModeComposerPlaceholder(activeMode, modeOptions, t)}
                      action={sendAction} />}
              onApplyTemplate={() => setTemplateRevision(value => value + 1)}
              onFocusComposer={activeMode.id === 'game' ? focusEditor : focusModeComposer}
              onPickPrompt={(prompt, meta) => {
                setText(prompt);
                composerRef.current?.setPlainText(prompt);
                focusModeComposer();
                applyPickedPromptMeta(meta);
              }}
              onOpenAllResources={category => {
                focusModeComposer();
                setMentionCategory(mapResourceTabToMentionCategory(category ?? 'all'));
                setMentionMenuSource('plus');
                setMentionQuery('');
                setMentionMenuOpen(true);
              }}
              onOpenGameStudio={onOpenGameStudio}
              onClose={exitActiveMode}
            />
          ) : (
          <div className="om-sa-home">
            <div className="om-sa-home-hero">
              <h2>{t('What can I create for you?')}</h2>
            </div>

            <div className="om-sa-starter-grid">
              {PRIMARY_STARTERS.map(card => (
                <Button
                  key={card.key ?? card.id}
                  variant="plain"
                  type="button"
                  className="om-sa-starter-card"
                  data-tone={card.tone}
                  onClick={() => {
                    enterMode(card.id, card.designModule, card.optionsPatch);
                    composerRef.current?.focus();
                  }}
                >
                  <span className="om-sa-starter-head">
                    <span className="om-sa-starter-icon" data-tone={card.tone} aria-hidden="true">
                      <RemixIcon name={card.icon} size={20} />
                    </span>
                    {card.badge && (
                      <span className="om-badge" data-nav-badge={card.badge} lang="en">{card.badge}</span>
                    )}
                  </span>
                  <strong>{t(card.title)}</strong>
                </Button>
              ))}

              <Popover
                open={moreStartersOpen}
                onOpenChange={setMoreStartersOpen}
                side="bottom"
                align="end"
                initialFocus={false}
                aria-label={t('Explore more')}
                className="om-agent-settings-popover om-sa-more-popover"
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-starter-card om-sa-starter-card-more"
                    data-active={moreStartersOpen || undefined}
                  >
                    <span className="om-sa-starter-icon" aria-hidden="true">
                      <RemixIcon name="more-fill" size={20} />
                    </span>
                    <strong>{t('Explore more')}</strong>
                  </Button>
                }
              >
                <div className="om-sa-more-menu">
                  {EXTRA_STARTERS.map(card => (
                    <Button
                      key={card.key}
                      variant="plain"
                      type="button"
                      className="om-sa-more-item"
                      onClick={() => {
                        setMoreStartersOpen(false);
                        enterMode(card.id, card.designModule, card.optionsPatch);
                        composerRef.current?.focus();
                      }}
                    >
                      <span className="om-sa-starter-icon" data-tone={card.tone} aria-hidden="true">
                        <RemixIcon name={card.icon} size={16} />
                      </span>
                      <span>{t(card.title)}</span>
                    </Button>
                  ))}
                </div>
              </Popover>
            </div>
          </div>
          )
        ) : (
          <>
          {displayChat && (
          <ExecutionTimeline
            chat={displayChat}
            busy={busy || Boolean(pendingSubmission)}
            sending={sending || scaffoldingGame || Boolean(pendingSubmission)}
            hideApprovals
            continueDisabled={sending || scaffoldingGame || busy || hasPendingApproval || runnableEngines.length === 0}
            engineLabel={effectiveAgents.find(a => a.id === displayChat.engine)?.label ?? displayChat.engine}
            onOpenArtifactId={onOpenArtifactId}
            onOpenChangedFile={onOpenChangedFile}
            onPreviewAttachment={onPreviewAttachment}
            onOpenFilePath={onOpenFilePath}
            onOpenWebUrl={onOpenWebUrl}
            onCopyText={onCopyText}
            onNotify={onNotify}
            onOpenAccountSettings={onOpenAccountSettings}
            onTriggerActionCard={onTriggerActionCard}
            onOpenInDesignStudio={onOpenInDesignStudio}
            onOpenInMotionStudio={onOpenInMotionStudio}
            onOpenInAssets={onOpenInAssets}
            onOpenInBrandKit={onOpenInBrandKit}
            onApprove={onApprove}
            onContinue={() => void onSend(t('Continue from where you stopped and finish the task.'))}
          />
          )}
          <GamePublishThread
            chatId={chat?.id}
            onOpenPanel={artifactId => {
              onOpenArtifactId(artifactId);
              gamePublishActions.reopen(artifactId);
            }}
            onNotify={onNotify}
          />
          </>
            )}
          </div>
          );
        })()}
      </div>

      {!hasInlineModeComposer && <div className="om-sa-composer-placement" ref={mountComposer} />}
      {createPortal(<div className="om-sa-composer-wrap">
        {hasPendingApproval && (
          <div className="om-sa-approval-dock" role="region" aria-label={t('Approval needed')}>
            {pendingApprovals.map(approval => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                sending={sending || scaffoldingGame}
                onApprove={onApprove}
              />
            ))}
          </div>
        )}
        {queuedMessages.length > 0 && (
          <div className="om-sa-queue-panel" role="region" aria-label={t('Queued Messages')}>
            <Button
              variant="plain"
              type="button"
              className="om-sa-queue-head"
              aria-expanded={!queueCollapsed}
              onClick={() => setQueueCollapsed(prev => !prev)}
            >
              <span className="om-sa-queue-title">{t('Queued Messages')}</span>
              <span className="om-sa-queue-count">{queuedMessages.length}</span>
              <span className="om-sa-queue-subtitle">
                {t(isRunning ? 'Sends after agent finishes working' : 'Waiting to send')}
              </span>
              <span className="om-sa-queue-chevron" data-collapsed={queueCollapsed || undefined} aria-hidden="true">
                <RemixIcon name="arrow-down-s-line" size={16} />
              </span>
            </Button>
            {!queueCollapsed && (
              <div className="om-sa-queue-list">
                {queuedMessages.map(item => {
                  const isEditingThis = editingQueuedId === item.id;
                  const hasMeta = isEditingThis || Boolean(item.contextTags?.length) || Boolean(item.attachments?.length);
                  return (
                    <div key={item.id} className="om-sa-queue-row" data-editing={isEditingThis || undefined}>
                      <div className="om-sa-queue-main">
                        <p className="om-sa-queue-text" title={item.text}>{item.text}</p>
                        {hasMeta && (
                          <div className="om-sa-queue-meta">
                            {isEditingThis && (
                              <span className="om-sa-queue-tag" data-tone="editing">
                                <RemixIcon name="edit-line" size={11} />
                                <span>{t('Editing')}</span>
                              </span>
                            )}
                            {item.contextTags?.slice(0, 3).map((tag, idx) => (
                              <span key={`${tag.label}-${idx}`} className="om-sa-queue-tag">
                                {tag.icon && <RemixIcon name={tag.icon} size={11} />}
                                <span>{tag.label}</span>
                              </span>
                            ))}
                            {(item.contextTags?.length ?? 0) > 3 && (
                              <span className="om-sa-queue-tag">+{item.contextTags!.length - 3}</span>
                            )}
                            {item.attachments?.slice(0, 2).map(att => (
                              <span key={resourceKey(att)} className="om-sa-queue-tag">
                                <RemixIcon name={resourceIcon(att)} size={11} />
                                <span>{att.title}</span>
                              </span>
                            ))}
                            {(item.attachments?.length ?? 0) > 2 && (
                              <span className="om-sa-queue-tag">+{item.attachments!.length - 2}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="om-sa-queue-actions">
                        <Tooltip label={t('Send Now')}>
                          <IconButton
                            variant="plain"
                            className="om-sa-queue-action-btn"
                            aria-label={t('Send Now')}
                            disabled={sending || hasPendingApproval}
                            onClick={() => {
                              if (isEditingThis) setEditingQueuedId(null);
                              void onSendQueuedNow?.(item.id);
                            }}
                            icon={<RemixIcon name="arrow-right-line" size={15} />}
                          />
                        </Tooltip>
                        <Tooltip label={t('Edit')}>
                          <IconButton
                            variant="plain"
                            className="om-sa-queue-action-btn"
                            aria-label={t('Edit')}
                            disabled={sending || hasPendingApproval}
                            onClick={() => handleStartEditQueued(item)}
                            icon={<RemixIcon name="edit-line" size={15} />}
                          />
                        </Tooltip>
                        <Tooltip label={t('Delete')}>
                          <IconButton
                            variant="plain"
                            className="om-sa-queue-action-btn"
                            data-tone="danger"
                            aria-label={t('Delete')}
                            disabled={sending}
                            onClick={() => {
                              if (isEditingThis) handleCancelEditQueued();
                              void onDeleteQueued?.(item.id);
                            }}
                            icon={<RemixIcon name="delete-bin-line" size={15} />}
                          />
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {agentsLoaded && !runnableEngines.length && (
          <div className="om-sa-agent-banner">
            <RemixIcon name="plug-line" size={15} />
            <span>
              {t(
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? 'Connect a local machine via the Bridge script or add a Custom Agent Service to run Super Agent.'
                  : 'Install and sign in to Codex or Claude Code to run Super Agent.',
              )}
            </span>
            <Button
              variant="ghost"
              className="om-button h-auto"
              onClick={
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? (onOpenRuntimeSettings ?? onOpenAgentSettings)
                  : onOpenAgentSettings
              }
            >
              {t(
                !localDirectAvailable || (activeRuntime && activeRuntime.kind !== 'local-direct')
                  ? 'Connect Agent Runtime'
                  : 'Configure Local Agent',
              )}
            </Button>
          </div>
        )}

        {activeMode && (
          <ModeComposerTopBar
            active={active}
            modeId={activeMode.id}
            options={modeOptions}
            attachments={attachments}
            disabled={sending || hasPendingApproval}
            onChange={updateModeOptions}
            onCatalogChange={handleCatalogChange}
            onOpenResourcePicker={category => {
              setMentionCategory(mapResourceTabToMentionCategory(category));
              setMentionMenuSource('plus');
              setMentionQuery('');
              setMentionMenuOpen(true);
            }}
            onOpenModelSettings={() => {
              if (onOpenModelSettings) onOpenModelSettings();
              else onOpenAgentSettings();
            }}
          />
        )}

        <div
          ref={composerShellRef}
          className="om-sa-composer"
          data-approval-pending={hasPendingApproval || undefined}
          data-editing-queued={Boolean(editingQueuedId) || undefined}
        >
          {hasPendingApproval && (
            <div className="om-sa-composer-approval-notice" role="status" aria-live="polite">
              <span className="om-sa-composer-approval-icon" aria-hidden="true">
                <RemixIcon name="error-warning-line" size={15} />
              </span>
              <span className="om-sa-composer-approval-text">
                {pendingApprovals.length === 1
                  ? t('Confirm the pending action above before sending your next message')
                  : t('Confirm {count} pending actions above before sending your next message', { count: pendingApprovals.length })}
              </span>
            </div>
          )}
          {editingQueuedId && !hasPendingApproval && (
            <div className="om-sa-composer-edit-banner" role="status">
              <span className="om-sa-composer-edit-info">
                <RemixIcon name="edit-line" size={14} />
                <span>{t('Editing queued message')}</span>
              </span>
              <Button
                variant="plain"
                type="button"
                className="om-sa-composer-edit-cancel"
                onClick={handleCancelEditQueued}
              >
                {t('Cancel')}
              </Button>
            </div>
          )}
          {(() => {
            const inlineKeySet = new Set(inlineMentions.map(resourceKey));
            const trayAttachments = attachments.filter(att => !inlineKeySet.has(resourceKey(att)));
            const hasGameTemplateChip = activeMode?.id === 'game' && Boolean(modeOptions.gameTemplate);
            const totalTrayCount = trayAttachments.length + (hasGameTemplateChip ? 1 : 0);
            if (totalTrayCount === 0) {
              return null;
            }
            return (
              <div className="om-sa-composer-chips">
                {hasGameTemplateChip && modeOptions.gameTemplate && (() => {
                  const tpl = modeOptions.gameTemplate;
                  const tplTitle = localizedGameTitle(tpl, locale);
                  return (
                    <span className="om-sa-attachment-chip om-sa-game-remix-chip">
                      <ResourceThumbImage
                        className="om-sa-attachment-thumb"
                        src={coverUrl(tpl)}
                        fallback={<RemixIcon name="gamepad-line" size={13} />}
                      />
                      <span>{t('Remix · {title}', { title: tplTitle })}</span>
                      <IconButton
                        variant="plain"
                        className="om-sa-chip-remove"
                        aria-label={t('Remove {title}', { title: tplTitle })}
                        onClick={() => updateModeOptions({ gameTemplate: null })}
                        icon={<RemixIcon name="close-line" size={12} />}
                      />
                    </span>
                  );
                })()}
                {trayAttachments.map(att => {
                  const key = resourceKey(att);
                  const isBrowserAnnotation = att.kind === 'browser-annotation';
                  const chipTitle = isBrowserAnnotation
                    ? (att.annotation?.comment || att.title)
                    : att.title;
                  const tooltipLabel = isBrowserAnnotation
                    ? [
                        att.annotation?.element?.componentName,
                        att.annotation?.element?.selector,
                        att.annotation?.pageUrl || att.subtitle,
                      ].filter(Boolean).join(' · ')
                    : '';
                  if (!isBrowserAnnotation) {
                    return (
                      <span key={key} className="om-sa-attachment-chip">
                        <Button
                          variant="plain"
                          type="button"
                          className="om-sa-chip-main"
                          onClick={() => onPreviewAttachment(att)}
                        >
                          <RemixIcon name={resourceIcon(att)} size={13} />
                          <span>{chipTitle}</span>
                        </Button>
                        <IconButton
                          variant="plain"
                          className="om-sa-chip-remove"
                          aria-label={t('Remove {title}', { title: chipTitle })}
                          onClick={() =>
                            onAttachmentsChange(attachments.filter(item => resourceKey(item) !== key))
                          }
                          icon={<RemixIcon name="close-line" size={12} />}
                        />
                      </span>
                    );
                  }

                  const annot = att.annotation;
                  const previewUrl = resourceImagePreviewUrl(att);
                  const sourceLoc = annot?.element?.sourceFile
                    ? `${annot.element.sourceFile}${typeof annot.element.sourceLine === 'number' ? `:${annot.element.sourceLine}` : ''}`
                    : '';
                  const chipTrigger = (
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-chip-main"
                      aria-label={chipTitle}
                    >
                      <ResourceThumbImage
                        className="om-sa-attachment-thumb"
                        src={previewUrl}
                        fallback={<RemixIcon name={resourceIcon(att)} size={13} />}
                      />
                      <span>{chipTitle}</span>
                    </Button>
                  );

                  return (
                    <span
                      key={key}
                      className="om-sa-attachment-chip"
                      data-kind="browser-annotation"
                    >
                      <Popover
                        open={previewingChipKey === key}
                        onOpenChange={open => setPreviewingChipKey(open ? key : null)}
                        side="top"
                        align="start"
                        tooltip={tooltipLabel || undefined}
                        aria-label={chipTitle}
                        className="om-sa-annot-preview-popover"
                        trigger={chipTrigger}
                      >
                        <div className="om-sa-annot-preview-body">
                          {previewUrl && (
                            <img className="om-sa-annot-preview-img" src={previewUrl} alt={chipTitle} />
                          )}
                          <div className="om-sa-annot-preview-meta">
                            <strong>{chipTitle}</strong>
                            {(annot?.element?.componentName || annot?.element?.selector) && (
                              <code>
                                {annot.element.componentName ? `${annot.element.componentName} · ` : ''}
                                {annot.element.selector}
                              </code>
                            )}
                            {sourceLoc && <small className="om-sa-annot-preview-source">{sourceLoc}</small>}
                            {annot?.region && (
                              <small>
                                {annot.region.width}×{annot.region.height} @ {annot.region.x},{annot.region.y}
                              </small>
                            )}
                            {annot?.consoleErrors && annot.consoleErrors.length > 0 && (
                              <pre className="om-sa-annot-preview-logs">
                                {annot.consoleErrors.slice(0, 4).join('\n')}
                              </pre>
                            )}
                            {(annot?.pageUrl || att.subtitle) && (
                              <small className="om-sa-annot-preview-url">{annot?.pageUrl || att.subtitle}</small>
                            )}
                          </div>
                          <div className="om-sa-annot-preview-actions">
                            <Button
                              variant="plain"
                              type="button"
                              className="om-sa-toolbar-btn"
                              onClick={() => {
                                setPreviewingChipKey(null);
                                onPreviewAttachment(att);
                              }}
                            >
                              <RemixIcon name="eye-line" size={13} />
                              <span>{t('Preview')}</span>
                            </Button>
                          </div>
                        </div>
                      </Popover>
                      <IconButton
                        variant="plain"
                        className="om-sa-chip-remove"
                        aria-label={t('Remove {title}', { title: chipTitle })}
                        onClick={() => {
                          if (previewingChipKey === key) setPreviewingChipKey(null);
                          onAttachmentsChange(attachments.filter(item => resourceKey(item) !== key));
                        }}
                        icon={<RemixIcon name="close-line" size={12} />}
                      />
                    </span>
                  );
                })}
                {totalTrayCount > 1 && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-chip-clear"
                  onClick={() => {
                    for (const item of inlineMentions) {
                      composerRef.current?.removeMentionByKey(resourceKey(item));
                    }
                    onAttachmentsChange([]);
                    updateModeOptions({ gameTemplate: null });
                  }}
                >
                  {t('Clear')}
                </Button>
                )}
              </div>
            );
          })()}

          <ComposerMentionMenu
            ref={mentionMenuRef}
            open={mentionMenuOpen && !hasPendingApproval}
            source={mentionMenuSource}
            anchorRef={composerShellRef}
            query={mentionQuery}
            category={mentionCategory}
            currentChatId={chat?.id}
            workingDir={activeMode?.id === 'coding' ? modeOptions.codingWorkdir.trim() || chat?.workingDir : chat?.workingDir}
            activeArtifacts={activeArtifacts}
            conversations={conversations}
            selected={attachments}
            onQueryChange={setMentionQuery}
            onCategoryChange={setMentionCategory}
            onSelectItem={handleSelectMentionItem}
            onUploadFiles={() => {
              if (mentionMenuSourceRef.current === 'at' || mentionMenuSourceRef.current === 'slash') {
                composerRef.current?.clearTrigger();
              }
              setMentionMenuOpen(false);
              setMentionQuery('');
              uploadInputRef.current?.click();
            }}
            onUploadFolder={() => {
              if (mentionMenuSourceRef.current === 'at' || mentionMenuSourceRef.current === 'slash') {
                composerRef.current?.clearTrigger();
              }
              setMentionMenuOpen(false);
              setMentionQuery('');
              folderInputRef.current?.click();
            }}
            onRunCommand={
              onRunCommand
                ? command => {
                    if (mentionMenuSourceRef.current === 'at' || mentionMenuSourceRef.current === 'slash') {
                      composerRef.current?.clearTrigger();
                    }
                    setMentionMenuOpen(false);
                    setMentionQuery('');
                    onRunCommand(command);
                  }
                : undefined
            }
            onClose={(refocus = true) => {
              setMentionMenuOpen(false);
              if (refocus) requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />

          <ComposerPromptEditor
            ref={composerRef}
            ariaLabel={t('Message Super Agent')}
            placeholder={(() => {
              if (hasPendingApproval) return t('Confirm or decline the pending action above to continue…');
              if (editingQueuedId) return t('Edit queued message…');
              if (isRunning) {
                return followUpBehavior === 'queue'
                  ? t('Queue a follow-up message…')
                  : t('Send a follow-up to steer the current run…');
              }
              if (activeMode?.id === 'game' && modeOptions.gameTemplate) {
                return t('Describe how to remix {title}, or send as is', { title: localizedGameTitle(modeOptions.gameTemplate, locale) });
              }
              if (!activeMode && chat && chat.messages.length > 0) {
                const primaryDeliverable = [...chat.artifacts].reverse().find(a => a.kind !== 'workspace-file' && a.kind !== 'web');
                if (primaryDeliverable) {
                  const rawLabel = (primaryDeliverable.title || chat.title || '').split('·')[0].trim();
                  const shortTitle = rawLabel.length > 18 ? `${rawLabel.slice(0, 18)}…` : rawLabel;
                  if (shortTitle) {
                    return primaryDeliverable.kind === 'game-project'
                      ? t('Continue tuning "{title}" — adjust controls, visuals, levels, or difficulty…', { title: shortTitle })
                      : t('Describe changes for "{title}", or ask a follow-up…', { title: shortTitle });
                  }
                }
              }
              return getModeComposerPlaceholder(activeMode, modeOptions, t);
            })()}
            disabled={loading || hasPendingApproval}
            mentionMenuOpen={mentionMenuOpen}
            onMenuKey={handleMenuKey}
            onChange={handleComposerSnapshotChange}
            onTriggerChange={handleComposerTriggerChange}
            onSubmit={oppositeMeta => {
              const oppositeBehavior =
                oppositeMeta && isRunning && !editingQueuedId
                  ? (followUpBehavior === 'queue' ? 'steer' : 'queue')
                  : undefined;
              void handleSubmit(oppositeBehavior);
            }}
            onCancelEdit={editingQueuedId ? handleCancelEditQueued : undefined}
            onPasteFiles={files => {
              if (!hasPendingApproval) void handleFilesUpload(files);
            }}
            onRestoreMentions={restored => {
              const next = [...attachmentsRef.current];
              for (const item of restored) {
                if (!next.some(existing => resourceKey(existing) === resourceKey(item))) {
                  next.push(item);
                }
              }
              onAttachmentsChange(next.slice(0, 30));
            }}
            onOpenMention={item => onPreviewAttachment(item)}
          />

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={event => void handleFilesUpload(event.target.files)}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            onChange={event => void handleFilesUpload(event.target.files)}
          />

          <div className="om-sa-composer-bar">
            <div className="om-sa-composer-tools">
              <IconButton
                variant="plain"
                className="om-sa-composer-icon-btn"
                data-mention-trigger="plus"
                data-active={mentionMenuOpen || undefined}
                aria-label={t('Attach workspace resources')}
                aria-expanded={mentionMenuOpen}
                disabled={uploading || hasPendingApproval}
                onClick={() => {
                  if (mentionMenuOpen && mentionMenuSource === 'plus') {
                    setMentionMenuOpen(false);
                  } else {
                    setMentionMenuSource('plus');
                    setMentionQuery('');
                    setMentionCategory('all');
                    setMentionMenuOpen(true);
                  }
                }}
                icon={<RemixIcon name={uploading ? 'loader-4-line' : 'add-line'} size={18} />}
              />

              {active && activeMode && (
                <span className="om-sa-active-mode-pill" data-mode={activeMode.id}>
                  <Select
                    appearance="boxed"
                    modal={false}
                    label={t('Creation mode')}
                    value={activeMode.id}
                    onCommit={switchActiveMode}
                    disabled={sending || scaffoldingGame || hasPendingApproval}
                    className="om-sa-mode-select"
                    popupClassName="om-sa-creation-mode-menu"
                    options={COMPOSER_MODES.map(mode => ({
                      value: mode.id,
                      label: t(mode.label),
                      icon: <RemixIcon name={mode.icon} size={13} />,
                    }))}
                  />
                  <IconButton
                    variant="plain"
                    className="om-sa-chip-remove"
                    aria-label={t('Clear mode')}
                    onClick={exitActiveMode}
                    icon={<RemixIcon name="close-line" size={12} />}
                  />
                </span>
              )}

              {activeMode && (
                <ModeComposerControls
                  active={active}
                  modeId={activeMode.id}
                  options={modeOptions}
                  disabled={sending || hasPendingApproval}
                  onChange={updateModeOptions}
                />
              )}

              <AgentModelPicker
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                disabled={busy || sending}
                selection={selection}
                activeAgent={activeAgent}
                activeRuntime={activeRuntime}
                runtimes={runtimes}
                runtimeOnline={runtimeOnline}
                engineChoices={engineChoices}
                browsingEngine={browsingEngine}
                inspectingEngine={inspectingEngine}
                onBrowseEngine={setBrowsingEngine}
                onChangeSelection={onChangeSelection}
                onOpenRuntimeSettings={onOpenRuntimeSettings}
                onOpenAgentSettings={onOpenAgentSettings}
              />
            </div>

            <div className="om-sa-composer-send">
              <Popover
                open={approvalMenuOpen}
                onOpenChange={setApprovalMenuOpen}
                side="top"
                align="end"
                tooltip={t('Approval mode')}
                aria-label={t('Agent settings')}
                className="om-agent-settings-popover om-sa-settings-popover"
                trigger={
                  <IconButton
                    variant="plain"
                    className="om-sa-composer-icon-btn om-sa-settings-trigger"
                    data-active={permissionMode === 'auto' || undefined}
                    aria-label={t('Agent settings')}
                    disabled={sending || hasPendingApproval}
                    icon={<RemixIcon name="shield-check-line" size={17} />}
                  />
                }
              >
                <div className="om-sa-popover-body">
                  <div className="om-sa-popover-field">
                    <span className="om-sa-popover-label">{t('Approval mode')}</span>
                    <div className="om-sa-popover-segment" role="group" aria-label={t('Approval mode')}>
                      <Button
                        variant="plain"
                        type="button"
                        className="om-sa-popover-seg-btn"
                        aria-pressed={permissionMode === 'on-request'}
                        data-active={permissionMode === 'on-request' || undefined}
                        onClick={() => onChangePermissionMode('on-request')}
                      >
                        <RemixIcon name="shield-check-line" size={14} />
                        <span>{t('Ask before paid/shell actions')}</span>
                      </Button>
                      <Button
                        variant="plain"
                        type="button"
                        className="om-sa-popover-seg-btn"
                        aria-pressed={permissionMode === 'auto'}
                        data-active={permissionMode === 'auto' || undefined}
                        onClick={() => onChangePermissionMode('auto')}
                      >
                        <RemixIcon name="sparkling-line" size={14} />
                        <span>{t('Auto-approve tool runs')}</span>
                      </Button>
                    </div>
                  </div>
                  <div className="om-sa-popover-links">
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setApprovalMenuOpen(false);
                        onOpenAgentSettings();
                      }}
                    >
                      <span className="om-sa-tone-icon" data-tone="agent" aria-hidden="true">
                        <RemixIcon name="robot-line" size={15} />
                      </span>
                      <span>{t('Manage Local Agents')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-popover-link-row"
                      onClick={() => {
                        setApprovalMenuOpen(false);
                        onOpenMcp();
                      }}
                    >
                      <span className="om-sa-tone-icon" data-tone="video" aria-hidden="true">
                        <RemixIcon name="plug-line" size={15} />
                      </span>
                      <span>{t('MCP guide')}</span>
                      <RemixIcon name="arrow-right-up-line" size={14} />
                    </Button>
                  </div>
                </div>
              </Popover>

              {busy && (
                <IconButton
                  variant="plain"
                  className="om-sa-send-btn"
                  data-stop
                  aria-label={t('Stop')}
                  disabled={sending}
                  onClick={onStop}
                  icon={<RemixIcon name="checkbox-blank-fill" size={14} />}
                />
              )}

              {sendAction}
            </div>
          </div>
        </div>
      </div>, composerHost)}
    </section>
  );
}
