// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { WebPublishPopover } from './WebPublishPopover';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flushUi(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

it('signs in with OpenDesign in-place and automatically deploys and copies the live share link', async () => {
  let signedIn = false;
  let published = false;
  const shareUrl = 'https://open-design.app/artifact/11111111-1111-5111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fetchCalls: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push(`${method} ${url}`);
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: signedIn ? 'signed-in' : 'signed-out',
        ...(signedIn ? { user: { id: 'u1', email: 'maker@example.com' } } : {}),
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.endsWith('/motion-api/settings/account/login') && method === 'POST') {
      signedIn = true;
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u1', email: 'maker@example.com' },
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.endsWith('/motion-api/web-publish/game/g1') && method === 'GET') {
      return jsonResponse({
        targetKind: 'game',
        targetId: 'g1',
        projectId: 'g1',
        title: 'Star Drift',
        accountSignedIn: signedIn,
        accountState: signedIn ? 'signed-in' : 'signed-out',
        freshness: published ? 'fresh' : 'unknown',
        fileCount: 3,
        totalBytes: 2048,
        bundledAssetCount: 1,
        entryPath: 'index.html',
        publications: [],
        deployments: [],
        active: published
          ? {
              schemaVersion: 1,
              targetKind: 'game',
              targetId: 'g1',
              cloudProjectId: '11111111-1111-5111-8111-111111111111',
              projectId: 'g1',
              filePath: 'index.html',
              entryPath: 'index.html',
              name: 'Star Drift',
              workspaceId: 'ws_1',
              workspaceName: 'Maker Personal',
              ownerMemberId: 'm_1',
              resourceId: 'res_1',
              sourceFileId: 'sf_1',
              sourceKey: 'sk_1',
              slug: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              version: 1,
              versionId: 'v1',
              status: 'published',
              url: shareUrl,
              publishedAt: 1700000000000,
              updatedAt: 1700000000000,
              fileCount: 3,
              totalBytes: 2048,
              bundledAssetCount: 1,
              contentFingerprint: 'fp-1',
              sourceRevision: '1',
            }
          : null,
      });
    }
    if (url.endsWith('/motion-api/web-publish/game/g1') && method === 'POST') {
      published = true;
      const pub = {
        schemaVersion: 1,
        targetKind: 'game',
        targetId: 'g1',
        cloudProjectId: '11111111-1111-5111-8111-111111111111',
        projectId: 'g1',
        filePath: 'index.html',
        entryPath: 'index.html',
        name: 'Star Drift',
        workspaceId: 'ws_1',
        workspaceName: 'Maker Personal',
        ownerMemberId: 'm_1',
        resourceId: 'res_1',
        sourceFileId: 'sf_1',
        sourceKey: 'sk_1',
        slug: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        version: 1,
        versionId: 'v1',
        status: 'published',
        url: shareUrl,
        publishedAt: 1700000000000,
        updatedAt: 1700000000000,
        fileCount: 3,
        totalBytes: 2048,
        bundledAssetCount: 1,
        contentFingerprint: 'fp-1',
        sourceRevision: '1',
      };
      return jsonResponse({ publication: pub, deployment: pub, url: shareUrl, updated: false });
    }
    if (url.includes('/motion-api/providers')) {
      return jsonResponse({ providers: [] });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });

  const notifications: string[] = [];
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover
          targetKind="game"
          targetId="g1"
          title="Star Drift"
          onNotify={msg => notifications.push(msg)}
        />
      </I18nProvider>,
    );
  });
  await flushUi();

  const trigger = container!.querySelector('button.om-web-publish-trigger') as HTMLButtonElement;
  expect(trigger).toBeTruthy();

  await act(async () => {
    trigger.click();
  });
  await flushUi();

  const popover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  expect(popover).toBeTruthy();
  expect(popover.textContent).toContain('Share');
  const signInBtn = Array.from(popover.querySelectorAll('button')).find(b =>
    b.textContent?.includes('Sign in with OpenDesign'),
  ) as HTMLButtonElement;
  expect(signInBtn).toBeTruthy();

  await act(async () => {
    signInBtn.click();
  });
  await flushUi();

  expect(fetchCalls).toContain('POST /motion-api/settings/account/login');
  expect(fetchCalls).toContain('POST /motion-api/web-publish/game/g1');
  expect(writeText).toHaveBeenCalledWith(shareUrl);
  expect(popover.textContent).toContain(shareUrl);
  expect(popover.textContent).toContain('Share link copied');
  expect(notifications).toContain('Deployed and copied share link');
});

