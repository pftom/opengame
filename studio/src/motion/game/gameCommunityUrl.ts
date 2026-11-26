import { useEffect, useState } from 'react';
import type { AccountSummary } from '../../../../shared/provider-directory';
import { getDesktopBridge, openExternalUrl } from '../../utils/platformHost';
import { gatewayRequest } from '../gatewayClient';

export const DEFAULT_GAME_COMMUNITY_BASE = 'https://open-design.ai/cloud';
export const DEFAULT_GAME_COMMUNITY_URL = `${DEFAULT_GAME_COMMUNITY_BASE}/games`;
export const GAME_COMMUNITY_TAB_ID = 'web:game-community';

const CACHE_TTL_MS = 5 * 60 * 1000;
const WARM_THROTTLE_MS = 60 * 1000;
let lastWarmAt = 0;

let preloadedBrowserChunks = false;

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized.endsWith('.localhost');
}

export function isLoopbackUrl(value?: string | null): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  try {
    return isLoopbackHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function isOpenDesignRemoteOrigin(origin?: string | null): boolean {
  const raw = origin?.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'open-design.ai' || host.endsWith('.open-design.ai') || host === 'open-design.app' || host.endsWith('.open-design.app');
  } catch {
    return false;
  }
}

function currentPageOrigin(): string | null {
  if (typeof window === 'undefined' || !window.location?.origin || window.location.origin === 'null') {
    return null;
  }
  return window.location.origin;
}

export function isLocalStudioRuntime(pageOrigin: string | null = currentPageOrigin()): boolean {
  if (!pageOrigin) return true;
  try {
    return isLoopbackHostname(new URL(pageOrigin).hostname);
  } catch {
    return false;
  }
}

function fallbackRemoteCommunityUrl(pageOrigin?: string | null): string {
  if (isOpenDesignRemoteOrigin(pageOrigin)) {
    const origin = new URL(pageOrigin!).origin;
    return `${origin}/cloud/games`;
  }
  return DEFAULT_GAME_COMMUNITY_URL;
}

/**
 * Opens the community game feed in a real external browser window:
 * - Electron Desktop: launches the user's OS default browser via the desktop bridge
 * - Web Browser: opens a new tab with noopener,noreferrer
 */
export function openGameCommunityExternal(url: string): void {
  const bridge = getDesktopBridge();
  if (bridge && typeof bridge.openExternal === 'function') {
    void openExternalUrl(url);
    return;
  }
  if (typeof window !== 'undefined') {
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (popup) popup.opener = null;
  }
}

/**
 * Triggers non-blocking headless Chrome warmup and preloads the lazy Browser Pane + WebBrowser JS chunks
 * so clicking Surprise me opens immediately with zero Suspense fallback flashes.
 */
export function warmSuperAgentBrowser(): void {
  if (typeof window === 'undefined') return;
  if (!preloadedBrowserChunks) {
    preloadedBrowserChunks = true;
    void import('../../super-agent/ArtifactBrowserPane')
      .then(mod => mod.preloadWebBrowser?.())
      .catch(() => {
        preloadedBrowserChunks = false;
      });
  }
  if (typeof fetch !== 'function') return;
  const now = Date.now();
  if (now - lastWarmAt < WARM_THROTTLE_MS) return;
  lastWarmAt = now;
  void fetch('/motion-api/super-agent/browser/warm', { method: 'POST' }).catch(() => {});
}

/**
 * Resolves the AMR random-swipe community game feed URL (`/games`) from the
 * active OpenDesign account console URL, enforcing local vs. remote environment boundaries.
 */
export function buildGameCommunityFeedUrl(
  consoleUrl?: string | null,
  options?: { allowLoopback?: boolean; pageOrigin?: string | null },
): string {
  const allowLoopback = options?.allowLoopback ?? true;
  const fallback = fallbackRemoteCommunityUrl(options?.pageOrigin);
  const raw = consoleUrl?.trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }
    if (!allowLoopback && isLoopbackHostname(parsed.hostname)) {
      return fallback;
    }
    const cleanPath = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/(?:dashboard|games)$/i, '');
    return `${parsed.origin}${cleanPath}/games`;
  } catch {
    return fallback;
  }
}

