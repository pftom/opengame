// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n/I18n';
import { WebBrowser } from './WebBrowser';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.closed = true;
  }
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('WebBrowser frame loading recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let origFetch: typeof globalThis.fetch;
  let origEventSource: typeof globalThis.EventSource;
  let origResizeObserver: typeof globalThis.ResizeObserver;
  let origDecode: typeof HTMLImageElement.prototype.decode;
  let origRaf: typeof globalThis.requestAnimationFrame;
  let origCancelRaf: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    origFetch = globalThis.fetch;
    origEventSource = globalThis.EventSource;
    origResizeObserver = globalThis.ResizeObserver;
    origDecode = HTMLImageElement.prototype.decode;
    origRaf = globalThis.requestAnimationFrame;
    origCancelRaf = globalThis.cancelAnimationFrame;

    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
    HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = origFetch;
    globalThis.EventSource = origEventSource;
    globalThis.ResizeObserver = origResizeObserver;
    HTMLImageElement.prototype.decode = origDecode;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancelRaf;
    vi.useRealTimers();
  });

  it('recovers from mismatched initial frame dimensions instead of staying stuck on Loading page', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url, body });
      return new Response(
        JSON.stringify({
          url: 'http://127.0.0.1:5179/games/demo',
          title: 'Demo Game',
          canGoBack: false,
          canGoForward: false,
          loading: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WebBrowser
            sessionId="preview"
            tabId="web-game-community"
            endpoint="/motion-api/super-agent/browser/tabs/web-game-community"
            url="http://127.0.0.1:5179/games/demo"
            fixedViewport={{ width: 900, height: 800, dpr: 2 }}
            onState={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    const sse = MockEventSource.instances[0];

    // Emit a frame whose dimensions differ by >20% from the 900x800 pane (e.g. shared tab at 520x629)
    await act(async () => {
      sse.emit('frame', { data: 'AAAA', mime: 'image/jpeg', width: 520, height: 629, dpr: 2 });
      await Promise.resolve();
    });

    // Should request /resize even though initial open already sent 900x800
    expect(requests.some(req => req.url.endsWith('/resize') && req.body.width === 900 && req.body.height === 800)).toBe(true);
    // Briefly holds back the mismatched frame while waiting for resize
    expect(container.querySelector('.om-sa-web-skeleton')).toBeTruthy();

    // After the grace window elapses with no resized frame, it must render the received frame rather than hanging forever
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.om-sa-web-skeleton')?.getAttribute('data-leaving')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('.om-sa-web-skeleton')).toBeNull();
    const img = container.querySelector<HTMLImageElement>('img.motion-web-page');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('data-loaded')).toBe('true');
    expect(img?.getAttribute('aria-hidden')).toBeNull();
    expect(img?.getAttribute('src')).toBeTruthy();
  });

  it('falls back to a data URL when Image.decode rejects on the first frame', async () => {
    HTMLImageElement.prototype.decode = vi.fn(() => Promise.reject(new Error('decode failed')));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          url: 'http://127.0.0.1:5179/games/demo',
          title: 'Demo Game',
          canGoBack: false,
          canGoForward: false,
          loading: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WebBrowser
            sessionId="preview"
            tabId="web-decode-fallback"
            endpoint="/motion-api/super-agent/browser/tabs/web-decode-fallback"
            url="http://127.0.0.1:5179/games/demo"
            fixedViewport={{ width: 900, height: 800, dpr: 2 }}
            onState={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const sse = MockEventSource.instances[0];
    await act(async () => {
      sse.emit('frame', { data: 'AAAA', mime: 'image/jpeg', width: 900, height: 800, dpr: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.om-sa-web-skeleton')?.getAttribute('data-leaving')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('.om-sa-web-skeleton')).toBeNull();
    const img = container.querySelector<HTMLImageElement>('img.motion-web-page');
    expect(img?.getAttribute('data-loaded')).toBe('true');
    expect(img?.getAttribute('aria-hidden')).toBeNull();
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });
});
