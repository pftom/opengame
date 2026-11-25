// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { designRoutes, type DesignComment, type DesignVersion } from '../../../shared/design-project';
import { I18nProvider } from '../i18n/I18n';
import { NearScreenIntersectionObserver } from '../hooks/intersectionObserverTestUtils';
import { readWorkspacePage, workspacePageHref } from '../motion/workspacePageRouting';
import { resourceImagePreviewUrl } from '../super-agent/ResourcePickerDialog';
import { CodeViewer } from './CodeViewer';
import { DesignApiError, designClient } from './designClient';
import { DesignProjectEditor, buildPresenterPopupHtml, overlayLocalPoint } from './DesignProjectEditor';
import { DesignProjectList } from './DesignProjectList';
import { DesignTemplateDetailModal } from './DesignTemplateDetailModal';
import { ScaledPreviewThumb, MAX_ACTIVE_THUMBS } from './ScaledPreviewThumb';
import { buildBridgeSrcDoc, looksLikeDeck, parseDeckSlides, parseSpeakerNotes } from './previewBridge';
import { SCROLL_SETTLE_MS } from '../utils/scrollActivity';

const projectId = '22222222-2222-4222-8222-222222222222';
const revision = 'b'.repeat(64);

const mockProject = {
  id: projectId,
  title: 'Test Prototype',
  scenario: 'prototype' as const,
  entry: 'index.html',
  designSystemId: 'stripe',
  templateId: null,
  source: 'blank' as const,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  trashedAt: null,
  revision,
  versionId: 'v-1',
  versionLabel: 'v1',
  files: [{ path: 'index.html', size: 80, sha256: revision, kind: 'html' as const }],
  path: '/tmp/design/projects/' + projectId,
  previewUrl: `/motion-api/design/raw/${projectId}/index.html`,
  editorUrl: `/?page=design&scene=projects&designProject=${projectId}`,
  openComments: 1,
};

const mockComment = {
  id: '33333333-3333-4333-8333-333333333333',
  projectId,
  text: 'Increase hero button contrast',
  status: 'open' as const,
  anchor: {
    filePath: 'index.html',
    viewport: { id: 'desktop' as const, width: 1440, height: 900 },
    slideIndex: 3,
    element: { selector: 'main.deck > section.slide > h1', tagName: 'h1', label: 'Hero', text: 'Start a free trial', box: { x: 40, y: 40, width: 300, height: 48 } },
  },
  sourceRevision: revision,
  author: 'user' as const,
  createdAt: 1700000000500,
  updatedAt: 1700000000500,
  commentRevision: 1,
};

describe('Design Studio client, bridge and routing', () => {
  it('parses structured API errors with code and status', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Stale revision' } }), { status: 409 }),
    );
    try {
      await expect(designClient.getProject(projectId)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        status: 409,
        message: 'Stale revision',
      });
      await expect(designClient.getProject(projectId).catch(e => e)).resolves.toBeInstanceOf(Error);
    } finally { spy.mockRestore(); }
  });

  it('extracts deck slides, speaker notes and injects base href into bridge srcdoc', () => {
    const deckHtml = `<!doctype html><html><head><title>Deck</title></head><body>
      <section class="slide active" data-screen-label="Intro"><h1>Welcome</h1></section>
      <section class="slide"><h2>Details</h2></section>
      <script type="application/json" id="speaker-notes">["First note", "Second note"]</script>
    </body></html>`;
    expect(looksLikeDeck(deckHtml)).toBe(true);
    expect(parseSpeakerNotes(deckHtml)).toEqual(['First note', 'Second note']);
    expect(parseDeckSlides(deckHtml)).toEqual([
      { index: 0, label: 'Intro' },
      { index: 1, label: 'Details' },
    ]);
    const wrapped = buildBridgeSrcDoc(deckHtml, 'http://localhost/motion-api/design/raw/id/', 'tok-1', true);
    expect(wrapped).toContain('<base href="http://localhost/motion-api/design/raw/id/" />');
    expect(wrapped).toContain('om:design-pick');
  });

  it('routes design HTML scenarios and project editor separately from image media scenes', () => {
    const img = readWorkspacePage('?page=design&scene=text-to-image');
    expect(img.studio?.studio.id).toBe('design');
    expect(img.studio?.scene.id).toBe('text-to-image');
    expect(img.designScene).toBeUndefined();

    expect(readWorkspacePage('?page=design').designScene).toBe('prototype');
    const proto = readWorkspacePage('?page=design&scene=prototype');
    expect(proto.designScene).toBe('prototype');
    expect(proto.studio).toBeNull();

    const editor = readWorkspacePage(`?page=design&scene=projects&designProject=${projectId}`);
    expect(editor.designScene).toBe('projects');
    expect(editor.designProject).toBe(projectId);
    expect(editor.studio).toBeNull();

    const href = workspacePageHref('http://localhost/?page=explore', { designScene: 'deck', designProject: projectId });
    expect(href).toBe(`/design/projects/${projectId}?scene=deck`);
    const parsedDeckProject = new URL(href, 'http://localhost');
    expect(readWorkspacePage(parsedDeckProject.search, parsedDeckProject.hash, parsedDeckProject.pathname)).toMatchObject({
      designScene: 'deck',
      designProject: projectId,
      studio: null,
    });
    const projectsHref = workspacePageHref('http://localhost/?page=explore', { designScene: 'projects', designProject: projectId });
    expect(projectsHref).toBe(`/design/projects/${projectId}`);
    const parsedProjectsEditor = new URL(projectsHref, 'http://localhost');
    expect(readWorkspacePage(parsedProjectsEditor.search, parsedProjectsEditor.hash, parsedProjectsEditor.pathname)).toMatchObject({
      designScene: 'projects',
      designProject: projectId,
      studio: null,
    });
  });
});

