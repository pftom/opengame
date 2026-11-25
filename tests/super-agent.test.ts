import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { designHttp, designProjectsFor } from '../design-projects.ts';
import { gameHttp, gameProjectsFor } from '../game-projects.ts';
import { injectPreviewBridgeHtml, isValidPreviewBridgeToken } from '../shared/preview-bridge.ts';
import { Phase1Service } from '../phase1.ts';
import { AssetLibrary } from '../gateway/asset-library.ts';
import { pluginRoot } from '../hyperframes.ts';
import {
  CLAUDE_SUPER_AGENT_INSTRUCTIONS,
  SUPER_AGENT_INSTRUCTIONS,
  SuperAgentConversations,
  extractLocalDevServerUrl,
  formatBrowserAnnotationsContext,
  superAgentConversations,
} from '../gateway/super-agent.ts';
import {
  captureWorkspaceSnapshot,
  collectTaskProjectRoots,
  diffWorkspaceSnapshots,
  listTaskWorkspaceEntries,
  resolveTaskProjectDir,
} from '../gateway/super-agent-workspace.ts';
import { gameAssetInstructions } from '../shared/game-contract.ts';
import { buildResourceContextManifest, collectWorkspaceResources } from '../gateway/super-agent-resources.ts';
import {
  registerCapabilityScriptExecutor,
  saveCapabilityOverrides,
  unregisterCapabilityScriptExecutor,
} from '../gateway/capability-center.ts';
import {
  classifySuperAgentTool, describeSuperAgentApproval, formatSuperAgentToolLabel,
  summarizeSuperAgentChat, superAgentIntentMeta, type SuperAgentChat, type SuperAgentResourceCatalog,
} from '../shared/super-agent.ts';
import { designScenarios } from '../shared/design-project.ts';
import { execute } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import { AssetAgentRpc } from '../gateway/asset-chat.ts';
import { buildSuperAgentHandoff } from '../shared/capability-hub.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';

test('Super Agent uses distinct task icons for design scenarios, media, and standalone modes', () => {
  const chat: SuperAgentChat = {
    id: 'task', title: 'Task', engine: 'codex', permissionMode: 'auto',
    state: 'running', messages: [], artifacts: [], approvals: [], createdAt: 1, updatedAt: 1,
  };
  const icon = (overrides: Partial<SuperAgentChat>) => {
    const summary = summarizeSuperAgentChat({ ...chat, ...overrides });
    return superAgentIntentMeta(summary.intent, summary).icon;
  };
  const designIcons = designScenarios.map(scenario => {
    const designIcon = icon({
      intent: 'website',
      artifacts: [{ id: 'project', kind: 'design-project', title: 'Project', scenario: scenario.id, createdAt: 1, updatedAt: 1 }],
    });
    assert.equal(designIcon, scenario.icon);
    return designIcon;
  });
  const otherIcons = (['chat', 'coding', 'design', 'research', 'visualization', 'image', 'video', 'audio', 'game', 'brand'] as const)
    .map(intent => icon({ intent }));
  const generatedVideoIcon = icon({
    intent: 'video',
    artifacts: [{ id: 'video', kind: 'asset-video', title: 'Video', createdAt: 1, updatedAt: 1 }],
  });
  const icons = [...designIcons, ...otherIcons, generatedVideoIcon];
  assert.equal(new Set(icons).size, icons.length);

  const firstPrompt = { id: 'prompt', role: 'user', text: 'Make this', createdAt: 1 } as const;
  assert.equal(icon({
    intent: 'design',
    messages: [{ ...firstPrompt, contextTags: [{ kind: 'mode', label: 'Design Studio', designScenario: 'document' }] }],
  }), 'file-text-line');
  assert.equal(icon({
    intent: 'website',
    messages: [{ ...firstPrompt, attachments: [{ id: 'template', kind: 'design-template', title: 'Template', scenario: 'web-clone' }] }],
  }), 'global-line');
  assert.equal(icon({
    intent: 'slides',
    artifacts: [{ id: 'report', kind: 'design-project', title: 'Report', scenario: 'document', createdAt: 1, updatedAt: 1 }],
    messages: [{ ...firstPrompt, contextTags: [{ kind: 'mode', label: 'Research', icon: 'book-open-line' }] }],
  }), 'book-open-line');
});

test('collectWorkspaceResources and buildResourceContextManifest aggregate workspace inputs and filter cleanly', () => fixture(async store => {
  await designProjectsFor(store.directory).create({
    scenario: 'prototype',
    title: 'Neon Space Game',
    requestId: 'req-design-1',
  });

  const all = await collectWorkspaceResources(store, { limit: 100 });
  assert.ok(all.counts.designProjects >= 1);
  assert.ok(all.counts.motionProjects >= 1);
  assert.ok(all.counts.officialBrandKits > 0);
  assert.ok(all.counts.designTemplates > 0);
  assert.ok(all.counts.skills > 0);
  assert.ok(all.counts.designSkills > 0);

  const projectsOnly = await collectWorkspaceResources(store, { kind: 'design-project', query: 'Neon Space' });
  assert.equal(projectsOnly.items.length, 1);
  assert.equal(projectsOnly.items[0].kind, 'design-project');
  assert.equal(projectsOnly.items[0].title, 'Neon Space Game');

  const manifest = await buildResourceContextManifest(store, [
    { id: 'brand-ref', kind: 'brand-kit', title: 'Reference Brand', subtitle: 'editorial' },
  ]);
  assert.match(manifest, /^<openmotion-workspace-context>/);
  assert.match(manifest, /Neon Space Game/);
  assert.match(manifest, /Reference Brand/);
}));

test('resource searches match both Chinese display titles and English titles for workflows and skills', () => fixture(async store => {
  const request = transport(store);
  const cases = [
    { kind: 'workflow', id: 'motion-full-chain', title: 'Idea to Motion Film', zh: '创意到动效短片' },
    { kind: 'skills', id: 'openmotion-ad-script', title: 'Product ad script', zh: '带货短视频脚本' },
    { kind: 'skills', id: 'design-brief', title: 'Design Brief', zh: '设计简报' },
  ];
  for (const { kind, id, title, zh } of cases) {
    for (const [category, query] of [[kind, title], [kind, zh], ['all', zh]]) {
      const params = new URLSearchParams({ kind: category, query, limit: '200' });
      const response = await request('/motion-api/super-agent/resources?' + params);
      assert.equal(response.status, 200);
      const result = await response.json() as SuperAgentResourceCatalog;
      assert.ok(result.items.some(item => item.id === id && item.title === title), `${category}: ${query}`);
    }
  }
}));

test('SuperAgentConversations persists CRUD state, recovers interrupted runs, and enforces requestId idempotency', () => fixture(async store => {
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
  });

  const created = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  assert.equal(created.state, 'idle');
  assert.equal(created.title, 'New conversation');

  const updated = await service.update(created.id, {
    title: 'Interactive Game Build',
    pinned: true,
    permissionMode: 'auto',
    addArtifact: { kind: 'web', url: 'https://example.com/docs' },
  });
  assert.equal(updated.title, 'Interactive Game Build');
  assert.equal(updated.pinned, true);
  assert.equal(updated.permissionMode, 'auto');
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].kind, 'web');

  await assert.rejects(
    () => service.update(created.id, { addArtifact: { kind: 'design-project', url: 'javascript:alert(1)' } as any }),
    /same-origin/,
  );

  // Persist running state on disk directly to verify restart interruption recovery.
  const file = await service.file(created.id);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({
    ...updated,
    state: 'running',
    approvals: [{ id: 'a1', kind: 'tool', title: 'Pending', detail: '{}' }],
    requestReceipts: [{ requestId: 'req-new-turn', inputHash: 'fixture-hash' }],
  }));
  const reloaded = new SuperAgentConversations(store);
  const recovered = await reloaded.get(created.id);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.approvals.length, 0);
  assert.match(recovered.error || '', /interrupted/i);

  const list = await reloaded.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].pinned, true);
  assert.equal(list[0].lastTurnId, 'req-new-turn');

  await reloaded.remove(created.id);
  await assert.rejects(() => reloaded.get(created.id), /CONVERSATION_NOT_FOUND/);
  await reloaded.close();
  await service.close();
}));

test('SuperAgentConversations runs Codex RPC dynamic tools, extracts artifacts, gates approvals, and deduplicates requestId', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const toolCallsSeen: string[] = [];
  let approvalPrompted = false;

  class FakeRpc {
    onNotification: (msg: any) => void;
    sent: any[] = [];
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string, params: any) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-codex-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          // 1. Call workspace resource discovery dynamic tool
          this.onNotification({
            id: 101,
            method: 'item/tool/call',
            params: { callId: 'c1', tool: 'openmotion_workspace_resources', arguments: { kind: 'all' } },
          });
        });
        return { turn: { id: 'turn-1' } };
      }
      return {};
    }

    send(payload: any) {
      this.sent.push(payload);
      if (payload.id === 101) {
        toolCallsSeen.push('resources');
        queueMicrotask(() => {
          // 2. Call design project create (auto-extracts design-project artifact)
          this.onNotification({
            id: 102,
            method: 'item/tool/call',
            params: {
              callId: 'c2',
              tool: 'openmotion_design_project',
              arguments: { action: 'create', scenario: 'prototype', title: 'Retro Shooter' },
            },
          });
        });
      }
      if (payload.id === 102) {
        toolCallsSeen.push('design');
        queueMicrotask(() => {
          // 3. Call present_artifact for official Brand Kit catalog entry
          this.onNotification({
            id: 103,
            method: 'item/tool/call',
            params: {
              callId: 'c3',
              tool: 'openmotion_present_artifact',
              arguments: { kind: 'brand-kit', kitId: 'catalog:vercel' },
            },
          });
        });
      }
      if (payload.id === 103) {
        toolCallsSeen.push('present');
        queueMicrotask(() => {
          // 4. Request command approval under on-request policy
          approvalPrompted = true;
          this.onNotification({
            id: 104,
            method: 'item/commandExecution/requestApproval',
            params: { command: 'echo hello' },
          });
        });
      }
      if (payload.id === 104) {
        assert.equal(payload.result?.decision, 'accept');
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg-a1', delta: 'Built **Retro Shooter** ' },
          });
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-a1', type: 'agentMessage', text: 'Built **Retro Shooter** in Design Studio.' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: FakeRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  const runtime = { origin: 'http://127.0.0.1:4173', phase1: () => phase1 };
  const turnInput = { requestId: 'req-turn-1', text: 'Build a retro arcade shooter game' };

  await service.start(chat.id, turnInput, runtime);
  // Idempotent retry with identical requestId succeeds; mismatched input fails with REQUEST_ID_CONFLICT
  await service.start(chat.id, turnInput, runtime);
  await assert.rejects(
    () => service.start(chat.id, { requestId: 'req-turn-1', text: 'Different prompt' }, runtime),
    /REQUEST_ID_CONFLICT/,
  );

  // Wait for approval prompt to arrive
  for (let i = 0; i < 60 && !approvalPrompted; i++) {
    await new Promise(r => setTimeout(r, 15));
  }
  const waiting = await service.get(chat.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.approvals.length, 1);

  await service.answer(chat.id, waiting.approvals[0].id, true);

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.title, 'Build a retro arcade shooter game');
  assert.deepEqual(toolCallsSeen, ['resources', 'design', 'present']);
  assert.ok(done.artifacts.some(a => a.kind === 'design-project' && a.title === 'Retro Shooter'));
  assert.ok(done.artifacts.some(a => a.kind === 'brand-kit' && a.kitId === 'catalog:vercel'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text.includes('Retro Shooter')));
  assert.ok(done.messages.some(m => m.role === 'tool' && m.toolEvent?.artifactId));

  await service.close();
}));

test('SuperAgentConversations runs Claude Code stream-json turns and extracts artifacts', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/claude',
    runClaude: async ({ prompt, onEvent }) => {
      assert.match(prompt, /<openmotion-workspace-context>/);
      await onEvent({ type: 'system', session_id: 'claude-sess-42' });
      await onEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__openmotion__openmotion_create_project',
              input: { title: 'Launch Reel' },
            },
          ],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: JSON.stringify({ projectId: 'mproj-1', sessionId: 'msess-1', revision: 'rev1', project: { title: 'Launch Reel' } }),
            },
          ],
        },
      });
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Created your editable Motion project.' }] },
      });
    },
  });

  const chat = await service.create({ engine: 'claude', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-claude-1', text: 'Create a launch reel' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.threadId, 'claude-sess-42');
  assert.ok(done.artifacts.some(a => a.kind === 'motion-project' && a.projectId === 'mproj-1'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text === 'Created your editable Motion project.'));

  await service.close();
}));

test('HTTP /motion-api/super-agent/* routes serve resources, CRUD chats, SSE initial frame, and clean errors', () => fixture(async store => {
  const req = transport(store);

  const resRes = await req('/motion-api/super-agent/resources?kind=design-template&limit=5');
  assert.equal(resRes.status, 200);
  const resBody = await resRes.json();
  assert.ok(resBody.counts.designTemplates > 0);
  assert.ok(resBody.items.length > 0);

  const createdRes = await req('/motion-api/super-agent/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'codex', title: 'HTTP Chat' }),
  });
  assert.equal(createdRes.status, 200);
  const created = (await createdRes.json()).conversation;
  assert.equal(created.title, 'HTTP Chat');

  const patchRes = await req(`/motion-api/super-agent/chats/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true, addArtifact: { kind: 'web', url: 'https://open-design.ai' } }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).conversation;
  assert.equal(patched.pinned, true);
  assert.equal(patched.artifacts[0].kind, 'web');

  const missingRes = await req('/motion-api/super-agent/chats/not-a-uuid');
  assert.equal(missingRes.status, 404);

  const listRes = await req('/motion-api/super-agent/chats');
  assert.equal(listRes.status, 200);
  assert.equal((await listRes.json()).conversations.length, 1);

  const delRes = await req(`/motion-api/super-agent/chats/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal((await req(`/motion-api/super-agent/chats/${created.id}`)).status, 404);

  await superAgentConversations(store).close();
}));

