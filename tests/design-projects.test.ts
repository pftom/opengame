import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesignError, DesignProjects, designHttp } from '../design-projects.ts';
import { readProjectZip } from '../shared/project-zip.ts';
import { browserExecutable } from '../browser.ts';

async function tempService() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-design-test-'));
  return { dir, service: new DesignProjects(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('design project lifecycle: create blank/template, revision conflict, idempotency, versions and restore', async () => {
  const { service, cleanup } = await tempService();
  try {
    const created = await service.create({ requestId: 'req-create-1', scenario: 'prototype', title: 'Landing Demo', designSystemId: 'stripe' }, 'http://127.0.0.1:4100');
    assert.equal(created.scenario, 'prototype');
    assert.equal(created.title, 'Landing Demo');
    assert.equal(created.designSystemId, 'stripe');
    assert.equal(created.versionLabel, 'v1');
    assert(created.files.some(f => f.path === 'index.html'));
    assert(created.files.some(f => f.path === 'DESIGN.md'));
    assert.equal(created.editorUrl, `http://127.0.0.1:4100/design/projects/${created.id}`);

    // Replay same requestId returns identical project without duplicating.
    const replayed = await service.create({ requestId: 'req-create-1', scenario: 'prototype', title: 'Landing Demo', designSystemId: 'stripe' }, 'http://127.0.0.1:4100');
    assert.equal(replayed.id, created.id);
    assert.equal((await service.list()).length, 1);

    // Stale revision fails with VERSION_CONFLICT.
    await assert.rejects(
      () => service.write(created.id, { requestId: 'req-bad', expectedRevision: '0'.repeat(64), files: [{ path: 'index.html', content: '<h1>nope</h1>' }] }),
      (error: unknown) => error instanceof DesignError && error.code === 'VERSION_CONFLICT',
    );

    // Path traversal rejected.
    await assert.rejects(
      () => service.write(created.id, { requestId: 'req-trav', expectedRevision: created.revision, files: [{ path: '../evil.html', content: 'x' }] }),
      (error: unknown) => error instanceof DesignError && error.code === 'INVALID_ARGUMENT',
    );

    // Valid write creates v2.
    const w1 = await service.write(created.id, {
      requestId: 'req-w1', expectedRevision: created.revision,
      files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>Version Two</h1></body></html>' }],
      summary: 'Update hero title', source: 'agent',
    });
    assert.equal(w1.version.label, 'v2');
    assert.equal(w1.project.versionLabel, 'v2');

    // Second write creates v3.
    const w2 = await service.write(created.id, {
      requestId: 'req-w2', expectedRevision: w1.project.revision,
      files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>Version Three</h1></body></html>' }],
      summary: 'Update again', source: 'manual',
    });
    assert.equal(w2.version.label, 'v3');

    const originalHistory = await service.listVersions(created.id);
    assert.deepEqual(originalHistory.versions.map(version => version.label), ['v3', 'v2', 'v1']);

    // Restoring v2 switches the active snapshot and leaves history intact.
    const restoreInput = { requestId: 'req-restore', expectedRevision: w2.project.revision };
    const restored = await service.restoreVersion(created.id, w1.version.id, restoreInput);
    assert.equal(restored.changed, true);
    assert.deepEqual(restored.version, w1.version);
    assert.equal(restored.project.versionId, w1.version.id);
    assert.equal(restored.project.versionLabel, 'v2');
    const readBack = await service.readFile(created.id, 'index.html');
    assert(readBack.content.includes('Version Two'));

    const unchanged = await service.restoreVersion(created.id, w1.version.id, { requestId: 'req-restore-again', expectedRevision: restored.project.revision });
    assert.equal(unchanged.changed, false);
    assert.deepEqual(unchanged.project, restored.project);
    assert.deepEqual(unchanged.version, restored.version);
    await assert.rejects(
      () => service.restoreVersion(created.id, w1.version.id, { requestId: 'req-stale-restore', expectedRevision: w2.project.revision }),
      (error: unknown) => error instanceof DesignError && error.code === 'VERSION_CONFLICT',
    );

    assert.deepEqual(await service.listVersions(created.id), { ...originalHistory, currentVersionId: w1.version.id });

    // A newer snapshot stays restorable. Replaying the old request returns its receipt without switching again.
    const forward = await service.restoreVersion(created.id, w2.version.id, { requestId: 'req-restore-forward', expectedRevision: restored.project.revision });
    assert.equal(forward.changed, true);
    assert.deepEqual(forward.version, w2.version);
    assert.equal(forward.project.versionId, w2.version.id);
    assert.deepEqual(await service.restoreVersion(created.id, w1.version.id, restoreInput), restored);
    assert.deepEqual(await service.listVersions(created.id), originalHistory);
    assert((await service.readFile(created.id, 'index.html')).content.includes('Version Three'));

    const editingBase = await service.restoreVersion(created.id, w1.version.id, { requestId: 'req-restore-for-edit', expectedRevision: forward.project.revision });
    const nextEdit = await service.write(created.id, {
      requestId: 'req-w3', expectedRevision: editingBase.project.revision,
      files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>New edit from Version Two</h1></body></html>' }],
    });
    assert.equal(nextEdit.version.label, 'v4');
    assert.deepEqual(await service.listVersions(created.id), {
      ...originalHistory, currentVersionId: nextEdit.version.id, versions: [nextEdit.version, ...originalHistory.versions],
    });
    const rawV3 = await service.readRawFile(created.id, 'index.html', w2.version.id);
    assert(rawV3.body.toString('utf8').includes('Version Three'));

    // Template creation works.
    const fromTpl = await service.create({ requestId: 'req-tpl', templateId: 'dashboard' });
    assert.equal(fromTpl.source, 'template');
    assert.equal(fromTpl.templateId, 'dashboard');
    assert(fromTpl.files.some(f => f.path === fromTpl.entry));

    // Rename, duplicate, trash, restore, delete.
    const renamed = await service.rename(created.id, { title: 'Renamed Demo', expectedTitle: 'Landing Demo', requestId: 'req-ren' });
    assert.equal(renamed.title, 'Renamed Demo');
    const dup = await service.duplicate(created.id, { requestId: 'req-dup' });
    assert.notEqual(dup.id, created.id);
    await assert.rejects(() => service.remove(dup.id, 'req-del-early'), (e: unknown) => e instanceof DesignError && e.code === 'INVALID_ARGUMENT');
    await service.trash(dup.id, 'req-trash');
    assert.equal((await service.list({ trashed: true })).length, 1);
    const removed = await service.remove(dup.id, 'req-del-ok');
    assert.equal(removed.deletedId, dup.id);
  } finally { await cleanup(); }
});

test('version restore switches between distinct snapshots with identical files and entry', async () => {
  const { service, cleanup } = await tempService();
  try {
    const project = await service.create({ requestId: 'identical-create', scenario: 'prototype' });
    const { content } = await service.readFile(project.id, project.entry);
    const written = await service.write(project.id, {
      requestId: 'identical-write', expectedRevision: project.revision,
      files: [{ path: project.entry, content }],
    });
    assert.equal(written.project.revision, project.revision);
    assert.equal(written.project.entry, project.entry);
    assert.notEqual(written.version.id, project.versionId);
    const history = await service.listVersions(project.id);
    const active = await service.restoreVersion(project.id, project.versionId!, {
      requestId: 'identical-restore', expectedRevision: written.project.revision,
    });
    assert.equal(active.changed, true);
    assert.equal(active.version.id, project.versionId);
    assert.equal(active.project.versionId, project.versionId);
    assert.equal(active.project.revision, written.project.revision);
    assert.deepEqual(await service.listVersions(project.id), { ...history, currentVersionId: project.versionId });
  } finally { await cleanup(); }
});

test('design comments support element/region/pen annotations and optimistic commentRevision', async () => {
  const { service, cleanup } = await tempService();
  try {
    const project = await service.create({ requestId: 'c-create', scenario: 'deck', title: 'Pitch Deck' });
    const created = await service.createComment(project.id, {
      requestId: 'c-1', expectedRevision: project.revision, text: 'Tighten headline spacing',
      anchor: {
        filePath: 'index.html',
        viewport: { id: 'desktop', width: 1440, height: 900 },
        slideIndex: 0,
        element: { selector: '.slide.active h1', tagName: 'h1', label: 'Headline', text: 'Pitch Deck', box: { x: 80, y: 120, width: 520, height: 72 } },
        annotation: { version: 1, coordinateSpace: 'normalized', width: 1440, height: 900, marks: [{ kind: 'rectangle', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.25 }] }] },
      },
    });
    assert.equal(created.comment.status, 'open');
    assert.equal(created.comment.commentRevision, 1);
    await assert.rejects(() => service.createComment(project.id, {
      requestId: 'invalid-scroll', expectedRevision: project.revision, text: 'Invalid scroll point',
      anchor: { ...created.comment.anchor, scroll: { x: 0, y: Infinity } },
    }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(() => service.createComment(project.id, {
      requestId: 'invalid-scroll-container', expectedRevision: project.revision, text: 'Invalid scroll container',
      anchor: { ...created.comment.anchor, scroll: { x: 0, y: 0, containers: [{ selector: 'main', x: NaN, y: 0 }] } },
    }), { code: 'INVALID_ARGUMENT' });

    // Resolve with right revision succeeds.
    const resolved = await service.updateComment(project.id, created.comment.id, { status: 'resolved', expectedCommentRevision: 1 });
    assert.equal(resolved.comment.status, 'resolved');
    assert.equal(resolved.comment.commentRevision, 2);

    // Stale commentRevision fails with COMMENT_CONFLICT.
    await assert.rejects(
      () => service.updateComment(project.id, created.comment.id, { status: 'open', expectedCommentRevision: 1 }),
      (error: unknown) => error instanceof DesignError && error.code === 'COMMENT_CONFLICT',
    );
  } finally { await cleanup(); }
});

test('saved region preview captures the full annotated viewport and keeps the render isolated', { timeout: 30_000 }, async t => {
  if (!await browserExecutable().catch(() => null)) {
    t.skip('Chrome or Chromium is unavailable');
    return;
  }
  const { dir, service, cleanup } = await tempService();
  let outsideRequests = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/outside-snapshot') outsideRequests++;
    const handled = await designHttp(req, res, url, dir, 'http://127.0.0.1', async () => ({}));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  try {
    const project = await service.create({ requestId: 'region-preview-create', scenario: 'mobile-app' });
    const old = await service.write(project.id, {
      requestId: 'region-preview-v2', expectedRevision: project.revision,
      files: [
        { path: 'index.html', content: `<!doctype html><link rel="stylesheet" href="colors.css"><img src="${origin}/outside-snapshot" alt="">` },
        { path: 'colors.css', content: 'html { background: #154abc; }' },
      ],
    });
    const anchor = {
      filePath: 'index.html', viewport: { id: 'mobile' as const, width: 390, height: 844 },
      region: { x: 23, y: 30, width: 94, height: 34 },
    };
    const first = await service.createComment(project.id, {
      requestId: 'region-preview-first', expectedRevision: old.project.revision, text: 'Old region', anchor,
    });
    const current = await service.write(project.id, {
      requestId: 'region-preview-v3', expectedRevision: old.project.revision,
      files: [{ path: 'colors.css', content: 'html { background: #b31267; }' }],
    });
    const second = await service.createComment(project.id, {
      requestId: 'region-preview-second', expectedRevision: current.project.revision, text: 'Current region', anchor,
    });
    const prefix = `${origin}/api/design/projects/${project.id}/comments`;
    const [historical, latest] = await Promise.all([
      fetch(`${prefix}/${first.comment.id}/preview`),
      fetch(`${prefix}/${second.comment.id}/preview`),
    ]);
    assert.equal(historical.status, 200);
    assert.equal(latest.status, 200);
    assert.equal(historical.headers.get('content-type'), 'image/png');
    assert.equal(historical.headers.get('cross-origin-resource-policy'), 'same-origin');
    const png = Buffer.from(await historical.arrayBuffer());
    assert.equal(png.readUInt32BE(16), anchor.viewport.width);
    assert.equal(png.readUInt32BE(20), anchor.viewport.height);
    assert.notDeepEqual(png, Buffer.from(await latest.arrayBuffer()), 'Styles come from each comment’s source revision');
    const wide = await service.createComment(project.id, {
      requestId: 'region-preview-wide', expectedRevision: current.project.revision, text: 'Wide region',
      anchor: { ...anchor, viewport: { id: 'desktop', width: 1600, height: 900 } },
    });
    const wideResponse = await fetch(`${prefix}/${wide.comment.id}/preview`);
    assert.equal(wideResponse.status, 200);
    const widePng = Buffer.from(await wideResponse.arrayBuffer());
    assert.equal(widePng.readUInt32BE(16), 960);
    assert.equal(widePng.readUInt32BE(20), 540);
    assert.equal(outsideRequests, 0);
    assert.equal((await fetch(`${prefix}/missing/preview`)).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});

test('saved region and pen previews replay window and nested scrolling from the annotated viewport', { timeout: 30_000 }, async t => {
  if (!await browserExecutable().catch(() => null)) {
    t.skip('Chrome or Chromium is unavailable');
    return;
  }
  const { service, cleanup } = await tempService();
  try {
    const viewport = { id: 'mobile' as const, width: 390, height: 280 };
    const project = await service.create({ requestId: 'scrolled-preview-create', scenario: 'mobile-app' });
    const styles = `<style>
      html, body { margin: 0; scroll-behavior: smooth; }
      ::-webkit-scrollbar { display: none; }
      .grid { display: grid; grid-template-columns: repeat(2, 390px); }
      .tile { width: 390px; height: 280px; background: #1a44aa; }
      .content { overflow: auto; scroll-behavior: smooth; }
      .not-selected { background: #c92727; }
      .selected { background: #0a8a67; }
      .toolbar { position: fixed; inset: 0 0 auto; height: 24px; background: #133635; }
    </style>`;
    const tile = '<div class="tile"></div>';
    const selected = '<div class="tile selected"></div>';
    const doc = (body: string) => `<!doctype html>${styles}<div class="toolbar"></div>${body}`;
    const current = await service.write(project.id, {
      requestId: 'scrolled-preview-write', expectedRevision: project.revision,
      files: [
        { path: 'index.html', content: doc(`<div class="grid">${tile}${tile}${tile}<main class="tile content"><div class="tile not-selected"></div>${selected}</main></div>`) },
        { path: 'expected.html', content: doc(selected) },
      ],
    });
    const anchor = { filePath: 'index.html', viewport, region: { x: 15, y: 35, width: 100, height: 40 } };
    const scroll = { x: 390, y: 280, containers: [{ selector: '.content', x: 0, y: 280 }] };
    const atTarget = await service.createComment(project.id, {
      requestId: 'scrolled-preview-target', expectedRevision: current.project.revision, text: 'Scrolled region', anchor: { ...anchor, scroll },
    });
    const atTop = await service.createComment(project.id, {
      requestId: 'scrolled-preview-top', expectedRevision: current.project.revision, text: 'Old region with no scroll data', anchor,
    });
    const reference = await service.createComment(project.id, {
      requestId: 'scrolled-preview-reference', expectedRevision: current.project.revision, text: 'Expected capture', anchor: { ...anchor, filePath: 'expected.html' },
    });
    const pen = await service.createComment(project.id, {
      requestId: 'scrolled-preview-pen', expectedRevision: current.project.revision, text: 'Straight pen stroke',
      anchor: {
        filePath: 'index.html', viewport: { ...viewport, height: 320 }, scroll,
        annotation: {
          version: 1, coordinateSpace: 'normalized', width: viewport.width, height: viewport.height,
          marks: [{ kind: 'pen', points: [{ x: 0.25, y: 0.4 }, { x: 0.75, y: 0.4 }] }],
        },
      },
    });

    assert.deepEqual(atTarget.comment.anchor.scroll, scroll);
    const image = await service.renderCommentPreview(project.id, atTarget.comment.id);
    assert.equal(image.readUInt32BE(16), viewport.width);
    assert.equal(image.readUInt32BE(20), viewport.height);
    assert.deepEqual(image, await service.renderCommentPreview(project.id, reference.comment.id), 'The capture shows the viewport after both scrolls');
    assert.deepEqual(await service.renderCommentPreview(project.id, pen.comment.id), image, 'The pen background uses the actual drawing dimensions and scroll position');
    assert.notDeepEqual(image, await service.renderCommentPreview(project.id, atTop.comment.id), 'Existing comments without scroll data still use the top viewport');
  } finally { await cleanup(); }
});

test('saved static deck previews report the captured slide for isolated and legacy scrolling views', { timeout: 30_000 }, async t => {
  if (!await browserExecutable().catch(() => null)) {
    t.skip('Chrome or Chromium is unavailable');
    return;
  }
  const { dir, service, cleanup } = await tempService();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!await designHttp(req, res, url, dir, 'http://127.0.0.1', async () => ({}))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const project = await service.create({ requestId: 'static-preview-create', scenario: 'deck' });
    const viewport = { id: 'desktop' as const, width: 320, height: 180 };
    const styles = `<style>
      body { margin: 0; }
      ::-webkit-scrollbar { display: none; }
      section.slide { height: 180px; }
      section.cover { background: #2045e3; }
      section.middle { background: #e11342; }
      section.target { background: #14ad65; }
    </style>`;
    const cover = '<section class="slide cover"><div class="slide"></div></section>';
    const middle = '<section class="slide middle"></section>';
    const target = '<section class="slide target"></section>';
    const current = await service.write(project.id, {
      requestId: 'static-preview-write', expectedRevision: project.revision,
      files: [
        { path: 'index.html', content: `<!doctype html>${styles}${cover}${middle}${target}` },
        { path: 'target.html', content: `<!doctype html>${styles}${target}` },
      ],
    });
    const anchor = { filePath: 'index.html', viewport, region: { x: 15, y: 35, width: 100, height: 40 } };
    const input = { expectedRevision: current.project.revision, text: 'Mark on the target slide' };
    await assert.rejects(service.createComment(project.id, {
      ...input, requestId: 'static-preview-without-slide-index', anchor: { ...anchor, isolatedSlide: true },
    }), (error: unknown) => error instanceof DesignError && error.code === 'INVALID_ARGUMENT');
    const isolated = await service.createComment(project.id, {
      ...input, requestId: 'static-preview-isolated', anchor: { ...anchor, slideIndex: 2, isolatedSlide: true },
    });
    const legacy = await service.createComment(project.id, {
      ...input, requestId: 'static-preview-legacy', anchor: { ...anchor, slideIndex: 0, scroll: { x: 0, y: 360 } },
    });
    const reference = await service.createComment(project.id, {
      ...input, requestId: 'static-preview-reference', anchor: { ...anchor, filePath: 'target.html' },
    });
    const prefix = `http://127.0.0.1:${port}/api/design/projects/${project.id}/comments`;
    const [referencePreview, isolatedPreview, legacyPreview] = await Promise.all(
      [reference, isolated, legacy].map(({ comment }) => fetch(`${prefix}/${comment.id}/preview`)),
    );
    assert.equal(referencePreview.status, 200);
    assert.equal(isolatedPreview.status, 200);
    assert.equal(legacyPreview.status, 200);
    assert.equal(referencePreview.headers.get('x-openmotion-slide-index'), null);
    assert.equal(isolatedPreview.headers.get('x-openmotion-slide-index'), '2');
    assert.equal(legacy.comment.anchor.slideIndex, 0);
    assert.equal(legacyPreview.headers.get('x-openmotion-slide-index'), '2');
    const expected = Buffer.from(await referencePreview.arrayBuffer());
    assert.deepEqual(Buffer.from(await isolatedPreview.arrayBuffer()), expected, 'Isolated snapshots show the recorded top-level slide');
    assert.deepEqual(Buffer.from(await legacyPreview.arrayBuffer()), expected, 'Legacy snapshots keep the original document scroll position');
    const legacyMetadata = await fetch(`${prefix}/${legacy.comment.id}/preview?view=viewport`, { method: 'HEAD' });
    assert.equal(legacyMetadata.status, 200);
    assert.equal(legacyMetadata.headers.get('x-openmotion-slide-index'), '2');
    assert.equal(legacyMetadata.headers.get('content-length'), String(expected.length));
    assert.equal((await legacyMetadata.arrayBuffer()).byteLength, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});

test('saved element preview renders the annotated deck page from the original revision', { timeout: 30_000 }, async t => {
  if (!await browserExecutable().catch(() => null)) {
    t.skip('Chrome or Chromium is unavailable');
    return;
  }
  const { service, cleanup } = await tempService();
  try {
    const project = await service.create({ requestId: 'element-preview-create', scenario: 'deck' });
    const styles = `
      html, body, .slide { width: 100%; height: 100%; margin: 0; }
      .slide { display: none; }
      .slide[data-visible] { display: flow-root; }
      .first { background: #1435ba; }
      .fourth { background: #fcdf31; }
      h2 { margin: 72px 33px 0; }
    `;
    const first = '<section class="slide first" data-visible><h2>First slide</h2></section>';
    const targetHtml = '<h2>Galilean moons</h2>';
    const fourth = `<section class="slide fourth">${targetHtml}</section>`;
    const doc = (body: string) => `<!doctype html><link rel="stylesheet" href="colors.css">${body}`;
    const deckHtml = doc(`${first}<section class="slide"></section><section class="slide"></section>${fourth}
      <script>
        window.addEventListener('message', ({ source, data }) => {
          if (source !== window.parent || data?.type !== 'od:slide' || data.action !== 'go') return;
          document.querySelectorAll('.slide').forEach((slide, i) => slide.toggleAttribute('data-visible', i === data.index));
        });
      </script>`);
    const old = await service.write(project.id, {
      requestId: 'element-preview-v2', expectedRevision: project.revision,
      files: [
        { path: 'index.html', content: deckHtml },
        { path: 'fourth.html', content: doc(fourth.replace('class="slide fourth"', 'class="slide fourth" data-visible')) },
        { path: 'colors.css', content: styles },
      ],
    });
    const viewport = { id: 'desktop' as const, width: 574, height: 309 };
    const anchor = {
      filePath: 'index.html', viewport, slideIndex: 3,
      element: { selector: '.fourth h2', tagName: 'h2', label: 'Galilean moons', text: 'Galilean moons', htmlHint: targetHtml, box: { x: 33, y: 72, width: 508, height: 24 } },
    };
    const original = await service.createComment(project.id, {
      requestId: 'element-preview-original', expectedRevision: old.project.revision, text: 'Change the heading font', anchor,
    });
    const reference = await service.createComment(project.id, {
      requestId: 'element-preview-reference', expectedRevision: old.project.revision, text: 'Known fourth slide',
      anchor: { ...anchor, filePath: 'fourth.html', slideIndex: undefined },
    });
    const corporate = await service.write(project.id, {
      requestId: 'element-preview-corporate', expectedRevision: old.project.revision,
      files: [{ path: 'index.html', content: deckHtml.replace(targetHtml, '<h2>Corporate promises</h2>') }],
    });
    const stale = await service.createComment(project.id, {
      requestId: 'element-preview-legacy', expectedRevision: corporate.project.revision, text: 'Captured before the frame reloaded', anchor,
    });
    const restored = await service.restoreVersion(project.id, old.version.id, {
      requestId: 'element-preview-resume', expectedRevision: corporate.project.revision,
    });
    const current = await service.write(project.id, {
      requestId: 'element-preview-recolor', expectedRevision: restored.project.revision,
      files: [{ path: 'colors.css', content: styles.replace('#fcdf31', '#ba1467') }],
    });
    const latest = await service.createComment(project.id, {
      requestId: 'element-preview-latest', expectedRevision: current.project.revision, text: 'Already recolored', anchor,
    });

    const image = await service.renderCommentPreview(project.id, original.comment.id);
    assert.equal((await service.renderCommentPreviewDetails(project.id, original.comment.id)).slideIndex, 3);
    assert.equal(image.readUInt32BE(16), viewport.width);
    assert.equal(image.readUInt32BE(20), viewport.height);
    assert.deepEqual(image, await service.renderCommentPreview(project.id, reference.comment.id), 'The recorded fourth slide is shown');
    assert.notDeepEqual(image, await service.renderCommentPreview(project.id, latest.comment.id), 'A later stylesheet edit cannot alter the original thumbnail');
    assert.deepEqual(image, await service.renderCommentPreview(project.id, stale.comment.id), 'The unique older matching slide repairs a stale frame thumbnail');
    assert.equal((await service.listComments(project.id)).comments.find(item => item.id === stale.comment.id)?.sourceRevision, corporate.project.revision);

    const corporateAgain = await service.restoreVersion(project.id, corporate.version.id, {
      requestId: 'element-preview-corporate-again', expectedRevision: current.project.revision,
    });
    const ambiguous = await service.createComment(project.id, {
      requestId: 'element-preview-ambiguous', expectedRevision: corporateAgain.project.revision, text: 'Could match either previous copy', anchor,
    });
    await assert.rejects(
      () => service.renderCommentPreview(project.id, ambiguous.comment.id),
      (error: unknown) => error instanceof DesignError && error.code === 'NOT_FOUND',
    );
  } finally { await cleanup(); }
});

test('export zip, open-design round-trip zip, standalone html, and import round-trip', async () => {
  const { dir, service, cleanup } = await tempService();
  try {
    const deck = await service.create({ requestId: 'exp-1', scenario: 'deck', title: 'Q4 Review', designSystemId: 'github' });
    // Add an extra CSS file and reference it from index.html so standalone HTML inlines it.
    const w = await service.write(deck.id, {
      requestId: 'exp-w', expectedRevision: deck.revision,
      files: [
        { path: 'extra.css', content: '.accent { color: #ff5500; }' },
        { path: 'index.html', content: (await service.readFile(deck.id, 'index.html')).content.replace('</head>', '<link rel="stylesheet" href="./extra.css" /></head>') },
      ],
    });

    // Standalone HTML inlines extra.css.
    const htmlExport = await service.exportProject(deck.id, { format: 'html' });
    const htmlStr = htmlExport.data.toString('utf8');
    assert(htmlStr.includes('.accent { color: #ff5500; }'), 'standalone html should inline local stylesheet');

    // Open Design ZIP includes manifest, handoff and .open-design/project.json.
    const odExport = await service.exportProject(deck.id, { format: 'open-design' });
    const entries = readProjectZip(odExport.data);
    assert(entries.has('DESIGN-MANIFEST.json'));
    assert(entries.has('DESIGN-HANDOFF.md'));
    assert(entries.has('.open-design/project.json'));
    const manifest = JSON.parse(entries.get('DESIGN-MANIFEST.json')!.toString('utf8'));
    assert.equal(manifest.schema, 'open-design.design-manifest.v1');
    assert.equal(manifest.title, 'Q4 Review');

    // Round-trip import from the exported Open Design ZIP preserves title, scenario and designSystemId.
    const zipFile = path.join(dir, 'roundtrip.zip');
    await writeFile(zipFile, odExport.data);
    const imported = await service.importPath(zipFile);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].title, 'Q4 Review');
    assert.equal(imported[0].scenario, 'deck');
    assert.equal(imported[0].designSystemId, 'github');
    assert.notEqual(imported[0].id, w.project.id);

    // Optional visual export check when Chrome is present on this machine.
    const chrome = await browserExecutable().catch(() => undefined);
    if (chrome) {
      const pdf = await service.exportProject(deck.id, { format: 'pdf' });
      assert(pdf.data.subarray(0, 4).toString('utf8') === '%PDF');
      const pptx = await service.exportProject(deck.id, { format: 'pptx' });
      assert(pptx.data.subarray(0, 2).toString('utf8') === 'PK', 'pptx should be a valid zip container');
    }
  } finally { await cleanup(); }
});

test('version restore restores project entry invariant and write rejects deleting sole entry', async () => {
  const { service, cleanup } = await tempService();
  try {
    const created = await service.create({ requestId: 'req-entry-1', scenario: 'prototype', title: 'Entry Invariant' });
    const v1 = created.versionId!;
    assert.equal(created.entry, 'index.html');

    // Reject deleting the sole HTML entry without leaving another HTML file.
    await assert.rejects(
      () => service.write(created.id, { requestId: 'req-del-sole', expectedRevision: created.revision, deletes: ['index.html'] }),
      (error: unknown) => error instanceof DesignError && error.code === 'INVALID_ARGUMENT',
    );
    const stillIntact = await service.get(created.id);
    assert(stillIntact.files.some(f => f.path === 'index.html'));

    // Reject overlapping path in both files and deletes before mutating disk.
    await assert.rejects(
      () => service.write(created.id, {
        requestId: 'req-overlap-entry',
        expectedRevision: created.revision,
        files: [{ path: 'index.html', content: '<!doctype html><html><body><h1>Replaced</h1></body></html>' }],
        deletes: ['index.html'],
      }),
      (error: unknown) => error instanceof DesignError && error.code === 'INVALID_ARGUMENT',
    );
    const afterOverlap = await service.get(created.id);
    assert.equal(afterOverlap.revision, created.revision);
    assert(afterOverlap.files.some(f => f.path === 'index.html'));

    // Replace-style write: add page2.html, delete index.html, and switch entry to page2.html (v2).
    const w2 = await service.write(created.id, {
      requestId: 'req-entry-2',
      expectedRevision: created.revision,
      files: [{ path: 'page2.html', content: '<!doctype html><html><body><h1>Page Two</h1></body></html>' }],
      deletes: ['index.html'],
      entry: 'page2.html',
      summary: 'Replace index.html with page2.html',
    });
    assert.equal(w2.project.entry, 'page2.html');
    assert(!w2.project.files.some(f => f.path === 'index.html'));

    // Exporting historical v1 still succeeds even while current entry is page2.html.
    const v1Html = await service.exportProject(created.id, { format: 'html', versionId: v1 });
    assert(/<!doctype html>/i.test(v1Html.data.toString('utf8')));

    // Restoring v1 removes page2.html and restores stored.entry back to index.html.
    const restored = await service.restoreVersion(created.id, v1, { requestId: 'req-entry-restore', expectedRevision: w2.project.revision });
    assert.equal(restored.project.entry, 'index.html');
    assert.equal(restored.project.versionId, v1);
    assert(restored.project.previewUrl.endsWith('/index.html'));
    const restoredHtml = await service.exportProject(created.id, { format: 'html' });
    assert(/<!doctype html>/i.test(restoredHtml.data.toString('utf8')));

    // File bytes can match even if the current and target entry files differ.
    const alternatePage = { path: 'page2.html', content: '<!doctype html><html><body><h1>Page Two</h1></body></html>' };
    const withAlternate = await service.write(created.id, {
      requestId: 'req-add-alternate', expectedRevision: restored.project.revision, files: [alternatePage],
    });
    const switchedEntry = await service.write(created.id, {
      requestId: 'req-switch-entry', expectedRevision: withAlternate.project.revision, files: [alternatePage], entry: alternatePage.path,
    });
    assert.equal(switchedEntry.project.revision, withAlternate.project.revision);
    const restoredEntry = await service.restoreVersion(created.id, withAlternate.version.id, {
      requestId: 'req-restore-entry-only', expectedRevision: switchedEntry.project.revision,
    });
    assert.equal(restoredEntry.changed, true);
    assert.equal(restoredEntry.project.entry, 'index.html');
    assert.deepEqual(restoredEntry.version, withAlternate.version);
    assert.equal(restoredEntry.project.versionId, withAlternate.version.id);
    assert.deepEqual((await service.listVersions(created.id)).versions.map(version => version.label), ['v4', 'v3', 'v2', 'v1']);
  } finally { await cleanup(); }
});

test('raw HTML previews are served with CSP sandbox header while sub-resources remain un-sandboxed', async () => {
  const { dir, service, cleanup } = await tempService();
  const created = await service.create({ requestId: 'req-csp-1', scenario: 'prototype', title: 'CSP Isolation' });
  await service.write(created.id, {
    requestId: 'req-csp-2',
    expectedRevision: created.revision,
    files: [{ path: 'styles.css', content: 'body { color: #111; }' }],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handled = await designHttp(req, res, url, dir, 'http://127.0.0.1', async () => ({}));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const htmlRes = await fetch(`http://127.0.0.1:${port}/api/design/raw/${created.id}/index.html`);
    assert.equal(htmlRes.status, 200);
    const csp = htmlRes.headers.get('content-security-policy') ?? '';
    assert(csp.includes('sandbox'), `Expected CSP sandbox on raw HTML, got: ${csp}`);
    assert(!csp.includes('allow-same-origin'), 'Raw HTML must not grant allow-same-origin');

    const cssRes = await fetch(`http://127.0.0.1:${port}/api/design/raw/${created.id}/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get('content-security-policy'), null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});

test('catalog template thumb preview injects WebGL disposal and setInterval throttling guards', async () => {
  const { dir, cleanup } = await tempService();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handled = await designHttp(req, res, url, dir, 'http://127.0.0.1', async () => ({}));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/api/design/catalog/templates?limit=1`);
    assert.equal(listRes.status, 200);
    const { items } = await listRes.json() as { items: Array<{ id: string; entry: string }> };
    assert(items.length > 0, 'Expected at least one built-in design template');
    const tpl = items[0];
    const thumbRes = await fetch(`http://127.0.0.1:${port}/api/design/catalog/templates/${encodeURIComponent(tpl.id)}/preview/${tpl.entry}?thumb=1`);
    assert.equal(thumbRes.status, 200);
    const html = await thumbRes.text();
    assert(html.includes('om:thumb-dispose'), 'Expected om:thumb-dispose handler in thumb perf guard');
    assert(html.includes('WEBGL_lose_context'), 'Expected WEBGL_lose_context cleanup in thumb perf guard');
    assert(html.includes('window.setInterval='), 'Expected setInterval throttling wrapper in thumb perf guard');
    assert.equal(thumbRes.headers.get('access-control-allow-origin'), '*');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});

test('sandboxed design raw and template preview routes expose CORS headers for sibling data fetches', async () => {
  const { dir, service, cleanup } = await tempService();
  const created = await service.create({ requestId: 'req-cors-1', scenario: 'live-artifact', title: 'Live Metrics' });
  await service.write(created.id, {
    requestId: 'req-cors-2',
    expectedRevision: created.revision,
    files: [{ path: 'data.json', content: JSON.stringify({ revenue: '$4.82M' }) }],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handled = await designHttp(req, res, url, dir, 'http://127.0.0.1', async () => ({}));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const preflightRes = await fetch(`http://127.0.0.1:${port}/api/design/raw/${created.id}/data.json`, { method: 'OPTIONS' });
    assert.equal(preflightRes.status, 204);
    assert.equal(preflightRes.headers.get('access-control-allow-origin'), '*');
    assert.match(preflightRes.headers.get('access-control-allow-methods') ?? '', /GET/);

    const dataRes = await fetch(`http://127.0.0.1:${port}/api/design/raw/${created.id}/data.json`);
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await dataRes.json(), { revenue: '$4.82M' });

    const htmlRes = await fetch(`http://127.0.0.1:${port}/api/design/raw/${created.id}/index.html`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('access-control-allow-origin'), '*');
    assert.match(htmlRes.headers.get('content-security-policy') ?? '', /^sandbox /);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/design/catalog/templates?limit=1`);
    const { items } = await listRes.json() as { items: Array<{ id: string; entry: string }> };
    const tpl = items[0];
    const tplPreflight = await fetch(`http://127.0.0.1:${port}/api/design/catalog/templates/${encodeURIComponent(tpl.id)}/preview/${tpl.entry}`, { method: 'OPTIONS' });
    assert.equal(tplPreflight.status, 204);
    assert.equal(tplPreflight.headers.get('access-control-allow-origin'), '*');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});