it('renders Link access switch, Update live link when outdated, new_link rotation when stopped, and compact trigger', async () => {
  const shareUrl = 'https://open-design.app/artifact/des_2/22222222-2222-4222-8222-222222222222';
  const rotatedUrl = 'https://open-design.app/artifact/des_2/33333333-3333-4333-8333-333333333333';
  let linkStatus: 'published' | 'stopped' = 'published';
  let currentUrl = shareUrl;
  const deployModes: string[] = [];

  const makeRecord = (status: 'published' | 'stopped', url: string, fp = 'fp-old') => ({
    schemaVersion: 1 as const,
    targetKind: 'design' as const,
    targetId: 'des_2',
    cloudProjectId: 'des_2',
    projectId: 'des_2',
    filePath: 'index.html',
    entryPath: 'index.html',
    name: 'Drift Two',
    workspaceId: 'ws_2',
    workspaceName: 'Pro Space',
    ownerMemberId: 'm_2',
    resourceId: 'res_2',
    sourceFileId: 'sf_2',
    sourceKey: 'sk_2',
    slug: url.split('/').pop()!,
    version: 2,
    versionId: 'v2',
    status,
    url,
    publishedAt: 1700000001000,
    updatedAt: 1700000001000,
    fileCount: 4,
    totalBytes: 4096,
    bundledAssetCount: 2,
    contentFingerprint: fp,
    sourceRevision: 'rev-2',
  });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u2', email: 'pro@example.com' },
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.includes('/motion-api/web-publish/design/des_2') && method === 'GET') {
      const pub = makeRecord(linkStatus, currentUrl);
      return jsonResponse({
        targetKind: 'design',
        targetId: 'des_2',
        projectId: 'des_2',
        title: 'Drift Two',
        accountSignedIn: true,
        accountState: 'signed-in',
        accountEmail: 'pro@example.com',
        freshness: 'outdated',
        fileCount: 4,
        totalBytes: 4096,
        bundledAssetCount: 2,
        entryPath: 'index.html',
        publications: [pub],
        deployments: [pub],
        active: pub,
      });
    }
    if (url.endsWith('/motion-api/web-publish/design/des_2') && method === 'DELETE') {
      linkStatus = 'stopped';
      const pub = makeRecord('stopped', currentUrl);
      return jsonResponse({ publication: pub, deployment: pub });
    }
    if (url.endsWith('/motion-api/web-publish/design/des_2') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { deployMode?: string };
      if (body.deployMode) deployModes.push(body.deployMode);
      linkStatus = 'published';
      if (body.deployMode === 'new_link') currentUrl = rotatedUrl;
      const pub = makeRecord('published', currentUrl, 'fp-new');
      return jsonResponse({ publication: pub, deployment: pub, url: currentUrl, updated: true });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }));

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover compact targetKind="design" targetId="des_2" title="Drift Two" />
      </I18nProvider>,
    );
  });
  await flushUi();

  const trigger = container!.querySelector('button.om-web-publish-trigger--compact') as HTMLButtonElement;
  expect(trigger).toBeTruthy();

  await act(async () => {
    trigger.click();
  });
  await flushUi();

  const popover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  expect(popover).toBeTruthy();
  const toggle = popover.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(popover.textContent).toContain('Changes pending');
  expect(popover.textContent).toContain(shareUrl);
  expect(popover.textContent).toContain('Update live link');
  expect(popover.textContent).toContain('4 files · +2');

  // Turn Link access OFF -> stop share link (DELETE).
  await act(async () => {
    toggle.click();
  });
  await flushUi();

  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(popover.textContent).toContain('The link is disabled');
  const newLinkBtn = Array.from(popover.querySelectorAll('button')).find(b =>
    b.textContent?.includes('Publish new link'),
  ) as HTMLButtonElement;
  expect(newLinkBtn).toBeTruthy();

  // Rotate to a brand new link via deployMode="new_link".
  await act(async () => {
    newLinkBtn.click();
  });
  await flushUi();

  expect(deployModes).toContain('new_link');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(popover.textContent).toContain(rotatedUrl);
  expect(popover.textContent).toContain('Up to date');
});

