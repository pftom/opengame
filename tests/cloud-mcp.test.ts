import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractCommentableElements,
  groupCloudCommentThreads,
  isGameShareUrl,
  parseCloudShareUrl,
  type CloudComment,
} from '../shared/cloud-comments.ts';
import { cloudCommentsOperation, type CloudCommentsAccountClient } from '../gateway/cloud-comments.ts';
import { cloudDeployOperation } from '../gateway/web-publish-ops.ts';
import { CloudApiError, OpenDesignAccount } from '../gateway/account.ts';
import { trackingError } from '../tracking/tool-fields.ts';
import { startServer } from '../server.ts';
import { MCP_HTTP_PATH, MCP_TOKENS_API } from '../shared/mcp-http.ts';
import { rpc, releaseRegistry } from '../mcp.ts';
import { WorkspaceStore } from '../workspace.ts';
import { gameProjectsFor } from '../game-projects.ts';
import type { WebPublishService } from '../gateway/web-publish.ts';

test('parseCloudShareUrl accepts https and loopback share links and rejects malformed inputs', () => {
  assert.deepEqual(
    parseCloudShareUrl('https://open-design.app/artifact/proj-123/my-slug?foo=bar'),
    {
      projectId: 'proj-123',
      slug: 'my-slug',
      origin: 'https://open-design.app',
      shareUrl: 'https://open-design.app/artifact/proj-123/my-slug',
    },
  );
  assert.deepEqual(
    parseCloudShareUrl('http://127.0.0.1:5180/artifact/p%201/s_2'),
    {
      projectId: 'p 1',
      slug: 's_2',
      origin: 'http://127.0.0.1:5180',
      shareUrl: 'http://127.0.0.1:5180/artifact/p%201/s_2',
    },
  );
  assert.throws(() => parseCloudShareUrl('http://evil.example/artifact/p/s'), /loopback/i);
  assert.throws(() => parseCloudShareUrl('https://open-design.app/design/p/s'), /path must match/i);
  assert.throws(() => parseCloudShareUrl('file:///artifact/p/s'), /https/i);
});

test('extractCommentableElements produces deterministic unique selectors and respects query/limit', () => {
  const html = `<!doctype html>
  <html>
    <head><title>Ignored</title><style>.hidden { color: red; }</style></head>
    <body>
      <header id="hero"><h1>Pricing Plan</h1><button data-testid="buy-btn">Upgrade Now</button></header>
      <main>
        <section class="cards">
          <div class="card"><p>Starter Tier</p></div>
          <div class="card"><p>Pro Tier</p></div>
        </section>
      </main>
      <script>console.log('ignored script text');</script>
    </body>
  </html>`;
  const full = extractCommentableElements(html);
  assert.equal(full.elements.some((el) => el.selector === '#hero' && el.elementId === 'hero'), true);
  assert.equal(full.elements.some((el) => el.selector === '[data-testid="buy-btn"]' && el.text === 'Upgrade Now'), true);
  assert.equal(full.elements.some((el) => el.text.includes('Pro Tier') && el.selector.includes(':nth-of-type(')), true);
  assert.equal(full.elements.some((el) => el.text.includes('ignored script text')), false);

  const queried = extractCommentableElements(html, { query: 'pro tier', limit: 1 });
  assert.equal(queried.totalElements, 1);
  assert.equal(queried.elements.length, 1);
  assert.match(queried.elements[0]!.text, /Pro Tier/);
});