test('local Claude runtime enforces on-request approvals for paid generation through the host MCP bridge', () => fixture(async store => {
  const { readFile } = await import('node:fs/promises');
  let generationExecuted = false;
  const phase1: any = {
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'openmotion_assets_use' && args.action === 'generate') {
        generationExecuted = true;
        return { job: { id: 'job-claude-1', state: 'queued' } };
      }
      return {};
    },
  };

  let approvalObserved = false;
  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/usr/local/bin/claude',
    runClaude: async ({ mcpConfigPath, onEvent }) => {
      const cfg = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
      const server = cfg.mcpServers.openmotion;
      assert.equal(server.type, 'http');
      const callPromise = fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...server.headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: { action: 'generate', modality: 'image', prompt: 'neon poster' },
          },
        }),
      });
      // Wait for approval gate to appear
      for (let i = 0; i < 60; i++) {
        const current = await service.get(chat.id);
        if (current.approvals.length > 0) {
          approvalObserved = true;
          assert.equal(current.state, 'waiting');
          assert.equal(generationExecuted, false);
          await service.answer(chat.id, current.approvals[0].id, true);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const res = await callPromise;
      const body = await res.json() as any;
      assert.equal(body.result.isError, false);
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Queued your image after approval.' }] },
      });
    },
  });

  const chat = await service.create({ engine: 'claude', permissionMode: 'on-request' });
  await service.start(chat.id, { requestId: 'req-claude-approval-1', text: 'Generate a neon poster' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const done = await service.get(chat.id);
  assert.equal(approvalObserved, true);
  assert.equal(generationExecuted, true);
  assert.equal(done.state, 'idle');
  await service.close();
}));

test('Super Agent limits saved Design comment mutations to the current message attachments', () => fixture(async store => {
  const { readFile } = await import('node:fs/promises');
  const origin = 'http://127.0.0.1:4173';
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => origin,
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });
  const design = designProjectsFor(store.directory);
  const project = await design.create({ scenario: 'deck', title: 'Review scope', requestId: 'review-scope' });
  const addComment = (text: string, requestId: string) => design.createComment(project.id, {
    text, requestId, expectedRevision: project.revision,
    anchor: {
      filePath: project.entry,
      viewport: { id: 'desktop', width: 800, height: 450 },
      region: { x: 10, y: 20, width: 100, height: 50 },
    },
  });
  const { comment: attached } = await addComment('Edit this heading', 'selected-comment');
  const { comment: other } = await addComment('Keep this second comment open', 'other-comment');
  const otherTarget = { projectId: project.id, commentId: other.id };
  let turn = 0;
  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/fake/claude',
    runClaude: async ({ mcpConfigPath, prompt }) => {
      const config = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
      const server = config.mcpServers.openmotion;
      let id = 0;
      const call = async (args: Record<string, unknown>) => {
        const res = await fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...server.headers },
          body: JSON.stringify({
            jsonrpc: '2.0', id: ++id, method: 'tools/call',
            params: { name: 'openmotion_design_comments', arguments: args },
          }),
        });
        const body = await res.json() as { result: { isError: boolean; content: { text: string }[] } };
        return body.result;
      };
      if (++turn === 1) {
        assert.match(prompt, /saved Design comments attached to the current message/);
        assert.equal((await call({ action: 'list', projectId: project.id })).isError, false);
        const denied = await call({ ...otherTarget, action: ' update ', status: 'resolved' });
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /attached to the current message/);
        assert.equal((await call({ ...otherTarget, action: 'delete' })).isError, true);
        const wrongProject = await call({
          action: 'update', status: 'resolved',
          projectId: '11111111-1111-4111-8111-111111111111',
          commentId: attached.id,
        });
        assert.equal(wrongProject.isError, true);
        assert.match(wrongProject.content[0].text, /attached to the current message/);
        assert.equal((await call({
          action: 'update', status: 'resolved', expectedCommentRevision: attached.commentRevision,
          projectId: project.id.toUpperCase(), commentId: attached.id.toUpperCase(),
        })).isError, false);
      } else {
        assert.doesNotMatch(prompt, /saved Design comments attached to the current message/);
        assert.equal((await call({ ...otherTarget, action: 'update', status: 'resolved' })).isError, false);
      }
    },
  });
  try {
    const chat = await service.create({ engine: 'claude' });
    const runtime = { origin, phase1: () => phase1 };
    await service.start(chat.id, {
      requestId: 'review-scoped',
      text: 'Apply the attached comment.',
      attachments: [{
        id: 'saved-design-comment',
        kind: 'browser-annotation',
        title: attached.text,
        annotation: {
          mode: 'design-comment', pageUrl: project.previewUrl, projectId: project.id, commentId: attached.id,
        },
      }],
    }, runtime);
    const scopedTurn = await service.waitForChat(chat.id);
    assert.equal(scopedTurn.state, 'idle', scopedTurn.error);
    const states = async () => (await design.listComments(project.id)).comments.map(({ id, status }) => [id, status]);
    assert.deepEqual(await states(), [[attached.id, 'resolved'], [other.id, 'open']]);

    await service.start(chat.id, { requestId: 'review-unbound', text: 'Resolve the remaining comment.' }, runtime);
    const unboundTurn = await service.waitForChat(chat.id);
    assert.equal(unboundTurn.state, 'idle', unboundTurn.error);
    assert.deepEqual(await states(), [[attached.id, 'resolved'], [other.id, 'resolved']]);
  } finally {
    await service.close();
  }
}));

test('deleting a conversation during an in-flight tool call prevents recreating the chat file', () => fixture(async store => {
  const { existsSync } = await import('node:fs');
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>(resolve => { toolStarted = resolve; });
  const phase1: any = {
    call: async () => {
      toolStarted();
      await new Promise<void>(resolve => { releaseTool = resolve; });
      return { ok: true };
    },
  };

  class DeleteRaceRpc {
    onNotification: (msg: any) => void;
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-del-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/tool/call',
            id: 50,
            params: { tool: 'openmotion_create_project', callId: 'call-del-1', arguments: { title: 'Race' } },
          });
        });
        return { turn: { id: 'turn-del-1' } };
      }
      return {};
    }

    send() {}

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: DeleteRaceRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-del-race-1', text: 'Create project' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  await toolStartedPromise;
  const removePromise = service.remove(chat.id);
  releaseTool();
  await removePromise;

  const chatPath = path.join(store.directory, 'super-agent', 'chats', `${chat.id}.json`);
  assert.equal(existsSync(chatPath), false);
  await assert.rejects(() => service.get(chat.id), /CONVERSATION_NOT_FOUND/);
  await service.close();
}));

test('SuperAgentConversations supports game intent, initial game artifact, openmotion_game_* live updates, and GET /api/games/:id/files', () => fixture(async store => {
  const createdGame = await gameProjectsFor(store.directory).create({
    prompt: 'Neon space drifter',
    genre: 'shooter',
    style: 'pixel',
    setting: 'space',
    multiplayer: false,
    orientation: 'portrait',
    playableAd: true,
  });
  const gameId = createdGame.game.id;

  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  class GameToolRpc {
    onNotification: (msg: any) => void;
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-game-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 201,
            method: 'item/tool/call',
            params: {
              callId: 'g1',
              tool: 'openmotion_game_write_files',
              arguments: {
                id: gameId,
                files: [
                  { path: 'index.html', content: '<!doctype html><canvas id="c"></canvas><script src="./logic.js"></script>' },
                  { path: 'logic.js', content: 'window.__GAME_READY__ = true;' },
                ],
              },
            },
          });
        });
        return { turn: { id: 'turn-game-1' } };
      }
      return {};
    }

    send(payload: any) {
      if (payload.id === 201) {
        queueMicrotask(() => {
          this.onNotification({
            id: 202,
            method: 'item/tool/call',
            params: {
              callId: 'g2',
              tool: 'openmotion_game_update_meta',
              arguments: {
                id: gameId,
                title: 'Star Drifter 99',
                description: 'Portrait space wave dodger',
                controls: 'Move with arrow keys',
              },
            },
          });
        });
      }
      if (payload.id === 202) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-g1', type: 'agentMessage', text: 'Updated **Star Drifter 99**.' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-game-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: GameToolRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
    initialArtifact: {
      id: `game:${gameId}`,
      kind: 'game-project',
      title: createdGame.game.title,
      subtitle: 'shooter · Game Studio',
      projectId: gameId,
      scenario: 'portrait',
      url: `/motion-api/games/${gameId}/play/index.html`,
    },
  });
  assert.equal(chat.intent, 'game');
  assert.equal(chat.activeArtifactId, `game:${gameId}`);
  assert.equal((await service.get(chat.id)).artifacts[0].playableAd, true);

  await service.start(chat.id, {
    requestId: 'req-game-turn-1',
    mode: 'game',
    text: `Update game ${gameId} with faster meteors`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.intent, 'game');
  assert.equal(done.title, 'Star Drifter 99');
  const gameArtifact = done.artifacts.find(item => item.kind === 'game-project' && item.projectId === gameId);
  assert.ok(gameArtifact);
  assert.equal(gameArtifact.title, 'Star Drifter 99');
  assert.equal(gameArtifact.scenario, 'portrait');
  assert.equal(gameArtifact.playableAd, true);
  assert.equal(gameArtifact.subtitle, 'shooter · Playable ad');
  assert.equal(gameArtifact.url, `/motion-api/games/${gameId}/play/index.html`);
  assert.equal(done.activeArtifactId, gameArtifact.id);

  // Verify GET /api/games/:id/files HTTP handler returns written game source inventory
  let statusCode = 0;
  let bodyText = '';
  const handled = await gameHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number) { statusCode = code; },
      end(chunk: string) { bodyText += chunk; },
    } as any,
    new URL(`http://127.0.0.1:4173/api/games/${encodeURIComponent(gameId)}/files`),
    store.directory,
    async () => ({}),
  );
  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  const filesRes = JSON.parse(bodyText) as { files: Array<{ path: string; bytes: number }> };
  assert.ok(filesRes.files.some(f => f.path === 'index.html'));
  assert.ok(filesRes.files.some(f => f.path === 'logic.js'));

  const renamed = await service.update(chat.id, { title: '新游戏名' });
  assert.equal(renamed.title, '新游戏名');
  assert.equal(renamed.activeArtifactId, gameArtifact.id);
  const renamedGame = renamed.artifacts.find(item => item.id === gameArtifact.id);
  assert.equal(renamedGame?.title, renamed.title);
  assert.equal(renamedGame?.url, gameArtifact.url);
  assert.equal(renamedGame?.playableAd, true);
  assert.equal((await gameProjectsFor(store.directory).get(gameId)).title, renamed.title);
  assert.match((await gameProjectsFor(store.directory).read(gameId, 'index.html')).content, /<title>新游戏名<\/title>/);
  assert.equal((await service.get(chat.id)).artifacts.find(item => item.id === gameArtifact.id)?.title, renamed.title);

  await service.close();
}));