it('shows Public/Unlisted visibility control for games, locks Unlisted behind Go+ for free users, and lets Go users toggle live', async () => {
  const freeUrl = 'https://open-design.app/artifact/cloud-free/44444444-4444-4444-8444-444444444444';
  const freeCommunityUrl = 'https://open-design.app/games/44444444-4444-4444-8444-444444444444';
  const patchCalls: Array<{ visibility: string }> = [];

  // 1. Free user on a published public game (pending offline review)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u_free', email: 'free@example.com' },
        plan: { id: 'free', name: 'Free', status: 'active' },
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.includes('/motion-api/web-publish/game/g_free') && method === 'GET') {
      const pub = {
        schemaVersion: 1,
        targetKind: 'game',
        targetId: 'g_free',
        cloudProjectId: 'cloud-free',
        projectId: 'g_free',
        filePath: 'index.html',
        entryPath: 'index.html',
        name: 'Free Arcade',
        workspaceId: 'ws_free',
        workspaceName: 'Free Space',
        ownerMemberId: 'm_free',
        resourceId: 'res_free',
        sourceFileId: 'sf_free',
        sourceKey: 'sk_free',
        slug: '44444444-4444-4444-8444-444444444444',
        version: 1,
        versionId: 'v1',
        status: 'published',
        url: freeUrl,
        communityUrl: freeCommunityUrl,
        visibility: 'public',
        feedStatus: 'pending',
        publishedAt: 1700000000000,
        updatedAt: 1700000000000,
        fileCount: 2,
        totalBytes: 1024,
        bundledAssetCount: 1,
        contentFingerprint: 'fp-free',
        sourceRevision: '1',
      };
      return jsonResponse({
        targetKind: 'game',
        targetId: 'g_free',
        projectId: 'g_free',
        title: 'Free Arcade',
        accountSignedIn: true,
        accountState: 'signed-in',
        accountPlan: 'free',
        canUsePrivateShare: false,
        freshness: 'fresh',
        fileCount: 2,
        totalBytes: 1024,
        bundledAssetCount: 1,
        entryPath: 'index.html',
        publications: [pub],
        deployments: [pub],
        active: pub,
      });
    }
    if (method === 'PATCH') {
      patchCalls.push(JSON.parse(String(init?.body ?? '{}')) as { visibility: string });
      return jsonResponse({ error: 'should not be called for free user' }, 403);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }));

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover targetKind="game" targetId="g_free" title="Free Arcade" />
      </I18nProvider>,
    );
  });
  await flushUi();

  const trigger = container!.querySelector('button.om-web-publish-trigger') as HTMLButtonElement;
  await act(async () => {
    trigger.click();
  });
  await flushUi();

  const popover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  expect(popover.textContent).toContain('Visibility');
  expect(popover.textContent).toContain('Public');
  expect(popover.textContent).toContain('Unlisted');
  expect(popover.textContent).toContain('Go+');
  expect(popover.textContent).toContain('In review');

  const radios = Array.from(popover.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
  expect(radios).toHaveLength(2);
  expect(radios[0].getAttribute('aria-checked')).toBe('true');
  expect(radios[1].getAttribute('aria-checked')).toBe('false');

  // Clicking Unlisted as a Free user surfaces inline Go+ upgrade guidance without firing PATCH.
  await act(async () => {
    radios[1].click();
  });
  await flushUi();

  expect(patchCalls).toHaveLength(0);
  expect(popover.textContent).toContain('Upgrade to Go+');

  // 2. Paid Go user can publish Unlisted and switch live to Public via PATCH keeping the same slug.
  let paidVisibility: 'public' | 'unlisted' = 'unlisted';
  const paidSlug = '55555555-5555-4555-8555-555555555555';
  const paidUrl = `https://open-design.app/artifact/cloud-go/${paidSlug}`;
  const paidCommunityUrl = `https://open-design.app/games/${paidSlug}`;
  const paidRequests: Array<{ method: string; body?: unknown }> = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u_go', email: 'go@example.com' },
        plan: { id: 'go', name: 'Go', status: 'active' },
        consoleUrl: 'https://open-design.app',
      });
    }
    const makePaidPub = () => ({
      schemaVersion: 1,
      targetKind: 'game',
      targetId: 'g_go',
      cloudProjectId: 'cloud-go',
      projectId: 'g_go',
      filePath: 'index.html',
      entryPath: 'index.html',
      name: 'Go Sandbox',
      workspaceId: 'ws_go',
      workspaceName: 'Go Space',
      ownerMemberId: 'm_go',
      resourceId: 'res_go',
      sourceFileId: 'sf_go',
      sourceKey: 'sk_go',
      slug: paidSlug,
      version: 1,
      versionId: 'v1',
      status: 'published',
      url: paidUrl,
      communityUrl: paidCommunityUrl,
      visibility: paidVisibility,
      feedStatus: 'pending',
      publishedAt: 1700000000000,
      updatedAt: 1700000000000,
      fileCount: 2,
      totalBytes: 1024,
      bundledAssetCount: 1,
      contentFingerprint: 'fp-go',
      sourceRevision: '1',
    });
    if (url.includes('/motion-api/web-publish/game/g_go') && method === 'GET') {
      const pub = makePaidPub();
      return jsonResponse({
        targetKind: 'game',
        targetId: 'g_go',
        projectId: 'g_go',
        title: 'Go Sandbox',
        accountSignedIn: true,
        accountState: 'signed-in',
        accountPlan: 'go',
        canUsePrivateShare: true,
        freshness: 'fresh',
        fileCount: 2,
        totalBytes: 1024,
        bundledAssetCount: 1,
        entryPath: 'index.html',
        publications: [pub],
        deployments: [pub],
        active: pub,
      });
    }
    if (url.endsWith('/motion-api/web-publish/game/g_go') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { visibility: 'public' | 'unlisted' };
      paidRequests.push({ method, body });
      paidVisibility = body.visibility;
      const pub = makePaidPub();
      return jsonResponse({ publication: pub, deployment: pub, visibility: paidVisibility, feedStatus: 'pending' });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }));

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover targetKind="game" targetId="g_go" title="Go Sandbox" />
      </I18nProvider>,
    );
  });
  await flushUi();

  const paidTrigger = container!.querySelector('button.om-web-publish-trigger') as HTMLButtonElement;
  await act(async () => {
    paidTrigger.click();
  });
  await flushUi();

  const paidPopover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  const paidRadios = Array.from(paidPopover.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
  expect(paidRadios).toHaveLength(2);
  expect(paidRadios[1].getAttribute('aria-checked')).toBe('true');
  expect(paidPopover.textContent).toContain('Link only');

  await act(async () => {
    paidRadios[0].click();
  });
  await flushUi();

  expect(paidRequests).toEqual([{ method: 'PATCH', body: { visibility: 'public' } }]);
  expect(paidRadios[0].getAttribute('aria-checked')).toBe('true');
  expect(paidPopover.textContent).toContain('In review');
});