let cachedUrl: { value: string; at: number } | null = null;
let inFlight: Promise<string> | null = null;
let inFlightId = 0;

export function resetGameCommunityUrlCache() {
  cachedUrl = null;
  inFlight = null;
  inFlightId += 1;
}

export function peekCachedGameCommunityUrl(): string {
  return cachedUrl?.value ?? fallbackRemoteCommunityUrl(currentPageOrigin());
}

async function fetchServerGameCommunityConfig(): Promise<{ url?: string | null } | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const response = await fetch('/motion-api/game-community/config');
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: unknown };
    return typeof data?.url === 'string' && data.url.trim() ? { url: data.url.trim() } : { url: null };
  } catch {
    return null;
  }
}

export async function resolveGameCommunityUrl(
  force = false,
  options?: { pageOrigin?: string | null; envOverride?: string | null },
): Promise<string> {
  const pageOrigin = options?.pageOrigin !== undefined ? options.pageOrigin : currentPageOrigin();
  const isLocal = isLocalStudioRuntime(pageOrigin);
  const envUrl = options?.envOverride !== undefined
    ? options.envOverride
    : (typeof import.meta !== 'undefined' ? (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GAME_COMMUNITY_URL : undefined);

  if (envUrl?.trim()) {
    const resolved = buildGameCommunityFeedUrl(envUrl, { allowLoopback: isLocal, pageOrigin });
    cachedUrl = { value: resolved, at: Date.now() };
    return resolved;
  }

  if (!force && cachedUrl && Date.now() - cachedUrl.at < CACHE_TTL_MS) {
    return cachedUrl.value;
  }
  if (!force && inFlight) return inFlight;
  const requestId = ++inFlightId;
  const run = (async () => {
    try {
      const account = await gatewayRequest<AccountSummary>('settings/account').catch(() => null);
      const accountConsoleUrl = account?.consoleUrl;

      if (isLocal) {
        // Local environment: prefer an explicit local consoleUrl (e.g. QA proxy or local profile);
        // otherwise ask the local server whether a local AMR community server is running.
        if (isLoopbackUrl(accountConsoleUrl)) {
          const next = buildGameCommunityFeedUrl(accountConsoleUrl, { allowLoopback: true, pageOrigin });
          if (inFlightId === requestId) cachedUrl = { value: next, at: Date.now() };
          return next;
        }
        const serverConfig = await fetchServerGameCommunityConfig();
        if (serverConfig?.url) {
          const next = buildGameCommunityFeedUrl(serverConfig.url, { allowLoopback: true, pageOrigin });
          if (inFlightId === requestId) cachedUrl = { value: next, at: Date.now() };
          return next;
        }
        const next = buildGameCommunityFeedUrl(accountConsoleUrl, { allowLoopback: true, pageOrigin });
        if (inFlightId === requestId) cachedUrl = { value: next, at: Date.now() };
        return next;
      }

      // Remote environment: never resolve to localhost/127.0.0.1; always target the remote community.
      const next = buildGameCommunityFeedUrl(accountConsoleUrl, { allowLoopback: false, pageOrigin });
      if (inFlightId === requestId) {
        cachedUrl = { value: next, at: Date.now() };
      }
      return next;
    } catch {
      return cachedUrl?.value ?? fallbackRemoteCommunityUrl(pageOrigin);
    } finally {
      if (inFlightId === requestId) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Resolves the AMR `/games` feed URL with one shared cached request across
 * Game Studio and the built-in Browser Pane.
 */
export function useGameCommunityUrl(): string {
  const [url, setUrl] = useState<string>(() => peekCachedGameCommunityUrl());

  useEffect(() => {
    let cancelled = false;
    const sync = (force = false) => {
      void resolveGameCommunityUrl(force).then(next => {
        if (!cancelled) setUrl(next);
      });
    };
    sync(false);
    const onAccountChanged = () => sync(true);
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('motion:account-changed', onAccountChanged);
    };
  }, []);

  return url;
}