test('game generation suppresses premature starter-kit artifacts during building and auto-presents on ready or turn completion', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });
  const draftA = await gameProjectsFor(store.directory).create({
    prompt: 'Starlit little prince planet exploration game',
    genre: 'story',
    orientation: 'landscape',
    multiplayer: false,
  });
  const gameIdA = draftA.game.id;
  assert.equal(draftA.game.status, 'draft');

  let turnCount = 0;
  let capturedSnapshots: Array<{ step: string; count: number; active?: string }> = [];
  let serviceRef!: SuperAgentConversations;
  let chatIdA = '';

  class StagedGameRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-staged-game' } };
      if (method === 'turn/start') {
        turnCount += 1;
        if (turnCount === 1) {
          queueMicrotask(() => {
            this.onNotification({
              id: 301,
              method: 'item/tool/call',
              params: {
                callId: 'sg-1',
                tool: 'openmotion_game_read_file',
                arguments: { id: gameIdA, path: 'index.html' },
              },
            });
          });
        } else {
          queueMicrotask(() => {
            this.onNotification({
              id: 311,
              method: 'item/tool/call',
              params: {
                callId: 'sg-4',
                tool: 'openmotion_game_write_files',
                arguments: {
                  id: gameIdA,
                  files: [
                    { path: 'index.html', content: '<!doctype html><title>Celestial Star Journey</title><canvas id="sky"></canvas>' },
                    { path: 'logic.js', content: 'export const version = 2;' },
                  ],
                },
              },
            });
          });
        }
        return { turn: { id: `turn-staged-${turnCount}` } };
      }
      return {};
    }
    send(payload: any) {
      const recordAndSend = async (step: string, nextMsg: any) => {
        const snap = await serviceRef.get(chatIdA);
        capturedSnapshots.push({ step, count: snap.artifacts.length, active: snap.activeArtifactId });
        this.onNotification(nextMsg);
      };
      if (payload.id === 301) {
        void recordAndSend('after_read', {
          id: 302,
          method: 'item/tool/call',
          params: {
            callId: 'sg-2',
            tool: 'openmotion_game_set_status',
            arguments: { id: gameIdA, status: 'building' },
          },
        });
      } else if (payload.id === 302) {
        void recordAndSend('after_building', {
          id: 303,
          method: 'item/tool/call',
          params: {
            callId: 'sg-3',
            tool: 'openmotion_game_write_files',
            arguments: {
              id: gameIdA,
              files: [{ path: 'design/style.md', content: '# Visual Style\nWarm gouache starfields.' }],
            },
          },
        });
      } else if (payload.id === 303) {
        void recordAndSend('after_style_md', {
          method: 'turn/completed',
          params: { turn: { id: 'turn-staged-1', status: 'completed' } },
        });
      } else if (payload.id === 311) {
        void recordAndSend('after_code_still_building', {
          id: 312,
          method: 'item/tool/call',
          params: {
            callId: 'sg-5',
            tool: 'openmotion_game_update_meta',
            arguments: {
              id: gameIdA,
              title: 'Celestial Star Journey',
              description: 'Gouache planet hopping adventure',
            },
          },
        });
      } else if (payload.id === 312) {
        void recordAndSend('after_meta_still_building', {
          id: 313,
          method: 'item/tool/call',
          params: {
            callId: 'sg-6',
            tool: 'openmotion_game_set_status',
            arguments: { id: gameIdA, status: 'ready' },
          },
        });
      } else if (payload.id === 313) {
        void recordAndSend('after_ready', {
          method: 'turn/completed',
          params: { turn: { id: 'turn-staged-2', status: 'completed' } },
        });
      }
    }
    close() {}
  }

  serviceRef = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: StagedGameRpc as unknown as typeof AssetAgentRpc,
  });

  const chatA = await serviceRef.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
  });
  chatIdA = chatA.id;

  // Turn 1: read starter files + set status=building + write design/style.md ONLY
  await serviceRef.start(chatIdA, {
    requestId: 'req-staged-1',
    mode: 'game',
    text: `Plan visual style for game ${gameIdA}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await serviceRef.get(chatIdA);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const afterTurn1 = await serviceRef.get(chatIdA);
  assert.equal(afterTurn1.state, 'idle');
  assert.equal(afterTurn1.artifacts.length, 0, 'design/style.md and building status must not prematurely register starter kit');
  assert.equal(afterTurn1.activeArtifactId, undefined);
  for (const snap of capturedSnapshots) {
    assert.equal(snap.count, 0, `expected 0 artifacts at ${snap.step}`);
    assert.equal(snap.active, undefined, `expected no activeArtifactId at ${snap.step}`);
  }

  // Turn 2: write runnable code -> update meta -> set status=ready -> must auto-present immediately
  capturedSnapshots = [];
  await serviceRef.start(chatIdA, {
    requestId: 'req-staged-2',
    mode: 'game',
    text: `Implement and finalize game ${gameIdA}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await serviceRef.get(chatIdA);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const afterTurn2 = await serviceRef.get(chatIdA);
  assert.equal(afterTurn2.state, 'idle');
  assert.equal(capturedSnapshots.find(s => s.step === 'after_code_still_building')?.count, 0);
  assert.equal(capturedSnapshots.find(s => s.step === 'after_meta_still_building')?.count, 0);
  assert.equal(capturedSnapshots.find(s => s.step === 'after_ready')?.active, `game:${gameIdA}`);
  const readyArt = afterTurn2.artifacts.find(item => item.id === `game:${gameIdA}`);
  assert.ok(readyArt);
  assert.equal(readyArt.title, 'Celestial Star Journey');
  assert.equal(typeof readyArt.presentedAt, 'number');
  assert.ok((readyArt.presentedAt ?? 0) > 0);
  assert.equal(afterTurn2.activeArtifactId, `game:${gameIdA}`);

  await serviceRef.close();

  // Part C: end-of-turn auto-present safety net when Agent writes runnable code and finishes without set_status("ready") or present_artifact
  const draftB = await gameProjectsFor(store.directory).create({
    prompt: 'Fast neon breakout shooter',
    genre: 'shooter',
    orientation: 'portrait',
    multiplayer: false,
  });
  const gameIdB = draftB.game.id;

  class ForgotPresentRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-forgot-present' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 401,
            method: 'item/tool/call',
            params: {
              callId: 'fp-1',
              tool: 'openmotion_game_write_files',
              arguments: {
                id: gameIdB,
                files: [
                  { path: 'index.html', content: '<!doctype html><canvas id="breakout"></canvas>' },
                  { path: 'client.js', content: 'console.log("ready");' },
                ],
              },
            },
          });
        });
        return { turn: { id: 'turn-forgot-present' } };
      }
      return {};
    }
    send(payload: any) {
      if (payload.id === 401) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-forgot-present', status: 'completed' } },
          });
        });
      }
    }
    close() {}
  }

  const serviceB = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: ForgotPresentRpc as unknown as typeof AssetAgentRpc,
  });
  const chatB = await serviceB.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
  });
  await serviceB.start(chatB.id, {
    requestId: 'req-forgot-present',
    mode: 'game',
    text: `Build game ${gameIdB}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 80; i++) {
    const snap = await serviceB.get(chatB.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneB = await serviceB.get(chatB.id);
  assert.equal(doneB.state, 'idle');
  assert.equal(doneB.activeArtifactId, `game:${gameIdB}`);
  const autoPresented = doneB.artifacts.find(item => item.id === `game:${gameIdB}`);
  assert.ok(autoPresented);
  assert.ok((autoPresented.presentedAt ?? 0) > 0);
  await serviceB.close();
}));

test('built-in template zero-rebuild delivery presents game artifact immediately and preserves localized title across concurrent set_status', () => fixture(async store => {
  const games = gameProjectsFor(store.directory);
  const remixed = await games.remix('ball-match');
  assert.equal(remixed.game.title, 'Jelly Ball Chain Pop');
  assert.equal(remixed.game.status, 'draft');

  const phase1 = {
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'openmotion_game_set_status') {
        return games.status(String(args.id), args.status);
      }
      throw new Error(`Unexpected tool in zero-rebuild delivery: ${name}`);
    },
  } as unknown as Phase1Service;

  const toolCalls: string[] = [];
  class InstantTemplateDeliveryRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return { serverInfo: { name: 'mock-codex' } };
      if (method === 'thread/start') return { thread: { id: 'thread-instant-template' } };
      if (method === 'turn/start') {
        setTimeout(() => {
          // Present with localized title first, then transition status to ready — title must not be clobbered back to English.
          this.onNotification({
            id: 401,
            method: 'item/tool/call',
            params: {
              callId: 'tpl-1',
              tool: 'openmotion_present_artifact',
              arguments: { kind: 'game-project', projectId: remixed.game.id, title: '弹珠连线爆爆乐' },
            },
          });
        }, 5);
        return { turn: { id: 'turn-instant-template' } };
      }
      return {};
    }
    send(payload: any) {
      if (payload.id === 401) {
        toolCalls.push('present_artifact');
        this.onNotification({
          id: 402,
          method: 'item/tool/call',
          params: {
            callId: 'tpl-2',
            tool: 'openmotion_game_set_status',
            arguments: { id: remixed.game.id, status: 'ready' },
          },
        });
      } else if (payload.id === 402) {
        toolCalls.push('set_status');
        this.onNotification({
          method: 'turn/completed',
          params: { turn: { id: 'turn-instant-template', status: 'completed' } },
        });
      }
    }
    close() {}
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: InstantTemplateDeliveryRpc as unknown as typeof AssetAgentRpc,
  });
  const chat = await service.create({ engine: 'codex', intent: 'game', permissionMode: 'auto' });
  await service.start(chat.id, {
    requestId: 'req-instant-tpl',
    mode: 'game',
    text: '做同款 · 弹珠连线爆爆乐',
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.deepEqual(toolCalls, ['present_artifact', 'set_status']);
  assert.equal((await games.get(remixed.game.id)).status, 'ready');
  assert.equal(done.activeArtifactId, `game:${remixed.game.id}`);
  const art = done.artifacts.find(item => item.id === `game:${remixed.game.id}`);
  assert.ok(art);
  assert.equal(art.title, '弹珠连线爆爆乐');
  await service.close();
}));

test('extractLocalDevServerUrl, annotation image persistence, and lean Coding prompt injection', () => fixture(async store => {
  assert.equal(
    extractLocalDevServerUrl('  VITE v6.0 ready\n  ➜  Local:   http://localhost:5173/dashboard\n', 'http://127.0.0.1:4173'),
    'http://localhost:5173/dashboard',
  );
  assert.equal(
    extractLocalDevServerUrl('\u001b[32m➜\u001b[39m  \u001b[1mLocal:\u001b[22m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m', 'http://127.0.0.1:4173'),
    'http://localhost:5173/',
  );
  assert.equal(
    extractLocalDevServerUrl('Listening on http://0.0.0.0:3000.', 'http://127.0.0.1:4173'),
    'http://127.0.0.1:3000/',
  );
  assert.equal(
    extractLocalDevServerUrl('OpenMotion UI at http://localhost:4173/agent', 'http://127.0.0.1:4173'),
    null,
  );

  let capturedPrompt = '';
  class CodingAnnotationRpc {
    onNotification: (msg: any) => void;
    closed = false;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string, params?: any) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-coding-annot' } };
      if (method === 'turn/start') {
        capturedPrompt = String(params?.input?.[0]?.text ?? '');
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-coding-annot', status: 'completed' } },
          });
        });
        return { turn: { id: 'turn-coding-annot' } };
      }
      return {};
    }
    send() {}
    close() { this.closed = true; }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: CodingAnnotationRpc as unknown as typeof AssetAgentRpc,
  });
  const chat = await service.create({ engine: 'codex', intent: 'coding', permissionMode: 'auto' });

  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const saved = await service.saveAnnotationImage(chat.id, pngBytes);
  const loaded = await service.readAnnotationImage(chat.id, saved.filename);
  assert.deepEqual(loaded, pngBytes);
  await assert.rejects(service.saveAnnotationImage(chat.id, Buffer.from('not-a-png')), /Invalid PNG/);
  await assert.rejects(service.readAnnotationImage(chat.id, '../escape.png'), /Invalid annotation/);

  const phase1 = new Phase1Service(store, undefined, pluginRoot);
  await service.start(chat.id, {
    requestId: 'req-coding-annot-1',
    mode: 'coding',
    text: 'Make this CTA rounded and purple',
    attachments: [{
      id: 'annot-1',
      kind: 'browser-annotation',
      title: 'HeroButton · button.cta',
      subtitle: 'http://localhost:5173/',
      previewUrl: `/motion-api/super-agent/chats/${chat.id}/annotations/${saved.filename}`,
      annotation: {
        mode: 'select',
        pageUrl: 'http://localhost:5173/',
        comment: 'Make this CTA rounded and purple',
        screenshotPath: saved.path,
        element: {
          tagName: 'button',
          selector: 'button.cta',
          label: 'Get Started',
          htmlPreview: '<button class="cta">Get Started</button>',
          styles: { borderRadius: '4px' },
          rect: { x: 20, y: 30, width: 120, height: 40 },
          viewport: { width: 1280, height: 800 },
          pageUrl: 'http://localhost:5173/',
          componentName: 'HeroButton',
          sourceFile: 'src/HeroButton.tsx',
          sourceLine: 18,
        },
      },
    }],
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  assert.ok(capturedPrompt.includes('<openmotion-browser-annotations>'));
  assert.ok(capturedPrompt.includes('button.cta'));
  assert.ok(capturedPrompt.includes('HeroButton'));
  assert.ok(capturedPrompt.includes('src/HeroButton.tsx'));
  assert.ok(capturedPrompt.includes(saved.path));
  assert.equal(capturedPrompt.includes('<openmotion-workspace-context>'), false);

  const formatted = formatBrowserAnnotationsContext([]);
  assert.equal(formatted, '');

  const allowedDir = path.dirname(saved.path);
  const confinedOut = formatBrowserAnnotationsContext([{
    id: 'bad-path-1',
    kind: 'browser-annotation',
    title: 'Bad path',
    annotation: {
      mode: 'select',
      pageUrl: 'http://localhost:5173/',
      screenshotPath: '/etc/passwd',
    },
  }, {
    id: 'good-path-1',
    kind: 'browser-annotation',
    title: 'Good path',
    annotation: {
      mode: 'select',
      pageUrl: 'http://localhost:5173/',
      screenshotPath: saved.path,
    },
  }], allowedDir);
  assert.equal(confinedOut.includes('/etc/passwd'), false);
  assert.ok(confinedOut.includes(saved.path));

  const formattedDraw = formatBrowserAnnotationsContext([{
    id: 'draw-1',
    kind: 'browser-annotation',
    title: 'Circle boss',
    annotation: {
      mode: 'draw',
      pageUrl: '/motion-api/games/g1/play/index.html',
      comment: 'Shrink boss hitbox',
      strokeCount: 2,
      strokeBounds: { x: 100, y: 120, width: 220, height: 180 },
    },
  }]);
  assert.ok(formattedDraw.includes('"strokeCount": 2'));
  assert.ok(formattedDraw.includes('"width": 220'));

  await service.close();
}));

test('Claude tool_result and Codex streaming command output auto-present local dev servers', () => fixture(async store => {
  const phase1: any = { call: async () => ({ ok: true }) };
  const claudeService = new SuperAgentConversations(store, {
    resolveAgent: async () => '/usr/local/bin/claude',
    runClaude: async ({ onEvent }) => {
      await onEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm run dev' } }],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'bash-1',
            content: '  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m',
          }],
        },
      });
    },
  });
  const claudeChat = await claudeService.create({ engine: 'claude', intent: 'coding', permissionMode: 'auto' });
  await claudeService.start(claudeChat.id, { requestId: 'req-claude-dev-1', mode: 'coding', text: 'Run dev server' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 60; i++) {
    const snap = await claudeService.get(claudeChat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneClaude = await claudeService.get(claudeChat.id);
  assert.equal(doneClaude.artifacts.some(a => a.kind === 'web' && a.url === 'http://localhost:5174/'), true);
  await claudeService.close();

  class StreamingCodexRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-stream-dev' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/started',
            params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm run dev' } },
          });
          this.onNotification({
            method: 'item/commandExecution/outputDelta',
            params: { itemId: 'cmd-1', delta: 'Local: http://localhost:5175/\n' },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-stream-dev', status: 'completed' } },
          });
        });
        return { turn: { id: 'turn-stream-dev' } };
      }
      return {};
    }
    send() {}
    close() {}
  }

  const codexService = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: StreamingCodexRpc as unknown as typeof AssetAgentRpc,
  });
  const codexChat = await codexService.create({ engine: 'codex', intent: 'coding', permissionMode: 'auto' });
  await codexService.start(codexChat.id, { requestId: 'req-codex-dev-1', mode: 'coding', text: 'Start dev server' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 60; i++) {
    const snap = await codexService.get(codexChat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneCodex = await codexService.get(codexChat.id);
  assert.equal(doneCodex.artifacts.some(a => a.kind === 'web' && a.url === 'http://localhost:5175/'), true);
  await codexService.close();
}));

test('shared preview-bridge injects safely under strict CSP on Design/Game previews and preview-snapshot blocks SSRF paths', () => fixture(async store => {
  assert.equal(isValidPreviewBridgeToken('omb_valid1234'), true);
  assert.equal(isValidPreviewBridgeToken('bad'), false);
  assert.equal(isValidPreviewBridgeToken('bad<script>'), false);

  const injected = injectPreviewBridgeHtml('<html><body><div id="app">Hi</div></body></html>\n', 'omb_valid1234').toString('utf8');
  assert.ok(injected.includes('data-om-preview-bridge'));
  assert.ok(injected.includes("'__reactFiber$'"));
  const scriptMatch = /<script data-om-preview-bridge>\s*([\s\S]*?)\s*<\/script>/.exec(injected);
  assert.ok(scriptMatch?.[1]);
  assert.doesNotThrow(() => new Function(scriptMatch![1]));
  assert.ok(injected.includes('om:preview-pick'));
  assert.ok(injected.includes('om:preview-console'));
  assert.ok(injected.includes('om:preview-capture'));

  const uninjected = injectPreviewBridgeHtml('<html><body>Hi</body></html>', 'bad!').toString('utf8');
  assert.equal(uninjected, '<html><body>Hi</body></html>');

  // Verify designHttp ?omBridge= preserves sandbox CSP
  const dproj = await designProjectsFor(store.directory).create({ scenario: 'prototype', title: 'Bridge Web', requestId: 'req-dbridge-1' });
  let dStatus = 0;
  let dHeaders: Record<string, unknown> = {};
  let dBody = Buffer.alloc(0);
  const dHandled = await designHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number, headers: Record<string, unknown>) { dStatus = code; dHeaders = headers; },
      end(chunk: Buffer | string) { dBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); },
    } as any,
    new URL(`http://127.0.0.1:4173/api/design/raw/${encodeURIComponent(dproj.id)}/index.html?omBridge=omb_valid1234`),
    store.directory,
    'http://127.0.0.1:4173',
    async () => ({}),
  );
  assert.equal(dHandled, true);
  assert.equal(dStatus, 200);
  assert.ok(String(dHeaders['Content-Security-Policy']).includes('sandbox allow-scripts'));
  assert.ok(dBody.toString('utf8').includes('data-om-preview-bridge'));

  // Verify gameHttp ?omBridge= preserves strict CSP & accurate Content-Length
  const createdGame = await gameProjectsFor(store.directory, pluginRoot).create({ prompt: 'Bridge game check', multiplayer: false });
  let gStatus = 0;
  let gHeaders: Record<string, unknown> = {};
  let gBody = Buffer.alloc(0);
  const gHandled = await gameHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number, headers: Record<string, unknown>) { gStatus = code; gHeaders = headers; },
      end(chunk: Buffer | string) { gBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); },
    } as any,
    new URL(`http://127.0.0.1:4173/api/games/${encodeURIComponent(createdGame.game.id)}/play/index.html?omBridge=omb_valid1234`),
    store.directory,
    async () => ({}),
  );
  assert.equal(gHandled, true);
  assert.equal(gStatus, 200);
  assert.equal(Number(gHeaders['Content-Length']), gBody.length);
  assert.ok(String(gHeaders['Content-Security-Policy']).includes("worker-src 'none'"));
  assert.ok(gBody.toString('utf8').includes('data-om-preview-bridge'));

  // Verify preview-snapshot rejects unsafe/external paths
  const req = transport(store);
  const chatRes = await req('/motion-api/super-agent/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'codex', title: 'Snapshot Guard Chat' }),
  });
  const chat = (await chatRes.json()).conversation;
  for (const badPath of ['https://evil.com/index.html', '/motion-api/design/raw/../../etc/passwd', '/etc/hosts']) {
    const badRes = await req(`/motion-api/super-agent/chats/${chat.id}/preview-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: badPath }),
    });
    assert.ok(badRes.status >= 400);
  }
  await superAgentConversations(store).close();
}));

test('SuperAgentConversations marks interrupted shutdown runs failed and resets tool activity phase back to thinking', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  let releaseTurn!: () => void;
  const turnBlocked = new Promise<void>(resolve => { releaseTurn = resolve; });
  const observedPhases: string[] = [];

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/agy',
    runAcp: async opts => {
      await opts.callbacks.onStatus('connecting', 'Antigravity');
      await opts.callbacks.onToolStarted({
        callId: 'c1',
        tool: 'openmotion_read_workflow',
        label: 'Read workflow guidance',
        status: 'running',
        category: 'mcp',
        startedAt: Date.now(),
      });
      await opts.callbacks.onToolFinished({
        callId: 'c1',
        tool: 'openmotion_read_workflow',
        label: 'Read workflow guidance',
        status: 'completed',
        category: 'mcp',
        startedAt: Date.now() - 50,
        finishedAt: Date.now(),
        durationMs: 50,
      }, { ok: true }, {});
      await opts.callbacks.onReasoningDelta('r1', 'Considering racing layout...');
      const midSnap = await service.get(chat.id);
      if (midSnap.turnActivity?.phase) observedPhases.push(midSnap.turnActivity.phase);
      await Promise.race([
        turnBlocked,
        new Promise<void>(resolve => opts.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    },
  });

  const chat = await service.create({ engine: 'antigravity', intent: 'game', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-agy-close-1', text: 'Build racing game' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    if (observedPhases.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.deepEqual(observedPhases, ['thinking']);

  await service.close();
  releaseTurn();

  const reloaded = new SuperAgentConversations(store);
  const afterClose = await reloaded.get(chat.id);
  assert.equal(afterClose.state, 'failed');
  assert.match(afterClose.error || '', /Server restarted while the Agent was running/);
  await reloaded.close();
}));

test('hiddenInstructions stay hidden from stored user messages while reaching the Agent, and approvals summarize cleanly with alwaysAllow', () => fixture(async store => {
  // 1) buildSuperAgentHandoff keeps user prompt concise while moving directives into hiddenInstructions
  const zhHandoff = buildSuperAgentHandoff(
    { kind: 'motion-template', id: 'tpl-launch-1', title: 'Product Launch' },
    { hiddenInstructions: 'Read openmotion://workflow/template/start and recreate tpl-launch-1.', locale: 'zh-CN' },
  );
  assert.equal(zhHandoff.prompt, '基于「Product Launch」模板制作一个动效视频。');
  assert.ok(zhHandoff.hiddenInstructions?.includes('openmotion://workflow/template/start'));
  assert.equal(zhHandoff.prompt.includes('openmotion://'), false);

  const designProtoHandoff = buildSuperAgentHandoff({ kind: 'design-template', id: 'tpl-proto', title: 'Landing', scenario: 'prototype' });
  assert.equal(designProtoHandoff.mode, 'design');
  assert.equal(designProtoHandoff.designModule, 'prototype');

  const designDeckHandoff = buildSuperAgentHandoff({ kind: 'design-template', id: 'tpl-deck', title: 'Pitch Deck', scenario: 'deck' });
  assert.equal(designDeckHandoff.mode, 'design');
  assert.equal(designDeckHandoff.designModule, 'deck');

  const designWebglHandoff = buildSuperAgentHandoff({ kind: 'design-template', id: 'tpl-webgl', title: '3D Globe', scenario: 'webgl' });
  assert.equal(designWebglHandoff.mode, 'design');
  assert.equal(designWebglHandoff.designModule, 'webgl');

  const designSkillHandoff = buildSuperAgentHandoff({ kind: 'design-skill', id: 'skill-1', title: 'Editorial' });
  assert.equal(designSkillHandoff.mode, 'design');
  assert.equal(designSkillHandoff.designModule, 'prototype');

  const brandKitHandoff = buildSuperAgentHandoff({ kind: 'brand-kit', id: 'catalog:vercel', title: 'Vercel' });
  assert.equal(brandKitHandoff.mode, 'design');
  assert.equal(brandKitHandoff.designModule, 'prototype');

  // 2) describeSuperAgentApproval turns raw Codex Python-script JSON into a clear 1-line summary
  const pythonAudioDetail = JSON.stringify({
    command: 'python3 - <<\'OPENMOTION_SCORE\'\nfrom pathlib import Path\ndestination = Path("欢快背景音乐.wav")\nOPENMOTION_SCORE',
    availableDecisions: ['accept', 'cancel'],
  }, null, 2);
  const describedAudio = describeSuperAgentApproval({
    kind: 'command',
    title: 'Command approval',
    detail: pythonAudioDetail,
  });
  assert.equal(describedAudio.headingKey, 'Create audio file');
  assert.equal(describedAudio.target, '欢快背景音乐.wav');
  assert.equal(describedAudio.summaryKey, 'Run a {runtime} script to create "{target}".');
  assert.deepEqual(describedAudio.summaryVars, { runtime: 'Python', target: '欢快背景音乐.wav' });
  assert.equal(describedAudio.technicalDetail.includes('availableDecisions'), false);
  assert.ok(describedAudio.technicalDetail.includes('destination = Path("欢快背景音乐.wav")'));

  const describedFiles = describeSuperAgentApproval({
    kind: 'file',
    title: 'File edit approval',
    detail: JSON.stringify({ changes: [{ path: 'src/index.html' }, { path: 'src/game.js' }] }),
  });
  assert.equal(describedFiles.headingKey, 'Edit files');
  assert.equal(describedFiles.target, 'index.html');
  assert.deepEqual(describedFiles.summaryVars, { count: 2, target: 'index.html' });

  const describedGen = describeSuperAgentApproval({
    kind: 'generation',
    title: 'Generate media asset',
    detail: JSON.stringify({ modality: 'image', model: 'seedream-4', prompt: 'Neon arcade background' }),
  });
  assert.equal(describedGen.headingKey, 'Generate image');
  assert.equal(describedGen.target, 'seedream-4');
  assert.equal(describedGen.summaryText, 'Neon arcade background');

  // 3) Backend injects hiddenInstructions into Agent prompt without storing them in user chat message,
  //    and answer(..., true, true) switches permissionMode to auto and auto-approves subsequent steps.
  let receivedAgentPrompt = '';
  const decisions: string[] = [];
  class ApprovalCodexRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string, params?: any) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-hidden-approval' } };
      if (method === 'turn/start') {
        receivedAgentPrompt = String(params?.input?.[0]?.text || '');
        queueMicrotask(() => {
          this.onNotification({
            id: 41,
            method: 'item/commandExecution/requestApproval',
            params: {
              command: 'python3 -c \'from pathlib import Path; Path("bgm.wav").write_bytes(b"RIFF")\'',
            },
          });
        });
        return { turn: { id: 'turn-hidden-approval' } };
      }
      return {};
    }
    send(msg: any) {
      if (msg?.id === 41) {
        decisions.push(String(msg.result?.decision || ''));
        queueMicrotask(() => {
          this.onNotification({
            id: 42,
            method: 'item/commandExecution/requestApproval',
            params: { command: 'npm test' },
          });
        });
      } else if (msg?.id === 42) {
        decisions.push(String(msg.result?.decision || ''));
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-hidden-approval', status: 'completed' } },
          });
        });
      }
    }
    close() {}
  }

  const phase1: any = { call: async () => ({ ok: true }) };
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: ApprovalCodexRpc as unknown as typeof AssetAgentRpc,
  });
  const chat = await service.create({ engine: 'codex', intent: 'game', permissionMode: 'on-request' });
  await service.start(
    chat.id,
    {
      requestId: 'req-hidden-1',
      text: '我想做一个2024小游戏',
      hiddenInstructions: 'Use the openmotion-game Skill. Read openmotion://workflow/game/start.',
      mode: 'game',
      contextTags: [
        { kind: 'mode', label: 'Game', icon: 'gamepad-line', tone: 'agent' },
        { kind: 'param', label: 'Casual' },
        { kind: 'param', label: '9:16' },
        { kind: 'param', label: 'Single player' },
      ],
    },
    { origin: 'http://127.0.0.1:4173', phase1: () => phase1 },
  );

  let waitingSnap = await service.get(chat.id);
  for (let i = 0; i < 60 && waitingSnap.approvals.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 15));
    waitingSnap = await service.get(chat.id);
  }
  assert.equal(waitingSnap.approvals.length, 1);
  assert.equal(waitingSnap.approvals[0].target, 'bgm.wav');
  assert.equal(waitingSnap.messages[0].text, '我想做一个2024小游戏');
  assert.equal(waitingSnap.messages[0].text.includes('openmotion-game'), false);
  assert.deepEqual(waitingSnap.messages[0].contextTags?.map(tag => tag.label), ['Game', 'Casual', '9:16', 'Single player']);
  assert.ok(receivedAgentPrompt.includes('<openmotion-task-instructions>'));
  assert.ok(receivedAgentPrompt.includes('Mode/Skill: game | Selected parameters: Casual · 9:16 · Single player'));
  assert.ok(receivedAgentPrompt.includes('openmotion://workflow/game/start'));

  // Approve with alwaysAllow=true -> switches chat.permissionMode to 'auto' and auto-approves req #42
  await service.answer(chat.id, waitingSnap.approvals[0].id, true, true);
  let doneSnap = await service.get(chat.id);
  for (let i = 0; i < 60 && doneSnap.state !== 'idle'; i++) {
    await new Promise(resolve => setTimeout(resolve, 15));
    doneSnap = await service.get(chat.id);
  }
  assert.equal(doneSnap.state, 'idle');
  assert.equal(doneSnap.permissionMode, 'auto');
  assert.deepEqual(decisions, ['accept', 'accept']);
  await service.close();
}));

test('SuperAgentConversations gates openmotion_capability_run approvals, skips approval on dryRun, wraps asset_manage read media, and isolates artifact extraction', () => fixture(async store => {
  assert.equal(formatSuperAgentToolLabel('openmotion_capability_discover', { action: 'list' }), 'Browsed capability catalog');
  assert.equal(formatSuperAgentToolLabel('openmotion_capability_run', { dryRun: true }), 'Previewed capability execution');
  assert.equal(formatSuperAgentToolLabel('openmotion_capability_run', { capabilityId: 'remove-background' }), 'Ran media capability');
  assert.equal(formatSuperAgentToolLabel('openmotion_job_manage', { action: 'status' }), 'Checked generation job status');
  assert.equal(formatSuperAgentToolLabel('openmotion_asset_manage', { action: 'read' }), 'Inspected media asset');
  assert.equal(
    classifySuperAgentTool('openmotion_capability_run', { capabilityId: 'remove-background' }).summary,
    'remove-background',
  );

  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const makePng = async (filename: string, color: string) => {
    const file = path.join(store.directory, filename);
    const res = await execute(
      verificationBinaries().ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x24`, '-frames:v', '1', '-y', file],
      store.directory,
      20_000,
    );
    assert.equal(res.code, 0, res.stderr);
    return file;
  };

  const rawPng = await makePng('sa-source.png', 'blue');
  const imported = await phase1.call('openmotion_asset_manage', {
    action: 'import',
    requestId: 'sa-import-1',
    sourcePath: rawPng,
    name: 'Source Subject',
  });
  const sourceRef = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };

  const scriptId = 'sa-test-cutout';
  let scriptRuns = 0;
  registerCapabilityScriptExecutor(scriptId, async () => {
    scriptRuns += 1;
    return { sourcePath: await makePng('sa-cutout.png', 'white'), name: 'Cutout Subject' };
  });

  await saveCapabilityOverrides(store, [
    { id: 'remove-background', executor: { kind: 'script', scriptId } },
  ]);

  let producedAssetId = '';
  let producedVersionId = '';
  const responses = new Map<number, any>();

  class CapabilityRpc {
    onNotification: (msg: any) => void;
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-cap-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          // 1. dryRun: true must NOT require approval or run script
          this.onNotification({
            id: 201,
            method: 'item/tool/call',
            params: {
              callId: 'cap-dry',
              tool: 'openmotion_capability_run',
              arguments: { capabilityId: 'remove-background', references: [sourceRef], dryRun: true },
            },
          });
        });
        return { turn: { id: 'turn-cap-1' } };
      }
      return {};
    }

    send(payload: any) {
      responses.set(payload.id, payload);
      if (payload.id === 201) {
        queueMicrotask(() => {
          // 2. Real capability_run (no requestId passed) must trigger generation approval & inject requestId
          this.onNotification({
            id: 202,
            method: 'item/tool/call',
            params: {
              callId: 'cap-real',
              tool: 'openmotion_capability_run',
              arguments: { capabilityId: 'remove-background', references: [sourceRef] },
            },
          });
        });
      }
      if (payload.id === 202) {
        const textItem = payload.result?.contentItems?.find((i: any) => i.type === 'inputText')?.text;
        const parsed = textItem ? JSON.parse(textItem) : {};
        producedAssetId = parsed.asset?.id ?? '';
        producedVersionId = parsed.version?.id ?? '';
        queueMicrotask(() => {
          // 3. asset_manage action=get must NOT add an extra artifact
          this.onNotification({
            id: 203,
            method: 'item/tool/call',
            params: {
              callId: 'cap-get',
              tool: 'openmotion_asset_manage',
              arguments: { action: 'get', assetId: imported.asset.id, versionId: imported.asset.currentVersionId },
            },
          });
        });
      }
      if (payload.id === 203) {
        queueMicrotask(() => {
          // 4. asset_manage action=update (trash) must NOT add an extra artifact
          this.onNotification({
            id: 204,
            method: 'item/tool/call',
            params: {
              callId: 'cap-update',
              tool: 'openmotion_asset_manage',
              arguments: { action: 'update', assetId: imported.asset.id, changes: { trashed: true } },
            },
          });
        });
      }
      if (payload.id === 204) {
        queueMicrotask(() => {
          // 5. asset_manage action=read must return wrapped image media content
          this.onNotification({
            id: 205,
            method: 'item/tool/call',
            params: {
              callId: 'cap-read',
              tool: 'openmotion_asset_manage',
              arguments: { action: 'read', assetId: producedAssetId, versionId: producedVersionId },
            },
          });
        });
      }
      if (payload.id === 205) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-cap-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: CapabilityRpc as unknown as typeof AssetAgentRpc,
  });

  try {
    const chat = await service.create({ engine: 'codex', permissionMode: 'on-request' });
    await service.start(chat.id, { requestId: 'req-cap-turn-1', text: 'Remove background from subject' }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => phase1,
    });

    // Wait for the approval triggered ONLY by call 202 (NOT call 201 dryRun)
    let waiting = await service.get(chat.id);
    for (let i = 0; i < 80 && waiting.approvals.length === 0; i++) {
      await new Promise(r => setTimeout(r, 15));
      waiting = await service.get(chat.id);
    }
    assert.equal(responses.has(201), true, 'dryRun should finish without waiting for approval');
    assert.equal(scriptRuns, 0, 'script must not execute before generation approval');
    assert.equal(waiting.approvals.length, 1);
    assert.equal(waiting.approvals[0].kind, 'generation');
    assert.match(waiting.approvals[0].title, /remove-background/);

    await service.answer(chat.id, waiting.approvals[0].id, true);

    let done = await service.get(chat.id);
    for (let i = 0; i < 100 && done.state !== 'idle'; i++) {
      await new Promise(r => setTimeout(r, 15));
      done = await service.get(chat.id);
    }

    assert.equal(done.state, 'idle');
    assert.equal(scriptRuns, 1);
    assert.ok(producedAssetId && producedVersionId);

    // Only the generated cutout asset should be extracted into chat artifacts (NOT get/update/trash on source)
    assert.equal(done.artifacts.length, 1);
    assert.equal(done.artifacts[0].assetId, producedAssetId);
    assert.equal(done.artifacts[0].versionId, producedVersionId);

    // asset_manage(action="read") must wrap image preview into Codex inputImage content item
    const readResp = responses.get(205);
    assert.equal(readResp?.result?.success, true);
    assert.ok(
      readResp?.result?.contentItems?.some((item: any) => item.type === 'inputImage' && typeof item.imageUrl === 'string'),
      'expected wrapped imageUrl content item from openmotion_asset_manage(action="read")',
    );
  } finally {
    unregisterCapabilityScriptExecutor(scriptId);
    await service.close();
  }
}));