it('unlocks Unlisted for Pro users even if status omits accountPlan and defaults canUsePrivateShare to false', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u_pro', email: 'pro@example.com' },
        plan: 'pro',
        billingUnavailable: false,
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.includes('/motion-api/web-publish/game/g_pro_fallback') && method === 'GET') {
      return jsonResponse({
        targetKind: 'game',
        targetId: 'g_pro_fallback',
        projectId: 'g_pro_fallback',
        title: 'Pro Community Game',
        accountSignedIn: true,
        accountState: 'signed-in',
        canUsePrivateShare: false,
        freshness: 'unknown',
        fileCount: 2,
        totalBytes: 1024,
        bundledAssetCount: 1,
        entryPath: 'index.html',
        publications: [],
        deployments: [],
        active: null,
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }));

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover targetKind="game" targetId="g_pro_fallback" title="Pro Community Game" />
      </I18nProvider>,
    );
  });
  await flushUi();

  const trigger = container!.querySelector('button.om-web-publish-trigger') as HTMLButtonElement;
  await act(async () => {
    trigger.click();
  });
  await flushUi();

  const popover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  const radios = Array.from(popover.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
  expect(radios).toHaveLength(2);
  expect(radios[0].getAttribute('aria-checked')).toBe('true');

  await act(async () => {
    radios[1].click();
  });
  await flushUi();

  expect(radios[1].getAttribute('aria-checked')).toBe('true');
  expect(popover.querySelector('[data-private-upgrade-hint]')).toBeNull();
});

