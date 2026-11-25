import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from 'open-design-ui/button';
import type { BrowserConsoleEntry } from '../../../shared/browser';
import type { SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { RemixIcon } from '../../../packages/design-system/react/RemixIcons';
import {
  designCommentsPrompt, designProjectPrompt, designRoutes, designViewports, findDesignScenario,
  type DesignComment, type DesignCommentAnchor, type DesignExportFormat, type DesignViewportId,
} from '../../../shared/design-project';
import type { ReviewAnnotation, ReviewPoint } from '../../../shared/review-comments';
import { IconButton } from 'open-design-ui/icon-button';
import { Tooltip } from '../components/ui';
import { OpenDesignLoadingMark } from '../components/ui/OpenDesignLoadingMark';
import { Skeleton } from '../components/ui/Skeleton';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { ResizablePane } from '../motion/ResizablePane';
import { ReviewAnnotationGraphic } from '../motion/ReviewAnnotationGraphic';
import { useIntegrationInfo } from '../motion/useIntegrationInfo';
import { captureSuperAgentPreviewSnapshot } from '../super-agent/superAgentClient';
import { CodeViewer } from './CodeViewer';
import { DesignDeployPopover } from './DesignDeployPopover';
import { DesignApiError, designClient, makeRequestId } from './designClient';
import {
  buildDesignCodeSelectionAttachment,
  buildDesignSelectionAttachment,
  designCommentToAttachment,
  readDomCodeSelection,
  readTextareaCodeSelection,
  type DesignCodeSelection,
} from './designSuperAgentBridge';
import { buildBridgeSrcDoc, looksLikeDeck, parseDeckSlides, parseSpeakerNotes, type PickedElement } from './previewBridge';
import { useDesignProject } from './useDesignProject';
import './design.css';

type AnnotationTool = 'none' | 'comment' | 'region' | 'pen';
type SidebarTab = 'files' | 'comments' | 'versions';
type PreviewPoint = NonNullable<DesignCommentAnchor['scroll']>;
type PreviewBox = PickedElement['box'];
type AnnotationScope = { offset: PreviewPoint; clip: PreviewBox };
type TrackedScope = { id: string; containers?: PreviewPoint['containers']; point?: PreviewPoint };
type PendingDraft = {
  element?: PickedElement;
  region?: { x: number; y: number; width: number; height: number };
  annotation?: ReviewAnnotation;
  pinX: number;
  pinY: number;
  scroll: PreviewPoint;
};

const ZOOM_STEPS = [50, 75, 100, 125, 150];
const ANNOTATION_PREVIEW_RATIO = 16 / 9;
const ORIGIN = { x: 0, y: 0 };
const DRAFT_ELEMENT_ID = 'pending';

function previewScrollOffset(captured: PreviewPoint = ORIGIN, current: PreviewPoint, nested: PreviewPoint = ORIGIN): PreviewPoint {
  return { x: captured.x - current.x + nested.x, y: captured.y - current.y + nested.y };
}

function isPreviewPoint(value: unknown): value is PreviewPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as PreviewPoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPreviewBox(value: unknown): value is PreviewBox {
  if (!isPreviewPoint(value)) return false;
  const box = value as PreviewBox;
  return Number.isFinite(box.width) && Number.isFinite(box.height);
}

function AnnotationLayer({ clip, children }: { clip?: PreviewBox; children: ReactNode }) {
  if (!clip) return <>{children}</>;
  if (clip.width <= 0 || clip.height <= 0) return null;
  const right = clip.x + clip.width;
  const bottom = clip.y + clip.height;
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      clipPath: `polygon(${clip.x}px ${clip.y}px, ${right}px ${clip.y}px, ${right}px ${bottom}px, ${clip.x}px ${bottom}px)`,
    }}>
      {children}
    </div>
  );
}

function PositionedStroke({
  annotation,
  offset = ORIGIN,
  selected,
}: {
  annotation: ReviewAnnotation;
  offset?: PreviewPoint;
  selected?: boolean;
}) {
  return (
    <svg width="100%" height="100%" viewBox="0 0 1000 1000" preserveAspectRatio="none"
      style={{ position: 'absolute', left: offset.x, top: offset.y, overflow: 'visible', pointerEvents: 'none' }}
      aria-hidden="true">
      <g className={selected !== undefined ? 'om-design-annotation-group' : undefined} data-selected={selected}>
        <ReviewAnnotationGraphic annotation={{ ...annotation, width: 1000, height: 1000 }} />
      </g>
    </svg>
  );
}

