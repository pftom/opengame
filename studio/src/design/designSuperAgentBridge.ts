import type { BrowserPickedElement, BrowserRect } from '../../../shared/browser';
import { designRoutes, type DesignComment, type DesignProjectDetail } from '../../../shared/design-project';
import type { ReviewAnnotation } from '../../../shared/review-comments';
import type { SuperAgentResourceAttachment } from '../../../shared/super-agent';
import type { PickedElement } from './previewBridge';
import { uploadSuperAgentAnnotationImage } from '../super-agent/superAgentClient';
import { readCommentPreviewSlideIndex } from './designClient';

export type DesignDraftSelection = {
  element?: PickedElement;
  region?: { x: number; y: number; width: number; height: number };
  annotation?: ReviewAnnotation;
  pinX: number;
  pinY: number;
};

export type DesignCodeSelection = {
  text: string;
  startLine: number;
  endLine: number;
};

function clampRect(rect: { x: number; y: number; width: number; height: number }): BrowserRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

export function designPickedElementToBrowserElement(
  el: PickedElement,
  viewport: { width: number; height: number },
  pageUrl: string,
  pageTitle?: string,
  filePath?: string,
): BrowserPickedElement {
  return {
    tagName: el.tagName,
    selector: el.selector,
    ...(el.elementId ? { id: el.elementId } : {}),
    label: el.label || el.selector,
    ...(el.text ? { text: el.text } : {}),
    htmlPreview: el.htmlHint || `<${el.tagName}>`,
    styles: {},
    rect: clampRect(el.box),
    viewport: {
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
    },
    pageUrl,
    ...(pageTitle ? { pageTitle } : {}),
    ...(filePath ? { sourceFile: filePath } : {}),
  };
}

function normalizedAnnotationBounds(annotation: ReviewAnnotation, vw: number, vh: number): BrowserRect | undefined {
  const pts = annotation.marks.flatMap(m => m.points);
  if (!pts.length) return undefined;
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: Math.round(minX * vw),
    y: Math.round(minY * vh),
    width: Math.max(1, Math.round((maxX - minX) * vw)),
    height: Math.max(1, Math.round((maxY - minY) * vh)),
  };
}

