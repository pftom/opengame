import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { WorkspaceBrowser } from '../browser.ts';
import { webAddress } from '../shared/browser.ts';
import { injectPreviewBridgeHtml } from '../shared/preview-bridge.ts';
import { buildBridgeSrcDoc } from '../studio/src/design/previewBridge.ts';

test('browser addresses accept bare domains and local ports but reject executable and credential URLs', () => {
  assert.equal(webAddress('baidu.com'), 'https://baidu.com/');
  assert.equal(webAddress('localhost:48263/page'), 'https://localhost:48263/page');
  for (const url of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:pass@example.com']) assert.throws(() => webAddress(url));
});

test('real browser handles frame-denying sites, navigation, input, history, reload and isolated sessions', { timeout: 60_000 }, async () => {
  let visits = 0;
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.end(`<title>${url.pathname}</title><a href="/next">Next</a><form action="/search"><input name="q" autofocus><button>Search</button></form><p id="query">${url.searchParams.get('q') || ''}</p><p id="visit">${++visits}</p>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-one', 'tab-one', `${base}/first`);
    await tab.page.waitForSelector('input');
    // Autofocus is scheduled after DOM readiness; explicitly focus before testing input delivery.
    await tab.page.focus('input');
    await tab.page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    await tab.input({ type: 'text', text: 'OpenDesign 中文' });
    await Promise.all([tab.page.waitForNavigation(), tab.input({ type: 'key', key: 'Enter', modifiers: 0 })]);
    assert.equal(new URL(tab.page.url()).searchParams.get('q'), 'OpenDesign 中文');
    const link = await tab.page.$eval('a', element => { const r = element.getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; });
    await tab.input({ type: 'pointer', event: 'down', button: 'left', ...link });
    await Promise.all([tab.page.waitForNavigation(), tab.input({ type: 'pointer', event: 'up', button: 'left', ...link })]);
    assert.equal(tab.page.url(), `${base}/next`);
    await Promise.all([tab.page.waitForNavigation(), tab.command('back')]);
    assert.equal(new URL(tab.page.url()).pathname, '/search');
    await Promise.all([tab.page.waitForNavigation(), tab.command('forward')]);
    assert.equal(tab.page.url(), `${base}/next`);
    const before = await tab.page.$eval('#visit', el => el.textContent);
    await Promise.all([tab.page.waitForNavigation(), tab.command('reload')]);
    assert.notEqual(await tab.page.$eval('#visit', el => el.textContent), before);
    await assert.rejects(tab.command('navigate', 'file:///tmp/private'), /HTTP/);
    await tab.page.evaluate(() => { localStorage.setItem('isolation', 'one'); });
    const other = await browser.open('session-two', 'tab-one', `${base}/first`);
    await other.page.waitForSelector('input');
    assert.equal(await other.page.evaluate(() => localStorage.getItem('isolation')), null);
    const sibling = await browser.open('session-one', 'tab-two', `${base}/first`);
    await sibling.page.waitForSelector('input');
    assert.equal(await sibling.page.evaluate(() => localStorage.getItem('isolation')), 'one');
    let frames = '';
    const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { frames += chunk.toString(); done(); } }), { writeHead() {} });
    await tab.watch(stream as unknown as ServerResponse);
    const deadline = Date.now() + 5000;
    while (!frames.includes('event: frame') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(frames, /event: frame/); assert.match(frames, /"canGoBack":true/);
    stream.destroy();
    assert.equal(await browser.open('session-one', 'tab-one', `${base}/first`), tab, 'reattaching preserves browser history');
    await browser.remove('session-one', 'tab-one');
    assert.equal(tab.page.isClosed(), true);
    await assert.rejects(browser.get('session-one', 'tab-one'), /关闭/);
    await other.page.browser().close();
    const recovered = await browser.open('session-two', 'tab-one', `${base}/recovered`);
    await recovered.page.waitForSelector('input');
    assert.equal(recovered.page.url(), `${base}/recovered`, 'a disconnected engine can be relaunched on retry');
  } finally { await browser.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); }
});

test('browser supports inspectAt, screenshot, color scheme, zoom, clear cache/cookies and console capture', { timeout: 60_000 }, async () => {
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/missing-asset') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Inspect Test</title></head>
        <body style="margin:0">
          <button id="cta" class="hero-btn" style="position:fixed;left:20px;top:20px;width:160px;height:48px">Launch App</button>
          <script>
            console.error('boom-console-msg');
            fetch('/missing-asset');
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-inspect', 'tab-inspect', `${base}/`, { width: 800, height: 600, dpr: 1 });
    await tab.page.waitForSelector('#cta');

    const picked = await tab.inspectAt(60, 44);
    assert.ok(picked.element);
    assert.equal(picked.element.tagName, 'button');
    assert.equal(picked.element.selector, '#cta');
    assert.ok(picked.element.htmlPreview.includes('Launch App'));
    assert.ok(picked.element.rect.width >= 150);
    assert.ok(picked.element.styles.display);

    const shot = await tab.screenshot();
    assert.equal(shot.mimeType, 'image/png');
    assert.ok(shot.dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(shot.width > 0 && shot.height > 0);

    await tab.command('set-color-scheme', 'dark');
    assert.equal(tab.state.colorScheme, 'dark');
    await tab.command('set-zoom', 1.25);
    assert.equal(tab.state.zoom, 1.25);

    const zoomedPicked = await tab.inspectAt(32, 32);
    assert.ok(zoomedPicked.element);
    assert.equal(zoomedPicked.element.selector, '#cta');
    assert.ok(zoomedPicked.element.rect.width >= 190, `Expected zoomed width >= 190, got ${zoomedPicked.element.rect.width}`);

    await tab.command('clear-cookies');
    await tab.command('clear-cache');
    await Promise.all([tab.page.waitForNavigation({ waitUntil: 'domcontentloaded' }), tab.command('hard-reload')]);

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline
      && !tab.getConsoleEntries().some(entry => entry.text.includes('boom-console-msg'))
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const entries = tab.getConsoleEntries();
    assert.ok(entries.some(entry => entry.level === 'error' && entry.text.includes('boom-console-msg')));

    await tab.page.evaluate(() => {
      void fetch('http://127.0.0.1:9/fail-network').catch(() => {});
    });
    const netDeadline = Date.now() + 3000;
    while (
      Date.now() < netDeadline
      && !tab.getConsoleEntries().some(entry => entry.level === 'network' && entry.text.includes('Network failed'))
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(tab.getConsoleEntries().some(entry => entry.level === 'network' && entry.text.includes('Network failed')));

    tab.clearConsoleEntries();
    assert.equal(tab.getConsoleEntries().length, 0);
    assert.equal(tab.state.errorCount, 0);

    const snap = await browser.snapshot(`${base}/`, { width: 640, height: 480 });
    assert.equal(snap.mimeType, 'image/png');
    assert.equal(snap.width, 640);
    assert.equal(snap.height, 480);
    assert.ok(snap.dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('browser streams 2x Retina frames with PNG settle and ignores slow child iframes for main loading state', { timeout: 60_000 }, async () => {
  const site = createServer((req, res) => {
    const reqUrl = new URL(req.url!, 'http://local');
    if (reqUrl.pathname === '/slow-frame') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<body>child ready</body>');
      }, 600);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>HiDPI Host</title></head>
      <body style="margin:0;background:#101214;color:#fff">
        <h1>Retina</h1>
        <iframe src="/slow-frame" style="width:200px;height:100px"></iframe>
      </body></html>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-hidpi', 'tab-hidpi', `${base}/`, { width: 420, height: 320, dpr: 2 });
    const doneDeadline = Date.now() + 8000;
    while ((tab.state.loading || tab.state.title !== 'HiDPI Host') && Date.now() < doneDeadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(tab.state.loading, false, 'main document load should clear loading promptly');

    // Injecting a new child iframe after initial load must not stick tab.state.loading at true.
    await tab.page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = '/slow-frame';
      document.body.appendChild(f);
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(tab.state.loading, false, 'child iframe start should not set main tab loading state');

    assert.equal(browser.has('session-hidpi', 'tab-hidpi'), true);
    await tab.input({ type: 'pointer', event: 'move', x: 50, y: 50, button: 'left', buttons: 1 });

    let streamChunks = '';
    const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { streamChunks += chunk.toString(); done(); } }), { writeHead() {} });
    await tab.watch(stream as unknown as ServerResponse);
    const frameDeadline = Date.now() + 8000;
    while (!streamChunks.includes('"mime":"image/png"') && Date.now() < frameDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // Wait across a 1.2s heartbeat interval and confirm unchanged state is not re-emitted.
    await new Promise(resolve => setTimeout(resolve, 1450));
    stream.destroy();

    const statePayloads = streamChunks
      .split('\n\n')
      .filter(block => block.startsWith('event: state\n'))
      .map(block => block.split('data: ')[1]);
    for (let i = 1; i < statePayloads.length; i += 1) {
      assert.notEqual(statePayloads[i], statePayloads[i - 1], 'heartbeat should not emit duplicate identical state payloads');
    }

    const framePayloads = streamChunks
      .split('\n\n')
      .filter(block => block.startsWith('event: frame\n'))
      .map(block => JSON.parse(block.split('data: ')[1]) as { data: string; mime?: string; width: number; height: number; dpr: number });
    const pngFrame = framePayloads.find(f => f.mime === 'image/png');
    assert.ok(pngFrame, 'idle watch stream should emit lossless image/png settle frame');
    assert.equal(pngFrame.width, 420);
    assert.equal(pngFrame.height, 320);
    assert.equal(pngFrame.dpr, 2);
    const pngBuf = Buffer.from(pngFrame.data, 'base64');
    const physicalWidth = pngBuf.readUInt32BE(16);
    const physicalHeight = pngBuf.readUInt32BE(20);
    assert.equal(physicalWidth, 840);
    assert.equal(physicalHeight, 640);
    await browser.remove('session-hidpi', 'tab-hidpi');
    assert.equal(browser.has('session-hidpi', 'tab-hidpi'), false);
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('real Chromium sandboxed ?omBridge= iframes deliver om:preview-pick, om:preview-console, and om:preview-capture under CSP', { timeout: 60_000 }, async () => {
  const DESIGN_TOKEN = ['omb', 'design', 'fixture'].join('_');
  const GAME_TOKEN = ['omb', 'game', 'fixture'].join('_');
  const BLANK_TOKEN = ['omb', 'blank', 'fixture'].join('_');
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/host') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
        <html>
          <body style="margin:0">
            <iframe id="f-design" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/design.html?omBridge=${DESIGN_TOKEN}" style="position:fixed;left:0;top:0;width:400px;height:250px;border:0"></iframe>
            <iframe id="f-drawn" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/game-drawn.html?omBridge=${GAME_TOKEN}" style="position:fixed;left:0;top:260px;width:240px;height:180px;border:0"></iframe>
            <iframe id="f-blank" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/game-blank.html?omBridge=${BLANK_TOKEN}" style="position:fixed;left:260px;top:260px;width:240px;height:180px;border:0"></iframe>
            <script>
              window.__picked = [];
              window.__console = [];
              window.__captures = {};
              window.addEventListener('message', function(e) {
                var d = e.data;
                if (!d || typeof d !== 'object') return;
                if (d.type === 'om:preview-pick') window.__picked.push(d);
                if (d.type === 'om:preview-console') window.__console.push(d);
                if (d.type === 'om:preview-capture-result') window.__captures[d.requestId] = d;
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (url.pathname === '/design.html') {
      const html = `<!doctype html><html><body style="margin:0">
        <button id="play-cta" data-component="HeroCard" data-source-file="src/Hero.tsx" style="position:fixed;left:20px;top:10px;width:140px;height:40px">Play</button>
        <script>console.error('iframe-err'); console.warn('iframe-warn');</script>
      </body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
      });
      res.end(out);
      return;
    }
    if (url.pathname === '/game-drawn.html') {
      const html = `<!doctype html><html><body style="margin:0">
        <canvas id="c" width="200" height="150"></canvas>
        <script>
          const ctx = document.getElementById('c').getContext('2d');
          ctx.fillStyle = '#e11d48';
          ctx.fillRect(0, 0, 200, 150);
        </script>
      </body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock allow-popups allow-modals; worker-src 'none'",
      });
      res.end(out);
      return;
    }
    if (url.pathname === '/game-blank.html') {
      const html = `<!doctype html><html><body style="margin:0"><canvas id="blank" width="200" height="150"></canvas></body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock allow-popups allow-modals; worker-src 'none'",
      });
      res.end(out);
      return;
    }
    res.writeHead(404).end('Not found');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-bridge-e2e', 'tab-bridge', `${base}/host`, { width: 800, height: 600, dpr: 1 });
    await tab.page.waitForFunction(() => {
      const logs = (window as any).__console || [];
      return logs.some((e: any) => e.level === 'error' && String(e.text).includes('iframe-err'))
        && logs.some((e: any) => e.level === 'warn' && String(e.text).includes('iframe-warn'));
    }, { timeout: 10_000 });

    await tab.page.evaluate(token => {
      const frame = document.getElementById('f-design') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: 'om:preview-mode', token, pick: true }, '*');
    }, DESIGN_TOKEN);

    await tab.page.mouse.move(60, 25);
    await tab.page.mouse.click(60, 25);

    await tab.page.waitForFunction(() => ((window as any).__picked || []).length > 0, { timeout: 5_000 });
    const pickedMsg = await tab.page.evaluate(() => (window as any).__picked[0]);
    assert.equal(pickedMsg.element.selector, '#play-cta');
    assert.equal(pickedMsg.element.componentName, 'HeroCard');
    assert.equal(pickedMsg.element.sourceFile, 'src/Hero.tsx');
    assert.ok(pickedMsg.element.styles.display);
    assert.ok(pickedMsg.rect.width >= 130);

    await tab.page.evaluate(([gameToken, blankToken]) => {
      (document.getElementById('f-drawn') as HTMLIFrameElement).contentWindow?.postMessage(
        { type: 'om:preview-capture', token: gameToken, requestId: 'cap-drawn' },
        '*',
      );
      (document.getElementById('f-blank') as HTMLIFrameElement).contentWindow?.postMessage(
        { type: 'om:preview-capture', token: blankToken, requestId: 'cap-blank' },
        '*',
      );
    }, [GAME_TOKEN, BLANK_TOKEN]);

    await tab.page.waitForFunction(() => {
      const c = (window as any).__captures || {};
      return 'cap-drawn' in c && 'cap-blank' in c;
    }, { timeout: 5_000 });
    const captures = await tab.page.evaluate(() => (window as any).__captures);
    assert.ok(String(captures['cap-drawn'].dataUrl).startsWith('data:image/png;base64,'));
    assert.equal(captures['cap-blank'].dataUrl, null);
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('Chromium preview bridges keep tracked annotation boxes aligned as content scrolls', { timeout: 60_000 }, async t => {
  const token = 'omb_design_scroll_fixture';
  const fixture = `<!doctype html><body style="margin:0;min-height:1600px">
    <div id="scroller" style="position:absolute;top:240px;left:20px;width:200px;height:160px;overflow:auto">
      <div style="height:700px;position:relative">
        <button id="target" style="position:absolute;top:90px;left:10px;width:100px;height:30px">Target</button>
      </div>
    </div>
    <div id="scaled-outer" style="position:absolute;top:20px;left:250px;width:240px;height:200px;overflow:auto;transform:scale(.5,.75);transform-origin:top left">
      <div id="scaled-inner" style="position:relative;top:40px;left:40px;width:320px;height:240px;overflow:auto;transform:scale(.75,.5);transform-origin:top left">
        <div style="position:relative;width:500px;height:400px">
          <div id="scaled-target" style="position:absolute;top:130px;left:130px;width:40px;height:40px"></div>
        </div>
      </div>
    </div>
  </body>`;
  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/preview' ? injectPreviewBridgeHtml(fixture, token, true) : '<!doctype html><body id="host" style="margin:0"></body>');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    for (const source of ['raw', 'srcdoc']) {
      await t.test(source, async () => {
        const { page } = await browser.open('session-design-scroll', source, base, { width: 800, height: 600, dpr: 1 });
        await page.waitForSelector('#host', { timeout: 5000 });
        const preview = source === 'srcdoc' ? buildBridgeSrcDoc(fixture, `${base}/`, token, true) : null;
        await page.evaluate(({ preview, token }) => {
          const iframe = document.createElement('iframe');
          iframe.setAttribute('sandbox', 'allow-scripts');
          iframe.style.cssText = 'display:block;width:400px;height:300px;border:0';
          if (preview) iframe.srcdoc = preview;
          else iframe.src = '/preview';
          const messages: Record<string, any[]> = {};
          (window as any).__annotationMessages = messages;
          window.addEventListener('message', event => {
            if (event.source === iframe.contentWindow && event.data?.token === token) {
              (messages[event.data.type] ??= []).push(event.data);
            }
          });
          document.body.appendChild(iframe);
        }, { preview, token });
        const frame = await (await page.waitForSelector('iframe', { timeout: 5000 }))!.contentFrame();
        assert.ok(frame);
        await frame.waitForSelector('#target', { timeout: 5000 });

        const post = (type: string, options = {}) => page.evaluate(message => {
          document.querySelector('iframe')!.contentWindow?.postMessage(message, '*');
        }, { type, token, ...options });
        const waitForScroll = (y: number) => page.waitForFunction(expectedY =>
          (window as any).__annotationMessages['om:design-scroll']?.at(-1)?.scroll.y === expectedY,
        { timeout: 5000 }, y);
        const waitForBox = (y: number) => page.waitForFunction(expectedY =>
          (window as any).__annotationMessages['om:design-element-boxes']?.at(-1)?.boxes.some(
            (entry: any) => entry.id === 'target-pin' && entry.box.y === expectedY,
          ), { timeout: 5000 }, y);

        await post('om:design-request-scroll');
        await waitForScroll(0);
        await post('om:design-track-elements', {
          elements: [{ id: 'target-pin', selector: '#target', elementId: 'target' }],
          scopes: [{ id: 'region', containers: [{ selector: '#scroller', x: 0, y: 0 }] }],
        });
        await waitForBox(330);

        await post('om:design-track-elements', { token: 'wrong_token', elements: [] });
        await frame.evaluate(() => window.scrollTo(0, 120));
        await waitForScroll(120);
        await waitForBox(210);

        await frame.$eval('#scroller', scroller => { scroller.scrollTop = 60; });
        await waitForBox(150);
        const scope = await page.evaluate(() => (window as any).__annotationMessages['om:design-element-boxes'].at(-1).scopes[0]);
        assert.deepEqual(scope.offset, { x: 0, y: -60 });
        assert.equal(scope.clip.y, 120);

        await post('om:design-pick-scroll', { requestId: 'region-drag', point: { x: 40, y: 160 } });
        const scrollPick = await page.waitForFunction(() => (window as any).__annotationMessages['om:design-picked-scroll']?.at(-1), { timeout: 5000 });
        const { requestId, scroll: regionScroll } = await scrollPick.jsonValue();
        assert.equal(requestId, 'region-drag');
        assert.deepEqual(regionScroll, { x: 0, y: 120, containers: [{ selector: '#scroller', x: 0, y: 60 }] });

        if (source === 'raw') await post('om:preview-mode', { pick: true });
        await page.mouse.click(40, 160);
        const pickType = source === 'raw' ? 'om:preview-pick' : 'om:design-pick';
        const picked = await page.waitForFunction(type => (window as any).__annotationMessages[type]?.at(-1),
          { timeout: 5000 }, pickType);
        const { rect, scroll } = await picked.jsonValue();
        assert.deepEqual(rect, { x: 30, y: 150, width: 100, height: 30 });
        assert.deepEqual(scroll, { x: 0, y: 120, containers: [{ selector: '#scroller', x: 0, y: 60 }] });

        await frame.evaluate(() => window.scrollTo(0, 0));
        await waitForScroll(0);
        await waitForBox(270);

        const scaledDelta = await frame.$eval('#scaled-target', target => {
          const before = target.getBoundingClientRect();
          document.querySelector('#scaled-outer')!.scrollTo(40, 20);
          document.querySelector('#scaled-inner')!.scrollTo(20, 20);
          const after = target.getBoundingClientRect();
          return { x: after.x - before.x, y: after.y - before.y };
        });
        assert.deepEqual(scaledDelta, { x: -27.5, y: -22.5 });
        await post('om:design-track-elements', {
          scopes: [{ id: 'scaled-region', containers: [
            { selector: '#scaled-outer', x: 0, y: 0 },
            { selector: '#scaled-inner', x: 0, y: 0 },
          ] }],
        });
        const scaledScope = await page.waitForFunction(() =>
          (window as any).__annotationMessages['om:design-element-boxes']?.at(-1)?.scopes.find(
            (entry: any) => entry.id === 'scaled-region',
          ), { timeout: 5000 });
        assert.deepEqual((await scaledScope.jsonValue()).offset, scaledDelta);
      });
    }
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('Chromium design preview bridges paginate stacked decks and preserve authored decks', { timeout: 60_000 }, async t => {
  const token = 'omb_design_deck_fixture';
  const stacked = '<style>.deck{display:grid;gap:24px;padding:24px}.slide{min-height:560px}</style>';
  const authored = `<style>
    .slide{display:none;width:270px;height:180px}
    .slide.active{display:grid;place-items:center}
  </style>`;
  const authoredProtocol = `<script>
    const slides = [...document.querySelectorAll('.slide')];
    function report(active) {
      window.parent.postMessage({type:'od:slide-state',active,count:slides.length,protocolVersion:1}, '*');
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (event.source !== window.parent || message?.type !== 'od:slide' || message.action !== 'go') return;
      slides.forEach((slide, i) => slide.classList.toggle('active', i === message.index));
      document.body.dataset.nativePage = String(message.index);
      report(message.index);
    });
    window.parent.postMessage({type:'od:deck-ready',capabilities:['absolute-navigation','state-events']}, '*');
    report(0);
  </script>`;
  const fixture = (native: boolean) => `<!doctype html><head>
    ${native ? authored : stacked}
  </head><body style="margin:0">
    <main class="deck">
      <section class="slide${native ? ' active' : ''}" id="cover">
        <div class="slide-frame"><h2>Cover</h2></div>
      </section>
      <section class="slide" id="details"><h2>Details</h2></section>
      <section class="slide" id="closing"><h2>Closing</h2></section>
    </main>
    ${native ? authoredProtocol : ''}
  </body>`;

  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const url = new URL(req.url!, 'http://local');
    res.end(url.pathname === '/preview'
      ? injectPreviewBridgeHtml(fixture(url.searchParams.has('native')), token, true)
      : '<!doctype html><body id="host"></body>');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());

  try {
    for (const source of ['raw', 'srcdoc']) {
      for (const native of [false, true]) {
        const name = `${source}-${native ? 'authored' : 'stacked'}`;
        await t.test(name, async () => {
          const { page } = await browser.open('session-design-deck', name, base, { width: 800, height: 600, dpr: 1 });
          await page.waitForSelector('#host', { timeout: 5000 });
          const preview = source === 'srcdoc' ? buildBridgeSrcDoc(fixture(native), `${base}/`, token, false) : null;
          await page.evaluate(({ preview, native }) => new Promise<void>(resolve => {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.style.cssText = 'display:block;width:400px;height:300px;border:0';
            iframe.addEventListener('load', () => resolve(), { once: true });
            window.addEventListener('message', event => {
              if (event.source === iframe.contentWindow && event.data?.type === 'od:slide-state') {
                document.body.dataset.slideState = `${event.data.active}/${event.data.count}`;
              }
            });
            if (preview) iframe.srcdoc = preview;
            else iframe.src = '/preview' + (native ? '?native=1' : '');
            document.body.appendChild(iframe);
          }), { preview, native });
          const frame = await (await page.waitForSelector('iframe', { timeout: 5000 }))!.contentFrame();
          assert.ok(frame);

          const post = (message: Record<string, unknown>) => page.evaluate(event => {
            document.querySelector('iframe')!.contentWindow!.postMessage(event, '*');
          }, message);
          const mode = (enabled: boolean, sentToken = token) => post({
            type: 'om:design-deck-mode', enabled, singlePage: true, token: sentToken,
          });
          const go = (index: number) => post({ type: 'od:slide', action: 'go', index });
          const waitForState = (index: number) => page.waitForFunction(value =>
            document.body.dataset.slideState === value, { timeout: 5000 }, `${index}/3`);
          const visibleSlides = () => frame.$$eval('.slide', slides =>
            slides.filter(slide => slide.getClientRects().length > 0).map(slide => slide.id));
          const waitForOnly = (id: string) => frame.waitForFunction(expectedId => {
            const visible = Array.from(document.querySelectorAll('.slide')).filter(slide => slide.getClientRects().length > 0);
            return visible.length === 1 && visible[0].id === expectedId;
          }, { timeout: 5000 }, id);

          if (!native) {
            await mode(false);
            await mode(true, 'wrong_deck_token');
            await go(1);
            assert.deepEqual(await visibleSlides(), ['cover', 'details', 'closing']);
          }

          await mode(true);
          await waitForOnly('cover');
          await waitForState(0);

          if (!native) {
            await frame.evaluate(() => window.scrollTo(0, 100));
            assert.equal(await frame.evaluate(() => window.scrollY), 100);
          }
          await go(1);
          await waitForOnly('details');
          await waitForState(1);

          assert.equal(await frame.evaluate(() => window.scrollY), 0);

          if (native) {
            const nativePage = await frame.$eval('#details', slide => {
              const { width, height } = slide.getBoundingClientRect();
              return { display: getComputedStyle(slide).display, width, height, authored: document.body.dataset.nativePage };
            });
            assert.deepEqual(nativePage, { display: 'grid', width: 270, height: 180, authored: '1' });
          }

          await go(2);
          await waitForOnly('closing');
          await waitForState(2);
          await go(1);
          await waitForOnly('details');
          await waitForState(1);

          if (!native) {
            await mode(false);
            await frame.waitForFunction(() => Array.from(document.querySelectorAll('.slide'))
              .every(slide => slide.getClientRects().length > 0), { timeout: 5000 });
          }
        });
      }
    }
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});