test('classifySuperAgentTool extracts every file in multi-file Game, Design, and Motion batches plus capture_cover', () => {
  const gameBatch = classifySuperAgentTool('mcp__openmotion__openmotion_game_write_files', {
    id: 'g-1',
    files: [
      { path: 'assets/icon.svg', content: '<svg></svg>' },
      { path: 'index.html', content: '<!doctype html>\n<html></html>' },
      { path: 'style.css', content: 'body { margin: 0; }\ncanvas { display: block; }' },
      { path: 'logic.js', content: 'export const meta = {};' },
      { path: 'client.js', content: 'console.log("ok");' },
    ],
  });
  assert.equal(gameBatch.category, 'file_edit');
  assert.equal(gameBatch.summary, '5 files');
  assert.deepEqual(gameBatch.files?.map(f => f.path), [
    'assets/icon.svg',
    'index.html',
    'style.css',
    'logic.js',
    'client.js',
  ]);
  assert.equal(gameBatch.files?.[1].addedLines, 2);
  assert.ok(gameBatch.files?.[1].diffPreview?.includes('+<!doctype html>'));

  const designWrite = classifySuperAgentTool('openmotion_design_edit', {
    action: 'write',
    files: [
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: 'app.js', content: 'const a = 1;' },
    ],
  });
  assert.deepEqual(designWrite.files?.map(f => f.path), ['index.html', 'app.js']);

  const designDelete = classifySuperAgentTool('openmotion_design_edit', {
    action: 'delete',
    files: [{ path: 'old.css' }],
  });
  assert.equal(designDelete.category, 'file_delete');
  assert.deepEqual(designDelete.files?.map(f => ({ path: f.path, action: f.action })), [
    { path: 'old.css', action: 'delete' },
  ]);

  const cover = classifySuperAgentTool('openmotion_game_capture_cover', { id: 'g-1' });
  assert.equal(cover.category, 'file_write');
  assert.deepEqual(cover.files, [{ action: 'create', path: 'assets/cover.png', binary: true }]);
});