export async function compositeDesignAnnotationPng(
  baseDataUrl: string | null,
  draft: {
    element?: PickedElement;
    region?: { x: number; y: number; width: number; height: number };
    annotation?: ReviewAnnotation;
  },
  viewport: { width: number; height: number },
): Promise<string | null> {
  if (!baseDataUrl || typeof document === 'undefined') return baseDataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('Image load failed'));
      node.src = baseDataUrl;
    });
    const w = img.naturalWidth || Math.max(1, viewport.width);
    const h = img.naturalHeight || Math.max(1, viewport.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return baseDataUrl;
    ctx.drawImage(img, 0, 0, w, h);

    const rootStyles = typeof window !== 'undefined' ? window.getComputedStyle(document.documentElement) : null;
    const accentColor = rootStyles?.getPropertyValue('--motion-accent').trim() || 'CanvasText';
    const dangerColor = rootStyles?.getPropertyValue('--motion-danger').trim() || 'CanvasText';

    const sx = w / Math.max(1, viewport.width);
    const sy = h / Math.max(1, viewport.height);
    const highlightRect = draft.region ?? draft.element?.box;
    if (highlightRect) {
      ctx.save();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = Math.max(2, Math.round(2 * sx));
      ctx.fillStyle = accentColor;
      const rx = highlightRect.x * sx;
      const ry = highlightRect.y * sy;
      const rw = highlightRect.width * sx;
      const rh = highlightRect.height * sy;
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.restore();
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }
    if (draft.annotation?.marks.length) {
      ctx.save();
      ctx.strokeStyle = dangerColor;
      ctx.lineWidth = Math.max(3, Math.round(3 * sx));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const mark of draft.annotation.marks) {
        if (mark.points.length < 2) continue;
        ctx.beginPath();
        mark.points.forEach((pt, idx) => {
          const px = pt.x * w;
          const py = pt.y * h;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      ctx.restore();
    }
    return canvas.toDataURL('image/png');
  } catch {
    return baseDataUrl;
  }
}

export async function buildDesignSelectionAttachment({
  project,
  artifactId,
  chatId,
  pageUrl,
  filePath,
  slideIndex,
  slideCount,
  viewport,
  draft,
  comment,
  commentId,
  captureBase,
}: {
  project: DesignProjectDetail;
  artifactId?: string;
  chatId?: string | null;
  pageUrl: string;
  filePath: string;
  slideIndex?: number;
  slideCount?: number;
  viewport: { width: number; height: number };
  draft: {
    element?: PickedElement;
    region?: { x: number; y: number; width: number; height: number };
    annotation?: ReviewAnnotation;
  };
  comment?: string;
  commentId?: string;
  captureBase?: () => Promise<string | null>;
}): Promise<SuperAgentResourceAttachment> {
  let screenshotUrl: string | undefined;
  let screenshotPath: string | undefined;

  if (chatId && captureBase) {
    try {
      const base = await captureBase();
      const composited = await compositeDesignAnnotationPng(base, draft, viewport);
      if (composited) {
        const uploaded = await uploadSuperAgentAnnotationImage(chatId, composited);
        screenshotUrl = uploaded.screenshotUrl;
        screenshotPath = uploaded.screenshotPath;
      }
    } catch {
      // Visual screenshot upload is best-effort; element/region metadata still attaches.
    }
  }

  const mode = commentId
    ? 'design-comment'
    : draft.annotation
      ? 'draw'
      : draft.region
        ? 'region'
        : 'select';
  const cleanComment = comment?.trim();
  const title = cleanComment
    ? cleanComment.slice(0, 48)
    : draft.element
      ? (draft.element.label || draft.element.selector)
      : draft.region
        ? `${Math.round(draft.region.width)}×${Math.round(draft.region.height)}`
        : 'Draw annotation';
  const strokeBounds = draft.annotation
    ? normalizedAnnotationBounds(draft.annotation, viewport.width, viewport.height)
    : undefined;

  return {
    id: `design-annot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'browser-annotation',
    title,
    subtitle: [draft.element?.selector || filePath, slideIndex !== undefined ? `Slide ${slideIndex + 1}` : null]
      .filter(Boolean)
      .join(' · '),
    ...(screenshotUrl ? { previewUrl: screenshotUrl } : {}),
    annotation: {
      mode,
      pageUrl,
      pageTitle: project.title,
      ...(cleanComment ? { comment: cleanComment } : {}),
      ...(draft.element
        ? { element: designPickedElementToBrowserElement(draft.element, viewport, pageUrl, project.title, filePath) }
        : {}),
      ...(draft.region ? { region: clampRect(draft.region) } : {}),
      viewport: { width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) },
      ...(draft.annotation ? { strokeCount: draft.annotation.marks.length } : {}),
      ...(strokeBounds ? { strokeBounds } : {}),
      ...(screenshotUrl ? { screenshotUrl } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
      ...(commentId && screenshotUrl ? { screenshotSource: 'saved-design-comment' as const } : {}),
      artifactId: artifactId || `design:${project.id}`,
      artifactKind: 'design-project',
      projectId: project.id,
      filePath,
      ...(typeof slideIndex === 'number' ? { slideIndex } : {}),
      ...(typeof slideCount === 'number' && slideCount > 0 ? { slideCount } : {}),
      ...(commentId ? { commentId } : {}),
    },
  };
}

async function readDesignCommentSnapshot(projectId: string, commentId: string) {
  try {
    const response = await fetch(designRoutes.commentPreview(projectId, commentId), { cache: 'no-store' });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') return null;
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid screenshot'));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, slideIndex: readCommentPreviewSlideIndex(response) };
  } catch {
    return null;
  }
}

export async function designCommentToAttachment(params: {
  project: DesignProjectDetail;
  comment: DesignComment;
  artifactId?: string;
  chatId?: string | null;
  slideCount?: number;
}): Promise<SuperAgentResourceAttachment> {
  const { anchor } = params.comment;
  const filePath = anchor.filePath || params.project.entry;
  const snapshot = params.chatId ? await readDesignCommentSnapshot(params.project.id, params.comment.id) : null;
  return buildDesignSelectionAttachment({
    project: params.project,
    artifactId: params.artifactId,
    chatId: params.chatId,
    pageUrl: designRoutes.raw(params.project.id, filePath),
    filePath,
    slideIndex: snapshot?.slideIndex ?? anchor.slideIndex,
    slideCount: params.slideCount,
    viewport: anchor.annotation ?? anchor.viewport,
    draft: {
      element: anchor.element,
      region: anchor.region,
      annotation: anchor.annotation,
    },
    comment: params.comment.text,
    commentId: params.comment.id,
    captureBase: snapshot ? async () => snapshot.dataUrl : undefined,
  });
}

export function buildDesignCodeSelectionAttachment({
  project,
  artifactId,
  pageUrl,
  filePath,
  selection,
}: {
  project: DesignProjectDetail;
  artifactId?: string;
  pageUrl: string;
  filePath: string;
  selection: DesignCodeSelection;
}): SuperAgentResourceAttachment {
  const lineSuffix = selection.startLine === selection.endLine
    ? `L${selection.startLine}`
    : `L${selection.startLine}–L${selection.endLine}`;
  const fileBase = filePath.split('/').pop() || filePath;
  return {
    id: `design-code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'browser-annotation',
    title: `${fileBase} · ${lineSuffix}`,
    subtitle: selection.text.replace(/\s+/g, ' ').trim().slice(0, 72),
    annotation: {
      mode: 'code-selection',
      pageUrl,
      pageTitle: project.title,
      filePath,
      lineRange: { start: selection.startLine, end: selection.endLine },
      codeSnippet: selection.text.slice(0, 4000),
      artifactId: artifactId || `design:${project.id}`,
      artifactKind: 'design-project',
      projectId: project.id,
    },
  };
}

export function readTextareaCodeSelection(
  textarea: HTMLTextAreaElement,
): DesignCodeSelection | null {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  if (end <= start) return null;
  const selected = textarea.value.slice(start, end);
  if (!selected.trim()) return null;
  const startLine = textarea.value.slice(0, start).split('\n').length;
  const endLine = textarea.value.slice(0, end).split('\n').length;
  return { text: selected, startLine, endLine };
}

export function readDomCodeSelection(
  container: HTMLElement | null,
  fullContent: string,
): DesignCodeSelection | null {
  if (!container || typeof window === 'undefined') return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;

  const findLineNum = (node: Node | null): number | null => {
    let cur: Node | null = node;
    while (cur && cur !== container) {
      if (cur instanceof HTMLElement && cur.classList.contains('om-design-code-line')) {
        const ln = cur.querySelector('.om-design-code-ln')?.textContent?.trim();
        const num = ln ? Number(ln) : NaN;
        if (Number.isInteger(num) && num >= 1) return num;
      }
      cur = cur.parentNode;
    }
    return null;
  };

  let startLine = findLineNum(range.startContainer);
  let endLine = findLineNum(range.endContainer);
  if (startLine === null || endLine === null) {
    const idx = fullContent.indexOf(text.trim());
    if (idx >= 0) {
      startLine = fullContent.slice(0, idx).split('\n').length;
      endLine = fullContent.slice(0, idx + text.trim().length).split('\n').length;
    } else {
      startLine = 1;
      endLine = Math.max(1, text.split('\n').length);
    }
  }
  return {
    text,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}
