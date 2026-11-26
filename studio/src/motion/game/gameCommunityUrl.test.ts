import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GAME_COMMUNITY_URL,
  buildGameCommunityFeedUrl,
  isLocalStudioRuntime,
  isLoopbackHostname,
  resetGameCommunityUrlCache,
  resolveGameCommunityUrl,
} from './gameCommunityUrl';

describe('gameCommunityUrl', () => {
  beforeEach(() => {
    resetGameCommunityUrlCache();
    vi.restoreAllMocks();
  });

  it('builds /games URL from production, dashboard, local QA, and remote boundaries', () => {
    expect(buildGameCommunityFeedUrl(undefined)).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('')).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('javascript:alert(1)')).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/dashboard')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/games/')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('http://127.0.0.1:5179')).toBe('http://127.0.0.1:5179/games');

    // Remote environments must never resolve to localhost/127.0.0.1
    expect(
      buildGameCommunityFeedUrl('http://127.0.0.1:5179', {
        allowLoopback: false,
        pageOrigin: 'https://staging.open-design.ai',
      }),
    ).toBe('https://staging.open-design.ai/cloud/games');
    expect(
      buildGameCommunityFeedUrl('http://localhost:5179', {
        allowLoopback: false,
        pageOrigin: 'https://example.com',
      }),
    ).toBe(DEFAULT_GAME_COMMUNITY_URL);

    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('open-design.ai')).toBe(false);
    expect(isLocalStudioRuntime('http://127.0.0.1:4179')).toBe(true);
    expect(isLocalStudioRuntime('https://open-design.ai')).toBe(false);
  });

  it('deduplicates and caches local consoleUrl lookups and probes local AMR when running locally', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/settings/account')) {
        return new Response(JSON.stringify({ state: 'signed-in', consoleUrl: 'http://127.0.0.1:5179' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ url: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4180' }),
      resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4180' }),
    ]);
    expect(a).toBe('http://127.0.0.1:5179/games');
    expect(b).toBe('http://127.0.0.1:5179/games');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4180' });
    expect(cached).toBe('http://127.0.0.1:5179/games');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Local Studio with prod account consoleUrl uses server-detected local AMR when running
    resetGameCommunityUrlCache();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/settings/account')) {
        return new Response(JSON.stringify({ state: 'signed-in', consoleUrl: 'https://open-design.ai/cloud' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/motion-api/game-community/config')) {
        return new Response(JSON.stringify({ url: 'http://127.0.0.1:5179/games', environment: 'local' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    }));
    expect(await resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4179' })).toBe('http://127.0.0.1:5179/games');

    // Local Studio without local AMR falls back to remote production Cloud
    resetGameCommunityUrlCache();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/settings/account')) {
        return new Response(JSON.stringify({ state: 'signed-in', consoleUrl: 'https://open-design.ai/cloud' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ url: null, environment: 'local' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    expect(await resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4179' })).toBe(DEFAULT_GAME_COMMUNITY_URL);

    // Remote Studio never probes local AMR and rejects loopback consoleUrl
    resetGameCommunityUrlCache();
    const remoteFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/settings/account')) {
        return new Response(JSON.stringify({ state: 'signed-in', consoleUrl: 'http://127.0.0.1:5179' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in remote mode: ${url}`);
    });
    vi.stubGlobal('fetch', remoteFetch);
    expect(await resolveGameCommunityUrl(false, { pageOrigin: 'https://staging.open-design.ai' })).toBe(
      'https://staging.open-design.ai/cloud/games',
    );
    expect(remoteFetch).toHaveBeenCalledTimes(1);

    // Offline fallback
    resetGameCommunityUrlCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await resolveGameCommunityUrl(false, { pageOrigin: 'http://127.0.0.1:4179' })).toBe(DEFAULT_GAME_COMMUNITY_URL);
  });
});