test('per-task projectDir, checkpoint diffing, and legacy hydration track all deliverable files accurately', () => fixture(async store => {
  const service = new SuperAgentConversations(store);
  const created = await service.create({ intent: 'coding', engine: 'claude' });
  assert.equal(created.projectKind, 'workspace');
  assert.equal(created.projectDir, path.join(store.directory, 'super-agent', 'work', created.id));
  const workDirStat = await stat(created.projectDir!);
  assert.ok(workDirStat.isDirectory());

  const resolvedCustom = resolveTaskProjectDir(store.directory, {
    id: created.id,
    workingDir: '/tmp/custom-repo',
    artifacts: [{
      id: 'game:g1',
      kind: 'game-project',
      title: 'G1',
      projectId: 'g1',
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  assert.deepEqual(resolvedCustom, { projectDir: '/tmp/custom-repo', projectKind: 'custom' });

  // Create a game project with all 9 real deliverable files plus internal scratch/metadata noise
  const { game } = await gameProjectsFor(store.directory).create({
    prompt: 'Action game',
    genre: 'casual',
    multiplayer: true,
  });
  await gameProjectsFor(store.directory).write(game.id, [
    { path: 'index.html', content: '<!doctype html>\n<title>Action</title>' },
    { path: 'style.css', content: 'body { color: white; }' },
    { path: 'logic.js', content: 'export const meta = { minPlayers: 1, maxPlayers: 2, tickRate: 20 };' },
    { path: 'client.js', content: 'console.log("ready");' },
    { path: 'assets/icon.svg', content: '<svg></svg>' },
    { path: 'design/plan.md', content: '# Plan' },
    { path: 'design/assets.csv', content: 'name,type\ncover,png' },
    { path: 'design/verification.md', content: '# Verification' },
  ]);
  const gameDir = path.join(store.directory, 'games', game.id);
  await mkdir(path.join(gameDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(gameDir, 'assets', 'cover.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await mkdir(path.join(gameDir, 'assets', 'playtests'), { recursive: true });
  await writeFile(path.join(gameDir, 'assets', 'playtests', 'ephemeral.png'), Buffer.from([1, 2, 3]));
  await mkdir(path.join(gameDir, 'trailer'), { recursive: true });
  await writeFile(path.join(gameDir, 'trailer', 'clip.mp4'), Buffer.from([4, 5, 6]));

  // Snapshot captures exact 9 deliverable files and excludes internal game metadata/noise
  const chatWithGame = await service.create({
    engine: 'claude',
    initialArtifact: {
      id: `game:${game.id}`,
      kind: 'game-project',
      title: game.title,
      projectId: game.id,
      url: `/motion-api/games/${game.id}/play/index.html`,
    },
  });
  assert.equal(chatWithGame.projectKind, 'game');
  assert.equal(chatWithGame.projectDir, gameDir);

  const roots = collectTaskProjectRoots(store.directory, chatWithGame);
  const snap = await captureWorkspaceSnapshot(roots);
  const diffOps = diffWorkspaceSnapshots(undefined, snap);
  assert.deepEqual(diffOps.map(op => op.path), [
    'assets/cover.png',
    'assets/icon.svg',
    'client.js',
    'design/assets.csv',
    'design/plan.md',
    'design/verification.md',
    'index.html',
    'logic.js',
    'style.css',
  ]);
  const coverOp = diffOps.find(op => op.path === 'assets/cover.png');
  assert.equal(coverOp?.binary, true);
  assert.equal(coverOp?.previewUrl, `/motion-api/games/${encodeURIComponent(game.id)}/play/assets/cover.png`);
  assert.equal(coverOp?.artifactId, `game:${game.id}`);

  // Legacy chat persisted without turnChangedFiles is hydrated on get()
  const chatFile = await service.file(chatWithGame.id);
  const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(chatFile, 'utf8'));
  parsed.messages = [{ id: 'turn-u1', role: 'user', text: 'Build game', createdAt: 100 }];
  delete parsed.turnChangedFiles;
  await writeFile(chatFile, JSON.stringify(parsed));

  const loaded = await service.get(chatWithGame.id);
  assert.equal(loaded.turnChangedFiles?.['turn-u1']?.length, 9);
  assert.ok(loaded.turnChangedFiles?.['turn-u1']?.some(op => op.path === 'index.html'));

  // Run + stop with custom mock agent persists turnChangedFiles in work/<chatId>
  const runChat = await service.create({ intent: 'coding', engine: 'claude' });
  const runService = new SuperAgentConversations(store, {
    resolveAgent: async () => '/fake/claude',
    runClaude: async ({ cwd, onEvent }) => {
      await writeFile(path.join(cwd, 'notes.md'), '# Task Notes\nReady\n');
      await onEvent({ type: 'result', subtype: 'success', result: 'Created notes.' });
    },
  });
  await runService.start(
    runChat.id,
    { requestId: 'req-turn-snap-1', text: 'Write notes.md' },
    { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) },
  );
  const finished = await runService.waitForChat(runChat.id);
  const firstUserMsg = finished.messages.find(m => m.role === 'user');
  assert.ok(firstUserMsg);
  assert.equal(finished.turnChangedFiles?.[firstUserMsg!.id]?.[0]?.path, 'notes.md');
  assert.equal(finished.turnChangedFiles?.[firstUserMsg!.id]?.[0]?.action, 'create');

  await runService.close();
  await service.close();
}));

test('Codex and Claude Super Agent prompts share unified gameAssetInstructions without stale optional-generate guidance', () => {
  for (const prompt of [SUPER_AGENT_INSTRUCTIONS, CLAUDE_SUPER_AGENT_INSTRUCTIONS]) {
    assert.ok(prompt.includes(gameAssetInstructions), 'Super Agent prompt must embed gameAssetInstructions');
    assert.doesNotMatch(prompt, /optionally generate visual/i);
    assert.doesNotMatch(prompt, /openmotion_generate_asset/);
    assert.doesNotMatch(prompt, /keep game assets inline in index\.html/i);
    assert.match(prompt, /except when the Game Studio no-nag boundary applies/);
    assert.match(prompt, /Built-in template remix fast path/);
    assert.match(prompt, /deliver immediately with zero rebuild/);
    assert.match(prompt, /never say you copied a template/i);
    assert.match(prompt, /edit the existing files in place/);
  }
});

test('SuperAgentConversations steers active turns while preserving threadId and drains queued items afterwards', () => fixture(async store => {
  const abortedPrompts: string[] = [];
  const seenThreads: (string | undefined)[] = [];
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { releaseFirst = resolve; });

  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/fake/claude',
    runClaude: async ({ prompt, threadId, onEvent, signal }) => {
      seenThreads.push(threadId);
      if (prompt.startsWith('Initial prompt')) {
        await onEvent({ type: 'system', session_id: 'claude-thread-steer' });
        releaseFirst();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortedPrompts.push('Initial prompt');
            reject(new Error('Agent conversation stopped'));
          }, { once: true });
        });
        return;
      }
      if (prompt.startsWith('Steer prompt')) {
        await onEvent({ type: 'assistant', message: { id: 'a-steer', content: [{ type: 'text', text: 'Steered output' }] } });
        await onEvent({ type: 'result', subtype: 'success', result: 'Steered output' });
        return;
      }
      if (prompt.startsWith('Queued after steer')) {
        await onEvent({ type: 'assistant', message: { id: 'a-queued', content: [{ type: 'text', text: 'Queued output' }] } });
        await onEvent({ type: 'result', subtype: 'success', result: 'Queued output' });
      }
    },
  });

  const runtime = { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) };
  const chat = await service.create({ engine: 'claude' });
  await service.start(chat.id, { requestId: 'req-steer-1', text: 'Initial prompt' }, runtime);
  await firstStarted;

  // Enqueue a follow-up first, then steer: steer must preserve the queue until the steered run completes.
  const withQueued = await service.enqueueMessage(chat.id, { requestId: 'req-steer-q1', text: 'Queued after steer' });
  assert.equal(withQueued.queuedMessages?.length, 1);

  await service.start(chat.id, { requestId: 'req-steer-2', text: 'Steer prompt', followUpBehavior: 'steer' }, runtime);
  assert.deepEqual(abortedPrompts, ['Initial prompt']);

  // Wait for steered turn and auto-dequeued follow-up to both finish.
  let finalChat = await service.get(chat.id);
  for (let i = 0; i < 40 && (finalChat.state === 'running' || (finalChat.queuedMessages?.length ?? 0) > 0); i++) {
    await new Promise(r => setTimeout(r, 15));
    finalChat = await service.get(chat.id);
  }
  assert.equal(finalChat.state, 'idle');
  assert.equal(finalChat.queuedMessages, undefined);
  assert.deepEqual(seenThreads, [undefined, 'claude-thread-steer', 'claude-thread-steer']);
  assert.ok(finalChat.messages.some(m => m.role === 'user' && m.text === 'Steer prompt'));
  assert.ok(finalChat.messages.some(m => m.role === 'user' && m.text === 'Queued after steer'));
  await service.close();
}));