describe('DesignProjectEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
  });

  it('switches Preview/Code, lists comments and resolves an open annotation', async () => {
    let resolved = false;
    const penComment: DesignComment = {
      ...mockComment,
      id: '44444444-4444-4444-8444-444444444444',
      text: 'Adjust the marked title',
      anchor: {
        filePath: 'index.html',
        viewport: { id: 'desktop', width: 640, height: 240 },
        slideIndex: 0,
        annotation: {
          version: 1, coordinateSpace: 'normalized', width: 640, height: 180,
          marks: [{ kind: 'pen', points: [{ x: 0.125, y: 0.2 }, { x: 0.375, y: 0.6 }] }],
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith(`/projects/${projectId}`) && (!init?.method || init.method === 'GET')) {
        return Response.json({ project: mockProject });
      }
      if (url.includes('/versions')) {
        return Response.json({ versions: [{ id: 'v-1', label: 'v1', number: 1, createdAt: 1700000000000, source: 'create', summary: 'Initial', prompt: null, restoredFrom: null, files: [] }], currentVersionId: 'v-1', nextCursor: null });
      }
      if (url.includes('/comments/') && init?.method === 'PATCH') {
        resolved = true;
        return Response.json({ comment: { ...mockComment, status: 'resolved', commentRevision: 2 } });
      }
      if (url.includes('/comments')) {
        return Response.json({ comments: [mockComment, penComment], sourceRevision: revision });
      }
      if (url.includes('/files/')) {
        return Response.json({ path: 'index.html', content: '<!doctype html><html><body><h1>Hello</h1></body></html>', revision, size: 56, nextOffset: null });
      }
      if (url.includes('/editors')) {
        return Response.json({ editors: [{ id: 'cursor', label: 'Cursor', icon: 'code-s-slash-line', available: true }] });
      }
      if (url.includes('/state')) {
        return Response.json({ revision, versionId: 'v-1', openComments: resolved ? 0 : 1, updatedAt: 1700000001000 });
      }
      return Response.json({});
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignProjectEditor projectId={projectId} onBack={() => {}} />
        </I18nProvider>,
      );
    });

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Project title"]')?.value).toBe('Test Prototype');

    // Switch to Code view
    const codeBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Code'));
    expect(codeBtn).toBeTruthy();
    await act(async () => { codeBtn!.click(); });
    expect(container.textContent).toContain('<h1>Hello</h1>');

    // Switch sidebar to Comments and resolve the open comment
    const commentsTab = Array.from(container.querySelectorAll('[role="tablist"] button')).find(b => b.textContent?.includes('Comments'));
    expect(commentsTab).toBeTruthy();
    await act(async () => { commentsTab!.click(); });
    const commentCard = container.querySelector('.om-design-comment-card')!;
    expect(commentCard.textContent).toContain('Slide 4');
    expect(commentCard.textContent).toContain('Start a free trial');
    expect(commentCard.textContent).toContain('Increase hero button contrast');
    expect(commentCard.textContent).not.toContain(mockComment.anchor.element.selector);
    const thumbnail = commentCard.querySelector<HTMLImageElement>('.om-design-annotation-snapshot-image')!;
    expect(thumbnail.getAttribute('src')).toBe(designRoutes.commentPreview(projectId, mockComment.id));
    await act(async () => { thumbnail.dispatchEvent(new Event('load')); });
    const highlight = commentCard.querySelector('.om-design-annotation-snapshot-overlay rect');
    expect(highlight?.getAttribute('x')).toBe('40');
    expect(highlight?.getAttribute('width')).toBe('300');
    await act(async () => { thumbnail.dispatchEvent(new Event('error')); });
    expect(commentCard.querySelector('.om-design-annotation-fallback')?.textContent).toBe('Preview unavailable');
    expect(commentCard.textContent).toContain('Start a free trial');

    const penCard = Array.from(container.querySelectorAll('.om-design-comment-card'))
      .find(card => card.textContent?.includes(penComment.text))!;
    const penThumbnail = penCard.querySelector<HTMLImageElement>('.om-design-annotation-snapshot-image')!;
    expect(penThumbnail.getAttribute('src')).toBe(designRoutes.commentPreview(projectId, penComment.id));
    await act(async () => { penThumbnail.dispatchEvent(new Event('load')); });
    const penOverlay = penCard.querySelector('.om-design-annotation-snapshot-overlay');
    expect(penOverlay?.getAttribute('viewBox')).toBe('0 0 320 180');
    expect(penOverlay?.querySelector('.om-review-annotation-ink path')?.getAttribute('d')).toBe('M 80 36 L 240 108');
    await act(async () => { penThumbnail.dispatchEvent(new Event('error')); });
    const penFallback = penCard.querySelector('.om-design-annotation-fallback');
    expect(penFallback?.querySelector('.om-review-annotation-ink path')).toBeTruthy();
    expect(penFallback?.textContent).toBe('Preview unavailable');

    const resolveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Resolve');
    expect(resolveBtn).toBeTruthy();
    await act(async () => { resolveBtn!.click(); });
    expect(resolved).toBe(true);
    expect(DesignApiError).toBeDefined();
  });

  it('labels and opens deck comments on the slide shown in their saved preview', async () => {
    const legacyComment: DesignComment = {
      ...mockComment,
      text: 'Legacy annotation on the second slide',
      anchor: {
        filePath: mockProject.entry,
        viewport: mockComment.anchor.viewport,
        slideIndex: 0,
        scroll: { x: 0, y: 362 },
        region: { x: 365, y: 52, width: 222, height: 50 },
      },
    };
    const isolatedComment: DesignComment = {
      ...legacyComment,
      id: '44444444-4444-4444-8444-444444444444',
      text: 'New annotation on the third slide',
      status: 'open',
      anchor: { ...legacyComment.anchor, slideIndex: 2, isolatedSlide: true, scroll: { x: 0, y: 0 } },
    };
    const legacyPreview = designRoutes.commentPreview(projectId, legacyComment.id);
    const metadataRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'HEAD') {
        metadataRequests.push(String(input));
        return new Response(null, { headers: { 'X-OpenMotion-Slide-Index': '1' } });
      }
      return Response.json({});
    });
    vi.spyOn(designClient, 'getProject').mockResolvedValue({ project: { ...mockProject, scenario: 'deck' } });
    vi.spyOn(designClient, 'listComments').mockResolvedValue({ comments: [legacyComment, isolatedComment], sourceRevision: revision });
    vi.spyOn(designClient, 'detectEditors').mockResolvedValue({ editors: [] });
    vi.spyOn(designClient, 'readFile').mockResolvedValue({
      path: mockProject.entry,
      content: ['One', 'Two', 'Three'].map(title => `<section class="slide"><h1>${title}</h1></section>`).join(''),
      revision,
      size: 100,
      nextOffset: null,
    });

    await act(async () => {
      root.render(<I18nProvider><DesignProjectEditor projectId={projectId} onBack={() => {}} /></I18nProvider>);
    });
    const findButton = (selector: string, label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find(button => button.textContent?.trim().startsWith(label))!;
    await act(async () => { findButton('[role="tablist"] button', 'Comments').click(); });

    const [legacyCard, isolatedCard] = Array.from(container.querySelectorAll('.om-design-comment-card'));
    const labelButton = (card: Element) => card.querySelector<HTMLButtonElement>('.om-design-comment-location button')!;
    const thumbnail = (card: Element) => card.querySelector<HTMLImageElement>('.om-design-annotation-snapshot-image')!;
    const pin = (comment: DesignComment) => Array.from(container.querySelectorAll<HTMLElement>('.om-design-pin'))
      .find(element => element.title === comment.text);
    expect(pin(legacyComment)).toBeDefined();
    await act(async () => {
      thumbnail(legacyCard!).dispatchEvent(new Event('load'));
      thumbnail(isolatedCard!).dispatchEvent(new Event('load'));
    });
    expect(labelButton(legacyCard!).textContent).toBe('Slide 2');
    expect(labelButton(isolatedCard!).textContent).toBe('Slide 3');
    expect(metadataRequests).toEqual([legacyPreview]);
    expect(pin(legacyComment)).toBeUndefined();

    const frame = container.querySelector<HTMLIFrameElement>('.om-design-iframe')!;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    const bridgeToken = postMessage.mock.calls.find(([message]) => message.type === 'om:design-mode')?.[0].token;
    expect(bridgeToken).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'od:slide-state', token: bridgeToken, isolated: true, active: 0, count: 3 },
      }));
    });
    await act(async () => { labelButton(legacyCard!).click(); });
    expect(postMessage).toHaveBeenCalledWith({ type: 'od:slide', action: 'go', index: 1 }, '*');
    expect(pin(legacyComment)?.dataset.selected).toBe('true');
    expect(pin(legacyComment)?.style.top).toBe('52px');
    expect(container.querySelector<HTMLElement>('.om-design-region-box[data-saved="true"][data-selected="true"]')?.style.top).toBe('52px');
    await act(async () => { labelButton(isolatedCard!).click(); });
    expect(postMessage).toHaveBeenCalledWith({ type: 'od:slide', action: 'go', index: 2 }, '*');
    expect(pin(legacyComment)).toBeUndefined();
    expect(pin(isolatedComment)?.dataset.selected).toBe('true');
    expect(metadataRequests).toEqual([legacyPreview]);
  });

  it('sends each saved comment with its own viewport image and the slide shown in that image', async () => {
    const chatId = 'chat-1';
    const selectedComment: DesignComment = {
      ...mockComment,
      id: '55555555-5555-4555-8555-555555555555',
      text: 'Make the footer type more expressive',
      anchor: {
        filePath: 'index.html',
        viewport: { id: 'desktop', width: 644, height: 240 },
        slideIndex: 0,
        region: { x: 365, y: 52, width: 222, height: 50 },
      },
    };
    const firstPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO4w8X1HwAEpgHwHjmzTAAAAABJRU5ErkJggg==';
    const selectedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPg4rrzHwADAgHwdHaYEwAAAABJRU5ErkJggg==';
    const firstPreview = designRoutes.commentPreview(projectId, mockComment.id);
    const selectedPreview = designRoutes.commentPreview(projectId, selectedComment.id);
    const previewRequests: string[] = [];
    const uploadedImages: string[] = [];
    const captureCurrentPage = vi.fn();
    const onAttachToChat = vi.fn();
    let selectedPreviewAvailable = true;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), window.location.href);
      const requestPath = url.pathname + url.search;
      if (requestPath === firstPreview || requestPath === selectedPreview) {
        previewRequests.push(requestPath);
        const selected = requestPath === selectedPreview;
        if (selected && !selectedPreviewAvailable) return new Response(null, { status: 404 });
        const bytes = Uint8Array.from(atob(selected ? selectedPng : firstPng), character => character.charCodeAt(0));
        return new Response(bytes, {
          headers: { 'Content-Type': 'image/png', 'X-OpenMotion-Slide-Index': selected ? '1' : '3' },
        });
      }
      if (url.pathname.endsWith(`/chats/${chatId}/annotations`) && init?.method === 'POST') {
        uploadedImages.push(JSON.parse(String(init.body)).dataUrl);
        return Response.json({
          id: String(uploadedImages.length),
          screenshotUrl: `/annotation-images/${uploadedImages.length}.png`,
          screenshotPath: `/tmp/annotation-images/${uploadedImages.length}.png`,
        });
      }
      if (url.pathname.endsWith('/preview-snapshot')) {
        captureCurrentPage();
        return Response.json({ dataUrl: `data:image/png;base64,${firstPng}` });
      }
      if (url.pathname.endsWith(`/projects/${projectId}`)) {
        return Response.json({ project: { ...mockProject, scenario: 'deck', openComments: 2 } });
      }
      if (url.pathname.endsWith('/comments')) {
        return Response.json({ comments: [mockComment, selectedComment], sourceRevision: revision });
      }
      if (url.pathname.includes('/files/')) {
        return Response.json({
          path: mockProject.entry,
          content: '<section class="slide">Cover</section><section class="slide">Review</section>',
          revision,
          size: 82,
          nextOffset: null,
        });
      }
      return Response.json({});
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <DesignProjectEditor projectId={projectId} onBack={() => {}} embedded chatId={chatId} onAttachToChat={onAttachToChat} />
          </I18nProvider>,
        );
      });
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Toggle panel"]')!.click(); });
      const commentsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"] button'))
        .find(button => button.textContent?.startsWith('Comments'))!;
      await act(async () => { commentsTab.click(); });
      const selectedCard = Array.from(container.querySelectorAll('.om-design-comment-card'))
        .find(card => card.textContent?.includes(selectedComment.text))!;
      const sendSelected = Array.from(selectedCard.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.trim() === 'Send to Agent')!;
      const sendAll = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.trim() === 'Send all to Agent')!;

      await act(async () => {
        sendSelected.click();
        await vi.waitFor(() => expect(onAttachToChat).toHaveBeenCalledTimes(1));
      });
      expect(previewRequests).toEqual([selectedPreview]);
      expect(uploadedImages).toEqual([`data:image/png;base64,${selectedPng}`]);
      expect(onAttachToChat).toHaveBeenLastCalledWith(expect.objectContaining({
        title: selectedComment.text,
        previewUrl: '/annotation-images/1.png',
        annotation: expect.objectContaining({
          commentId: selectedComment.id,
          screenshotSource: 'saved-design-comment',
          slideIndex: 1,
        }),
      }), true);
      const [sentAttachment] = onAttachToChat.mock.calls[0]!;
      expect(resourceImagePreviewUrl(sentAttachment)).toBe('/annotation-images/1.png');
      expect(resourceImagePreviewUrl({
        ...sentAttachment,
        previewUrl: '/annotation-images/wrong-live-page.png',
        annotation: { ...sentAttachment.annotation, screenshotSource: undefined },
      })).toBe(selectedPreview);

      await act(async () => {
        sendAll.click();
        await vi.waitFor(() => expect(onAttachToChat).toHaveBeenCalledTimes(3));
      });
      expect(previewRequests).toEqual([selectedPreview, firstPreview, selectedPreview]);
      expect(uploadedImages.slice(1)).toEqual([`data:image/png;base64,${firstPng}`, `data:image/png;base64,${selectedPng}`]);
      expect(onAttachToChat).toHaveBeenNthCalledWith(2, expect.objectContaining({
        previewUrl: '/annotation-images/2.png',
        annotation: expect.objectContaining({ commentId: mockComment.id, slideIndex: 3 }),
      }), false);
      expect(onAttachToChat).toHaveBeenNthCalledWith(3, expect.objectContaining({
        previewUrl: '/annotation-images/3.png',
        annotation: expect.objectContaining({ commentId: selectedComment.id, slideIndex: 1 }),
      }), true);

      selectedPreviewAvailable = false;
      await act(async () => {
        sendSelected.click();
        await vi.waitFor(() => expect(onAttachToChat).toHaveBeenCalledTimes(4));
      });
      const [unavailableAttachment] = onAttachToChat.mock.calls[3]!;
      expect(unavailableAttachment.annotation.commentId).toBe(selectedComment.id);
      expect(unavailableAttachment.previewUrl).toBeUndefined();
      expect(unavailableAttachment.annotation.screenshotUrl).toBeUndefined();
      expect(previewRequests).toEqual([selectedPreview, firstPreview, selectedPreview, selectedPreview]);
      expect(uploadedImages).toHaveLength(3);
      expect(captureCurrentPage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('previews a historical version read-only, exports its entry and makes it current without adding history', async () => {
    const previous = {
      id: 'v-1', label: 'v1', number: 1, createdAt: 1700000000000,
      source: 'create' as const, summary: null, prompt: null, restoredFrom: null, entry: 'cover.html',
      files: [{ ...mockProject.files[0]!, path: 'cover.html' }],
    };
    const active = { ...previous, id: 'v-2', label: 'v2', number: 2, source: 'agent' as const, entry: mockProject.entry, files: mockProject.files };
    let currentProject = { ...mockProject, versionId: active.id, versionLabel: active.label };
    const versions: DesignVersion[] = [active, previous];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    vi.spyOn(designClient, 'getProject').mockImplementation(async () => ({ project: currentProject }));
    vi.spyOn(designClient, 'listVersions').mockImplementation(async () => ({
      versions: [...versions], currentVersionId: currentProject.versionId, nextCursor: null,
    }));
    vi.spyOn(designClient, 'listComments').mockResolvedValue({ comments: [mockComment], sourceRevision: revision });
    vi.spyOn(designClient, 'readFile').mockImplementation(async () => ({
      path: currentProject.entry, content: '<h1>Deck</h1>', revision: currentProject.revision, size: 13, nextOffset: null,
    }));
    const restoreVersion = vi.spyOn(designClient, 'restoreVersion').mockImplementationOnce(async () => {
      currentProject = { ...currentProject, entry: previous.entry, files: [{ ...mockProject.files[0]!, path: previous.entry }],
        versionId: previous.id, versionLabel: previous.label, revision: 'c'.repeat(64) };
      return { project: currentProject, version: previous, changed: true };
    });
    const onNotify = vi.fn();
    const onAttachToChat = vi.fn();
    const downloadExport = vi.spyOn(designClient, 'downloadExport').mockResolvedValue('project');
    const renderEditor = (externalAnnotateActive?: boolean) => root.render(
      <I18nProvider>
        <DesignProjectEditor projectId={projectId} onBack={() => {}} embedded onNotify={onNotify}
          onAttachToChat={onAttachToChat} externalAnnotateActive={externalAnnotateActive} externalAnnotTool="region" />
      </I18nProvider>,
    );

    await act(async () => { renderEditor(); });
    const frame = () => container.querySelector<HTMLIFrameElement>('.om-design-iframe')!;
    const clickElementInFrame = () => window.dispatchEvent(new MessageEvent('message', {
      source: frame().contentWindow,
      data: {
        type: 'om:design-pick',
        token: new URL(frame().getAttribute('src')!, window.location.href).searchParams.get('omBridge'),
        element: { tagName: 'h1', selector: 'h1', label: 'Heading' },
      },
    }));
    const draftNote = () => container.querySelector('textarea[placeholder="Add a note for Super Agent (optional)…"]');
    const commentTool = () => container.querySelector<HTMLButtonElement>('button[aria-label="Comment"]')!;
    const initialFrame = frame();
    expect(initialFrame?.getAttribute('src')).toContain('/index.html?r=0');
    expect(container.querySelector('.om-design-pin')).not.toBeNull();
    await act(async () => {
      commentTool().click();
      clickElementInFrame();
    });
    expect(draftNote()).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Toggle panel"]')!.click(); });
    const versionsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')).find(button => button.textContent === 'Versions');
    await act(async () => { versionsTab!.click(); });
    const versionButton = (version: string, action: string) => {
      const card = Array.from(container.querySelectorAll('.om-design-item-card')).find(item => item.querySelector('strong')?.textContent === version);
      return Array.from(card!.querySelectorAll('button')).find(button => button.textContent === action);
    };
    await act(async () => { versionButton('v1', 'Preview')!.click(); });
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(versionButton('v2', 'Current')).toBeDefined();
    expect(frame().getAttribute('src')).toContain('/cover.html?version=v-1');
    for (const label of ['Comment', 'Region', 'Draw']) {
      expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled).toBe(true);
    }
    expect(container.querySelector('.om-design-pin')).toBeNull();
    expect(draftNote()).toBeNull();
    await act(async () => { renderEditor(true); });
    expect(container.querySelector<HTMLElement>('.om-design-overlay')?.dataset.interactive).toBe('false');
    await act(async () => { clickElementInFrame(); });
    expect(draftNote()).toBeNull();

    const exportButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.om-design-toolbar button'))
      .find(button => button.textContent?.trim() === 'Export')!;
    for (const [format, label] of [['html', 'Standalone HTML (.html)'], ['pdf', 'PDF document (.pdf)'], ['png', 'PNG screenshot (.png)']]) {
      await act(async () => { exportButton.click(); });
      const action = Array.from(document.querySelectorAll<HTMLButtonElement>('.om-design-popover button'))
        .find(button => button.textContent?.trim() === label)!;
      await act(async () => { action.click(); });
      expect(downloadExport).toHaveBeenLastCalledWith(projectId, { format, versionId: 'v-1', filePath: 'cover.html' });
    }
    await act(async () => { versionButton('v2', 'Export')!.click(); });
    expect(downloadExport).toHaveBeenLastCalledWith(projectId, { format: 'zip', versionId: 'v-2', filePath: undefined });

    const makeCurrent = Array.from(container.querySelectorAll<HTMLButtonElement>('.om-design-banner button')).find(button => button.textContent === 'Make current version');
    await act(async () => { makeCurrent!.click(); });
    const restoredFrame = container.querySelector<HTMLIFrameElement>('.om-design-iframe');
    expect(restoreVersion).toHaveBeenCalledExactlyOnceWith(projectId, 'v-1', revision);
    expect(restoredFrame).not.toBe(initialFrame);
    expect(restoredFrame?.getAttribute('src')).toContain('/cover.html?r=1');
    expect(container.querySelector('.om-design-banner')).toBeNull();
    expect(container.querySelectorAll('.om-design-item-card')).toHaveLength(2);
    expect(versionButton('v1', 'Current')).toBeDefined();
    expect(versionButton('v1', 'Make current version')).toBeUndefined();
    expect(versionButton('v2', 'Make current version')).toBeDefined();
    expect(onNotify).toHaveBeenLastCalledWith('Set v1 as the current version', 'info');
    expect(commentTool().disabled).toBe(false);
    expect(container.querySelector<HTMLElement>('.om-design-overlay')?.dataset.interactive).toBe('true');
  });

  it('refreshes the active version after an external switch with the same file revision', async () => {
    const files = [...mockProject.files, { ...mockProject.files[0]!, path: 'cover.html' }];
    let project = { ...mockProject, files, versionId: 'v-2', versionLabel: 'v2' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    vi.spyOn(designClient, 'getProject').mockImplementation(async () => ({ project }));
    vi.spyOn(designClient, 'getState').mockImplementation(async () => ({
      revision: project.revision, versionId: project.versionId, openComments: project.openComments, updatedAt: project.updatedAt,
    }));
    vi.spyOn(designClient, 'readFile').mockImplementation(async (_id, file) => ({
      path: file, content: '<h1>Deck</h1>', revision, size: 13, nextOffset: null,
    }));

    await act(async () => {
      root.render(<I18nProvider><DesignProjectEditor projectId={projectId} onBack={() => {}} embedded /></I18nProvider>);
    });
    expect(container.querySelector('.om-design-iframe')?.getAttribute('src')).toContain('/index.html?r=0');
    project = { ...project, versionId: 'v-1', versionLabel: 'v1', entry: 'cover.html' };
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(container.querySelector('.om-design-iframe')?.getAttribute('src')).toContain('/cover.html?r=0');
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.trim() === 'v1')).toBe(true);
  });

  it('renders line numbers and syntax token classes in CodeViewer', async () => {
    await act(async () => {
      root.render(<CodeViewer content={'<!-- hero -->\n<h1 class="title">Hello</h1>\nconst count = 42;'} />);
    });
    const lines = container.querySelectorAll('.om-design-code-line');
    expect(lines.length).toBe(3);
    expect(container.querySelector('.om-design-tok-comment')?.textContent).toBe('<!-- hero -->');
    expect(container.querySelector('.om-design-tok-tag')?.textContent).toBe('<h1');
    expect(container.querySelector('.om-design-tok-string')?.textContent).toBe('"title"');
    expect(container.querySelector('.om-design-tok-keyword')?.textContent).toBe('const');
    expect(container.querySelector('.om-design-tok-number')?.textContent).toBe('42');
  });

  it('lists design projects and opens a project from DesignProjectList', async () => {
    const opened: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/editors')) return Response.json({ editors: [{ id: 'vscode', label: 'VS Code', icon: 'code-s-slash-line', available: true }] });
      if (url.includes('/projects')) return Response.json({ projects: [mockProject] });
      return Response.json({});
    });
    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignProjectList onOpen={id => opened.push(id)} />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('Test Prototype');
    expect(container.textContent).toContain('v1');
    const openBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Open');
    expect(openBtn).toBeTruthy();
    await act(async () => { openBtn!.click(); });
    expect(opened).toEqual([projectId]);
  });

  it('sandboxes Presenter popup iframe and escapes title and speaker notes', () => {
    const html = buildPresenterPopupHtml(
      'Deck </title><script>alert(1)</script>',
      'http://127.0.0.1:4197/motion-api/design/raw/id/index.html',
      ['Note </script><script>alert(2)</script>'],
      2,
    );
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"');
    expect(html).not.toContain('sandbox="allow-same-origin');
    expect(html).not.toContain('</title><script>alert(1)');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('</script><script>alert(2)');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('normalizes annotation coordinates for scrolled viewport picks and zoomed overlays', () => {
    const srcdoc = buildBridgeSrcDoc('<html><body><h1 id="hero">Hi</h1></body></html>', 'http://127.0.0.1/raw/', 'tok-scroll', true);
    expect(srcdoc).toContain('box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }');
    expect(srcdoc).not.toContain('rect.top + scrollY');

    // At 50% zoom, an overlay with clientWidth=1000 renders at rect.width=500.
    const fakeOverlay = {
      clientWidth: 1000,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 500, height: 300, right: 600, bottom: 350, x: 100, y: 50, toJSON: () => ({}) }),
    };
    const start = overlayLocalPoint(fakeOverlay, 200, 110);
    const end = overlayLocalPoint(fakeOverlay, 350, 210);
    expect(start.x).toBe(200);
    expect(start.y).toBe(120);
    expect(end.x - start.x).toBe(300);
    expect(end.y - start.y).toBe(200);
    expect(start.width).toBe(1000);
    expect(start.height).toBe(600);
  });

  it('submits edit-start expectedRevision on manual save, preserves draft on VERSION_CONFLICT, and allows conflict overwrite retry', async () => {
    const newRevision = 'c'.repeat(64);
    const savedRevision = 'd'.repeat(64);
    let currentRevision = revision;
    let storedContent = '<h1>v1</h1>';
    const submittedRevisions: string[] = [];
    vi.spyOn(designClient, 'getProject').mockImplementation(async () => ({ project: { ...mockProject, revision: currentRevision } }));
    vi.spyOn(designClient, 'listVersions').mockResolvedValue({ versions: [], currentVersionId: 'v-1', nextCursor: null });
    vi.spyOn(designClient, 'listComments').mockResolvedValue({ comments: [], sourceRevision: revision });
    vi.spyOn(designClient, 'detectEditors').mockResolvedValue({ editors: [] });
    vi.spyOn(designClient, 'readFile').mockImplementation(async () => ({ path: 'index.html', content: storedContent, offset: 0, limit: 100, totalBytes: storedContent.length, hasMore: false, nextOffset: null }));
    vi.spyOn(designClient, 'writeFiles').mockImplementation(async (_id, payload) => {
      submittedRevisions.push(payload.expectedRevision);
      if (payload.expectedRevision !== currentRevision) {
        throw new DesignApiError('VERSION_CONFLICT', 'Expected revision mismatch', 409);
      }
      currentRevision = savedRevision;
      storedContent = payload.files?.[0]?.content ?? storedContent;
      return {
        project: { ...mockProject, revision: savedRevision, versionLabel: 'v3' },
        version: { id: 'v-3', label: 'v3', number: 3, createdAt: 1700000002000, source: 'manual', summary: 'Manual edit', prompt: null, restoredFrom: null, files: [] },
      };
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignProjectEditor projectId={projectId} onBack={() => {}} />
        </I18nProvider>,
      );
    });

    const codeBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Code'));
    await act(async () => { codeBtn!.click(); });

    const editBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Edit source'));
    await act(async () => { editBtn!.click(); });

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!;
    expect(editor).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, '<h1>Unsaved manual draft</h1>');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Simulate external Agent write advancing revision before the user clicks Save.
    currentRevision = newRevision;
    const reloadBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Reload preview"]');
    if (reloadBtn) await act(async () => { reloadBtn.click(); });

    const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Save version'));
    await act(async () => { saveBtn!.click(); });

    expect(submittedRevisions).toEqual([revision]);
    // Draft stays open in the editor so user edits are not lost on conflict.
    const stillEditing = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]');
    expect(stillEditing?.value).toBe('<h1>Unsaved manual draft</h1>');

    // User explicitly clicks "Overwrite with my draft" to rebase onto the latest revision and retry save.
    const overwriteBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Overwrite with my draft'));
    expect(overwriteBtn).toBeTruthy();
    await act(async () => { overwriteBtn!.click(); });

    expect(submittedRevisions).toEqual([revision, newRevision]);
    // After successful retry, editing exits cleanly and the saved draft is displayed.
    expect(container.querySelector('textarea[aria-label="Source editor"]')).toBeNull();
    expect(container.textContent).toContain('Unsaved manual draft');
  });

  it('reads latest file content when clicking Discard draft & reload latest before post-conflict read resolves', async () => {
    const newRevision = 'e'.repeat(64);
    const savedRevision = 'f'.repeat(64);
    let currentRevision = revision;
    let storedContent = '<h1>v1</h1>';
    const submittedWrites: { expectedRevision: string; content: string }[] = [];
    let readCallCount = 0;
    let resolveDeferredEffectRead: ((value: { path: string; content: string; offset: number; limit: number; totalBytes: number; hasMore: boolean; nextOffset: null }) => void) | null = null;

    vi.spyOn(designClient, 'getProject').mockImplementation(async () => ({ project: { ...mockProject, revision: currentRevision } }));
    vi.spyOn(designClient, 'listVersions').mockResolvedValue({ versions: [], currentVersionId: 'v-1', nextCursor: null });
    vi.spyOn(designClient, 'listComments').mockResolvedValue({ comments: [], sourceRevision: revision });
    vi.spyOn(designClient, 'detectEditors').mockResolvedValue({ editors: [] });
    vi.spyOn(designClient, 'readFile').mockImplementation(async () => {
      readCallCount += 1;
      // 1st read: initial load (v1). 2nd read: post-conflict useEffect read held in flight.
      if (readCallCount === 2) {
        return new Promise(resolve => {
          resolveDeferredEffectRead = resolve;
        });
      }
      return { path: 'index.html', content: storedContent, offset: 0, limit: 100, totalBytes: storedContent.length, hasMore: false, nextOffset: null };
    });
    vi.spyOn(designClient, 'writeFiles').mockImplementation(async (_id, payload) => {
      const content = payload.files?.[0]?.content ?? '';
      submittedWrites.push({ expectedRevision: payload.expectedRevision, content });
      if (payload.expectedRevision !== currentRevision) {
        throw new DesignApiError('VERSION_CONFLICT', 'Expected revision mismatch', 409);
      }
      currentRevision = savedRevision;
      storedContent = content;
      return {
        project: { ...mockProject, revision: savedRevision, versionLabel: 'v3' },
        version: { id: 'v-3', label: 'v3', number: 3, createdAt: 1700000003000, source: 'manual', summary: 'Manual edit', prompt: null, restoredFrom: null, files: [] },
      };
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignProjectEditor projectId={projectId} onBack={() => {}} />
        </I18nProvider>,
      );
    });

    const codeBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Code'));
    await act(async () => { codeBtn!.click(); });

    const editBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Edit source'));
    await act(async () => { editBtn!.click(); });

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, '<h1>Stale user draft</h1>');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // External Agent updates project revision and file content on disk before user saves.
    currentRevision = newRevision;
    storedContent = '<h1>External Agent v2</h1>';

    const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Save version'));
    await act(async () => { saveBtn!.click(); });

    // Post-conflict effect read (#2) is still unresolved when user clicks Discard.
    expect(resolveDeferredEffectRead).not.toBeNull();
    const discardBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Discard draft & reload latest'));
    expect(discardBtn).toBeTruthy();

    await act(async () => { discardBtn!.click(); });

    // Editor now holds the freshly fetched v2 content, NOT pre-conflict v1 content.
    const reloadedEditor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!;
    expect(reloadedEditor.value).toBe('<h1>External Agent v2</h1>');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Even if the earlier deferred read resolves late with stale content, it must not overwrite fileContent/draft.
    await act(async () => {
      resolveDeferredEffectRead!({ path: 'index.html', content: '<h1>v1</h1>', offset: 0, limit: 100, totalBytes: 11, hasMore: false, nextOffset: null });
    });
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!.value).toBe('<h1>External Agent v2</h1>');

    // Saving now rebases onto newRevision with the fresh content.
    const saveAfterDiscard = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Save version'));
    await act(async () => { saveAfterDiscard!.click(); });
    expect(submittedWrites).toEqual([
      { expectedRevision: revision, content: '<h1>Stale user draft</h1>' },
      { expectedRevision: newRevision, content: '<h1>External Agent v2</h1>' },
    ]);
  });

  it('clears codeLoading when discard reload fails after invalidating an in-flight post-conflict read', async () => {
    const newRevision = '1'.repeat(64);
    let currentRevision = revision;
    let readCallCount = 0;

    vi.spyOn(designClient, 'getProject').mockImplementation(async () => ({ project: { ...mockProject, revision: currentRevision } }));
    vi.spyOn(designClient, 'listVersions').mockResolvedValue({ versions: [], currentVersionId: 'v-1', nextCursor: null });
    vi.spyOn(designClient, 'listComments').mockResolvedValue({ comments: [], sourceRevision: revision });
    vi.spyOn(designClient, 'detectEditors').mockResolvedValue({ editors: [] });
    vi.spyOn(designClient, 'readFile').mockImplementation(async () => {
      readCallCount += 1;
      if (readCallCount === 1) {
        return { path: 'index.html', content: '<h1>v1</h1>', offset: 0, limit: 100, totalBytes: 11, hasMore: false, nextOffset: null };
      }
      if (readCallCount === 2) {
        // Post-conflict effect read stays pending so Discard invalidates its sequence.
        return new Promise(() => {});
      }
      throw new Error('Transient read failure');
    });
    vi.spyOn(designClient, 'writeFiles').mockRejectedValue(new DesignApiError('VERSION_CONFLICT', 'Expected revision mismatch', 409));

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignProjectEditor projectId={projectId} onBack={() => {}} />
        </I18nProvider>,
      );
    });

    const codeBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Code'));
    await act(async () => { codeBtn!.click(); });

    const editBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Edit source'));
    await act(async () => { editBtn!.click(); });

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, '<h1>Unsaved draft</h1>');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    currentRevision = newRevision;
    const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Save version'));
    await act(async () => { saveBtn!.click(); });

    const discardBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Discard draft & reload latest'));
    expect(discardBtn).toBeTruthy();
    await act(async () => { discardBtn!.click(); });

    // Failure keeps the conflict banner and draft intact.
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source editor"]')!.value).toBe('<h1>Unsaved draft</h1>');

    // Clicking Cancel must exit edit mode cleanly without stranding the code panel in "Loading file…".
    const cancelBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Cancel');
    expect(cancelBtn).toBeTruthy();
    await act(async () => { cancelBtn!.click(); });

    expect(container.textContent).not.toContain('Loading file');
    expect(container.querySelector('.om-design-code-pre')).toBeTruthy();
  });

  it('unmounts ScaledPreviewThumb iframe when inactive and renders a single preview iframe in DesignTemplateDetailModal', async () => {
    vi.stubGlobal('IntersectionObserver', NearScreenIntersectionObserver);
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <ScaledPreviewThumb
              active
              src="/motion-api/design/catalog/templates/sample/preview/index.html"
              title="Sample"
            />
          </I18nProvider>,
        );
        await Promise.resolve();
      });
      expect(container.querySelector('iframe')?.getAttribute('src')).toContain('?thumb=1');

      await act(async () => {
        root.render(
          <I18nProvider>
            <ScaledPreviewThumb
              active={false}
              src="/motion-api/design/catalog/templates/sample/preview/index.html"
              title="Sample"
            />
          </I18nProvider>,
        );
      });
      expect(container.querySelector('iframe')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesignTemplateDetailModal
            templates={[{
              id: 'sample',
              title: 'Sample Template',
              description: 'Test',
              scenario: 'prototype',
              category: 'prototype',
              entry: 'index.html',
              tags: [],
              previewUrl: '/motion-api/design/catalog/templates/sample/preview/index.html',
              examplePrompt: '',
            }]}
            index={0}
            onNavigate={() => {}}
            onClose={() => {}}
            onRemix={() => {}}
            onUseWithAgent={() => {}}
          />
        </I18nProvider>,
      );
    });
    expect(document.querySelectorAll('.om-design-tpl-detail-popup iframe').length).toBe(1);
    expect(document.querySelector('.om-design-tpl-ambient')).toBeNull();
  });

  it('preserves first-row visible ScaledPreviewThumb slots without eviction and promotes queued thumbnails on release', async () => {
    vi.stubGlobal('IntersectionObserver', NearScreenIntersectionObserver);
    try {
      const ids = Array.from({ length: MAX_ACTIVE_THUMBS + 2 }, (_, idx) => idx);
      await act(async () => {
        root.render(
          <I18nProvider>
            <div>
              {ids.map(idx => (
                <ScaledPreviewThumb
                  key={idx}
                  active
                  src={`/motion-api/design/catalog/templates/sample-${idx}/preview/index.html`}
                  title={`Card ${idx}`}
                />
              ))}
            </div>
          </I18nProvider>,
        );
        await Promise.resolve();
      });

      const mountedTitles = [...container.querySelectorAll('iframe')].map(el => el.getAttribute('title'));
      expect(mountedTitles.length).toBe(MAX_ACTIVE_THUMBS);
      expect(mountedTitles[0]).toBe('Card 0');
      expect(mountedTitles).toContain('Card 1');
      expect(mountedTitles).not.toContain(`Card ${MAX_ACTIVE_THUMBS}`);

      // Unmount Card 0: its freed slot should immediately promote the first queued waiting card.
      await act(async () => {
        root.render(
          <I18nProvider>
            <div>
              {ids.slice(1).map(idx => (
                <ScaledPreviewThumb
                  key={idx}
                  active
                  src={`/motion-api/design/catalog/templates/sample-${idx}/preview/index.html`}
                  title={`Card ${idx}`}
                />
              ))}
            </div>
          </I18nProvider>,
        );
        await Promise.resolve();
      });

      const nextTitles = [...container.querySelectorAll('iframe')].map(el => el.getAttribute('title'));
      expect(nextTitles.length).toBe(MAX_ACTIVE_THUMBS);
      expect(nextTitles).toContain(`Card ${MAX_ACTIVE_THUMBS}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defers ScaledPreviewThumb iframe mounting during active scroll and mounts once scroll settles', async () => {
    vi.useFakeTimers();
    let emitIO!: (inView: boolean) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        emitIO = inView => callback([{ isIntersecting: inView } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    });
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <div data-scroller="" style={{ overflowY: 'auto' }}>
              <ScaledPreviewThumb
                active
                src="/motion-api/design/catalog/templates/scroll-card/preview/index.html"
                title="Scroll Card"
              />
            </div>
          </I18nProvider>,
        );
      });
      const scroller = container.querySelector<HTMLDivElement>('[data-scroller]')!;

      // Enter then leave while scrolling: never spawns an iframe mid-scroll.
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll'));
        emitIO(true);
      });
      expect(container.querySelector('iframe')).toBeNull();

      await act(async () => {
        emitIO(false);
        vi.advanceTimersByTime(SCROLL_SETTLE_MS);
      });
      expect(container.querySelector('iframe')).toBeNull();

      // Stop scrolling while visible: mounts after SCROLL_SETTLE_MS.
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll'));
        emitIO(true);
      });
      expect(container.querySelector('iframe')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(SCROLL_SETTLE_MS);
      });
      expect(container.querySelector('iframe')?.getAttribute('title')).toBe('Scroll Card');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