it('lets paid users change draft visibility on a stopped game share and sends it when reopening', async () => {
  const stoppedSlug = '66666666-6666-4666-8666-666666666666';
  const stoppedUrl = `https://open-design.app/artifact/cloud-go/${stoppedSlug}`;
  const communityUrl = `https://open-design.app/games/${stoppedSlug}`;
  const postBodies: Array<Record<string, unknown>> = [];
  let statusValue: 'stopped' | 'published' = 'stopped';
  let currentVisibility: 'public' | 'unlisted' = 'public';

  const makePub = () => ({
    schemaVersion: 1,
    targetKind: 'game',
    targetId: 'g_stopped',
    cloudProjectId: 'cloud-go',
    projectId: 'g_stopped',
    filePath: 'index.html',
    entryPath: 'index.html',
    name: 'Stopped Arcade',
    workspaceId: 'ws_go',
    workspaceName: 'Go Space',
    ownerMemberId: 'm_go',
    resourceId: 'res_go',
    sourceFileId: 'sf_go',
    sourceKey: 'sk_go',
    slug: stoppedSlug,
    version: 1,
    versionId: 'v1',
    status: statusValue,
    url: stoppedUrl,
    communityUrl,
    visibility: currentVisibility,
    feedStatus: 'pending',
    publishedAt: 1700000000000,
    updatedAt: 1700000000000,
    fileCount: 2,
    totalBytes: 1024,
    bundledAssetCount: 1,
    contentFingerprint: 'fp-stopped',
    sourceRevision: '1',
  });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/motion-api/settings/account')) {
      return jsonResponse({
        state: 'signed-in',
        user: { id: 'u_go', email: 'go@example.com' },
        plan: { id: 'go', name: 'Go', status: 'active' },
        consoleUrl: 'https://open-design.app',
      });
    }
    if (url.includes('/motion-api/web-publish/game/g_stopped') && method === 'GET') {
      const pub = makePub();
      return jsonResponse({
        targetKind: 'game',
        targetId: 'g_stopped',
        projectId: 'g_stopped',
        title: 'Stopped Arcade',
        accountSignedIn: true,
        accountState: 'signed-in',
        accountPlan: 'go',
        canUsePrivateShare: true,
        freshness: 'fresh',
        fileCount: 2,
        totalBytes: 1024,
        bundledAssetCount: 1,
        entryPath: 'index.html',
        publications: [pub],
        deployments: [pub],
        active: pub,
      });
    }
    if (url.endsWith('/motion-api/web-publish/game/g_stopped') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      postBodies.push(body);
      statusValue = 'published';
      if (body.visibility === 'unlisted' || body.visibility === 'public') {
        currentVisibility = body.visibility;
      }
      const pub = makePub();
      return jsonResponse({ publication: pub, deployment: pub, url: communityUrl, updated: false });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }));

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <WebPublishPopover targetKind="game" targetId="g_stopped" title="Stopped Arcade" />
      </I18nProvider>,
    );
  });
  await flushUi();

  const trigger = container!.querySelector('button.om-web-publish-trigger') as HTMLButtonElement;
  await act(async () => {
    trigger.click();
  });
  await flushUi();

  const popover = document.body.querySelector('.om-web-publish-popover') as HTMLElement;
  const radios = Array.from(popover.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
  expect(radios).toHaveLength(2);
  expect(radios[0].getAttribute('aria-checked')).toBe('true');
  expect(radios[1].getAttribute('aria-checked')).toBe('false');

  // Switch stopped share draft to Unlisted: radio updates immediately without PATCH.
  await act(async () => {
    radios[1].click();
  });
  await flushUi();

  expect(radios[0].getAttribute('aria-checked')).toBe('false');
  expect(radios[1].getAttribute('aria-checked')).toBe('true');

  // Clicking "Reopen share link" sends the updated visibility in POST body.
  const reopenBtn = Array.from(popover.querySelectorAll('button')).find(b =>
    b.textContent?.includes('Reopen share link'),
  ) as HTMLButtonElement;
  expect(reopenBtn).toBeTruthy();

  await act(async () => {
    reopenBtn.click();
  });
  await flushUi();

  expect(postBodies).toHaveLength(1);
  expect(postBodies[0]).toMatchObject({ deployMode: 'resume', visibility: 'unlisted' });
});