test('SuperAgentConversations supports queue CRUD, sendQueuedMessageNow, auto-dequeue, and preserves queue on stop or error', () => fixture(async store => {
  const executed: { text: string; attachmentIds: string[]; tagLabels: string[] }[] = [];
  let releaseHold: (() => void) | null = null;
  const nextHold = () => new Promise<void>(resolve => { releaseHold = resolve; });

  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/fake/claude',
    runClaude: async ({ prompt, onEvent, signal }) => {
      if (prompt.startsWith('Slow run') || prompt.startsWith('Stop guard run')) {
        releaseHold?.();
        releaseHold = null;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Agent conversation stopped')), { once: true });
        });
        return;
      }
      if (prompt.startsWith('Fail now')) {
        throw new Error('Synthetic provider failure');
      }
      const heading = prompt.split('\n')[0];
      executed.push({
        text: heading,
        attachmentIds: [],
        tagLabels: [],
      });
      await onEvent({ type: 'result', subtype: 'success', result: `Done: ${heading}` });
    },
  });

  const runtime = { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) };
  const chat = await service.create({ engine: 'claude' });
  const slowStarted = nextHold();
  await service.start(chat.id, { requestId: 'req-q-init', text: 'Slow run' }, runtime);
  await slowStarted;

  const afterQ1 = await service.enqueueMessage(chat.id, {
    requestId: 'req-q-1',
    text: 'Draft queued 1',
    attachments: [{ id: 'asset-a', kind: 'asset', title: 'Poster.png' }],
    contextTags: [{ kind: 'mode', label: 'Image' }],
  });
  const afterQ2 = await service.enqueueMessage(chat.id, { requestId: 'req-q-2', text: 'Queued to delete' });
  const afterQ3 = await service.enqueueMessage(chat.id, { requestId: 'req-q-3', text: 'Run immediately now' });
  assert.equal(afterQ3.queuedMessages?.length, 3);

  const q1Id = afterQ1.queuedMessages![0].id;
  const q2Id = afterQ2.queuedMessages![1].id;
  const q3Id = afterQ3.queuedMessages![2].id;

  const edited = await service.updateQueuedMessage(chat.id, q1Id, {
    text: 'Edited queued 1',
    attachments: [{ id: 'asset-b', kind: 'asset', title: 'Hero.png' }],
    contextTags: [{ kind: 'param', label: '16:9' }],
  });
  assert.equal(edited.queuedMessages?.[0]?.text, 'Edited queued 1');
  assert.equal(edited.queuedMessages?.[0]?.attachments?.[0]?.id, 'asset-b');
  assert.equal(edited.queuedMessages?.[0]?.contextTags?.[0]?.label, '16:9');

  const removed = await service.removeQueuedMessage(chat.id, q2Id);
  assert.deepEqual(removed.queuedMessages?.map(m => m.id), [q1Id, q3Id]);

  // Send Q3 immediately -> interrupts Slow run, removes Q3, runs Q3, then auto-dequeues Edited queued 1.
  await service.sendQueuedMessageNow(chat.id, q3Id, runtime);
  let settled = await service.get(chat.id);
  for (let i = 0; i < 40 && (settled.state === 'running' || (settled.queuedMessages?.length ?? 0) > 0); i++) {
    await new Promise(r => setTimeout(r, 15));
    settled = await service.get(chat.id);
  }
  assert.equal(settled.state, 'idle');
  assert.equal(settled.queuedMessages, undefined);
  assert.deepEqual(executed.map(e => e.text), ['Run immediately now', 'Edited queued 1']);
  const editedUserMsg = settled.messages.find(m => m.role === 'user' && m.text === 'Edited queued 1');
  assert.equal(editedUserMsg?.attachments?.[0]?.id, 'asset-b');
  assert.equal(editedUserMsg?.contextTags?.[0]?.label, '16:9');

  // Verify queue is preserved when a turn fails cleanly or is stopped manually.
  const failChat = await service.create({ engine: 'claude' });
  await service.enqueueMessage(failChat.id, { requestId: 'req-fail-keep', text: 'Must stay queued on error' });
  await service.start(failChat.id, { requestId: 'req-fail-trigger', text: 'Fail now' }, runtime);
  const failedState = await service.waitForChat(failChat.id);
  assert.equal(failedState.state, 'failed');
  assert.equal(failedState.queuedMessages?.length, 1);

  const stopChat = await service.create({ engine: 'claude' });
  const stopStarted = nextHold();
  await service.start(stopChat.id, { requestId: 'req-stop-trigger', text: 'Stop guard run' }, runtime);
  await stopStarted;
  await service.enqueueMessage(stopChat.id, { requestId: 'req-stop-keep', text: 'Must stay queued on stop' });
  const stoppedState = await service.stop(stopChat.id);
  assert.equal(stoppedState.state, 'cancelled');
  assert.equal(stoppedState.queuedMessages?.length, 1);

  await service.close();
}));

test('SuperAgentConversations awaits closeAndWait() on steer and retries transient active-writer locks', () => fixture(async store => {
  let instanceCount = 0;
  let turn1Closed = false;
  let resumeCalls = 0;
  let resumeSawTurn1Closed = false;
  let releaseTurn1Started!: () => void;
  const turn1Started = new Promise<void>(resolve => { releaseTurn1Started = resolve; });

  class SteerRaceCodexRpc {
    private readonly instanceId: number;
    private readonly onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.instanceId = ++instanceCount;
      this.onNotification = onNotification;
    }
    async request(method: string, params?: any) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-steer-race' } };
      if (method === 'thread/resume') {
        resumeCalls += 1;
        assert.equal(params?.threadId, 'thr-steer-race');
        resumeSawTurn1Closed = turn1Closed;
        if (resumeCalls <= 2) {
          throw new Error('thread thr-steer-race already has an active writer');
        }
        return { thread: { id: 'thr-steer-race' } };
      }
      if (method === 'turn/start') {
        if (this.instanceId === 1) {
          releaseTurn1Started();
          return { turn: { id: 'turn-race-1' } };
        }
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-race-2', type: 'agentMessage', text: 'Steered after lock release' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-race-2', status: 'completed' } },
          });
        });
        return { turn: { id: 'turn-race-2' } };
      }
      return {};
    }
    send() {}
    close() {}
    async closeAndWait() {
      if (this.instanceId === 1) {
        await new Promise(resolve => setTimeout(resolve, 60));
        turn1Closed = true;
      }
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: SteerRaceCodexRpc as unknown as typeof AssetAgentRpc,
  });
  const runtime = { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) };
  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });

  await service.start(chat.id, { requestId: 'req-race-1', text: 'Initial long turn' }, runtime);
  await turn1Started;

  await service.start(chat.id, { requestId: 'req-race-2', text: 'Immediate steer turn', followUpBehavior: 'steer' }, runtime);
  const done = await service.waitForChat(chat.id);
  for (let i = 0; i < 40 && done.state === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const finalChat = await service.get(chat.id);
  assert.equal(turn1Closed, true);
  assert.equal(resumeSawTurn1Closed, true);
  assert.equal(resumeCalls, 3);
  assert.equal(finalChat.state, 'idle');
  assert.equal(finalChat.error, undefined);
  assert.ok(finalChat.messages.some(m => m.role === 'assistant' && m.text === 'Steered after lock release'));
  await service.close();
}));

test('SuperAgentConversations ignores late errors or rejections from a stopped/steered turn', () => fixture(async store => {
  let instanceCount = 0;
  let releaseTurn1AtThreadStart!: () => void;
  const turn1ReadyToSteer = new Promise<void>(resolve => { releaseTurn1AtThreadStart = resolve; });
  let triggerTurn1LateRejection!: (err: Error) => void;
  let turn1Callbacks: { onNotification: (msg: any) => void; onClose: (err: Error) => void } | null = null;

  class LateErrorCodexRpc {
    private readonly instanceId: number;
    private readonly onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, onClose: (err: Error) => void) {
      this.instanceId = ++instanceCount;
      this.onNotification = onNotification;
      if (this.instanceId === 1) {
        turn1Callbacks = { onNotification, onClose };
      }
    }
    async request(method: string) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-late-err' } };
      if (method === 'thread/resume') return { thread: { id: 'thr-late-err' } };
      if (method === 'turn/start') {
        if (this.instanceId === 1) {
          releaseTurn1AtThreadStart();
          return new Promise((_, reject) => { triggerTurn1LateRejection = reject; });
        }
        setTimeout(() => {
          turn1Callbacks?.onNotification({
            method: 'error',
            params: { willRetry: false, error: { message: 'late turn 1 protocol error' } },
          });
          turn1Callbacks?.onClose(new Error('late turn 1 close error'));
          triggerTurn1LateRejection?.(new Error('late turn 1 turn/start rejection'));
        }, 15);
        setTimeout(() => {
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-late-2', type: 'agentMessage', text: 'Turn 2 unaffected' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-late-2', status: 'completed' } },
          });
        }, 55);
        return { turn: { id: 'turn-late-2' } };
      }
      return {};
    }
    send() {}
    close() {}
    async closeAndWait() {}
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: LateErrorCodexRpc as unknown as typeof AssetAgentRpc,
  });
  const runtime = { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) };
  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });

  await service.start(chat.id, { requestId: 'req-late-1', text: 'Turn 1' }, runtime);
  await turn1ReadyToSteer;

  await service.start(chat.id, { requestId: 'req-late-2', text: 'Turn 2 steer', followUpBehavior: 'steer' }, runtime);
  const done = await service.waitForChat(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.error, undefined);
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text === 'Turn 2 unaffected'));
  await service.close();
}));