test('extractCommentableElements walks to body for unique deep-DOM selectors and comment targets the exact leaf', async () => {
  const wrap8 = (leafText: string) =>
    '<div><div><div><div><div><div><div><div>' +
    `<p>${leafText}</p>` +
    '</div></div></div></div></div></div></div></div>';
  const deepHtml = `<!doctype html>
  <html>
    <body>
      <main>
        <section class="branch">${wrap8('First Deep Leaf')}</section>
        <section class="branch">${wrap8('Second Deep Leaf')}</section>
      </main>
    </body>
  </html>`;

  const parsed = extractCommentableElements(deepHtml, { limit: 200 });
  const firstLeaf = parsed.elements.find((el) => el.text === 'First Deep Leaf');
  const secondLeaf = parsed.elements.find((el) => el.text === 'Second Deep Leaf');
  assert.ok(firstLeaf);
  assert.ok(secondLeaf);
  assert.notEqual(firstLeaf.selector, secondLeaf.selector);
  assert.match(firstLeaf.selector, /^body > main:nth-of-type\(1\) > section:nth-of-type\(1\) >/);
  assert.match(secondLeaf.selector, /^body > main:nth-of-type\(1\) > section:nth-of-type\(2\) >/);

  const leafSelectors = parsed.elements.map((el) => el.selector);
  assert.equal(new Set(leafSelectors).size, leafSelectors.length);

  const root = mkdtempSync(path.join(os.tmpdir(), 'om-cloud-deep-dom-'));
  const posted: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const jsonBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/deep-slug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          slug: 'deep-slug',
          snapshotSlug: 'deep-snap',
          entryPath: 'index.html',
          version: 1,
        }),
      );
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/deep-snap/files/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(deepHtml);
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/deep-slug/comments') {
      posted.push(jsonBody);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          comment: {
            id: 'c-deep-2',
            seq: 1,
            author: { kind: 'user', authorKey: 'alice-hash', displayName: 'Alice' },
            isMine: true,
            note: jsonBody.note,
            filePath: 'index.html',
            elementId: jsonBody.elementId,
            selector: jsonBody.selector,
            htmlHint: jsonBody.htmlHint,
            status: 'open',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          share: { projectId: 'proj-deep', slug: 'deep-slug', filePath: 'index.html', version: 1 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const store = new WorkspaceStore(path.join(root, 'ws'));
    const credDir = path.join(store.directory, 'account', 'credentials');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      path.join(credDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'alice-key',
            controlKeyId: 'ck-alice',
            runtimeKey: 'rk-alice',
            user: { id: 'u-alice', name: 'Alice', email: 'alice@example.com' },
          },
        },
      }),
    );
    const account = new OpenDesignAccount(store.directory);
    const res = (await cloudCommentsOperation(
      store,
      {
        action: 'comment',
        shareUrl: 'https://open-design.app/artifact/proj-deep/deep-slug',
        selector: secondLeaf.selector,
        note: 'Anchor specifically to second deep subtree',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment };
    assert.equal(res.comment.elementId, secondLeaf.elementId);
    assert.equal(res.comment.selector, secondLeaf.selector);
    assert.equal(posted[0]?.elementId, secondLeaf.elementId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('cloud deploy + cloud comments MCP supports author and external 1-level replies via mock Cloud HTTP server', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'om-cloud-mcp-'));
  const htmlFile = path.join(root, 'deck.html');
  writeFileSync(
    htmlFile,
    '<html><body><h1 id="headline">Launch Deck</h1><button id="cta">Publish</button></body></html>',
    'utf8',
  );

  type StoredComment = CloudComment;
  const comments: StoredComment[] = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBytes = Buffer.concat(chunks);
    const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
    const bodyText = isJson ? rawBytes.toString('utf8') : '';
    const jsonBody = bodyText ? JSON.parse(bodyText) : {};

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/share-slug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          slug: 'share-slug',
          snapshotSlug: 'snap-v2',
          entryPath: 'deck.html',
          displayName: 'Launch Deck',
          publishedAt: 1700000000000,
          version: 2,
        }),
      );
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/snap-v2/files/deck.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1 id="headline">Launch Deck</h1><button id="cta">Publish</button></body></html>');
      return;
    }

    if (reqUrl.pathname === '/api/v1/collab/client-share/share-slug/comments') {
      const auth = req.headers.authorization;
      if (auth !== 'Bearer alice-key' && auth !== 'Bearer bob-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
        return;
      }
      const actor = auth === 'Bearer alice-key'
        ? { key: 'alice-hash', name: 'Alice', isOwner: true }
        : { key: 'bob-hash', name: 'Bob', isOwner: false };

      if (req.method === 'GET') {
        const includeResolved = reqUrl.searchParams.get('includeResolved') === 'true';
        if (includeResolved && !actor.isOwner) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'FORBIDDEN' }));
          return;
        }
        const resolvedRoots = new Set(
          comments.filter((c) => !c.parentCommentId && c.status !== 'open').map((c) => c.id),
        );
        const visible = comments.filter((c) => {
          if (c.status === 'deleted') return false;
          if (!includeResolved && c.status !== 'open') return false;
          if (!includeResolved && c.parentCommentId && resolvedRoots.has(c.parentCommentId)) return false;
          return true;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            share: { projectId: 'cloud-proj-1', slug: 'share-slug', filePath: 'deck.html', version: 2 },
            viewer: { authorKey: actor.key, displayName: actor.name, isOwner: actor.isOwner },
            comments: visible,
            threads: groupCloudCommentThreads(visible),
            latestSeq: seq,
            unresolvedTotal: visible.filter((c) => !c.parentCommentId && c.status === 'open').length,
          }),
        );
        return;
      }

      if (req.method === 'POST') {
        if (jsonBody.parentCommentId) {
          const parent = comments.find((c) => c.id === jsonBody.parentCommentId && c.status !== 'deleted');
          if (!parent) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'PARENT_NOT_FOUND' }));
            return;
          }
          if (parent.parentCommentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'REPLY_DEPTH_EXCEEDED' }));
            return;
          }
          if (parent.status !== 'open') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'PARENT_CLOSED' }));
            return;
          }
          const reply: StoredComment = {
            id: `c-${++seq}`,
            seq,
            parentCommentId: parent.id,
            author: { kind: 'user', authorKey: actor.key, displayName: actor.name },
            isMine: true,
            note: jsonBody.note,
            filePath: 'deck.html',
            elementId: parent.elementId,
            selector: parent.selector,
            htmlHint: parent.htmlHint,
            status: 'open',
            createdAt: Date.now() + seq,
            updatedAt: Date.now() + seq,
          };
          comments.push(reply);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            comment: reply,
            share: { projectId: 'cloud-proj-1', slug: 'share-slug', filePath: 'deck.html', version: 2 },
          }));
          return;
        }
        const rootComment: StoredComment = {
          id: `c-${++seq}`,
          seq,
          author: { kind: 'user', authorKey: actor.key, displayName: actor.name },
          isMine: true,
          note: jsonBody.note,
          filePath: 'deck.html',
          elementId: jsonBody.elementId,
          selector: jsonBody.selector,
          htmlHint: jsonBody.htmlHint,
          status: 'open',
          createdAt: Date.now() + seq,
          updatedAt: Date.now() + seq,
        };
        comments.push(rootComment);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          comment: rootComment,
          share: { projectId: 'cloud-proj-1', slug: 'share-slug', filePath: 'deck.html', version: 2 },
        }));
        return;
      }
    }

    const patchMatch = /^\/api\/v1\/collab\/client-share\/share-slug\/comments\/([^/]+)$/.exec(reqUrl.pathname);
    if (patchMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const target = comments.find((c) => c.id === decodeURIComponent(patchMatch[1]!));
      if (!target || target.status === 'deleted') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'COMMENT_NOT_FOUND' }));
        return;
      }
      if (req.method === 'DELETE') {
        target.status = 'deleted';
      } else {
        if (jsonBody.note !== undefined) target.note = jsonBody.note;
        if (jsonBody.status !== undefined) target.status = jsonBody.status;
      }
      target.updatedAt = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        comment: target,
        share: { projectId: 'cloud-proj-1', slug: 'share-slug', filePath: 'deck.html', version: 2 },
      }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/collab/share/share-slug/comments') {
      const openOnly = comments.filter((c) => c.status === 'open');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ comments: openOnly, latestSeq: seq, unresolvedTotal: openOnly.filter((c) => !c.parentCommentId).length }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const apiUrl = `http://127.0.0.1:${address.port}`;

  try {
    const aliceStore = new WorkspaceStore(path.join(root, 'alice-ws'));
    const aliceCredDir = path.join(aliceStore.directory, 'account', 'credentials');
    mkdirSync(aliceCredDir, { recursive: true });
    writeFileSync(
      path.join(aliceCredDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'alice-key',
            controlKeyId: 'ck-alice',
            runtimeKey: 'rk-alice',
            user: { id: 'u-alice', name: 'Alice', email: 'alice@example.com' },
          },
        },
      }),
    );

    const mockRecord = {
      schemaVersion: 1 as const,
      targetKind: 'html' as const,
      targetId: 'html-deck',
      cloudProjectId: 'cloud-proj-1',
      projectId: 'html-deck',
      filePath: 'deck.html',
      entryPath: 'deck.html',
      name: 'Launch Deck',
      workspaceId: 'ws-1',
      ownerMemberId: 'm-1',
      resourceId: 'res-1',
      sourceFileId: 'sf-1',
      sourceKey: 'html:html-deck',
      slug: 'share-slug',
      version: 2,
      versionId: 'v2',
      status: 'published' as const,
      url: 'http://127.0.0.1:5180/artifact/cloud-proj-1/share-slug',
      publishedAt: 1700000000000,
      updatedAt: 1700000000000,
      fileCount: 1,
      totalBytes: 128,
      sourceRevision: 'a'.repeat(64),
    };
    const mockPublishService = {
      async publish() {
        return {
          publication: mockRecord,
          deployment: mockRecord,
          url: mockRecord.url,
          updated: false,
        };
      },
      async status() {
        return {
          targetKind: 'html' as const,
          targetId: 'html-deck',
          projectId: 'html-deck',
          accountSignedIn: true,
          publications: [mockRecord],
          deployments: [mockRecord],
          active: mockRecord,
        };
      },
    } as unknown as WebPublishService;

    const deployed = (await cloudDeployOperation(
      aliceStore,
      { action: 'publish', sourcePath: htmlFile },
      'http://127.0.0.1:4179',
      mockPublishService,
    )) as { share?: { projectId: string; slug: string; shareUrl: string } };
    assert.equal(deployed.share?.projectId, 'cloud-proj-1');
    assert.equal(deployed.share?.slug, 'share-slug');

    const aliceAccount = new OpenDesignAccount(aliceStore.directory);
    // Inspect elements by local published target
    const inspected = (await cloudCommentsOperation(
      aliceStore,
      { action: 'inspect_elements', targetKind: 'html', sourcePath: htmlFile },
      'http://127.0.0.1:4179',
      { account: aliceAccount, webPublish: mockPublishService },
    )) as { elements: Array<{ elementId: string; selector: string }> };
    assert.equal(inspected.elements.some((el) => el.selector === '#headline'), true);

    // Alice comments using just selector (auto-resolves htmlHint & elementId from published HTML)
    const rootCreated = (await cloudCommentsOperation(
      aliceStore,
      {
        action: 'comment',
        shareUrl: deployed.share!.shareUrl,
        selector: '#headline',
        note: 'Tighten hero headline spacing',
      },
      'http://127.0.0.1:4179',
      { account: aliceAccount, webPublish: mockPublishService },
    )) as { comment: CloudComment };
    assert.equal(rootCreated.comment.elementId, 'headline');

    // Bob (external user) connects using his own account + Alice's shareUrl
    const bobWsDir = path.join(root, 'bob-ws');
    const bobCredDir = path.join(bobWsDir, 'account', 'credentials');
    mkdirSync(bobCredDir, { recursive: true });
    writeFileSync(
      path.join(bobCredDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'bob-key',
            controlKeyId: 'ck-bob',
            runtimeKey: 'rk-bob',
            user: { id: 'u-bob', name: 'Bob', email: 'bob@example.com' },
          },
        },
      }),
    );
    const bobAccount = new OpenDesignAccount(bobWsDir);

    const bobReply = (await cloudCommentsOperation(
      aliceStore,
      {
        action: 'reply',
        shareUrl: deployed.share!.shareUrl,
        parentCommentId: rootCreated.comment.id,
        note: 'Agreed, +4px top padding looks cleaner.',
      },
      'http://127.0.0.1:4179',
      { account: bobAccount },
    )) as { comment: CloudComment };
    assert.equal(bobReply.comment.parentCommentId, rootCreated.comment.id);

    // Strictly 1-level: replying to Bob's reply rejects with REPLY_DEPTH_EXCEEDED
    await assert.rejects(
      () =>
        cloudCommentsOperation(
          aliceStore,
          {
            action: 'reply',
            shareUrl: deployed.share!.shareUrl,
            parentCommentId: bobReply.comment.id,
            note: 'Nested level 2 should fail',
          },
          'http://127.0.0.1:4179',
          { account: aliceAccount },
        ),
      /REPLY_DEPTH_EXCEEDED/,
    );

    // Signed-out caller can still inspect & list open threads publicly
    const signedOutAccount: CloudCommentsAccountClient = {
      isSignedIn: async () => false,
      cloudApiRequest: async () => {
        throw new Error('ACCOUNT_NOT_SIGNED_IN');
      },
      cloudPublicRequest: aliceAccount.cloudPublicRequest.bind(aliceAccount),
    };
    const publicList = (await cloudCommentsOperation(
      aliceStore,
      { action: 'list', shareUrl: deployed.share!.shareUrl },
      'http://127.0.0.1:4179',
      { account: signedOutAccount },
    )) as { threads: Array<{ id: string; replies: CloudComment[] }>; unresolvedTotal: number };
    assert.equal(publicList.unresolvedTotal, 1);
    assert.equal(publicList.threads.length, 1);
    assert.equal(publicList.threads[0]!.replies.length, 1);

    // Alice resolves root comment; open list now shows 0 unresolved
    await cloudCommentsOperation(
      aliceStore,
      {
        action: 'update',
        shareUrl: deployed.share!.shareUrl,
        commentId: rootCreated.comment.id,
        status: 'resolved',
      },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    );
    const afterResolve = (await cloudCommentsOperation(
      aliceStore,
      { action: 'list', shareUrl: deployed.share!.shareUrl },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    )) as { threads: unknown[]; unresolvedTotal: number };
    assert.equal(afterResolve.unresolvedTotal, 0);
    assert.equal(afterResolve.threads.length, 0);

    // Alice with includeResolved=true sees resolved root + reply
    const ownerResolved = (await cloudCommentsOperation(
      aliceStore,
      { action: 'list', shareUrl: deployed.share!.shareUrl, includeResolved: true },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    )) as { threads: Array<{ status: string; replies: CloudComment[] }> };
    assert.equal(ownerResolved.threads.length, 1);
    assert.equal(ownerResolved.threads[0]!.status, 'resolved');
    assert.equal(ownerResolved.threads[0]!.replies.length, 1);

    // Stdio RPC & HTTP MCP surface check: tools/list includes both tools and HTTP read-token blocks write
    const listRpc = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      aliceStore,
      releaseRegistry,
    );
    const toolNames = ((listRpc as any).result.tools as Array<{ name: string }>).map((t) => t.name);
    assert.equal(toolNames.includes('openmotion_cloud_deploy'), true);
    assert.equal(toolNames.includes('openmotion_cloud_comments'), true);

    const running = await startServer(aliceStore, 0, { editor: false });
    const mcpPort = (running.server.address() as { port: number }).port;
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`;
    try {
      const tokenRes = await fetch(`${mcpOrigin}${MCP_TOKENS_API}`, {
        method: 'POST',
        headers: { Origin: mcpOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'reader', scope: 'read' }),
      });
      assert.equal(tokenRes.status, 201);
      const readToken = (await tokenRes.json()) as { token: string };

      const denied = await fetch(`${mcpOrigin}${MCP_HTTP_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readToken.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'openmotion_cloud_comments',
            arguments: { action: 'list', shareUrl: deployed.share!.shareUrl },
          },
        }),
      });
      const deniedJson = (await denied.json()) as { error?: { code?: number } };
      assert.equal(deniedJson.error?.code, -32003);
    } finally {
      await running.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('cloud comments MCP supports image uploads (comment + reply + image-only) and ?kind=game stage anchors', async () => {
  const { crc32, deflateSync } = await import('node:zlib');
  const root = mkdtempSync(path.join(os.tmpdir(), 'om-cloud-img-game-'));
  const chunk = (type: string, data: Uint8Array) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.byteLength, 0);
    const body = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((1 + 4 * 4) * 3))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const pngPath = path.join(root, 'stage-shot.png');
  const badPath = path.join(root, 'not-image.txt');
  writeFileSync(pngPath, pngBytes);
  writeFileSync(badPath, 'plain text');

  const storedComments: CloudComment[] = [];
  const uploadedTokens = new Map<string, { id: string; contentType: string; sizeBytes: number }>();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunkBuf of req) chunks.push(Buffer.from(chunkBuf));
    const rawBytes = Buffer.concat(chunks);

    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/game-slug/attachments') {
      assert.equal(req.headers.authorization, 'Bearer alice-key');
      assert.equal(req.headers['content-type'], 'image/png');
      assert.deepEqual(rawBytes, pngBytes);
      const id = `att-${++seq}`;
      const uploadToken = `tok-${id}`;
      uploadedTokens.set(uploadToken, { id, contentType: 'image/png', sizeBytes: rawBytes.byteLength });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          attachment: { id, uploadToken, mimeType: 'image/png', sizeBytes: rawBytes.byteLength, width: 4, height: 3 },
          share: { projectId: 'game-proj-1', slug: 'game-slug', filePath: 'index.html', version: 1 },
        }),
      );
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/game-slug/comments') {
      const jsonBody = JSON.parse(rawBytes.toString('utf8')) as {
        parentCommentId?: string;
        note: string;
        elementId?: string;
        selector?: string;
        htmlHint?: string;
        attachments?: Array<{ uploadToken: string; alt?: string }>;
      };
      const projectedAttachments = (jsonBody.attachments ?? []).map((att) => {
        const meta = uploadedTokens.get(att.uploadToken)!;
        return {
          id: meta.id,
          mimeType: meta.contentType as 'image/png',
          sizeBytes: meta.sizeBytes,
          width: 4,
          height: 3,
          ...(att.alt ? { alt: att.alt } : {}),
          url: `/api/v1/collab/client-share/game-slug/attachments/${meta.id}?projectId=game-proj-1`,
        };
      });
      const created: CloudComment = {
        id: `c-${++seq}`,
        seq,
        ...(jsonBody.parentCommentId ? { parentCommentId: jsonBody.parentCommentId } : {}),
        author: { kind: 'user', authorKey: 'alice-hash', displayName: 'Alice' },
        isMine: true,
        note: jsonBody.note,
        ...(projectedAttachments.length > 0 ? { attachments: projectedAttachments } : {}),
        filePath: 'index.html',
        elementId: jsonBody.elementId ?? 'game-stage',
        selector: jsonBody.selector ?? 'body',
        htmlHint: jsonBody.htmlHint ?? '<body>',
        status: 'open',
        createdAt: Date.now() + seq,
        updatedAt: Date.now() + seq,
      };
      storedComments.push(created);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          comment: created,
          share: { projectId: 'game-proj-1', slug: 'game-slug', filePath: 'index.html', version: 1 },
        }),
      );
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/collab/client-share/game-slug/comments') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          share: { projectId: 'game-proj-1', slug: 'game-slug', filePath: 'index.html', version: 1 },
          viewer: { authorKey: 'alice-hash', displayName: 'Alice', isOwner: true },
          comments: storedComments,
          threads: groupCloudCommentThreads(storedComments),
          latestSeq: seq,
          unresolvedTotal: storedComments.filter((c) => !c.parentCommentId).length,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const aliceStore = new WorkspaceStore(path.join(root, 'alice-ws'));
    const credDir = path.join(aliceStore.directory, 'account', 'credentials');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      path.join(credDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'alice-key',
            controlKeyId: 'ck-alice',
            runtimeKey: 'rk-alice',
            user: { id: 'u-alice', name: 'Alice', email: 'alice@example.com' },
          },
        },
      }),
    );
    const aliceAccount = new OpenDesignAccount(aliceStore.directory);
    const gameShareUrl = 'http://127.0.0.1:5180/artifact/game-proj-1/game-slug?kind=game';
    const pageShareUrl = 'http://127.0.0.1:5180/artifact/game-proj-1/game-slug';

    // 1. Image-only Game comment without selector defaults to game-stage anchor
    const rootRes = (await cloudCommentsOperation(
      aliceStore,
      {
        action: 'comment',
        shareUrl: gameShareUrl,
        note: '',
        images: [{ path: pngPath, alt: 'Boss frame' }],
      },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    )) as { comment: CloudComment };
    assert.equal(rootRes.comment.elementId, 'game-stage');
    assert.equal(rootRes.comment.selector, 'body');
    assert.equal(rootRes.comment.htmlHint, '<body>');
    assert.equal(rootRes.comment.note, '');
    assert.equal(rootRes.comment.attachments?.length, 1);
    assert.equal(rootRes.comment.attachments?.[0]?.alt, 'Boss frame');

    // 1b. Non-game normal shareUrl without selector defaults to whole-page page-comment anchor
    const pageRootRes = (await cloudCommentsOperation(
      aliceStore,
      {
        action: 'comment',
        shareUrl: pageShareUrl,
        note: 'Page-wide review with screenshot',
        imagePaths: [pngPath],
      },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    )) as { comment: CloudComment };
    assert.equal(pageRootRes.comment.elementId, 'page-comment');
    assert.equal(pageRootRes.comment.selector, 'body');
    assert.equal(pageRootRes.comment.htmlHint, '<body>');
    assert.equal(pageRootRes.comment.attachments?.length, 1);

    // 1c. targetType="element" still requires selector or elementId
    await assert.rejects(
      () =>
        cloudCommentsOperation(
          aliceStore,
          {
            action: 'comment',
            shareUrl: pageShareUrl,
            targetType: 'element',
            note: 'Missing selector',
          },
          'http://127.0.0.1:4179',
          { account: aliceAccount },
        ),
      /INVALID_ARGUMENT/,
    );

    // 2. Reply with imagePaths
    const replyRes = (await cloudCommentsOperation(
      aliceStore,
      {
        action: 'reply',
        shareUrl: gameShareUrl,
        parentCommentId: rootRes.comment.id,
        note: 'Follow-up screenshot',
        imagePaths: [pngPath],
      },
      'http://127.0.0.1:4179',
      { account: aliceAccount },
    )) as { comment: CloudComment };
    assert.equal(replyRes.comment.parentCommentId, rootRes.comment.id);
    assert.equal(replyRes.comment.attachments?.length, 1);

    // 3. Reject >4 images & invalid non-image files
    await assert.rejects(
      () =>
        cloudCommentsOperation(
          aliceStore,
          {
            action: 'comment',
            shareUrl: gameShareUrl,
            note: 'Too many',
            imagePaths: [pngPath, pngPath, pngPath, pngPath, pngPath],
          },
          'http://127.0.0.1:4179',
          { account: aliceAccount },
        ),
      /up to 4 image attachments/,
    );
    await assert.rejects(
      () =>
        cloudCommentsOperation(
          aliceStore,
          {
            action: 'comment',
            shareUrl: gameShareUrl,
            note: 'Not image',
            imagePaths: [badPath],
          },
          'http://127.0.0.1:4179',
          { account: aliceAccount },
        ),
      /INVALID_ATTACHMENT/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCloudShareUrl + openmotion_cloud_comments support /games/<slug> short links and cloudDeployOperation forwards game visibility', async () => {
  assert.equal(isGameShareUrl('https://open-design.app/games/my-game-slug'), true);
  assert.equal(isGameShareUrl('https://open-design.ai/cloud/games/my-game-slug'), true);
  assert.equal(isGameShareUrl('http://127.0.0.1:5179/artifact/p1/s1?kind=game'), true);
  assert.equal(isGameShareUrl('http://127.0.0.1:5179/artifact/p1/s1'), false);

  assert.deepEqual(parseCloudShareUrl('https://open-design.ai/cloud/games/my-game-slug?foo=bar'), {
    projectId: '',
    slug: 'my-game-slug',
    origin: 'https://open-design.ai',
    shareUrl: 'https://open-design.ai/cloud/games/my-game-slug',
    isGame: true,
  });

  const root = mkdtempSync(path.join(os.tmpdir(), 'om-cloud-game-link-'));
  const postedBodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const jsonBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/games/community-game-slug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          slug: 'community-game-slug',
          projectId: 'proj-game-99',
          entryPath: 'index.html',
          version: 3,
        }),
      );
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/community-game-slug/comments') {
      assert.equal(reqUrl.searchParams.get('projectId'), 'proj-game-99');
      postedBodies.push(jsonBody);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          comment: {
            id: 'gc-1',
            seq: 1,
            author: { kind: 'user', authorKey: 'alice-hash', displayName: 'Alice' },
            isMine: true,
            note: jsonBody.note,
            filePath: 'index.html',
            elementId: jsonBody.elementId,
            selector: jsonBody.selector,
            htmlHint: jsonBody.htmlHint,
            status: 'open',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          share: { projectId: 'proj-game-99', slug: 'community-game-slug', filePath: 'index.html', version: 3 },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;

  try {
    const store = new WorkspaceStore(path.join(root, 'ws'));
    const credDir = path.join(store.directory, 'account', 'credentials');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      path.join(credDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'alice-key',
            controlKeyId: 'ck-alice',
            runtimeKey: 'rk-alice',
            user: { id: 'u-alice', name: 'Alice', email: 'alice@example.com' },
          },
        },
      }),
    );
    const account = new OpenDesignAccount(store.directory);

    const commentRes = (await cloudCommentsOperation(
      store,
      {
        action: 'comment',
        shareUrl: 'http://127.0.0.1:5179/games/community-game-slug',
        note: 'Great boss fight tuning!',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment; share: { projectId: string; slug: string } };
    assert.equal(commentRes.comment.elementId, 'game-stage');
    assert.equal(commentRes.share.projectId, 'proj-game-99');
    assert.equal(postedBodies[0]?.expectedVersion, 3);

    let capturedVisibility: Record<string, unknown> | null = null;
    const games = gameProjectsFor(store.directory);
    const createdGame = await games.create({
      title: 'Community Game',
      description: 'Test game',
      prompt: 'Build a fast neon shooter game',
      orientation: 'landscape',
      controls: 'Space',
      genre: 'shooter',
      multiplayer: false,
    });
    const mockGameService = {
      async setVisibility(_target: unknown, opts: Record<string, unknown>) {
        capturedVisibility = opts;
        return {
          url: 'http://127.0.0.1:5179/games/community-game-slug',
          communityUrl: 'http://127.0.0.1:5179/games/community-game-slug',
          publication: {
            projectId: 'proj-game-99',
            cloudProjectId: 'proj-game-99',
            slug: 'community-game-slug',
            visibility: opts.visibility,
          },
        };
      },
    } as unknown as WebPublishService;

    const visRes = (await cloudDeployOperation(
      store,
      {
        action: 'visibility',
        targetKind: 'game',
        targetId: createdGame.game.id,
        visibility: 'unlisted',
        allowRemix: false,
      },
      'http://127.0.0.1:4179',
      mockGameService,
    )) as { share?: { projectId: string; slug: string; isGame?: boolean } };
    assert.deepEqual(capturedVisibility, { filePath: undefined, visibility: 'unlisted', allowRemix: false });
    assert.equal(visRes.share?.projectId, 'proj-game-99');
    assert.equal(visRes.share?.slug, 'community-game-slug');
    assert.equal(visRes.share?.isGame, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCloudShareUrl preserves ?kind=game and trackingError keeps Cloud media and plan error codes', () => {
  const parsed = parseCloudShareUrl('https://open-design.app/artifact/p1/s1?kind=game&foo=bar');
  assert.equal(parsed.isGame, true);
  assert.equal(parsed.shareUrl, 'https://open-design.app/artifact/p1/s1?kind=game');
  assert.equal(isGameShareUrl(parsed.shareUrl), true);

  for (const code of [
    'PRIVATE_SHARE_REQUIRES_PAID_PLAN',
    'INVALID_ATTACHMENT',
    'UPLOAD_FAILED',
    'UPLOAD_UNAVAILABLE',
    'PAYLOAD_TOO_LARGE',
  ] as const) {
    assert.equal(trackingError(new CloudApiError(403, code, `${code}: detail`)), code);
    assert.equal(trackingError(new Error(`${code}: detail`)), code);
  }
});

test('CloudCommentsService comments on elements past index 200 and preserves caller idempotencyKey across image comment/reply retries', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'om-cloud-240-retry-'));
  const buttons = Array.from({ length: 240 }, (_, i) => `<button id="choice-${i}">Choice ${i}</button>`).join('');
  const html240 = `<!doctype html><html><body><div id="choices">${buttons}</div></body></html>`;
  const pngPath = path.join(root, 'shot.png');
  writeFileSync(
    pngPath,
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]),
  );

  let uploadSeq = 0;
  let commentSeq = 0;
  const storedByKey = new Map<string, CloudComment>();
  const storedComments: CloudComment[] = [];

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);

    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/large-slug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug: 'large-slug', snapshotSlug: 'snap-240', entryPath: 'index.html', version: 1 }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/v1/public/snapshots/snap-240/files/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html240);
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/large-slug/attachments') {
      uploadSeq += 1;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          attachment: {
            id: `att-up-${uploadSeq}`,
            uploadToken: `tok-${uploadSeq}`,
            mimeType: 'image/png',
            sizeBytes: raw.byteLength,
            width: 1,
            height: 1,
          },
        }),
      );
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/api/v1/collab/client-share/large-slug/comments') {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const key = String(body.idempotencyKey ?? '');
      const existing = storedByKey.get(key);
      if (existing) {
        if (existing.note !== body.note || existing.parentCommentId !== body.parentCommentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'INVALID_COMMENT' }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            comment: existing,
            share: { projectId: 'proj-240', slug: 'large-slug', filePath: 'index.html', version: 1 },
          }),
        );
        return;
      }
      commentSeq += 1;
      const attachments = Array.isArray(body.attachments)
        ? (body.attachments as Array<{ uploadToken: string; alt?: string }>).map((att, idx) => ({
            id: `att-saved-${commentSeq}-${idx}`,
            mimeType: 'image/png' as const,
            sizeBytes: 67,
            width: 1,
            height: 1,
            ...(att.alt ? { alt: att.alt } : {}),
            url: `/api/v1/collab/share/large-slug/attachments/att-saved-${commentSeq}-${idx}`,
          }))
        : undefined;
      const created: CloudComment = {
        id: `c-${commentSeq}`,
        seq: commentSeq,
        ...(typeof body.parentCommentId === 'string' ? { parentCommentId: body.parentCommentId } : {}),
        author: { kind: 'user', authorKey: 'alice-hash', displayName: 'Alice' },
        isMine: true,
        note: String(body.note ?? ''),
        ...(attachments ? { attachments } : {}),
        filePath: 'index.html',
        elementId: String(body.elementId ?? 'choice-239'),
        selector: String(body.selector ?? '#choice-239'),
        htmlHint: String(body.htmlHint ?? '<button id="choice-239">'),
        status: 'open',
        createdAt: 1000 + commentSeq,
        updatedAt: 1000 + commentSeq,
      };
      storedByKey.set(key, created);
      storedComments.push(created);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          comment: created,
          share: { projectId: 'proj-240', slug: 'large-slug', filePath: 'index.html', version: 1 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const store = new WorkspaceStore(path.join(root, 'ws'));
    const credDir = path.join(store.directory, 'account', 'credentials');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      path.join(credDir, 'config.json'),
      JSON.stringify({
        profiles: {
          prod: {
            apiUrl,
            controlKey: 'alice-key',
            controlKeyId: 'ck-alice',
            runtimeKey: 'rk-alice',
            user: { id: 'u-alice', name: 'Alice', email: 'alice@example.com' },
          },
        },
      }),
    );
    const account = new OpenDesignAccount(store.directory);

    const inspected = (await cloudCommentsOperation(
      store,
      {
        action: 'inspect_elements',
        shareUrl: 'https://open-design.app/artifact/proj-240/large-slug',
        query: '#choice-239',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { elements: Array<{ selector: string; elementId: string }> };
    assert.equal(inspected.elements[0]?.selector, '#choice-239');

    const root1 = (await cloudCommentsOperation(
      store,
      {
        action: 'comment',
        shareUrl: 'https://open-design.app/artifact/proj-240/large-slug',
        selector: '#choice-239',
        note: 'Anchor on 240th choice',
        imagePaths: [pngPath],
        idempotencyKey: 'retry-root-key',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment };
    assert.equal(root1.comment.elementId, 'choice-239');
    assert.equal(root1.comment.selector, '#choice-239');
    assert.equal(root1.comment.htmlHint, '<button id="choice-239">');

    const rootRetry = (await cloudCommentsOperation(
      store,
      {
        action: 'comment',
        shareUrl: 'https://open-design.app/artifact/proj-240/large-slug',
        selector: '#choice-239',
        note: 'Anchor on 240th choice',
        imagePaths: [pngPath],
        idempotencyKey: 'retry-root-key',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment };
    assert.equal(rootRetry.comment.id, root1.comment.id);
    assert.equal(rootRetry.comment.attachments?.[0]?.id, root1.comment.attachments?.[0]?.id);
    assert.equal(storedComments.length, 1);

    const reply1 = (await cloudCommentsOperation(
      store,
      {
        action: 'reply',
        shareUrl: 'https://open-design.app/artifact/proj-240/large-slug',
        parentCommentId: root1.comment.id,
        note: 'Reply screenshot',
        imagePaths: [pngPath],
        idempotencyKey: 'retry-reply-key',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment };

    const replyRetry = (await cloudCommentsOperation(
      store,
      {
        action: 'reply',
        shareUrl: 'https://open-design.app/artifact/proj-240/large-slug',
        parentCommentId: root1.comment.id,
        note: 'Reply screenshot',
        imagePaths: [pngPath],
        idempotencyKey: 'retry-reply-key',
      },
      'http://127.0.0.1:4179',
      { account },
    )) as { comment: CloudComment };
    assert.equal(replyRetry.comment.id, reply1.comment.id);
    assert.equal(replyRetry.comment.attachments?.[0]?.id, reply1.comment.attachments?.[0]?.id);
    assert.equal(storedComments.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