function formatTime(ms: number) {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function annotationBounds(annotation: ReviewAnnotation) {
  const pts = annotation.marks.flatMap(m => m.points);
  if (!pts.length) return { minX: 0.05, minY: 0.05, maxX: 0.2, maxY: 0.2 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeInlineJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Build isolated Presenter popup HTML with sandboxed deck iframe and escaped title/notes. */
export function buildPresenterPopupHtml(title: string, rawUrl: string, speakerNotes: string[], total: number, bridgeToken?: string): string {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeTitle = escapeHtml(title);
  const safeUrl = escapeHtml(rawUrl);
  const safeNotesJson = escapeInlineJson(speakerNotes);
  const safeBridgeToken = escapeInlineJson(bridgeToken ?? null);
  return `<!doctype html><html><head><title>${safeTitle} — Presenter</title>
<link rel="stylesheet" href="/design-system/ui.css" />
<style>body{margin:0;background:var(--motion-bg);color:var(--motion-text);font-family:var(--motion-font-sans);display:grid;grid-template-columns:2fr 1fr;height:100vh}
iframe{width:100%;height:100%;border:0;background:var(--motion-canvas)}aside{display:flex;flex-direction:column;gap:12px;padding:18px;background:var(--motion-panel);border-left:1px solid var(--motion-border-subtle)}
.row{display:flex;gap:8px;align-items:center}button{padding:8px 14px;border-radius:8px;border:1px solid var(--motion-border);background:var(--motion-raised);color:var(--motion-text);cursor:pointer}
.notes{flex:1;overflow:auto;line-height:1.6;color:var(--motion-muted);white-space:pre-wrap;font-size:15px}</style></head>
<body data-motion-ui><iframe id="deck" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" src="${safeUrl}"></iframe>
<aside><div class="row"><strong id="counter">1 / ${safeTotal}</strong><span id="timer" style="margin-left:auto;font-variant-numeric:tabular-nums">00:00</span></div>
<div class="row"><button onclick="go(cur-1)">Prev</button><button onclick="go(cur+1)">Next</button><button onclick="reset()">Reset timer</button></div>
<div class="notes" id="notes"></div></aside>
<script id="om-presenter-notes" type="application/json">${safeNotesJson}</script>
<script>const notes=JSON.parse(document.getElementById('om-presenter-notes').textContent||'[]');let cur=0,sec=0;const f=document.getElementById('deck');const token=${safeBridgeToken};
function configureDeck(){if(token)f.contentWindow.postMessage({type:'om:design-deck-mode',token,enabled:true,singlePage:true},'*');}
f.addEventListener('load',configureDeck);
window.addEventListener('message',e=>{if(e.source===f.contentWindow&&e.data?.type==='om:design-deck-ready'&&e.data.token===token)configureDeck();});
function render(){document.getElementById('counter').textContent=(cur+1)+' / ${safeTotal}';document.getElementById('notes').textContent=notes[cur]||'No speaker notes for this slide.';}
function go(i){cur=Math.max(0,Math.min(${safeTotal - 1},i));f.contentWindow.postMessage({type:'od:slide',action:'go',index:cur},'*');render();}
function reset(){sec=0;}setInterval(()=>{sec++;document.getElementById('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');},1000);
window.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')go(cur+1);if(e.key==='ArrowLeft')go(cur-1);});render();</script></body></html>`;
}

/** Convert pointer client coordinates into the overlay's unscaled local layout coordinate space. */
export function overlayLocalPoint(el: Pick<HTMLElement, 'getBoundingClientRect' | 'clientWidth' | 'clientHeight'>, clientX: number, clientY: number) {
  const rect = el.getBoundingClientRect();
  const width = el.clientWidth > 0 ? el.clientWidth : Math.max(1, Math.round(rect.width));
  const height = el.clientHeight > 0 ? el.clientHeight : Math.max(1, Math.round(rect.height));
  const scaleX = width > 0 && rect.width > 0 ? rect.width / width : 1;
  const scaleY = height > 0 && rect.height > 0 ? rect.height / height : 1;
  return {
    x: (clientX - rect.left) / scaleX,
    y: (clientY - rect.top) / scaleY,
    width,
    height,
  };
}

function AnnotationVisualPreview({
  region,
  annotation,
  viewport,
  imageUrl,
  onImageLoaded,
}: {
  region?: DesignCommentAnchor['region'];
  annotation?: ReviewAnnotation;
  viewport?: { width: number; height: number };
  imageUrl?: string;
  onImageLoaded?: () => void;
}) {
  const { t } = useI18n();
  const [imageStatus, setImageStatus] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  if (annotation && !imageUrl) {
    const b = annotationBounds(annotation);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="om-design-annotation-thumb" aria-hidden="true">
          <svg width="100%" height="100%" viewBox="0 0 160 90" preserveAspectRatio="none" style={{ display: 'block' }}>
            <ReviewAnnotationGraphic annotation={{ ...annotation, width: 160, height: 90 }} />
          </svg>
        </div>
        <div className="om-design-annotation-meta">
          <span>Draw · {annotation.marks.length} stroke</span>
          <span>{Math.round(b.minX * 100)}%–{Math.round(b.maxX * 100)}%, {Math.round(b.minY * 100)}%–{Math.round(b.maxY * 100)}%</span>
        </div>
      </div>
    );
  }
  if (!viewport || (!region && !annotation)) return null;

  const viewportWidth = Math.max(1, annotation ? Math.round(annotation.width) : viewport.width);
  const viewportHeight = Math.max(1, annotation ? Math.round(annotation.height) : viewport.height);
  const bounds = annotation ? annotationBounds(annotation) : null;
  const box = bounds ? {
    x: bounds.minX * viewportWidth,
    y: bounds.minY * viewportHeight,
    width: (bounds.maxX - bounds.minX) * viewportWidth,
    height: (bounds.maxY - bounds.minY) * viewportHeight,
  } : region;
  if (!box) return null;
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.max(0, Math.min(viewportWidth, box.x + box.width) - x);
  const height = Math.max(0, Math.min(viewportHeight, box.y + box.height) - y);
  const overlay = annotation
    ? <ReviewAnnotationGraphic annotation={{ ...annotation, width: viewportWidth, height: viewportHeight }} />
    : <rect className="om-design-annotation-selection" x={x} y={y} width={width} height={height} vectorEffect="non-scaling-stroke" />;
  if (!imageUrl || imageStatus === 'unavailable') {
    return (
      <div className="om-design-annotation-fallback">
        <svg className="om-design-annotation-map" aria-hidden="true" viewBox={`0 0 ${viewportWidth} ${viewportHeight}`}>
          <rect className="om-design-annotation-map-page" width={viewportWidth} height={viewportHeight} vectorEffect="non-scaling-stroke" />
          {overlay}
        </svg>
        {imageUrl ? t('Preview unavailable') : `${Math.round(box.width)} × ${Math.round(box.height)}`}
      </div>
    );
  }

  // Cropping keeps the full selection and enough surrounding page to locate it.
  const previewWidth = Math.max(Math.min(viewportWidth, viewportHeight * ANNOTATION_PREVIEW_RATIO), width, height * ANNOTATION_PREVIEW_RATIO);
  const previewHeight = previewWidth / ANNOTATION_PREVIEW_RATIO;
  const left = Math.min(Math.max(0, x + (width - previewWidth) / 2), Math.max(0, viewportWidth - previewWidth))
    - Math.max(0, previewWidth - viewportWidth) / 2;
  const top = Math.min(Math.max(0, y + (height - previewHeight) / 2), Math.max(0, viewportHeight - previewHeight))
    - Math.max(0, previewHeight - viewportHeight) / 2;
  return (
    <div className="om-design-annotation-thumb om-design-annotation-snapshot">
      {imageStatus === 'loading' && <Skeleton className="om-design-thumb-skeleton" />}
      <img
        className="om-design-annotation-snapshot-image"
        src={imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        data-loaded={imageStatus === 'loaded'}
        style={{
          left: `${-left / previewWidth * 100}%`,
          top: `${-top / previewHeight * 100}%`,
          width: `${viewportWidth / previewWidth * 100}%`,
          height: `${viewportHeight / previewHeight * 100}%`,
        }}
        onLoad={() => {
          setImageStatus('loaded');
          onImageLoaded?.();
        }}
        onError={() => setImageStatus('unavailable')}
      />
      {imageStatus === 'loaded' && (
        <svg className="om-design-annotation-snapshot-overlay" aria-hidden="true" viewBox={`${left} ${top} ${previewWidth} ${previewHeight}`} preserveAspectRatio="none">
          {overlay}
        </svg>
      )}
    </div>
  );
}

export interface DesignProjectEditorProps {
  projectId: string;
  onBack: () => void;
  onOpenMcp?: () => void;
  embedded?: boolean;
  chatId?: string | null;
  artifactId?: string;
  externalRevision?: string;
  externalReloadKey?: number;
  requestedFile?: { path: string; seq: number } | null;
  controlledViewMode?: 'preview' | 'code';
  onViewModeChange?: (mode: 'preview' | 'code') => void;
  controlledViewport?: DesignViewportId;
  onViewportChange?: (viewport: DesignViewportId) => void;
  externalAnnotateActive?: boolean;
  externalAnnotTool?: 'select' | 'region' | 'draw';
  onAnnotateStateChange?: (active: boolean, tool: 'select' | 'region' | 'draw') => void;
  captureRef?: RefObject<(() => Promise<string | null>) | null>;
  onConsoleEntry?: (entry: BrowserConsoleEntry) => void;
  onAttachToChat?: (attachment: SuperAgentResourceAttachment, sendImmediately?: boolean) => void;
  onAttachFile?: (filePath: string) => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
}

function externalToolToDesignTool(tool?: 'select' | 'region' | 'draw'): AnnotationTool {
  if (tool === 'region') return 'region';
  if (tool === 'draw') return 'pen';
  return 'comment';
}

function designToolToExternalTool(tool: AnnotationTool): 'select' | 'region' | 'draw' {
  if (tool === 'region') return 'region';
  if (tool === 'pen') return 'draw';
  return 'select';
}

export function DesignProjectEditor({
  projectId,
  onBack,
  onOpenMcp,
  embedded = false,
  chatId = null,
  artifactId,
  externalRevision,
  externalReloadKey,
  requestedFile,
  controlledViewMode,
  onViewModeChange,
  controlledViewport,
  onViewportChange,
  externalAnnotateActive,
  externalAnnotTool,
  onAnnotateStateChange,
  captureRef,
  onConsoleEntry,
  onAttachToChat,
  onAttachFile,
  onNotify,
}: DesignProjectEditorProps) {
  const { t, locale } = useI18n();
  const { info: integrationInfo } = useIntegrationInfo();
  const promptOptions = { integration: integrationInfo, language: locale !== 'en' ? locale : null };
  const toast = useToast();
  const { project, versions, currentVersionId, comments, editors, loading, error, refresh, setProject, setComments } = useDesignProject(projectId);

  const [titleDraft, setTitleDraft] = useState('');
  const [activeFile, setActiveFile] = useState<string>('');
  const [viewMode, setViewMode] = useState<'preview' | 'code'>(controlledViewMode ?? 'preview');
  const [viewportId, setViewportId] = useState<DesignViewportId>(controlledViewport ?? 'desktop');
  const [rotated, setRotated] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const previewVersion = previewVersionId === currentVersionId ? undefined : versions.find(version => version.id === previewVersionId);

  const [sidebarOpen, setSidebarOpen] = useState(!embedded);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [commentFilter, setCommentFilter] = useState<'open' | 'all' | 'resolved'>('open');
  const [annotationTool, setActiveTool] = useState<AnnotationTool>(() =>
    externalAnnotateActive ? externalToolToDesignTool(externalAnnotTool) : 'none',
  );
  const activeTool = previewVersion ? 'none' : annotationTool;
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const selectedCommentCardRef = useRef<HTMLDivElement>(null);
  const [commentSlideIndexes, setCommentSlideIndexes] = useState(() => new Map<string, number>());
  const commentSlideLookups = useRef(new Map<string, Promise<number | undefined>>());
  const commentFocusRequest = useRef(0);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [attachingChat, setAttachingChat] = useState(false);

  // Code view state
  const [fileContent, setFileContent] = useState<string>('');
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeEditing, setCodeEditing] = useState(false);
  const [codeEditBaseRevision, setCodeEditBaseRevision] = useState<string | null>(null);
  const [codeConflict, setCodeConflict] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [savingCode, setSavingCode] = useState(false);
  const [reloadingCode, setReloadingCode] = useState(false);
  const [selectedCode, setSelectedCode] = useState<DesignCodeSelection | null>(null);
  const fileReadSeqRef = useRef(0);
  const codeViewerWrapRef = useRef<HTMLDivElement>(null);

  // Deck state
  const [activeSlide, setActiveSlide] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);

  // Agent copy popover & fallback
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentNote, setAgentNote] = useState('');
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [exporting, setExporting] = useState<DesignExportFormat | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [openInOpen, setOpenInOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(false);

  // Region / Pen drawing state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [penPoints, setPenPoints] = useState<ReviewPoint[]>([]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isolatedDeckFrame, setIsolatedDeckFrame] = useState<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bridgeToken = useMemo(() => makeRequestId('bridge'), []);
  const [previewScroll, setPreviewScroll] = useState<PreviewPoint>(ORIGIN);
  const [previewElementBoxes, setPreviewElementBoxes] = useState(() => new Map<string, PreviewBox>());
  const [previewScopes, setPreviewScopes] = useState(() => new Map<string, AnnotationScope>());
  const previewScrollRef = useRef(ORIGIN);
  const drawingScrollRef = useRef(ORIGIN);
  const drawingRequestRef = useRef<{ id: string; draft: PendingDraft; timer: number } | null>(null);
  const clearDrawingRequest = useCallback(() => {
    const request = drawingRequestRef.current;
    if (request) window.clearTimeout(request.timer);
    drawingRequestRef.current = null;
    return request;
  }, []);
  useEffect(() => { clearDrawingRequest(); return () => { clearDrawingRequest(); }; }, [activeTool, clearDrawingRequest]);
  const finishDrawingDraft = useCallback((id: string, point?: PreviewPoint) => {
    if (drawingRequestRef.current?.id !== id) return;
    const request = clearDrawingRequest();
    if (!request) return;
    setPendingDraft({
      ...request.draft,
      scroll: point?.containers?.length
        ? { ...request.draft.scroll, containers: point.containers }
        : request.draft.scroll,
    });
    setCommentText('');
  }, [clearDrawingRequest]);
  const captureResolversRef = useRef<Map<string, (dataUrl: string | null) => void>>(new Map());
  const consoleSeqRef = useRef(0);
  const onConsoleEntryRef = useRef(onConsoleEntry);
  onConsoleEntryRef.current = onConsoleEntry;

  const effectiveViewMode = controlledViewMode ?? viewMode;
  const setEffectiveViewMode = useCallback((next: 'preview' | 'code') => {
    setViewMode(next);
    onViewModeChange?.(next);
  }, [onViewModeChange]);

  const effectiveViewportId = controlledViewport ?? viewportId;
  const setEffectiveViewportId = useCallback((next: DesignViewportId) => {
    setViewportId(next);
    onViewportChange?.(next);
  }, [onViewportChange]);

  const updateAnnotationTool = useCallback((next: AnnotationTool) => {
    setActiveTool(next);
    if (next !== 'none' && effectiveViewMode !== 'preview') {
      setEffectiveViewMode('preview');
    }
    onAnnotateStateChange?.(next !== 'none', designToolToExternalTool(next));
  }, [effectiveViewMode, setEffectiveViewMode, onAnnotateStateChange]);

  const showToast = useCallback((message: string, tone: 'error' | 'info' = 'info', _category?: 'feedback') => {
    if (embedded && onNotify) {
      onNotify(message, tone);
    } else {
      toast.showToast(message, tone, 'feedback');
    }
  }, [embedded, onNotify, toast]);

  // Sync controlled props from Super Agent host
  const prevExternalAnnotRef = useRef({ active: externalAnnotateActive, tool: externalAnnotTool });
  useEffect(() => {
    const prev = prevExternalAnnotRef.current;
    if (prev.active === externalAnnotateActive && prev.tool === externalAnnotTool) return;
    prevExternalAnnotRef.current = { active: externalAnnotateActive, tool: externalAnnotTool };
    if (externalAnnotateActive === undefined) return;
    if (externalAnnotateActive) {
      setActiveTool(externalToolToDesignTool(externalAnnotTool));
    } else {
      setActiveTool('none');
      setDragStart(null);
      setDragCurrent(null);
      setPenPoints([]);
    }
  }, [externalAnnotateActive, externalAnnotTool]);

  const prevExternalRevRef = useRef<string | undefined>(externalRevision);
  useEffect(() => {
    if (!externalRevision) return;
    if (prevExternalRevRef.current === externalRevision) return;
    prevExternalRevRef.current = externalRevision;
    if (project && externalRevision !== project.revision) {
      setReloadNonce(n => n + 1);
      void refresh();
    }
  }, [externalRevision, project, refresh]);

  const prevExternalReloadRef = useRef<number | undefined>(externalReloadKey);
  useEffect(() => {
    if (externalReloadKey === undefined || externalReloadKey === prevExternalReloadRef.current) return;
    prevExternalReloadRef.current = externalReloadKey;
    setReloadNonce(n => n + 1);
    void refresh();
  }, [externalReloadKey, refresh]);

  const prevRequestedSeqRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedFile || requestedFile.seq === prevRequestedSeqRef.current) return;
    prevRequestedSeqRef.current = requestedFile.seq;
    setActiveFile(requestedFile.path);
    setEffectiveViewMode('code');
    setSelectedCode(null);
  }, [requestedFile, setEffectiveViewMode]);

  // Sync title and default viewport when project loads
  useEffect(() => {
    if (!project) return;
    setTitleDraft(project.title);
    if (!controlledViewport && project.scenario === 'mobile-app') setViewportId('mobile');
  }, [project?.id]);

  const previousEntryRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!project) return;
    const previousEntry = previousEntryRef.current;
    previousEntryRef.current = project.entry;
    setActiveFile(file => file !== previousEntry && project.files.some(item => item.path === file) ? file : project.entry);
  }, [project?.id, project?.entry, project?.revision]);

  useEffect(() => {
    if (previewVersionId === currentVersionId) setPreviewVersionId(null);
  }, [previewVersionId, currentVersionId]);

  // Reset edit session when switching project or active file
  useEffect(() => {
    setCodeEditing(false);
    setCodeEditBaseRevision(null);
    setCodeConflict(false);
    setSelectedCode(null);
  }, [project?.id, activeFile]);

  useEffect(() => {
    setSelectedCode(null);
  }, [codeEditing, effectiveViewMode]);

  // Load text content for active file (needed for code view, deck parsing, and srcdoc bridge)
  useEffect(() => {
    if (!project || !activeFile) return;
    let cancelled = false;
    const seq = ++fileReadSeqRef.current;
    setCodeLoading(true);
    designClient.readFile(project.id, activeFile).then(res => {
      if (cancelled || fileReadSeqRef.current !== seq) return;
      setFileContent(res.content);
      if (!codeEditing) setCodeDraft(res.content);
    }).catch(() => {
      if (!cancelled && fileReadSeqRef.current === seq) setFileContent('');
    }).finally(() => {
      if (!cancelled && fileReadSeqRef.current === seq) setCodeLoading(false);
    });
    return () => { cancelled = true; };
  }, [project?.id, project?.revision, activeFile, reloadNonce]);

  const htmlFiles = useMemo(() => project?.files.filter(f => f.kind === 'html') ?? [], [project]);
  const effectiveFile = activeFile || project?.entry || '';
  const isHtmlActive = useMemo(() => /\.html?$/i.test(effectiveFile), [effectiveFile]);
  const isDeck = useMemo(() => project?.scenario === 'deck' || (isHtmlActive && looksLikeDeck(fileContent)), [project?.scenario, isHtmlActive, fileContent]);
  const deckSlides = useMemo(() => (isDeck && fileContent ? parseDeckSlides(fileContent) : []), [isDeck, fileContent]);
  const speakerNotes = useMemo(() => (isDeck && fileContent ? parseSpeakerNotes(fileContent) : []), [isDeck, fileContent]);
  const configureDeck = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      type: 'om:design-deck-mode',
      token: bridgeToken,
      enabled: isDeck,
      singlePage: project?.scenario === 'deck',
    }, '*');
  }, [bridgeToken, isDeck, project?.scenario]);
  useEffect(configureDeck, [configureDeck]);

  // Escape dismisses active annotation tool / composer
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearDrawingRequest();
        updateAnnotationTool('none');
        setPendingDraft(null);
        setDragStart(null);
        setPenPoints([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDrawingRequest, updateAnnotationTool]);

  // Listen to bridge postMessages from preview iframe
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const fromOwnIframe = !iframeRef.current || !event.source || event.source === iframeRef.current.contentWindow;
      if (data.type === 'od:slide-state' && typeof data.active === 'number' && typeof data.count === 'number') {
        if (!fromOwnIframe) return;
        const frame = iframeRef.current;
        if (frame && event.source === frame.contentWindow && data.token === bridgeToken && typeof data.isolated === 'boolean') {
          setIsolatedDeckFrame(data.isolated ? frame : null);
        }
        setActiveSlide(data.active);
        setSlideCount(data.count);
        return;
      }
      if (data.token !== bridgeToken) return;
      if (!fromOwnIframe) return;
      if (data.type === 'om:design-deck-ready') {
        if (event.source && event.source === iframeRef.current?.contentWindow) configureDeck();
        return;
      }
      if (data.type === 'om:design-scroll' || data.type === 'om:design-element-boxes' || data.type === 'om:design-picked-scroll') {
        if (!event.source || event.source !== iframeRef.current?.contentWindow) return;
        if (data.type === 'om:design-picked-scroll') {
          const point = data.scroll;
          if (!isPreviewPoint(point)) return;
          const containers = Array.isArray(point.containers) ? point.containers.slice(0, 24).filter(container =>
            isPreviewPoint(container) && typeof container.selector === 'string' && container.selector.length > 0 && container.selector.length <= 1000,
          ) : [];
          finishDrawingDraft(data.requestId, { x: point.x, y: point.y, containers });
        } else if (data.type === 'om:design-scroll') {
          const { x, y } = data.scroll ?? {};
          if (Number.isFinite(x) && Number.isFinite(y)
            && (x !== previewScrollRef.current.x || y !== previewScrollRef.current.y)) {
            previewScrollRef.current = { x, y };
            setPreviewScroll(previewScrollRef.current);
          }
        } else if (Array.isArray(data.boxes)) {
          const boxes = new Map<string, PreviewBox>();
          for (const item of data.boxes) {
            if (typeof item?.id === 'string' && isPreviewBox(item.box)) boxes.set(item.id, item.box);
          }
          const scopes = new Map<string, AnnotationScope>();
          if (Array.isArray(data.scopes)) {
            for (const item of data.scopes) {
              if (typeof item?.id === 'string' && isPreviewPoint(item.offset) && isPreviewBox(item.clip)) {
                scopes.set(item.id, { offset: item.offset, clip: item.clip });
              }
            }
          }
          setPreviewElementBoxes(boxes);
          setPreviewScopes(scopes);
        }
        return;
      }
      if ((data.type === 'om:design-pick' || data.type === 'om:preview-pick') && data.element) {
        if (previewVersion) return;
        const raw = data.element as Record<string, unknown>;
        const rawBox = (raw.box ?? raw.rect ?? data.rect ?? { x: 0, y: 0, width: 40, height: 24 }) as {
          x?: number; y?: number; width?: number; height?: number;
        };
        const picked: PickedElement = {
          selector: String(raw.selector || raw.tagName || 'div'),
          ...(typeof raw.elementId === 'string' && raw.elementId
            ? { elementId: raw.elementId }
            : typeof raw.id === 'string' && raw.id
              ? { elementId: raw.id }
              : {}),
          tagName: String(raw.tagName || 'div').toLowerCase(),
          label: String(raw.label || raw.text || raw.selector || raw.tagName || 'element'),
          ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
          ...(typeof raw.htmlHint === 'string'
            ? { htmlHint: raw.htmlHint }
            : typeof raw.htmlPreview === 'string'
              ? { htmlHint: raw.htmlPreview }
              : {}),
          box: {
            x: Math.round(rawBox.x ?? 0),
            y: Math.round(rawBox.y ?? 0),
            width: Math.max(1, Math.round(rawBox.width ?? 40)),
            height: Math.max(1, Math.round(rawBox.height ?? 24)),
          },
        };
        const pt = data.clientPoint ?? {
          x: picked.box.x + Math.round(picked.box.width / 2),
          y: picked.box.y + Math.min(24, Math.round(picked.box.height / 2)),
        };
        const scroll = isPreviewPoint(data.scroll)
          ? data.scroll
          : previewScrollRef.current;
        setPendingDraft({ element: picked, pinX: pt.x, pinY: pt.y, scroll });
        setCommentText('');
      } else if (data.type === 'om:preview-console' && typeof data.text === 'string') {
        const level = data.level === 'warn' ? 'warn' : data.level === 'log' ? 'log' : 'error';
        onConsoleEntryRef.current?.({
          id: `design-pv-${++consoleSeqRef.current}-${Date.now()}`,
          level,
          text: data.text.slice(0, 600),
          ...(typeof data.url === 'string' ? { url: data.url } : {}),
          ...(typeof data.line === 'number' ? { line: data.line } : {}),
          timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
        });
      } else if (data.type === 'om:preview-capture-result') {
        const reqId = String(data.requestId || '');
        const resolver = captureResolversRef.current.get(reqId);
        if (resolver) {
          captureResolversRef.current.delete(reqId);
          resolver(typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/png;base64,') ? data.dataUrl : null);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bridgeToken, configureDeck, finishDrawingDraft, previewVersion]);

  // Toggle pick mode inside bridge iframe
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ type: 'om:design-mode', token: bridgeToken, pick: activeTool === 'comment' }, '*');
      win.postMessage({ type: 'om:preview-mode', token: bridgeToken, pick: activeTool === 'comment' }, '*');
    } catch { /* ignore */ }
  }, [activeTool, bridgeToken]);

  const sendDeckCommand = useCallback((action: 'next' | 'prev' | 'first' | 'last' | 'go', index?: number) => {
    const total = Math.max(1, slideCount || deckSlides.length);
    const target = action === 'go' && typeof index === 'number' ? Math.max(0, Math.min(total - 1, index))
      : action === 'next' ? Math.min(total - 1, activeSlide + 1)
      : action === 'prev' ? Math.max(0, activeSlide - 1)
      : action === 'last' ? total - 1 : 0;
    setActiveSlide(target);
    try { iframeRef.current?.contentWindow?.postMessage({ type: 'od:slide', action: 'go', index: target }, '*'); } catch { /* ignore */ }
  }, [activeSlide, slideCount, deckSlides.length]);

  const copyPrompt = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setManualCopy(null);
      showToast(t('Copied. Paste into your Agent.'), 'info', 'feedback');
    } catch {
      setManualCopy(text);
      showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback');
    }
  }, [showToast, t]);

  const commitTitle = async () => {
    if (!project) return;
    const next = titleDraft.trim();
    if (!next || next === project.title) { setTitleDraft(project.title); return; }
    try {
      const { project: updated } = await designClient.renameProject(project.id, next, project.title);
      setProject(updated);
      showToast(t('Project renamed'), 'info', 'feedback');
    } catch (err) {
      setTitleDraft(project.title);
      showToast(err instanceof Error ? err.message : t('Could not rename project'), 'error', 'feedback');
    }
  };

  const saveCode = async (overrideRevision?: string) => {
    if (!project || !activeFile || savingCode || reloadingCode) return;
    setSavingCode(true);
    try {
      const { project: updated } = await designClient.writeFiles(project.id, {
        expectedRevision: overrideRevision ?? codeEditBaseRevision ?? project.revision,
        files: [{ path: activeFile, content: codeDraft }],
        summary: `Manual edit to ${activeFile}`,
        source: 'manual',
      });
      setProject(updated);
      setFileContent(codeDraft);
      setCodeEditBaseRevision(null);
      setCodeConflict(false);
      setCodeEditing(false);
      await refresh();
      showToast(t('Saved new version'), 'info', 'feedback');
    } catch (err) {
      if (err instanceof DesignApiError && err.code === 'VERSION_CONFLICT') {
        await refresh();
        setCodeConflict(true);
        showToast(t('Project changed externally. Reload to get the latest revision.'), 'error', 'feedback');
      } else {
        showToast(err instanceof Error ? err.message : t('Could not save file'), 'error', 'feedback');
      }
    } finally {
      setSavingCode(false);
    }
  };

  const discardAndReloadLatest = async () => {
    if (!project || !activeFile || savingCode || reloadingCode) return;
    setReloadingCode(true);
    const seq = ++fileReadSeqRef.current;
    try {
      const { project: latest } = await designClient.getProject(project.id);
      const targetFile = latest.files.some(f => f.path === activeFile) ? activeFile : latest.entry;
      const { content } = await designClient.readFile(latest.id, targetFile);
      if (fileReadSeqRef.current !== seq) return;
      setProject(latest);
      if (targetFile !== activeFile) setActiveFile(targetFile);
      setFileContent(content);
      setCodeDraft(content);
      setCodeEditBaseRevision(latest.revision);
      setCodeConflict(false);
    } catch (err) {
      if (fileReadSeqRef.current === seq) {
        showToast(err instanceof Error ? err.message : t('Could not reload file'), 'error', 'feedback');
      }
    } finally {
      if (fileReadSeqRef.current === seq) setCodeLoading(false);
      setReloadingCode(false);
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!project || restoringVersion) return;
    setRestoringVersion(true);
    try {
      const { project: updated, version, changed } = await designClient.restoreVersion(project.id, versionId, project.revision);
      setProject(updated);
      setPreviewVersionId(null);
      if (changed || previewVersion) {
        setActiveSlide(0);
        setSlideCount(0);
        setReloadNonce(n => n + 1);
      }
      await refresh();
      showToast(t(changed ? 'Set {label} as the current version' : '{label} is already the current version.', { label: version.label }), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not restore version'), 'error', 'feedback');
    } finally {
      setRestoringVersion(false);
    }
  };

  const handlePreviewVersion = (versionId: string) => {
    const historical = versionId !== currentVersionId;
    if (historical) {
      clearDrawingRequest();
      setPendingDraft(null);
      setCommentText('');
      setDragStart(null);
      setDragCurrent(null);
      setPenPoints([]);
      if (activeTool !== 'none') updateAnnotationTool('none');
    }
    setPreviewVersionId(historical ? versionId : null);
    setEffectiveViewMode('preview');
  };

  const handleExport = async (format: DesignExportFormat, versionId?: string | null) => {
    if (!project) return;
    setExporting(format);
    setExportOpen(false);
    try {
      const exportVersionId = versionId ?? previewVersion?.id ?? null;
      const filePath = exportVersionId
        ? exportVersionId === previewVersion?.id ? previewFile : undefined
        : isHtmlActive ? effectiveFile : project.entry;
      const filename = await designClient.downloadExport(project.id, { format, versionId: exportVersionId, filePath });
      showToast(t('Exported {filename}', { filename }), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Export failed'), 'error', 'feedback');
    } finally {
      setExporting(null);
    }
  };

  const handleOpenIn = async (editorId: string, label: string) => {
    if (!project) return;
    setOpenInOpen(false);
    try {
      await designClient.openIn(project.id, editorId);
      showToast(t('Opened in {app}', { app: label }), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not open editor'), 'error', 'feedback');
    }
  };

  const openPresenterPopup = () => {
    if (!project) return;
    const popup = window.open('', 'om-design-presenter', 'width=1200,height=760');
    if (!popup) { showToast(t('Pop-up blocked by browser'), 'error', 'feedback'); return; }
    const rawUrl = new URL(designRoutes.raw(project.id, activeFile || project.entry), window.location.origin);
    rawUrl.searchParams.set('omBridge', bridgeToken);
    const total = Math.max(1, slideCount || deckSlides.length);
    popup.document.write(buildPresenterPopupHtml(project.title, rawUrl.href, speakerNotes, total, bridgeToken));
    popup.document.close();
  };

  const currentViewport = designViewports.find(v => v.id === effectiveViewportId) ?? designViewports[0];
  const frameWidth = currentViewport.width ? (rotated ? currentViewport.height! : currentViewport.width) : null;
  const frameHeight = currentViewport.height ? (rotated ? currentViewport.width! : currentViewport.height) : null;

  const previewFile = previewVersion
    ? previewVersion.entry ?? previewVersion.files.find(file => file.path === project?.entry)?.path
      ?? previewVersion.files.find(file => /\.html?$/i.test(file.path))?.path
    : activeFile;
  const baseRawPreviewUrl = project
    ? `${designRoutes.raw(project.id, previewFile || project.entry)}${previewVersion ? `?version=${encodeURIComponent(previewVersion.id)}&r=${reloadNonce}` : `?r=${reloadNonce}`}`
    : '';
  const rawPreviewUrl = (embedded || previewVersion) && baseRawPreviewUrl
    ? `${baseRawPreviewUrl}&omBridge=${encodeURIComponent(bridgeToken)}`
    : baseRawPreviewUrl;

  const captureDesignSnapshot = useCallback(async (): Promise<string | null> => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      const requestId = `dcap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const canvasUrl = await new Promise<string | null>(resolve => {
        const timer = setTimeout(() => {
          captureResolversRef.current.delete(requestId);
          resolve(null);
        }, 450);
        captureResolversRef.current.set(requestId, dataUrl => {
          clearTimeout(timer);
          resolve(dataUrl);
        });
        try {
          win.postMessage({ type: 'om:preview-capture', token: bridgeToken, requestId }, '*');
        } catch {
          clearTimeout(timer);
          captureResolversRef.current.delete(requestId);
          resolve(null);
        }
      });
      if (canvasUrl) return canvasUrl;
    }
    if (chatId && baseRawPreviewUrl) {
      const cleanPath = baseRawPreviewUrl.split('?')[0];
      const w = frameWidth ?? Math.max(240, Math.round(overlayRef.current?.clientWidth || 1280));
      const h = frameHeight ?? Math.max(200, Math.round(overlayRef.current?.clientHeight || 800));
      try {
        const shot = await captureSuperAgentPreviewSnapshot(chatId, cleanPath, w, h);
        return shot.dataUrl || null;
      } catch {
        return null;
      }
    }
    return null;
  }, [bridgeToken, chatId, baseRawPreviewUrl, frameWidth, frameHeight]);

  useEffect(() => {
    if (!captureRef) return;
    if (effectiveViewMode === 'preview') {
      captureRef.current = captureDesignSnapshot;
      return () => {
        if (captureRef.current === captureDesignSnapshot) captureRef.current = null;
      };
    }
    return undefined;
  }, [captureRef, effectiveViewMode, captureDesignSnapshot]);

  const attachDraftToSuperAgent = async (sendImmediately: boolean) => {
    if (!project || previewVersion || !pendingDraft || !onAttachToChat || attachingChat) return;
    setAttachingChat(true);
    try {
      const el = overlayRef.current;
      const rect = el?.getBoundingClientRect();
      const vw = frameWidth ?? Math.max(320, Math.round(el?.clientWidth || rect?.width || 1280));
      const vh = frameHeight ?? Math.max(240, Math.round(el?.clientHeight || rect?.height || 800));
      const attachment = await buildDesignSelectionAttachment({
        project,
        artifactId,
        chatId,
        pageUrl: baseRawPreviewUrl,
        filePath: activeFile || project.entry,
        ...(isDeck ? { slideIndex: activeSlide, slideCount: Math.max(1, slideCount || deckSlides.length) } : {}),
        viewport: { width: vw, height: vh },
        draft: pendingDraft,
        comment: commentText.trim(),
        captureBase: captureDesignSnapshot,
      });
      onAttachToChat(attachment, sendImmediately);
      setPendingDraft(null);
      setCommentText('');
      updateAnnotationTool('none');
    } finally {
      setAttachingChat(false);
    }
  };

  const attachCommentToSuperAgent = async (comment: DesignComment, sendImmediately: boolean) => {
    if (!project || !onAttachToChat || attachingChat) return;
    setAttachingChat(true);
    try {
      const attachment = await designCommentToAttachment({
        project,
        comment,
        artifactId,
        chatId,
        slideCount: isDeck ? Math.max(1, slideCount || deckSlides.length) : undefined,
      });
      onAttachToChat(attachment, sendImmediately);
    } finally {
      setAttachingChat(false);
    }
  };

  const attachOpenCommentsToSuperAgent = async (sendImmediately: boolean) => {
    if (!project || !onAttachToChat || !openComments.length || attachingChat) return;
    setAttachingChat(true);
    try {
      for (const [idx, c] of openComments.slice(0, 8).entries()) {
        const attachment = await designCommentToAttachment({
          project,
          comment: c,
          artifactId,
          chatId,
          slideCount: isDeck ? Math.max(1, slideCount || deckSlides.length) : undefined,
        });
        const isLast = idx === Math.min(openComments.length, 8) - 1;
        onAttachToChat(attachment, sendImmediately && isLast);
      }
    } finally {
      setAttachingChat(false);
    }
  };

  const handleAttachCodeSelection = () => {
    if (!project || !onAttachToChat || !selectedCode) return;
    const attachment = buildDesignCodeSelectionAttachment({
      project,
      artifactId,
      pageUrl: baseRawPreviewUrl,
      filePath: effectiveFile,
      selection: selectedCode,
    });
    onAttachToChat(attachment, false);
  };

  const submitDraftComment = async () => {
    if (!project || previewVersion || !pendingDraft) return;
    const autoText = pendingDraft.element
      ? `${pendingDraft.element.tagName} ${pendingDraft.element.label}`.slice(0, 120)
      : pendingDraft.region
        ? `Region ${Math.round(pendingDraft.region.width)}×${Math.round(pendingDraft.region.height)}`
        : pendingDraft.annotation
          ? `Pen annotation (${pendingDraft.annotation.marks.length})`
          : '';
    const effectiveText = commentText.trim() || (embedded ? autoText : '');
    if (!effectiveText) return;
    setSubmittingComment(true);
    try {
      const el = overlayRef.current;
      const rect = el?.getBoundingClientRect();
      const vw = frameWidth ?? Math.max(320, Math.round(el?.clientWidth || rect?.width || 1280));
      const vh = frameHeight ?? Math.max(240, Math.round(el?.clientHeight || rect?.height || 800));
      const isolatedSlide = iframeRef.current !== null && isolatedDeckFrame === iframeRef.current;
      const anchor: DesignCommentAnchor = {
        filePath: activeFile || project.entry,
        viewport: { id: effectiveViewportId, width: vw, height: vh },
        scroll: pendingDraft.scroll,
        ...(isDeck ? { slideIndex: activeSlide } : {}),
        ...(isDeck && isolatedSlide ? { isolatedSlide: true } : {}),
        ...(pendingDraft.element ? { element: pendingDraft.element } : {}),
        ...(pendingDraft.region ? { region: pendingDraft.region } : {}),
        ...(pendingDraft.annotation ? { annotation: pendingDraft.annotation } : {}),
      };
      const res = await designClient.createComment(project.id, {
        text: effectiveText, anchor, expectedRevision: project.revision,
      });
      setComments(res.comments);
      setSelectedCommentId(res.comment.id);
      setCommentFilter(filter => filter === 'resolved' ? 'open' : filter);
      setPendingDraft(null);
      setCommentText('');
      updateAnnotationTool('none');
      setSidebarOpen(true);
      setSidebarTab('comments');
      showToast(t('Annotation saved'), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not save annotation'), 'error', 'feedback');
    } finally {
      setSubmittingComment(false);
    }
  };

  const toggleCommentStatus = async (comment: DesignComment) => {
    if (!project) return;
    try {
      const nextStatus = comment.status === 'open' ? 'resolved' : 'open';
      const { comment: updated } = await designClient.updateComment(project.id, comment.id, {
        status: nextStatus, expectedCommentRevision: comment.commentRevision,
      });
      setComments(comments.map(c => (c.id === updated.id ? updated : c)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not update annotation'), 'error', 'feedback');
    }
  };

  const removeComment = async (commentId: string) => {
    if (!project) return;
    try {
      await designClient.deleteComment(project.id, commentId);
      setComments(comments.filter(c => c.id !== commentId));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not delete annotation'), 'error', 'feedback');
    }
  };

  // Pointer handlers for region box & pen drawing overlay (always in unscaled overlay coordinates)
  const onOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool !== 'region' && activeTool !== 'pen') return;
    if (event.target !== event.currentTarget) return;
    clearDrawingRequest();
    setPendingDraft(null);
    drawingScrollRef.current = previewScrollRef.current;
    const { x, y, width, height } = overlayLocalPoint(event.currentTarget, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (activeTool === 'region') {
      setDragStart({ x, y });
      setDragCurrent({ x, y });
    } else if (activeTool === 'pen') {
      setPenPoints([{ x: Math.max(0, Math.min(1, x / width)), y: Math.max(0, Math.min(1, y / height)) }]);
    }
  };

  const onOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const { x, y, width, height } = overlayLocalPoint(event.currentTarget, event.clientX, event.clientY);
    if (activeTool === 'region' && dragStart) {
      setDragCurrent({ x, y });
    } else if (activeTool === 'pen' && penPoints.length > 0 && event.buttons > 0) {
      setPenPoints(prev => prev.length < 900 ? [...prev, { x: Math.max(0, Math.min(1, x / width)), y: Math.max(0, Math.min(1, y / height)) }] : prev);
    }
  };

  const composeDrawingDraft = (draft: PendingDraft, point: PreviewPoint) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const id = makeRequestId('scroll');
    drawingRequestRef.current = {
      id, draft,
      timer: window.setTimeout(() => finishDrawingDraft(id), 250),
    };
    win.postMessage({ type: 'om:design-pick-scroll', token: bridgeToken, requestId: id, point }, '*');
  };

  const onOverlayPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const { width: w, height: h } = overlayLocalPoint(event.currentTarget, event.clientX, event.clientY);
    if (activeTool === 'region' && dragStart && dragCurrent) {
      const x = Math.round(Math.min(dragStart.x, dragCurrent.x));
      const y = Math.round(Math.min(dragStart.y, dragCurrent.y));
      const width = Math.round(Math.abs(dragCurrent.x - dragStart.x));
      const height = Math.round(Math.abs(dragCurrent.y - dragStart.y));
      setDragStart(null);
      setDragCurrent(null);
      if (width > 8 && height > 8) {
        composeDrawingDraft({ region: { x, y, width, height }, pinX: x, pinY: y, scroll: drawingScrollRef.current },
          { x: x + width / 2, y: y + height / 2 });
      }
    } else if (activeTool === 'pen' && penPoints.length >= 2) {
      const annotation: ReviewAnnotation = { version: 1, coordinateSpace: 'normalized', width: w, height: h, marks: [{ kind: 'pen', points: penPoints }] };
      const bounds = annotationBounds(annotation);
      setPenPoints([]);
      composeDrawingDraft({ annotation, pinX: bounds.minX * w, pinY: bounds.minY * h, scroll: drawingScrollRef.current },
        { x: penPoints[0].x * w, y: penPoints[0].y * h });
    }
  };

  const openComments = useMemo(() => comments.filter(c => c.status === 'open'), [comments]);
  const visibleComments = useMemo(() => {
    if (commentFilter === 'open') return openComments;
    if (commentFilter === 'resolved') return comments.filter(c => c.status === 'resolved');
    return comments;
  }, [comments, openComments, commentFilter]);

  useEffect(() => {
    if (sidebarOpen && sidebarTab === 'comments') selectedCommentCardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [commentFilter, selectedCommentId, sidebarOpen, sidebarTab]);

  const resolveCommentSlide = useCallback((commentId: string) => {
    const key = `${projectId}:${commentId}`;
    const existing = commentSlideLookups.current.get(key);
    if (existing) return existing;
    const lookup = designClient.getCommentPreviewSlideIndex(projectId, commentId).then(index => {
      if (index !== undefined) setCommentSlideIndexes(current => new Map(current).set(key, index));
      return index;
    }).catch(() => {
      commentSlideLookups.current.delete(key);
      return undefined;
    });
    commentSlideLookups.current.set(key, lookup);
    return lookup;
  }, [projectId]);

  const pinComments = useMemo(() => {
    if (previewVersion) return [];
    return openComments.filter(comment => {
      const slideIndex = commentSlideIndexes.get(`${projectId}:${comment.id}`) ?? comment.anchor.slideIndex;
      return comment.anchor.filePath === effectiveFile
        && (!isDeck || slideIndex === undefined || slideIndex === activeSlide);
    });
  }, [previewVersion, openComments, commentSlideIndexes, projectId, effectiveFile, isDeck, activeSlide]);

  const pendingElement = pendingDraft?.element;
  const trackedElements = useMemo(() => {
    const elements = pinComments.flatMap(({ id, anchor }) => anchor.element
      ? [{ id, selector: anchor.element.selector, elementId: anchor.element.elementId }]
      : []);
    if (pendingElement) elements.push({ id: DRAFT_ELEMENT_ID, selector: pendingElement.selector, elementId: pendingElement.elementId });
    return elements;
  }, [pinComments, pendingElement]);

  const pendingContainers = pendingDraft?.scroll.containers;
  const trackedScopes = useMemo(() => {
    const scopes = pinComments.flatMap<TrackedScope>(({ id, anchor }) => {
      if (anchor.scroll?.containers?.length) return [{ id, containers: anchor.scroll.containers }];
      // Existing freeform comments only have a viewport position. Use it to find the scroll container.
      if (anchor.scroll) return [];
      if (anchor.region) {
        const { x, y, width, height } = anchor.region;
        return [{ id, point: { x: x + width / 2, y: y + height / 2 } }];
      }
      const firstPoint = anchor.annotation?.marks[0]?.points[0];
      return firstPoint ? [{ id, point: { x: firstPoint.x * anchor.viewport.width, y: firstPoint.y * anchor.viewport.height } }] : [];
    });
    if (pendingContainers?.length) scopes.push({ id: DRAFT_ELEMENT_ID, containers: pendingContainers });
    return scopes;
  }, [pinComments, pendingContainers]);
  const trackAnnotations = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      type: 'om:design-track-elements', token: bridgeToken, elements: trackedElements, scopes: trackedScopes,
    }, '*');
  }, [bridgeToken, trackedElements, trackedScopes]);
  useEffect(trackAnnotations, [trackAnnotations]);

  const pendingBox = pendingElement && previewElementBoxes.get(DRAFT_ELEMENT_ID);
  const pendingScope = pendingContainers?.length ? previewScopes.get(DRAFT_ELEMENT_ID) : undefined;
  const pendingOffset = pendingBox && pendingElement
    ? { x: pendingBox.x - pendingElement.box.x, y: pendingBox.y - pendingElement.box.y }
    : previewScrollOffset(pendingDraft?.scroll, previewScroll, pendingScope?.offset);
  const isolatedDeck = iframeRef.current !== null && isolatedDeckFrame === iframeRef.current;
  const positionedComments = pinComments.map(comment => {
    const scope = previewScopes.get(comment.id);
    // Legacy comments captured the window scroll of the entire slide stack.
    // The isolated slide already has its own viewport, so keep the captured viewport coordinates.
    const legacyInIsolatedDeck = isolatedDeck && !comment.anchor.isolatedSlide
      && commentSlideIndexes.has(`${projectId}:${comment.id}`);
    const capturedScroll = legacyInIsolatedDeck ? ORIGIN : comment.anchor.scroll;
    return { comment, clip: scope?.clip, offset: previewScrollOffset(capturedScroll, previewScroll, scope?.offset) };
  });

  const awaitingSrcDoc = !embedded && effectiveViewMode === 'preview' && isHtmlActive && !previewVersion && !fileContent;
  const useSrcDoc = !embedded && effectiveViewMode === 'preview' && isHtmlActive && !previewVersion && Boolean(fileContent);
  const baseHref = useMemo(() => {
    if (!project) return '';
    const relDir = activeFile.includes('/') ? activeFile.slice(0, activeFile.lastIndexOf('/') + 1) : '';
    return new URL(designRoutes.raw(project.id, relDir), window.location.origin).href;
  }, [project, activeFile]);
  const srcDocValue = useMemo(() => (useSrcDoc ? buildBridgeSrcDoc(fileContent, baseHref, bridgeToken, false) : undefined), [useSrcDoc, fileContent, baseHref, bridgeToken]);

  if (loading && !project) {
    return (
      <div className="om-design-shell" data-embedded={embedded || undefined} style={{ alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <OpenDesignLoadingMark height={24} />
        <span className="om-design-muted">{t('Loading design project…')}</span>
      </div>
    );
  }
  if (error || !project) {
    return (
      <div className="om-design-shell" data-embedded={embedded || undefined} style={{ alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p>{error || t('Design project not found')}</p>
        {embedded ? (
          <Button type="button" variant="secondary" onClick={() => void refresh()}>{t('Retry')}</Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onBack}>{t('Back to Design Studio')}</Button>
        )}
      </div>
    );
  }

  const versionsPopupBody = (
    <>
      <strong>{t('Version history')}</strong>
      {versions.length === 0 ? (
        <span className="om-design-muted">{t('No saved versions yet.')}</span>
      ) : versions.map(v => (
        <div key={v.id} className="om-design-item-card" data-active={v.id === (previewVersion?.id ?? currentVersionId)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <strong>{v.label}</strong>
            <span className="om-design-badge">{v.source}</span>
            <span className="om-design-muted">{formatTime(v.createdAt)}</span>
          </div>
          {v.summary && <span className="om-design-muted">{v.summary}</span>}
          <div style={{ display: 'flex', gap: 6 }}>
            <Button type="button" size="sm" variant="ghost" onClick={() => { handlePreviewVersion(v.id); setVersionsOpen(false); }}>
              {v.id === currentVersionId ? t('Current') : t('Preview')}
            </Button>
            {v.id !== currentVersionId && (
              <Button type="button" size="sm" variant="secondary" disabled={restoringVersion} onClick={() => { void handleRestoreVersion(v.id); setVersionsOpen(false); }}>
                {t('Make current version')}
              </Button>
            )}
          </div>
        </div>
      ))}
    </>
  );

  const exportPopupBody = (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('open-design')}>{t('Open Design project (.zip)')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('zip')}>{t('Source archive (.zip)')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('html')}>{t('Standalone HTML (.html)')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('pdf')}>{t('PDF document (.pdf)')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('png')}>{t('PNG screenshot (.png)')}</Button>
      {isDeck && <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('pptx')}>{t('PowerPoint deck (.pptx)')}</Button>}
    </>
  );

  const toggleTool = (tool: Exclude<AnnotationTool, 'none'>) => {
    const next = activeTool === tool ? 'none' : tool;
    updateAnnotationTool(next);
  };

  return (
    <div className="om-design-shell" data-design-editor={project.id} data-embedded={embedded || undefined}>
      {/* Standalone top header (omitted in Super Agent embedded mode where ArtifactBrowserPane owns the frame chrome) */}
      {!embedded && (
        <header className="om-design-header">
          <div className="om-design-header-group">
            <Tooltip label={t('Back to projects')}>
              <IconButton aria-label={t('Back to projects')} icon={<RemixIcon name="arrow-left-line" size={16} />} onClick={onBack} />
            </Tooltip>
            <input
              className="om-design-title-input"
              aria-label={t('Project title')}
              size={Math.max(6, Math.min(32, (titleDraft || project.title).length))}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
            />
            {findDesignScenario(project.scenario) && (
              <span className="om-design-badge">
                <RemixIcon name={findDesignScenario(project.scenario)!.icon} size={12} />
                {t(findDesignScenario(project.scenario)!.label)}
              </span>
            )}
            {htmlFiles.length > 1 && htmlFiles.slice(0, 4).map(file => (
              <Button key={file.path} type="button" size="sm" variant={activeFile === file.path ? 'secondary' : 'ghost'} onClick={() => setActiveFile(file.path)}>
                {file.path}
              </Button>
            ))}
          </div>

          <div className="om-design-header-group">
            {/* Versions popover */}
            <Popover.Root modal={false} open={versionsOpen} onOpenChange={setVersionsOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="history-line" size={15} />}>
                  {project.versionLabel ?? 'v1'}
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {versionsPopupBody}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>

            {/* Share live deploy popover */}
            <DesignDeployPopover
              projectId={project.id}
              filePath={isHtmlActive ? activeFile : project.entry}
              title={project.title}
              revisionKey={project.revision}
              onNotify={(message, variant = 'info') => showToast(message, variant, 'feedback')}
              onCopyUrl={async url => {
                try {
                  await navigator.clipboard.writeText(url);
                  showToast(t('Share link copied'), 'info', 'feedback');
                } catch {
                  showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback');
                }
              }}
            />

            {/* Export menu */}
            <Popover.Root modal={false} open={exportOpen} onOpenChange={setExportOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="secondary" loading={Boolean(exporting)} icon={<RemixIcon name="download-2-line" size={14} />}>
                  {t('Export')}
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover">
                    {exportPopupBody}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>

            {/* Open in menu */}
            <Popover.Root modal={false} open={openInOpen} onOpenChange={setOpenInOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="folder-open-line" size={14} />}>
                  {t('Open in')}
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover">
                    {editors.filter(e => e.available).map(ed => (
                      <Button key={ed.id} type="button" size="sm" variant="ghost" icon={<RemixIcon name={ed.icon} size={14} />} onClick={() => void handleOpenIn(ed.id, ed.label)}>
                        {ed.label}
                      </Button>
                    ))}
                    <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="file-copy-line" size={14} />} onClick={() => { setOpenInOpen(false); void copyPrompt(project.path); }}>
                      {t('Copy local path')}
                    </Button>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>

            {/* Copy to Agent (MCP) */}
            <Popover.Root modal={false} open={agentOpen} onOpenChange={setAgentOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="primary" icon={<RemixIcon name="plug-line" size={14} />}>
                  {t('Copy to Agent')}
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-150">
                  <Popover.Popup className="om-design-popover" style={{ width: 340 }}>
                    <strong>{t('Hand off to Codex or Claude Code (MCP)')}</strong>
                    <span className="om-design-muted">{t('OpenMotion does not run a built-in agent. Copy this MCP instruction into your connected Agent to edit this project.')}</span>
                    <textarea
                      className="om-design-textarea"
                      placeholder={t('Optional change request for your Agent…')}
                      value={agentNote}
                      onChange={e => setAgentNote(e.target.value)}
                    />
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {openComments.length > 0 && (
                        <Button type="button" size="sm" variant="primary" onClick={() => { void copyPrompt(designCommentsPrompt(project, openComments, agentNote, promptOptions)); setAgentOpen(false); }}>
                          {t('Copy {count} open annotations', { count: openComments.length })}
                        </Button>
                      )}
                      <Button type="button" size="sm" variant={openComments.length > 0 ? 'secondary' : 'primary'} onClick={() => { void copyPrompt(designProjectPrompt(project, agentNote, promptOptions)); setAgentOpen(false); }}>
                        {t('Copy project brief')}
                      </Button>
                      {onOpenMcp && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => { setAgentOpen(false); onOpenMcp(); }}>
                          {t('Connect MCP')}
                        </Button>
                      )}
                    </div>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </header>
      )}

      {/* Editor toolbar: streamlined in embedded mode so nothing duplicates ArtifactBrowserPane's outer controls */}
      {embedded ? (
        <div className="om-design-toolbar om-design-toolbar-embedded" data-embedded="true">
          <div className="om-design-header-group">
            <Tooltip label={t('Files, Comments & Versions')}>
              <IconButton
                aria-label={t('Toggle panel')}
                aria-pressed={sidebarOpen}
                variant={sidebarOpen ? 'secondary' : 'ghost'}
                icon={<RemixIcon name="side-bar-line" size={15} />}
                onClick={() => setSidebarOpen(v => !v)}
              />
            </Tooltip>
            <input
              className="om-design-title-input om-design-title-input-inline"
              aria-label={t('Project title')}
              size={Math.max(6, Math.min(26, (titleDraft || project.title).length))}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
            />
            {htmlFiles.length > 1 && htmlFiles.slice(0, 3).map(file => (
              <Button key={file.path} type="button" size="sm" variant={activeFile === file.path ? 'secondary' : 'ghost'} onClick={() => setActiveFile(file.path)}>
                {file.path}
              </Button>
            ))}
            <Popover.Root modal={false} open={versionsOpen} onOpenChange={setVersionsOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="history-line" size={14} />}>
                  {project.versionLabel ?? 'v1'}
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover" style={{ maxHeight: 340, overflowY: 'auto' }}>
                    {versionsPopupBody}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </div>

          {isDeck && effectiveViewMode === 'preview' && (
            <div className="om-design-header-group om-design-embedded-deck-ctl">
              <IconButton aria-label={t('Previous slide')} icon={<RemixIcon name="arrow-left-s-line" size={15} />} onClick={() => sendDeckCommand('prev')} />
              <span className="om-design-muted" style={{ minWidth: 36, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{activeSlide + 1} / {Math.max(1, slideCount || deckSlides.length)}</span>
              <IconButton aria-label={t('Next slide')} icon={<RemixIcon name="arrow-right-s-line" size={15} />} onClick={() => sendDeckCommand('next')} />
              <Button type="button" size="sm" variant={notesOpen ? 'secondary' : 'ghost'} onClick={() => setNotesOpen(v => !v)}>{t('Notes')}</Button>
              <Tooltip label={t('Present')}>
                <IconButton aria-label={t('Present')} icon={<RemixIcon name="fullscreen-line" size={14} />} onClick={() => iframeRef.current?.requestFullscreen?.()} />
              </Tooltip>
              <Button type="button" size="sm" variant="ghost" onClick={openPresenterPopup}>{t('Presenter view')}</Button>
            </div>
          )}

          <div className="om-design-header-group" style={{ marginLeft: 'auto' }}>
            {effectiveViewMode === 'preview' && (
              <>
                <div className="om-design-header-group" role="group" aria-label={t('Annotation tools')} style={{ gap: 2 }}>
                  <Tooltip label={t('Comment on element')}>
                    <IconButton
                      aria-label={t('Comment')}
                      disabled={Boolean(previewVersion)}
                      variant={activeTool === 'comment' ? 'primary' : 'ghost'}
                      icon={<RemixIcon name="chat-1-line" size={15} />}
                      onClick={() => toggleTool('comment')}
                    />
                  </Tooltip>
                  <Tooltip label={t('Mark region')}>
                    <IconButton
                      aria-label={t('Region')}
                      disabled={Boolean(previewVersion)}
                      variant={activeTool === 'region' ? 'primary' : 'ghost'}
                      icon={<RemixIcon name="shape-2-line" size={15} />}
                      onClick={() => toggleTool('region')}
                    />
                  </Tooltip>
                  <Tooltip label={t('Draw pen annotation')}>
                    <IconButton
                      aria-label={t('Draw')}
                      disabled={Boolean(previewVersion)}
                      variant={activeTool === 'pen' ? 'primary' : 'ghost'}
                      icon={<RemixIcon name="pen-nib-line" size={15} />}
                      onClick={() => toggleTool('pen')}
                    />
                  </Tooltip>
                </div>

                {frameWidth && frameHeight && (
                  <Tooltip label={t('Rotate orientation')}>
                    <IconButton
                      aria-label={t('Rotate orientation')}
                      variant={rotated ? 'secondary' : 'ghost'}
                      icon={<RemixIcon name="clockwise-line" size={14} />}
                      onClick={() => setRotated(r => !r)}
                    />
                  </Tooltip>
                )}

                <div className="om-design-header-group om-design-embedded-zoom" style={{ gap: 2 }}>
                  <IconButton aria-label={t('Zoom out')} icon={<RemixIcon name="zoom-out-line" size={14} />}
                    onClick={() => setZoom(z => ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)] ?? 75)} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setZoom(100)}>{zoom}%</Button>
                  <IconButton aria-label={t('Zoom in')} icon={<RemixIcon name="zoom-in-line" size={14} />}
                    onClick={() => setZoom(z => ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)] ?? 125)} />
                </div>
              </>
            )}

            <Tooltip label={t('Comments')}>
              <Button
                type="button"
                size="sm"
                variant={sidebarOpen && sidebarTab === 'comments' ? 'secondary' : 'ghost'}
                aria-pressed={sidebarOpen && sidebarTab === 'comments'}
                icon={<RemixIcon name="chat-1-line" size={14} />}
                onClick={() => {
                  if (sidebarOpen && sidebarTab === 'comments') {
                    setSidebarOpen(false);
                  } else {
                    setSidebarOpen(true);
                    setSidebarTab('comments');
                  }
                }}
              >
                {openComments.length}
              </Button>
            </Tooltip>

            <Popover.Root modal={false} open={exportOpen} onOpenChange={setExportOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="ghost" loading={Boolean(exporting)} icon={<RemixIcon name="download-2-line" size={14} />}>
                  <span className="om-design-embedded-hide-narrow">{t('Export')}</span>
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover">
                    {exportPopupBody}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>
      ) : (
        <div className="om-design-toolbar">
          <div className="om-design-header-group">
            <Tooltip label={t('Toggle panel')}>
              <IconButton aria-label={t('Toggle panel')} icon={<RemixIcon name="side-bar-line" size={15} />} onClick={() => setSidebarOpen(v => !v)} />
            </Tooltip>
            <Tooltip label={t('Reload preview')}>
              <IconButton aria-label={t('Reload preview')} icon={<RemixIcon name="refresh-line" size={15} />} onClick={() => { setReloadNonce(n => n + 1); void refresh(); }} />
            </Tooltip>

            <div className="om-design-segmented" role="group" aria-label={t('View mode')}>
              <Button type="button" size="sm" variant={effectiveViewMode === 'preview' ? 'secondary' : 'ghost'} icon={<RemixIcon name="eye-line" size={14} />} onClick={() => setEffectiveViewMode('preview')}>
                {t('Preview')}
              </Button>
              <Button type="button" size="sm" variant={effectiveViewMode === 'code' ? 'secondary' : 'ghost'} icon={<RemixIcon name="code-s-slash-line" size={14} />} onClick={() => setEffectiveViewMode('code')}>
                {t('Code')}
              </Button>
            </div>

            {/* Device selector */}
            <Popover.Root modal={false} open={deviceOpen} onOpenChange={setDeviceOpen}>
              <Popover.Trigger render={
                <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name={currentViewport.icon} size={14} />}>
                  <span>{t(currentViewport.label)}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} />
                </Button>
              } />
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-150">
                  <Popover.Popup initialFocus={false} className="om-design-popover" style={{ minWidth: 180 }}>
                    {designViewports.map(vp => (
                      <Button key={vp.id} type="button" size="sm" variant={effectiveViewportId === vp.id ? 'secondary' : 'ghost'}
                        icon={<RemixIcon name={vp.icon} size={14} />}
                        onClick={() => { setEffectiveViewportId(vp.id); setRotated(false); setDeviceOpen(false); }}>
                        {t(vp.label)}{vp.width ? ` (${vp.width}×${vp.height})` : ''}
                      </Button>
                    ))}
                    {effectiveViewportId !== 'desktop' && (
                      <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="clockwise-line" size={14} />} onClick={() => { setRotated(r => !r); setDeviceOpen(false); }}>
                        {t('Rotate orientation')}
                      </Button>
                    )}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>

            {project.scenario === 'live-artifact' && (
              <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="refresh-line" size={14} />} onClick={() => setReloadNonce(n => n + 1)}>
                {t('Refresh data')}
              </Button>
            )}
            <Tooltip label={t('Open preview in new tab')}>
              <IconButton aria-label={t('Open preview in new tab')} icon={<RemixIcon name="external-link-line" size={15} />} onClick={() => window.open(rawPreviewUrl, '_blank', 'noopener,noreferrer')} />
            </Tooltip>
          </div>

          {/* Deck controls (centered in 3-column toolbar grid) */}
          {isDeck && effectiveViewMode === 'preview' ? (
            <div className="om-design-header-group">
              <IconButton aria-label={t('Previous slide')} icon={<RemixIcon name="arrow-left-s-line" size={16} />} onClick={() => sendDeckCommand('prev')} />
              <span className="om-design-muted" style={{ minWidth: 40, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{activeSlide + 1} / {Math.max(1, slideCount || deckSlides.length)}</span>
              <IconButton aria-label={t('Next slide')} icon={<RemixIcon name="arrow-right-s-line" size={16} />} onClick={() => sendDeckCommand('next')} />
              <Button type="button" size="sm" variant={notesOpen ? 'secondary' : 'ghost'} onClick={() => setNotesOpen(v => !v)}>{t('Notes')}</Button>
              <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="fullscreen-line" size={14} />} onClick={() => iframeRef.current?.requestFullscreen?.()}>{t('Present')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={openPresenterPopup}>{t('Presenter view')}</Button>
            </div>
          ) : <div />}

          {/* Annotation tools & Zoom */}
          <div className="om-design-header-group">
            <div className="om-design-header-group" role="group" aria-label={t('Annotation tools')} style={{ gap: 2 }}>
              <Tooltip label={t('Comment on element')}>
                <IconButton
                  aria-label={t('Comment')}
                  disabled={Boolean(previewVersion)}
                  variant={activeTool === 'comment' ? 'primary' : 'ghost'}
                  icon={<RemixIcon name="chat-1-line" size={15} />}
                  onClick={() => toggleTool('comment')}
                />
              </Tooltip>
              <Tooltip label={t('Mark region')}>
                <IconButton
                  aria-label={t('Region')}
                  disabled={Boolean(previewVersion)}
                  variant={activeTool === 'region' ? 'primary' : 'ghost'}
                  icon={<RemixIcon name="shape-2-line" size={15} />}
                  onClick={() => toggleTool('region')}
                />
              </Tooltip>
              <Tooltip label={t('Draw pen annotation')}>
                <IconButton
                  aria-label={t('Draw')}
                  disabled={Boolean(previewVersion)}
                  variant={activeTool === 'pen' ? 'primary' : 'ghost'}
                  icon={<RemixIcon name="pen-nib-line" size={15} />}
                  onClick={() => toggleTool('pen')}
                />
              </Tooltip>
            </div>

            <Tooltip label={t('Comments')}>
              <Button
                type="button"
                size="sm"
                variant={sidebarOpen && sidebarTab === 'comments' ? 'secondary' : 'ghost'}
                aria-pressed={sidebarOpen && sidebarTab === 'comments'}
                icon={<RemixIcon name="chat-1-line" size={14} />}
                onClick={() => {
                  if (sidebarOpen && sidebarTab === 'comments') {
                    setSidebarOpen(false);
                  } else {
                    setSidebarOpen(true);
                    setSidebarTab('comments');
                  }
                }}
              >
                {openComments.length}
              </Button>
            </Tooltip>

            <div className="om-design-header-group" style={{ gap: 2 }}>
              <IconButton aria-label={t('Zoom out')} icon={<RemixIcon name="zoom-out-line" size={14} />}
                onClick={() => setZoom(z => ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)] ?? 75)} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setZoom(100)}>{zoom}%</Button>
              <IconButton aria-label={t('Zoom in')} icon={<RemixIcon name="zoom-in-line" size={14} />}
                onClick={() => setZoom(z => ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)] ?? 125)} />
            </div>
          </div>
        </div>
      )}

      {/* Historical version preview notice */}
      {previewVersion && (
        <div className="om-design-banner">
          <span>{t('Previewing historical snapshot {label}', { label: previewVersion.label })}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="button" size="sm" variant="secondary" disabled={restoringVersion} onClick={() => void handleRestoreVersion(previewVersion.id)}>{t('Make current version')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewVersionId(null)}>{t('Return to current')}</Button>
          </div>
        </div>
      )}

      {/* Main split body */}
      <div className="om-design-body">
        {sidebarOpen && (
          <ResizablePane className="om-design-sidebar" storageKey={embedded ? 'om.design.embedded.sidebar' : 'om.design.sidebar'} initial={embedded ? 236 : 280} min={190} max={380} edge="right" label={t('Resize panel')}>
            <div className="om-design-sidebar-tabs" role="tablist">
              <Button type="button" size="sm" variant={sidebarTab === 'files' ? 'secondary' : 'ghost'} onClick={() => setSidebarTab('files')}>{t('Files')}</Button>
              <Button type="button" size="sm" variant={sidebarTab === 'comments' ? 'secondary' : 'ghost'} onClick={() => setSidebarTab('comments')}>
                {t('Comments')}{openComments.length ? ` (${openComments.length})` : ''}
              </Button>
              <Button type="button" size="sm" variant={sidebarTab === 'versions' ? 'secondary' : 'ghost'} onClick={() => setSidebarTab('versions')}>{t('Versions')}</Button>
            </div>

            <div className="om-design-sidebar-scroll">
              {sidebarTab === 'files' && project.files.map(file => (
                embedded && onAttachFile ? (
                  <div key={file.path} className="om-design-file-row-wrap" data-active={activeFile === file.path || undefined}>
                    <Button
                      type="button"
                      size="sm"
                      variant="plain"
                      className="om-design-file-row"
                      onClick={() => { setActiveFile(file.path); if (file.kind !== 'html') setEffectiveViewMode('code'); }}
                    >
                      <span className="om-design-file-name">
                        <RemixIcon name={file.kind === 'html' ? 'file-code-line' : file.kind === 'image' ? 'file-image-line' : 'file-text-line'} size={14} />
                        <span title={file.path}>{file.path}</span>
                      </span>
                      <span className="om-design-file-size">{formatBytes(file.size)}</span>
                    </Button>
                    <Tooltip label={t('Attach file')}>
                      <IconButton
                        variant="plain"
                        className="om-design-file-attach-btn"
                        aria-label={`${t('Attach file')}: ${file.path}`}
                        icon={<RemixIcon name="add-line" size={13} />}
                        onClick={() => onAttachFile(file.path)}
                      />
                    </Tooltip>
                  </div>
                ) : (
                  <Button key={file.path} type="button" size="sm" variant={activeFile === file.path ? 'secondary' : 'ghost'}
                    className="om-design-file-row"
                    aria-current={activeFile === file.path || undefined}
                    onClick={() => { setActiveFile(file.path); if (file.kind !== 'html') setEffectiveViewMode('code'); }}>
                    <span className="om-design-file-name">
                      <RemixIcon name={file.kind === 'html' ? 'file-code-line' : file.kind === 'image' ? 'file-image-line' : 'file-text-line'} size={14} />
                      <span title={file.path}>{file.path}</span>
                    </span>
                    <span className="om-design-file-size">{formatBytes(file.size)}</span>
                  </Button>
                )
              ))}

              {sidebarTab === 'comments' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <div className="om-design-segmented">
                      {(['open', 'resolved', 'all'] as const).map(f => (
                        <Button key={f} type="button" size="sm" variant={commentFilter === f ? 'secondary' : 'ghost'} onClick={() => setCommentFilter(f)}>
                          {t(f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All')}
                        </Button>
                      ))}
                    </div>
                    {openComments.length > 0 && (
                      embedded && onAttachToChat ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <Button
                            type="button"
                            size="sm"
                            variant="plain"
                            className="om-design-tonal-btn"
                            disabled={attachingChat}
                            icon={<RemixIcon name="add-line" size={13} />}
                            onClick={() => void attachOpenCommentsToSuperAgent(false)}
                          >
                            {t('Attach open comments')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="plain"
                            className="om-design-tonal-primary-btn"
                            disabled={attachingChat}
                            icon={<RemixIcon name="sparkling-line" size={13} />}
                            onClick={() => void attachOpenCommentsToSuperAgent(true)}
                          >
                            {t('Send all to Agent')}
                          </Button>
                        </div>
                      ) : (
                        <Button type="button" size="sm" variant="primary" icon={<RemixIcon name="plug-line" size={13} />}
                          onClick={() => void copyPrompt(designCommentsPrompt(project, openComments, undefined, promptOptions))}>
                          {t('Copy for Agent')}
                        </Button>
                      )
                    )}
                  </div>

                  {visibleComments.length === 0 && (
                    <p className="om-design-muted">{embedded
                      ? t('No annotations yet. Pick Comment, Region or Draw to mark anything on the page and attach it directly to Super Agent.')
                      : t('No annotations yet. Pick Comment, Region or Draw to mark an element, then copy the brief to your Agent.')}
                    </p>
                  )}

                  {visibleComments.map((comment, idx) => {
                    const { annotation, element, filePath, region, viewport } = comment.anchor;
                    const kindLabel = annotation ? t('Draw') : region ? t('Region') : element ? t('Element') : t('Comment');
                    const kindIcon = annotation ? 'pen-nib-line' : region ? 'shape-2-line' : 'chat-1-line';
                    const targetBox = region ?? element?.box;
                    const legacyDeckComment = comment.anchor.slideIndex !== undefined && !comment.anchor.isolatedSlide && Boolean(targetBox || annotation);
                    const slideIndex = commentSlideIndexes.get(`${projectId}:${comment.id}`) ?? comment.anchor.slideIndex;
                    const targetText = element?.text?.trim() || element?.label.trim();
                    const viewportLabel = designViewports.find(item => item.id === viewport.id)?.label ?? 'Desktop';
                    const focusComment = async () => {
                      const request = ++commentFocusRequest.current;
                      const targetSlide = legacyDeckComment ? (await resolveCommentSlide(comment.id)) ?? slideIndex : slideIndex;
                      if (request !== commentFocusRequest.current) return;
                      setSelectedCommentId(comment.id);
                      setEffectiveViewMode('preview');
                      if (filePath && filePath !== activeFile) setActiveFile(filePath);
                      if (isDeck && targetSlide !== undefined && targetSlide !== activeSlide) {
                        sendDeckCommand('go', targetSlide);
                      }
                    };
                    return (
                      <div
                        key={comment.id}
                        ref={selectedCommentId === comment.id ? selectedCommentCardRef : undefined}
                        className="om-design-item-card om-design-comment-card"
                        data-active={selectedCommentId === comment.id}
                        onClick={() => void focusComment()}
                      >
                        <div className="om-design-comment-heading">
                          <span className="om-design-comment-location">
                            <RemixIcon name={kindIcon} size={13} />
                            <span>#{idx + 1} · {kindLabel}</span>
                            {slideIndex === undefined ? (
                              <span className="om-design-muted">{t(viewportLabel)}</span>
                            ) : (
                              <Button type="button" size="sm" variant="ghost" onClick={event => { event.stopPropagation(); void focusComment(); }}>
                                {t('Slide {n}', { n: slideIndex + 1 })}
                              </Button>
                            )}
                          </span>
                          <span className="om-design-muted">{t(comment.status === 'open' ? 'Unresolved' : 'Resolved')}</span>
                        </div>
                        {targetText && <p className="om-design-comment-target" title={targetText}>{targetText}</p>}
                        <AnnotationVisualPreview
                          region={targetBox}
                          annotation={annotation}
                          viewport={viewport}
                          imageUrl={targetBox || annotation ? designRoutes.commentPreview(project.id, comment.id) : undefined}
                          onImageLoaded={legacyDeckComment ? () => void resolveCommentSlide(comment.id) : undefined}
                        />
                        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>{comment.text}</p>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                          <Button type="button" size="sm" variant="ghost" onClick={() => void toggleCommentStatus(comment)}>
                            {comment.status === 'open' ? t('Resolve') : t('Reopen')}
                          </Button>
                          {embedded && onAttachToChat ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="plain"
                                className="om-design-tonal-btn"
                                disabled={attachingChat}
                                onClick={() => void attachCommentToSuperAgent(comment, false)}
                              >
                                {t('Attach to chat')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="plain"
                                className="om-design-tonal-primary-btn"
                                disabled={attachingChat}
                                onClick={() => void attachCommentToSuperAgent(comment, true)}
                              >
                                {t('Send to Agent')}
                              </Button>
                            </>
                          ) : (
                            <Button type="button" size="sm" variant="ghost" onClick={() => void copyPrompt(designCommentsPrompt(project, [comment], undefined, promptOptions))}>
                              {t('Copy')}
                            </Button>
                          )}
                          <IconButton aria-label={t('Delete annotation')} icon={<RemixIcon name="delete-bin-line" size={14} />} onClick={() => void removeComment(comment.id)} />
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {sidebarTab === 'versions' && (versions.length === 0 ? (
                <p className="om-design-muted">{t('No saved versions yet.')}</p>
              ) : versions.map(ver => (
                <div key={ver.id} className="om-design-item-card" data-active={ver.id === (previewVersion?.id ?? currentVersionId)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <strong>{ver.label}</strong>
                    <span className="om-design-badge">{ver.source}</span>
                  </div>
                  {ver.summary && <span className="om-design-muted">{ver.summary}</span>}
                  {ver.prompt && <span className="om-design-muted" style={{ fontStyle: 'italic' }}>{ver.prompt}</span>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button type="button" size="sm" variant="ghost" onClick={() => handlePreviewVersion(ver.id)}>
                      {ver.id === currentVersionId ? t('Current') : t('Preview')}
                    </Button>
                    {ver.id !== currentVersionId && (
                      <Button type="button" size="sm" variant="secondary" disabled={restoringVersion} onClick={() => void handleRestoreVersion(ver.id)}>
                        {t('Make current version')}
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" onClick={() => void handleExport('zip', ver.id)}>{t('Export')}</Button>
                  </div>
                </div>
              )))}
            </div>
          </ResizablePane>
        )}

        {/* Stage: Preview or Code */}
        <section className="om-design-stage">
          {manualCopy && (
            <div className="om-design-banner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{t('Copy this MCP instruction manually')}</strong>
                <IconButton aria-label={t('Close')} icon={<RemixIcon name="close-line" size={14} />} onClick={() => setManualCopy(null)} />
              </div>
              <textarea className="om-design-textarea" readOnly value={manualCopy} onFocus={e => e.currentTarget.select()} />
            </div>
          )}

          {effectiveViewMode === 'preview' ? (
            <>
              <div className="om-design-stage-viewport" data-fluid={effectiveViewportId === 'desktop' && zoom === 100 && project.scenario !== 'document'}>
                {(effectiveViewportId !== 'desktop' || zoom !== 100) && (
                  <div className="om-design-device-caption">
                    <RemixIcon name={currentViewport.icon} size={13} />
                    <span>{t(currentViewport.label)}</span>
                    {frameWidth && frameHeight && <span>· {frameWidth} × {frameHeight}</span>}
                    <span>· {zoom}%</span>
                  </div>
                )}
                <div
                  className="om-design-frame-wrap"
                  data-fluid={effectiveViewportId === 'desktop' && zoom === 100 && project.scenario !== 'document'}
                  data-document={effectiveViewportId === 'desktop' && project.scenario === 'document'}
                  style={{
                    ...(frameWidth ? { width: frameWidth, height: frameHeight! } : { width: '100%', height: '100%' }),
                    ...(zoom !== 100 ? { transform: `scale(${zoom / 100})` } : {}),
                  }}
                >
                  <iframe
                    ref={iframeRef}
                    key={`${project.id}:${previewFile}:${previewVersion?.id ?? project.revision}:${reloadNonce}`}
                    title={project.title}
                    className="om-design-iframe"
                    sandbox={embedded
                      ? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads'
                      : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads'}
                    src={useSrcDoc || awaitingSrcDoc ? undefined : rawPreviewUrl}
                    srcDoc={useSrcDoc ? srcDocValue : undefined}
                    onLoad={() => {
                      const win = iframeRef.current?.contentWindow;
                      if (!win) return;
                      clearDrawingRequest();
                      previewScrollRef.current = ORIGIN;
                      setPreviewScroll(ORIGIN);
                      setPreviewElementBoxes(new Map());
                      setPreviewScopes(new Map());
                      try {
                        win.postMessage({ type: 'om:design-mode', token: bridgeToken, pick: activeTool === 'comment' }, '*');
                        win.postMessage({ type: 'om:preview-mode', token: bridgeToken, pick: activeTool === 'comment' }, '*');
                        win.postMessage({ type: 'om:design-request-scroll', token: bridgeToken }, '*');
                        configureDeck();
                        trackAnnotations();
                      } catch { /* ignore */ }
                    }}
                  />

                  {/* Annotation & Pins overlay */}
                  <div
                    ref={overlayRef}
                    className="om-design-overlay"
                    data-interactive={activeTool === 'region' || activeTool === 'pen'}
                    onPointerDown={onOverlayPointerDown}
                    onPointerMove={onOverlayPointerMove}
                    onPointerUp={onOverlayPointerUp}
                    onPointerCancel={() => { setDragStart(null); setDragCurrent(null); setPenPoints([]); }}
                  >
                    {/* Live region drag preview */}
                    {dragStart && dragCurrent && (() => {
                      const rx = Math.min(dragStart.x, dragCurrent.x);
                      const ry = Math.min(dragStart.y, dragCurrent.y);
                      const rw = Math.abs(dragCurrent.x - dragStart.x);
                      const rh = Math.abs(dragCurrent.y - dragStart.y);
                      return (
                        <div className="om-design-region-box" style={{ left: rx, top: ry, width: rw, height: rh }}>
                          {rw >= 48 && rh >= 28 && (
                            <span className="om-design-region-size">{Math.round(rw)} × {Math.round(rh)}</span>
                          )}
                        </div>
                      );
                    })()}

                    {/* Pending region outline while composing comment */}
                    {pendingDraft?.region && (
                      <AnnotationLayer clip={pendingScope?.clip}>
                        <div
                          className="om-design-region-box"
                          data-selected="true"
                          style={{
                            left: pendingDraft.region.x + pendingOffset.x,
                            top: pendingDraft.region.y + pendingOffset.y,
                            width: pendingDraft.region.width,
                            height: pendingDraft.region.height,
                          }}
                        />
                      </AnnotationLayer>
                    )}

                    {/* Saved region outlines */}
                    {positionedComments.map(({ comment: c, clip, offset }) => {
                      const { region } = c.anchor;
                      if (!region) return null;
                      return (
                        <AnnotationLayer key={`region-${c.id}`} clip={clip}>
                          <div
                            className="om-design-region-box"
                            data-saved="true"
                            data-selected={selectedCommentId === c.id}
                            style={{ left: region.x + offset.x, top: region.y + offset.y, width: region.width, height: region.height }}
                          />
                        </AnnotationLayer>
                      );
                    })}

                    {/* Live pen stroke, pending draft stroke & saved vector annotations */}
                    {penPoints.length >= 2 && (
                      <PositionedStroke annotation={{ version: 1, coordinateSpace: 'normalized', width: 1000, height: 1000, marks: [{ kind: 'pen', points: penPoints }] }} />
                    )}
                    {pendingDraft?.annotation && (
                      <AnnotationLayer clip={pendingScope?.clip}>
                        <PositionedStroke annotation={pendingDraft.annotation} offset={pendingOffset} selected />
                      </AnnotationLayer>
                    )}
                    {positionedComments.map(({ comment: c, clip, offset }) => c.anchor.annotation ? (
                      <AnnotationLayer key={c.id} clip={clip}>
                        <PositionedStroke annotation={c.anchor.annotation} offset={offset} selected={selectedCommentId === c.id} />
                      </AnnotationLayer>
                    ) : null)}

                    {/* Saved pins */}
                    {positionedComments.map(({ comment: c, clip, offset }, idx) => {
                      const { annotation, element, region } = c.anchor;
                      const drawBounds = annotation && annotationBounds(annotation);
                      const liveBox = element && previewElementBoxes.get(c.id);
                      const elementBox = liveBox ?? element?.box;
                      const left = region ? region.x + offset.x
                        : drawBounds ? `calc(${drawBounds.minX * 100}% + ${offset.x}px)`
                        : elementBox ? elementBox.x + elementBox.width / 2 + (liveBox ? 0 : offset.x)
                        : 32 + idx * 28;
                      const top = region ? region.y + offset.y
                        : drawBounds ? `calc(${drawBounds.minY * 100}% + ${offset.y}px)`
                        : elementBox ? elementBox.y + 12 + (liveBox ? 0 : offset.y)
                        : 32;
                      return (
                        <AnnotationLayer key={c.id} clip={clip}>
                          <div
                            className="om-design-pin"
                            data-selected={selectedCommentId === c.id}
                            style={{ left, top }}
                            title={c.text}
                            onClick={() => { setSelectedCommentId(c.id); setSidebarOpen(true); setSidebarTab('comments'); }}
                          >
                            {idx + 1}
                          </div>
                        </AnnotationLayer>
                      );
                    })}

                    {/* Pending comment composer anchored cleanly outside the marked region or drawing */}
                    {pendingDraft && (() => {
                      const ow = overlayRef.current?.clientWidth ?? 960;
                      const oh = overlayRef.current?.clientHeight ?? 640;
                      const popW = embedded ? Math.min(356, Math.max(240, ow - 24)) : 300;
                      const popH = (pendingDraft.annotation || pendingDraft.region ? 305 : 210) + (embedded && popW < 340 ? 34 : 0);
                      const pendingAnnotation = pendingDraft.annotation;
                      const drawBox = pendingAnnotation ? (() => {
                        const b = annotationBounds(pendingAnnotation);
                        return { x: b.minX * ow, y: b.minY * oh, width: (b.maxX - b.minX) * ow, height: (b.maxY - b.minY) * oh };
                      })() : null;
                      const draftBox = pendingDraft.region ?? drawBox;
                      const anchorBox = draftBox && { ...draftBox, y: draftBox.y + pendingOffset.y };
                      const pinY = pendingDraft.pinY + pendingOffset.y;
                      const preferredX = (draftBox?.x ?? pendingDraft.pinX) + pendingOffset.x;
                      const preferredY = anchorBox
                        ? (anchorBox.y + anchorBox.height + 12 + popH <= oh
                          ? anchorBox.y + anchorBox.height + 12
                          : Math.max(12, anchorBox.y - popH - 12))
                        : (pinY + 14 + popH <= oh
                          ? pinY + 14
                          : Math.max(12, pinY - popH - 14));
                      const left = Math.min(Math.max(12, preferredX), Math.max(12, ow - popW - 12));
                      const top = Math.min(Math.max(12, preferredY), Math.max(12, oh - popH - 12));
                      return (
                        <div className="om-design-popover" style={{ position: 'absolute', left, top, width: popW, maxHeight: Math.max(180, oh - 24), overflowY: 'auto', pointerEvents: 'auto', zIndex: 25 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>{pendingDraft.element ? `<${pendingDraft.element.tagName}> ${pendingDraft.element.label}` : pendingDraft.region ? t('Region annotation') : t('Pen annotation')}</strong>
                            <IconButton aria-label={t('Cancel')} icon={<RemixIcon name="close-line" size={14} />} onClick={() => setPendingDraft(null)} />
                          </div>
                          <AnnotationVisualPreview
                            region={pendingDraft.region}
                            annotation={pendingDraft.annotation}
                            viewport={{ width: ow, height: oh }}
                          />
                          <textarea
                            className="om-design-textarea"
                            autoFocus
                            placeholder={embedded ? t('Add a note for Super Agent (optional)…') : t('Describe the change for your Agent…')}
                            value={commentText}
                            onChange={e => setCommentText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                if (embedded && onAttachToChat) {
                                  void attachDraftToSuperAgent(true);
                                } else {
                                  void submitDraftComment();
                                }
                              }
                            }}
                          />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                            {embedded && onAttachToChat ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="plain"
                                  className="om-design-tonal-btn"
                                  loading={submittingComment}
                                  disabled={attachingChat}
                                  icon={<RemixIcon name="save-line" size={13} />}
                                  onClick={() => void submitDraftComment()}
                                >
                                  {t('Save pin')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="plain"
                                  className="om-design-tonal-btn"
                                  disabled={attachingChat || submittingComment}
                                  icon={<RemixIcon name="add-line" size={13} />}
                                  onClick={() => void attachDraftToSuperAgent(false)}
                                >
                                  {t('Attach to chat')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="plain"
                                  className="om-design-tonal-primary-btn"
                                  loading={attachingChat}
                                  disabled={submittingComment}
                                  icon={<RemixIcon name="sparkling-line" size={13} />}
                                  onClick={() => void attachDraftToSuperAgent(true)}
                                >
                                  {t('Send to Agent')}
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setPendingDraft(null)}>{t('Cancel')}</Button>
                                <Button type="button" size="sm" variant="primary" loading={submittingComment} disabled={!commentText.trim()} onClick={() => void submitDraftComment()}>
                                  {t('Save annotation')}
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Deck speaker notes & thumbnail rail */}
              {isDeck && notesOpen && (
                <div className="om-design-notes-bar">
                  <strong>{t('Speaker notes')} · {t('Slide {n}', { n: activeSlide + 1 })}: </strong>
                  {speakerNotes[activeSlide] || t('No speaker notes for this slide.')}
                </div>
              )}
              {isDeck && deckSlides.length > 0 && (
                <div className="om-design-deck-rail" role="tablist" aria-label={t('Slides')}>
                  {deckSlides.map(slide => (
                    <Button key={slide.index} type="button" size="sm" variant={slide.index === activeSlide ? 'secondary' : 'ghost'}
                      className="om-design-deck-thumb" data-active={slide.index === activeSlide}
                      onClick={() => sendDeckCommand('go', slide.index)}>
                      <span className="om-design-slide-num">{String(slide.index + 1).padStart(2, '0')}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{slide.label}</span>
                    </Button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="om-design-code-wrap">
              <div className="om-design-code-bar">
                <span className="om-design-muted">{activeFile} · {project.versionLabel ?? 'v1'}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {embedded && onAttachToChat && selectedCode && (
                    <Button
                      type="button"
                      size="sm"
                      variant="plain"
                      className="om-design-tonal-primary-btn"
                      icon={<RemixIcon name="sparkling-line" size={13} />}
                      onClick={handleAttachCodeSelection}
                    >
                      {t('Attach selection')} (L{selectedCode.startLine}{selectedCode.endLine !== selectedCode.startLine ? `–L${selectedCode.endLine}` : ''})
                    </Button>
                  )}
                  {embedded && onAttachFile && effectiveFile && (
                    <Button
                      type="button"
                      size="sm"
                      variant="plain"
                      className="om-design-tonal-btn"
                      icon={<RemixIcon name="add-line" size={13} />}
                      onClick={() => onAttachFile(effectiveFile)}
                    >
                      {t('Attach file')}
                    </Button>
                  )}
                  {codeEditing ? (
                    <>
                      <Button type="button" size="sm" variant="ghost" disabled={savingCode || reloadingCode} onClick={() => { setCodeDraft(fileContent); setCodeEditBaseRevision(null); setCodeConflict(false); setCodeEditing(false); }}>{t('Cancel')}</Button>
                      <Button type="button" size="sm" variant="primary" loading={savingCode} disabled={reloadingCode} icon={<RemixIcon name="save-line" size={14} />} onClick={() => void saveCode()}>
                        {t('Save version')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="file-copy-line" size={14} />} onClick={() => void copyPrompt(fileContent)}>
                        {t('Copy code')}
                      </Button>
                      <Button type="button" size="sm" variant="secondary" icon={<RemixIcon name="edit-line" size={14} />} onClick={() => { setCodeDraft(fileContent); setCodeEditBaseRevision(project.revision); setCodeConflict(false); setCodeEditing(true); }}>
                        {t('Edit source')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {codeEditing && codeConflict && (
                <div className="om-design-banner" role="alert">
                  <span>{t('Project changed externally. Reload to get the latest revision.')}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      loading={savingCode}
                      disabled={reloadingCode}
                      onClick={() => {
                        setCodeEditBaseRevision(project.revision);
                        void saveCode(project.revision);
                      }}
                    >
                      {t('Overwrite with my draft')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      loading={reloadingCode}
                      disabled={savingCode}
                      onClick={() => void discardAndReloadLatest()}
                    >
                      {t('Discard draft & reload latest')}
                    </Button>
                  </div>
                </div>
              )}
              {reloadingCode || (!codeEditing && codeLoading) ? (
                <div style={{ padding: 16 }} className="om-design-muted">{t('Loading file…')}</div>
              ) : codeEditing ? (
                <textarea
                  className="om-design-code-editor"
                  aria-label={t('Source editor')}
                  value={codeDraft}
                  onChange={e => setCodeDraft(e.target.value)}
                  onSelect={e => setSelectedCode(readTextareaCodeSelection(e.currentTarget))}
                  onKeyUp={e => setSelectedCode(readTextareaCodeSelection(e.currentTarget))}
                  onMouseUp={e => setSelectedCode(readTextareaCodeSelection(e.currentTarget))}
                  spellCheck={false}
                />
              ) : (
                <div
                  ref={codeViewerWrapRef}
                  className="om-design-code-viewer-wrap"
                  onMouseUp={() => setSelectedCode(readDomCodeSelection(codeViewerWrapRef.current, fileContent))}
                  onKeyUp={() => setSelectedCode(readDomCodeSelection(codeViewerWrapRef.current, fileContent))}
                >
                  <CodeViewer content={fileContent} />
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      {(!embedded || !onNotify) && <StudioToastViewport {...toast} />}
    </div>
  );
}