test('HTTP /motion-api/super-agent uploads, workspace files, file-content, and security guards', () => fixture(async store => {
  const req = transport(store);

  // 1. Upload general Markdown/UTF-8 file with CJK filename
  const mdBody = '# Launch Plan\n\nUse primary tokens from the Brand Kit.\n';
  const uploadRes = await req('/motion-api/super-agent/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/markdown',
      'X-File-Name': encodeURIComponent('产品说明 brief.md'),
    },
    body: mdBody,
  });
  assert.equal(uploadRes.status, 200);
  const uploadJson = await uploadRes.json() as { attachment: any };
  assert.equal(uploadJson.attachment.kind, 'file');
  assert.equal(uploadJson.attachment.rootKey, 'upload');
  assert.equal(uploadJson.attachment.title, '产品说明 brief.md');
  assert.equal(uploadJson.attachment.mimeType, 'text/markdown');
  assert.equal(uploadJson.attachment.sizeBytes, Buffer.byteLength(mdBody));

  // 2. Read upload metadata + text content via ?format=json and raw download
  const uploadJsonRes = await req(`${uploadJson.attachment.previewUrl}?format=json`);
  assert.equal(uploadJsonRes.status, 200);
  const uploadMeta = await uploadJsonRes.json() as any;
  assert.equal(uploadMeta.binary, false);
  assert.equal(uploadMeta.content, mdBody);

  const rawDownloadRes = await req(`${uploadJson.attachment.previewUrl}?download=1`);
  assert.equal(rawDownloadRes.status, 200);
  assert.match(rawDownloadRes.headers.get('content-disposition') ?? '', /attachment/i);
  assert.equal(rawDownloadRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(await rawDownloadRes.text(), mdBody);

  const missingUploadRes = await req('/motion-api/super-agent/uploads/nonexistent-id');
  assert.equal(missingUploadRes.status, 404);

  // 3. Index and read files/folders under a custom workingDir
  const workDir = path.join(store.directory, 'custom-repo');
  await mkdir(path.join(workDir, 'docs'), { recursive: true });
  await mkdir(path.join(workDir, 'src'), { recursive: true });
  await writeFile(path.join(workDir, 'docs', 'guide.md'), '# Guide\nHello workspace\n');
  await writeFile(path.join(workDir, 'src', 'index.ts'), 'export const version = 1;\n');

  const filesRes = await req(`/motion-api/super-agent/files?workingDir=${encodeURIComponent(workDir)}&query=guide`);
  assert.equal(filesRes.status, 200);
  const filesJson = await filesRes.json() as { items: any[] };
  const guideItem = filesJson.items.find(item => item.kind === 'file' && item.filePath === 'docs/guide.md');
  assert.ok(guideItem, 'expected docs/guide.md in listed workspace entries');

  const folderRes = await req(`/motion-api/super-agent/files?workingDir=${encodeURIComponent(workDir)}&query=docs`);
  assert.equal(folderRes.status, 200);
  const folderJson = await folderRes.json() as { items: any[] };
  assert.ok(folderJson.items.some(item => item.kind === 'folder' && item.filePath === 'docs'));

  const contentRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&rootKey=${encodeURIComponent(guideItem.rootKey)}&path=${encodeURIComponent(guideItem.filePath)}`,
  );
  assert.equal(contentRes.status, 200);
  const contentJson = await contentRes.json() as any;
  assert.equal(contentJson.content, '# Guide\nHello workspace\n');
  assert.equal(contentJson.binary, false);

  const rawContentRes = await req(contentJson.previewUrl);
  assert.equal(rawContentRes.status, 200);
  assert.equal(await rawContentRes.text(), '# Guide\nHello workspace\n');

  const traversalRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&rootKey=${encodeURIComponent(guideItem.rootKey)}&path=${encodeURIComponent('../../etc/passwd')}`,
  );
  assert.equal(traversalRes.status, 400);

  // Omitted rootKey resolves both relative and in-root absolute paths safely, while blocking external paths
  const noRootRelRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&path=${encodeURIComponent('docs/guide.md')}`,
  );
  assert.equal(noRootRelRes.status, 200);
  const noRootRelJson = await noRootRelRes.json() as any;
  assert.equal(noRootRelJson.content, '# Guide\nHello workspace\n');
  const noRootRawRes = await req(noRootRelJson.previewUrl);
  assert.equal(noRootRawRes.status, 200);
  assert.equal(await noRootRawRes.text(), '# Guide\nHello workspace\n');

  const noRootAbsRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&path=${encodeURIComponent(path.join(workDir, 'docs', 'guide.md'))}`,
  );
  assert.equal(noRootAbsRes.status, 200);
  const noRootAbsJson = await noRootAbsRes.json() as any;
  assert.equal(noRootAbsJson.content, '# Guide\nHello workspace\n');

  const outsideAbsRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&path=${encodeURIComponent('/etc/passwd')}`,
  );
  assert.equal(outsideAbsRes.status, 400);
  const noRootTraversalRes = await req(
    `/motion-api/super-agent/file-content?workingDir=${encodeURIComponent(workDir)}&path=${encodeURIComponent('../../etc/passwd')}`,
  );
  assert.equal(noRootTraversalRes.status, 400);
}));

test('Referenced chats (<openmotion-referenced-conversations>), uploaded textExcerpt, and inline segments persistence', () => fixture(async store => {
  let capturedPrompt = '';
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/claude',
    runClaude: async ({ prompt, onEvent }) => {
      capturedPrompt = prompt;
      await onEvent({ type: 'result', subtype: 'success', result: 'Combined context applied.' });
    },
  });

  // 1. Seed a prior conversation with history and an artifact
  const sourceChat = await service.create({ engine: 'claude', title: 'Sunset Landing Thread', permissionMode: 'auto' });
  await service.start(sourceChat.id, {
    requestId: 'req-src-chat-1',
    text: 'Create a sunset gradient hero section',
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => ({} as Phase1Service),
  });
  await service.waitForChat(sourceChat.id);
  await service.update(sourceChat.id, {
    addArtifact: {
      id: 'design-sunset-1',
      kind: 'design-project',
      title: 'Sunset Hero',
      projectId: '11111111-1111-4111-8111-111111111111',
      scenario: 'prototype',
    },
  });

  // 2. Upload an attachment so its textExcerpt also flows into <openmotion-workspace-context>
  const uploaded = await service.saveUploadedFile('notes.md', Buffer.from('# Spec Notes\nKeep nav height 56px.\n'), 'text/markdown');

  // 3. Reference the prior chat and uploaded file inline via segments + attachments
  const targetChat = await service.create({ engine: 'claude', permissionMode: 'auto' });
  const segments = [
    { type: 'text' as const, text: 'Reuse tokens from ' },
    { type: 'mention' as const, attachmentKey: `chat:${sourceChat.id}:`, label: 'Sunset Landing Thread', kind: 'chat' as const },
    { type: 'text' as const, text: ' and follow ' },
    { type: 'mention' as const, attachmentKey: `file:${uploaded.id}:`, label: 'notes.md', kind: 'file' as const },
  ];

  await service.start(targetChat.id, {
    requestId: 'req-ref-chat-1',
    text: 'Reuse tokens from @Sunset Landing Thread and follow @notes.md',
    segments,
    attachments: [
      {
        id: sourceChat.id,
        chatId: sourceChat.id,
        kind: 'chat',
        title: 'Sunset Landing Thread',
        subtitle: '2 messages',
      },
      uploaded,
    ],
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => ({} as Phase1Service),
  });
  const doneTarget = await service.waitForChat(targetChat.id);

  assert.match(capturedPrompt, /<openmotion-referenced-conversations>/);
  assert.match(capturedPrompt, /Sunset Landing Thread/);
  assert.match(capturedPrompt, /Create a sunset gradient hero section/);
  assert.match(capturedPrompt, /Sunset Hero/);
  assert.match(capturedPrompt, /Keep nav height 56px\./);

  const userMsg = doneTarget.messages.find(m => m.role === 'user');
  assert.equal(userMsg?.segments?.length, 4);
  assert.equal(userMsg?.segments?.[1]?.type, 'mention');
  if (userMsg?.segments?.[1]?.type === 'mention') {
    assert.equal(userMsg.segments[1].kind, 'chat');
  }

  // 4. Verify queued message retains updated segments
  const queued = await service.enqueueMessage(targetChat.id, {
    requestId: 'req-q-seg',
    text: 'Initial',
    segments: [{ type: 'text', text: 'Initial' }],
  });
  const qId = queued.queuedMessages![0].id;
  const updatedQ = await service.updateQueuedMessage(targetChat.id, qId, {
    text: 'Check @notes.md',
    segments: [
      { type: 'text', text: 'Check ' },
      { type: 'mention', attachmentKey: `file:${uploaded.id}:`, label: 'notes.md', kind: 'file' },
    ],
  });
  assert.equal(updatedQ.queuedMessages?.[0]?.segments?.length, 2);

  await service.close();
}));

test('SuperAgentConversations accepts asset-* present aliases, extracts multiple assets, and long-polls status', () => fixture(async store => {
  const lib = new AssetLibrary(store);
  const img1 = await lib.importFile(await (async () => {
    const file = path.join(store.directory, 'out1.png');
    const res = await execute(
      verificationBinaries().ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x24', '-frames:v', '1', '-y', file],
      store.directory,
      20_000,
    );
    assert.equal(res.code, 0, res.stderr);
    return file;
  })(), { requestId: 'sa-out-1', name: 'Output 1' });
  const img2 = await lib.importFile(await (async () => {
    const file = path.join(store.directory, 'out2.png');
    const res = await execute(
      verificationBinaries().ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x24', '-frames:v', '1', '-y', file],
      store.directory,
      20_000,
    );
    assert.equal(res.code, 0, res.stderr);
    return file;
  })(), { requestId: 'sa-out-2', name: 'Output 2' });

  let statusCalls = 0;
  let presentedResponse: any;
  let statusResponse: any;
  const mockPhase1: any = {
    call: async (name: string, args: any) => {
      if (name === 'openmotion_assets_use' && args.action === 'status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { job: { id: args.jobId, state: 'queued', modality: 'image' } };
        }
        return {
          job: {
            id: args.jobId,
            state: 'completed',
            modality: 'image',
            libraryAssets: [
              { assetId: img1.id, versionId: img1.currentVersionId },
              { assetId: img2.id, versionId: img2.currentVersionId },
            ],
          },
        };
      }
      return { ok: true };
    },
  };

  class MediaRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-media-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 301,
            method: 'item/tool/call',
            params: {
              callId: 'poll-1',
              tool: 'openmotion_assets_use',
              arguments: { action: 'status', jobId: 'job-multi-1' },
            },
          });
        });
        return { turn: { id: 'turn-media-1' } };
      }
      return {};
    }
    send(payload: any) {
      if (payload.id === 301) {
        statusResponse = payload.result;
        queueMicrotask(() => {
          this.onNotification({
            id: 302,
            method: 'item/tool/call',
            params: {
              callId: 'present-alias-1',
              tool: 'openmotion_present_artifact',
              arguments: { kind: 'asset-image', assetId: img1.id, versionId: img1.currentVersionId },
            },
          });
        });
      } else if (payload.id === 302) {
        presentedResponse = payload.result;
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-media-1', status: 'completed' } },
          });
        });
      }
    }
    close() {}
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: MediaRpc as unknown as typeof AssetAgentRpc,
    statusPollWaitMs: 3_000,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-media-poll-1', text: 'Check media job' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => mockPhase1,
  });
  const done = await service.waitForChat(chat.id);
  assert.equal(statusCalls, 2);
  assert.equal(statusResponse?.success, true);
  assert.equal(presentedResponse?.success, true);
  assert.equal(done.artifacts.length, 2);
  assert.ok(done.artifacts.some(a => a.assetId === img1.id && typeof a.presentedAt === 'number'));
  assert.ok(done.artifacts.some(a => a.assetId === img2.id));
  await service.close();
}));

test('listTaskWorkspaceEntries ignores custom root directory name in single-root searches and ranks stem matches first', () => fixture(async store => {
  const customRootDir = path.join(store.directory, 'design_studio_modules_entry');
  await mkdir(path.join(customRootDir, 'skills', 'demo', 'agents'), { recursive: true });
  await writeFile(path.join(customRootDir, 'AGENTS.md'), '# Agents\n');
  await writeFile(path.join(customRootDir, 'README.md'), '# Readme\n');
  await writeFile(path.join(customRootDir, 'design-spec.md'), '# Design Spec\n');

  const roots = [
    {
      key: `custom:${customRootDir}`,
      kind: 'custom' as const,
      dir: customRootDir,
      label: 'design_studio_modules_entry',
    },
  ];

  const agentMatches = await listTaskWorkspaceEntries(roots, { query: 'AGENTS' });
  assert.ok(agentMatches.length >= 2);
  assert.equal(agentMatches[0]?.filePath, 'AGENTS.md');
  assert.equal(agentMatches[0]?.kind, 'file');

  const designMatches = await listTaskWorkspaceEntries(roots, { query: 'design' });
  assert.equal(designMatches.some(item => item.filePath === 'design-spec.md'), true);
  assert.equal(designMatches.some(item => item.filePath === 'README.md'), false);
}));

test('formatBrowserAnnotationsContext serializes Motion, Design comment, and code selections clearly', () => {
  const ctx = formatBrowserAnnotationsContext([
    {
      id: 'att-motion',
      kind: 'browser-annotation',
      title: 'Headline · 2.4s',
      annotation: {
        mode: 'motion-selection',
        pageUrl: '/#project/mproj-1',
        pageTitle: 'Product Reel',
        artifactId: 'motion:mproj-1',
        artifactKind: 'motion-project',
        projectId: 'mproj-1',
        compositionPath: 'scenes/intro.html',
        filePath: 'scenes/intro.html',
        timeSec: 2.4,
        durationSec: 10,
        fps: 30,
        timeRange: { start: 1.5, end: 4.5 },
        keyframeCount: 2,
        timelineClips: [
          {
            id: 'clip-hero',
            label: 'Hero Headline',
            kind: 'text',
            start: 1.5,
            duration: 3.0,
            track: 1,
            sourceFile: 'scenes/intro.html',
            selector: '#hero-title',
          },
        ],
        selectedElements: [
          {
            label: 'Hero Headline',
            tagName: 'h1',
            selector: '#hero-title',
            hfId: 'hf-1',
            sourceFile: 'scenes/intro.html',
            text: 'Launch Day',
          },
        ],
        comment: 'Soften the blur entrance.',
      },
    },
    {
      id: 'att-design-comment',
      kind: 'browser-annotation',
      title: 'Slide #3 spacing',
      annotation: {
        mode: 'design-comment',
        pageUrl: '/motion-api/design/raw/dproj-1/deck.html',
        pageTitle: 'Launch Deck',
        artifactKind: 'design-project',
        projectId: 'dproj-1',
        filePath: 'deck.html',
        slideIndex: 2,
        slideCount: 8,
        commentId: 'cmt-42',
        comment: 'Increase card gap',
      },
    },
    {
      id: 'att-code',
      kind: 'browser-annotation',
      title: 'index.html L12-L15',
      annotation: {
        mode: 'code-selection',
        pageUrl: '/motion-api/design/raw/dproj-1/index.html',
        artifactKind: 'design-project',
        projectId: 'dproj-1',
        filePath: 'index.html',
        lineRange: { start: 12, end: 15 },
        codeSnippet: '<section class="hero">\n  <h1>Hello</h1>\n</section>',
      },
    },
  ]);

  assert.ok(ctx.includes('"mode": "motion-selection"'));
  assert.ok(ctx.includes('"projectId": "mproj-1"'));
  assert.ok(ctx.includes('"compositionPath": "scenes/intro.html"'));
  assert.ok(ctx.includes('"timeSec": 2.4'));
  assert.ok(ctx.includes('"durationSec": 10'));
  assert.ok(ctx.includes('"fps": 30'));
  assert.ok(ctx.includes('"start": 1.5'));
  assert.ok(ctx.includes('"end": 4.5'));
  assert.ok(ctx.includes('"keyframeCount": 2'));
  assert.ok(ctx.includes('"id": "clip-hero"'));
  assert.ok(ctx.includes('"selector": "#hero-title"'));
  assert.ok(ctx.includes('"mode": "design-comment"'));
  assert.ok(ctx.includes('"slideIndex": 2'));
  assert.ok(ctx.includes('"slideCount": 8'));
  assert.ok(ctx.includes('"commentId": "cmt-42"'));
  assert.ok(ctx.includes('"mode": "code-selection"'));
  assert.ok(ctx.includes('"start": 12'));
  assert.ok(ctx.includes('"end": 15'));
  assert.ok(ctx.includes('<section class=\\"hero\\">'));
});

test('extractArtifactFromTool auto-presents created design and motion projects so embedded editor opens automatically', () => fixture(async store => {
  const createdDesign = await designProjectsFor(store.directory).create({
    scenario: 'prototype',
    title: 'Interactive Brief',
    requestId: 'req-auto-present-design',
  });

  class AutoPresentRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-autopresent-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 401,
            method: 'item/tool/call',
            params: {
              callId: 'call-design-create',
              tool: 'openmotion_design_project',
              arguments: { action: 'create', title: 'Interactive Brief', scenario: 'prototype' },
            },
          });
        });
        return { turn: { id: 'turn-autopresent-1' } };
      }
      return {};
    }
    send(payload: any) {
      if (payload.id === 401) {
        queueMicrotask(() => {
          this.onNotification({
            id: 402,
            method: 'item/tool/call',
            params: {
              callId: 'call-motion-create',
              tool: 'openmotion_create_project',
              arguments: { name: 'MotionOpener' },
            },
          });
        });
      } else if (payload.id === 402) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-autopresent-1', status: 'completed' } },
          });
        });
      }
    }
    close() {}
  }

  const mockPhase1: any = {
    call: async (name: string) => {
      if (name === 'openmotion_design_project') {
        return {
          project: createdDesign,
          editorUrl: `/design/projects/${createdDesign.id}`,
          previewUrl: `/motion-api/design/raw/${createdDesign.id}/index.html`,
        };
      }
      if (name === 'openmotion_create_project') {
        return {
          projectId: 'MotionOpener',
          sessionId: 'sess-ap-1',
          revision: 'rev-ap-1',
          project: { title: 'MotionOpener' },
        };
      }
      return { ok: true };
    },
  };

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: AutoPresentRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-ap-1', text: 'Create design and motion' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => mockPhase1,
  });
  const done = await service.waitForChat(chat.id);
  const designArt = done.artifacts.find(a => a.kind === 'design-project' && a.projectId === createdDesign.id);
  const motionArt = done.artifacts.find(a => a.kind === 'motion-project' && a.projectId === 'MotionOpener');
  assert.ok(designArt);
  assert.equal(typeof designArt.presentedAt, 'number');
  assert.ok(motionArt);
  assert.equal(typeof motionArt.presentedAt, 'number');
  await service.close();
}));

test('SuperAgentConversations starts a new Codex thread with the conversation when its tools changed since the thread began', () => fixture(async store => {
  const requests: Array<{ method: string; params: any }> = [];
  class ToolsCodexRpc {
    private readonly onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) { this.onNotification = onNotification; }
    async request(method: string, params?: any) {
      requests.push({ method, params });
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: `thr-${requests.filter(r => r.method === 'thread/start').length}` } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({ method: 'item/completed', params: { item: { id: `msg-${requests.length}`, type: 'agentMessage', text: 'ok' } } });
          this.onNotification({ method: 'turn/completed', params: { turn: { id: `turn-${requests.length}`, status: 'completed' } } });
        });
        return { turn: { id: `turn-${requests.length}` } };
      }
      return {};
    }
    send() {}
    close() {}
    async closeAndWait() {}
  }
  const service = new SuperAgentConversations(store, { resolve: async () => '/usr/local/bin/codex', rpc: ToolsCodexRpc as unknown as typeof AssetAgentRpc });
  const runtime = { origin: 'http://127.0.0.1:4120', phase1: () => ({} as Phase1Service) };
  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
  const turn = async (requestId: string, text: string) => {
    await service.start(chat.id, { requestId, text }, runtime);
    let done = await service.waitForChat(chat.id);
    for (let i = 0; i < 40 && done.state === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 25)); done = await service.get(chat.id); }
  };
  await turn('req-1', 'Make a stacking game');
  const first = requests.find(r => r.method === 'thread/start')!;
  assert.ok(first.params.dynamicTools.some((tool: any) => tool.name === 'openmotion_game_wechat'));
  // A thread started before an upgrade: it does not have the tools this version offers.
  const saved = await service.get(chat.id);
  assert.equal(saved.threadId, 'thr-1');
  await (service as any).persistChatState({ ...saved, threadTools: 'openmotion_game_get' });
  requests.length = 0;
  await turn('req-2', 'Publish it to WeChat');
  assert.equal(requests.some(r => r.method === 'thread/resume'), false);
  assert.ok(requests.some(r => r.method === 'thread/start'));
  const carried = requests.find(r => r.method === 'turn/start')!.params.input[0].text;
  assert.match(carried, /<openmotion-compacted-history>/);
  assert.match(carried, /Make a stacking game/);
  // Same tools afterwards: the new thread is resumed as usual.
  requests.length = 0;
  await turn('req-3', 'Next step');
  assert.ok(requests.some(r => r.method === 'thread/resume'));
  assert.equal(requests.some(r => r.method === 'thread/start'), false);
  assert.doesNotMatch(requests.find(r => r.method === 'turn/start')!.params.input[0].text, /<openmotion-compacted-history>/);
  await service.close();
}));

test('extractActionCardFromTool maps provider handoffs, low-balance failures, and web-publish auth errors', async () => {
  const { extractActionCardFromTool } = await import('../gateway/super-agent.ts');
  const { resolveMediaSetupEntry } = await import('../gateway/media-use.ts');

  assert.deepEqual(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers', entry: 'agent_media_signed_out' }, { previewUrl: 'http://localhost/settings/providers?provider=account' }, true),
    {
      id: 'action:sign_in:agent_media_signed_out',
      kind: 'sign_in',
      entry: 'agent_media_signed_out',
      provider: 'account',
    },
  );
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers', entry: 'agent_media_upgrade_free' }, {}, true)?.kind,
    'upgrade_free',
  );
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers', entry: 'agent_media_upgrade_go' }, {}, true)?.kind,
    'upgrade_go',
  );
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers', entry: 'agent_media_balance_low' }, {}, true)?.kind,
    'top_up',
  );
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers', entry: 'agent_media_key_rejected' }, {}, true)?.kind,
    'configure_key',
  );
  // Generic provider preview without an actionable onboarding entry should not show a setup card
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'providers' }, {}, true),
    undefined,
  );
  assert.equal(
    extractActionCardFromTool('openmotion_open_preview', { target: 'templates' }, {}, true),
    undefined,
  );
  // Silent capability discovery (inspect with settingsHandoff) must never auto-pop a sign-in or upgrade card
  assert.equal(
    extractActionCardFromTool(
      'openmotion_media_use',
      { action: 'inspect', modality: 'audio' },
      { settingsHandoff: { tool: 'openmotion_open_preview', arguments: { target: 'providers', entry: 'agent_media_signed_out' } } },
      true,
    ),
    undefined,
  );
  assert.equal(
    extractActionCardFromTool(
      'openmotion_media_use',
      { action: 'inspect', modality: 'audio' },
      { settingsHandoff: { tool: 'openmotion_open_preview', arguments: { target: 'providers', entry: 'agent_media_upgrade_free' } } },
      true,
    ),
    undefined,
  );

  // Reactive Plus low-balance failure from failed OpenDesign account generation job (direct AND MCP structuredContent envelope)
  assert.deepEqual(
    extractActionCardFromTool('openmotion_assets_use', { action: 'status' }, { job: { state: 'failed', model: { provider: 'account' }, error: 'Your OpenDesign balance is too low for this request. Top up, then try again.' } }, true),
    {
      id: 'action:top_up:agent_media_balance_low',
      kind: 'top_up',
      entry: 'agent_media_balance_low',
      provider: 'account',
    },
  );
  assert.deepEqual(
    extractActionCardFromTool(
      'openmotion_assets_use',
      { action: 'status', jobId: 'job-1' },
      {
        isError: false,
        structuredContent: {
          job: { state: 'failed', model: { provider: 'account' }, error: 'Your OpenDesign balance is too low for this request. Top up, then try again.' },
        },
        content: [{ type: 'text', text: '{"job":{"state":"failed"}}' }],
      },
      true,
    ),
    {
      id: 'action:top_up:agent_media_balance_low',
      kind: 'top_up',
      entry: 'agent_media_balance_low',
      provider: 'account',
    },
  );
  // Negative case: BYOK provider insufficient_credits must NOT trigger an OpenDesign top-up card
  assert.equal(
    extractActionCardFromTool('openmotion_assets_use', { action: 'generate', model: 'fal:flux-pro' }, { error: 'insufficient_credits on fal account' }, false),
    undefined,
  );

  // Plan restriction uses actual account context (Go -> upgrade_go, Free -> upgrade_free, Plus -> undefined)
  const planErr = { isError: true, structuredContent: { error: { code: 'tier_model_not_entitled', message: 'Your OpenDesign plan does not include this model. Choose another model or upgrade your plan.' } } };
  assert.equal(
    extractActionCardFromTool('openmotion_assets_use', { action: 'generate', model: 'account:seedance' }, planErr, false, { accountPlan: 'go', accountMediaEntitlement: 'not-included' })?.kind,
    'upgrade_go',
  );
  assert.equal(
    extractActionCardFromTool('openmotion_assets_use', { action: 'generate', model: 'account:seedance' }, planErr, false, { accountPlan: 'free', accountMediaEntitlement: 'not-included' })?.kind,
    'upgrade_free',
  );
  assert.equal(
    extractActionCardFromTool('openmotion_assets_use', { action: 'generate', model: 'account:pro-only' }, planErr, false, { accountPlan: 'plus', accountMediaEntitlement: 'included' }),
    undefined,
  );

  // Structured MCP content[] envelope for web_publish auth failure (publish only, not status)
  const mcpAuthErr = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'OPENDESIGN_SIGN_IN_REQUIRED: Sign in with OpenDesign to publish' } }) }],
  };
  assert.deepEqual(
    extractActionCardFromTool(
      'openmotion_assets_use',
      { action: 'web_publish', webPublish: { command: 'publish', targetKind: 'game', targetId: 'game-abc' } },
      mcpAuthErr,
      false,
    ),
    {
      id: 'action:web_publish_sign_in:game:game-abc',
      kind: 'web_publish_sign_in',
      entry: 'agent_media_signed_out',
      provider: 'account',
      targetKind: 'game',
      targetId: 'game-abc',
    },
  );
  assert.equal(
    extractActionCardFromTool(
      'openmotion_assets_use',
      { action: 'web_publish', webPublish: { command: 'status', targetKind: 'game', targetId: 'game-abc' } },
      mcpAuthErr,
      false,
    ),
    undefined,
  );
  assert.deepEqual(
    extractActionCardFromTool(
      'openmotion_design_project',
      { action: 'deploy', projectId: 'design-xyz' },
      mcpAuthErr,
      false,
    ),
    {
      id: 'action:web_publish_sign_in:design:design-xyz',
      kind: 'web_publish_sign_in',
      entry: 'agent_media_signed_out',
      provider: 'account',
      targetKind: 'design',
      targetId: 'design-xyz',
    },
  );

  // Modality-scoped media setup resolution: Codex image-only does not suppress audio/video upgrade entry
  const providers = [
    { id: 'codex', available: true, configured: true, verification: 'unverified' as const },
    { id: 'account', available: true, configured: true, verification: 'unverified' as const, mediaEntitlement: 'not-included' as const, plan: 'go' as const },
  ];
  const capabilities = [
    { modality: 'image' as const, available: true, modelIds: ['codex:image-generation'] },
    { modality: 'video' as const, available: false, modelIds: [] },
    { modality: 'audio' as const, available: false, modelIds: [] },
  ];
  assert.equal(resolveMediaSetupEntry(providers, { modality: 'image', capabilities }), undefined);
  assert.equal(resolveMediaSetupEntry(providers, { modality: 'audio', capabilities }), 'agent_media_upgrade_go');
  assert.equal(resolveMediaSetupEntry(providers, { modality: 'video', capabilities }), 'agent_media_upgrade_go');

  // Text-only provider (e.g. openai) must not suppress media setup when capabilities are supplied without modality
  const textOnlyProviders = [
    { id: 'openai', available: true, configured: true, verification: 'unverified' as const },
    { id: 'account', available: false, configured: false, verification: 'unverified' as const },
  ];
  const emptyMediaCapabilities = [
    { modality: 'image' as const, available: false, modelIds: [] },
    { modality: 'video' as const, available: false, modelIds: [] },
    { modality: 'audio' as const, available: false, modelIds: [] },
  ];
  assert.equal(resolveMediaSetupEntry(textOnlyProviders, { capabilities: emptyMediaCapabilities }), 'agent_media_signed_out');

  // Guard against presenting /settings/providers as a web artifact (both absolute same-origin and relative forms)
  const { isProviderSettingsWebArtifactUrl } = await import('../gateway/super-agent.ts');
  const ownOrigin = 'http://127.0.0.1:4120';
  assert.equal(isProviderSettingsWebArtifactUrl('http://127.0.0.1:4120/settings/providers?provider=account&entry_from=agent_media_signed_out', ownOrigin), true);
  assert.equal(isProviderSettingsWebArtifactUrl('/settings/providers?entry_from=agent_media_signed_out', ownOrigin), true);
  assert.equal(isProviderSettingsWebArtifactUrl('/settings/providers/', ownOrigin), true);
  assert.equal(isProviderSettingsWebArtifactUrl('https://example.com/settings/providers', ownOrigin), false);
  assert.equal(isProviderSettingsWebArtifactUrl('http://127.0.0.1:4120/games/demo', ownOrigin), false);
});

test('Super Agent always gates billed media generation approvals even in default auto permissionMode until Always allow is granted for generation', () => fixture(async store => {
  const { readFile } = await import('node:fs/promises');
  let generationCalls = 0;
  const phase1 = {
    call: async (name: string, args: any) => {
      if (name === 'openmotion_assets_use' && args.action === 'generate') {
        generationCalls += 1;
        return { job: { id: `job-auto-gate-${generationCalls}`, state: 'queued', model: { id: args.model || 'account:elevenlabs-music-v2' } } };
      }
      return {};
    },
  } as unknown as Phase1Service;

  let firstApprovalObserved = false;
  let secondApprovalObserved = false;
  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/usr/local/bin/claude',
    runClaude: async ({ mcpConfigPath, onEvent }) => {
      const cfg = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
      const server = cfg.mcpServers.openmotion;
      const callGen = (id: number, model: string, modality: string, prompt: string) =>
        fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...server.headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'openmotion_assets_use', arguments: { action: 'generate', model, modality, prompt } },
          }),
        });

      // 1) First billed call in default auto mode MUST still wait for user approval
      const firstPromise = callGen(11, 'account:elevenlabs-music-v2', 'audio', 'playful farmyard loop');
      for (let i = 0; i < 60; i++) {
        const current = await service.get(chat.id);
        if (current.approvals.length > 0) {
          firstApprovalObserved = true;
          assert.equal(current.state, 'waiting');
          assert.equal(current.approvals[0].kind, 'generation');
          assert.equal(generationCalls, 0);
          // Approve once (alwaysAllow=false)
          await service.answer(chat.id, current.approvals[0].id, true, false);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const firstBody = await (await firstPromise).json() as any;
      assert.equal(firstBody.result.isError, false);
      assert.equal(generationCalls, 1);

      // 2) Second billed call MUST still gate until user grants alwaysAllow=true on generation
      const secondPromise = callGen(12, 'account:gpt-image-2', 'image', 'farmyard backdrop');
      for (let i = 0; i < 60; i++) {
        const current = await service.get(chat.id);
        if (current.approvals.length > 0) {
          secondApprovalObserved = true;
          assert.equal(current.approvals[0].kind, 'generation');
          assert.equal(generationCalls, 1);
          await service.answer(chat.id, current.approvals[0].id, true, true);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const secondBody = await (await secondPromise).json() as any;
      assert.equal(secondBody.result.isError, false);
      assert.equal(generationCalls, 2);

      // 3) Third billed call after generation alwaysAllow=true proceeds immediately without waiting
      const thirdBody = await (await callGen(13, 'account:gpt-image-2', 'image', 'golden goose icon')).json() as any;
      assert.equal(thirdBody.result.isError, false);
      assert.equal(generationCalls, 3);

      await onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'All assets generated.' }] } });
    },
  });

  // Default create() uses permissionMode: 'auto'
  const chat = await service.create({ engine: 'claude' });
  assert.equal(chat.permissionMode, 'auto');
  await service.start(chat.id, { requestId: 'req-auto-gen-gate-1', text: 'Make a goose game' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 100; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const done = await service.get(chat.id);
  assert.equal(firstApprovalObserved, true);
  assert.equal(secondApprovalObserved, true);
  assert.equal(generationCalls, 3);
  assert.equal(done.generationAutoApproved, true);
  assert.equal(done.state, 'idle');
  await service.close();
}));
