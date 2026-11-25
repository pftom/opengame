import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAgent } from '../gateway/agents.ts';
import { clearLocalAgentResolveCache, LocalAgentDirectory, resolveLocalAgent } from '../gateway/local-agents.ts';
import {
  agentInvocation,
  discoverAcp,
  discoverClaudeModels,
  discoverCodexAppServer,
  discoverPiRpc,
  extractAcpModels,
  parseAgentAuth,
  parseAgentModels,
  qwenModels,
  validModelId,
  vibeConfigModels,
} from '../gateway/agent-discovery.ts';
import { terminalCommand } from '../gateway/agent-terminal.ts';
import { localAgents, pickPreferredLocalAgent, type LocalAgent } from '../shared/local-agents.ts';

test('local Codex prefers a newer bundled CLI and respects an explicit binary', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openmotion-codex-resolve-'));
  const keys = ['PATH', 'CODEX_BIN', 'CODEX_APP_RUNTIME_CLI_PATH'] as const;
  const saved = keys.map(key => process.env[key]);
  t.after(async () => {
    for (const [index, key] of keys.entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearLocalAgentResolveCache();
    await rm(dir, { recursive: true, force: true });
  });

  const standalone = path.join(dir, 'codex');
  const bundled = path.join(dir, 'bundled codex');
  const override = path.join(dir, 'configured codex');
  const writeCli = (file: string, version: string) =>
    writeFile(file, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`, { mode: 0o700 });
  await Promise.all([writeCli(standalone, '0.99.0'), writeCli(bundled, '0.100.0'), writeCli(override, '0.1.0')]);
  process.env.PATH = dir;
  process.env.CODEX_APP_RUNTIME_CLI_PATH = bundled;
  delete process.env.CODEX_BIN;
  clearLocalAgentResolveCache();

  assert.equal(await resolveLocalAgent('codex'), bundled);
  assert.equal(await resolveAgent('codex'), bundled);

  process.env.CODEX_BIN = override;
  assert.equal(await resolveLocalAgent('codex'), override);
  assert.equal(await resolveAgent('codex'), override);
  delete process.env.CODEX_BIN;

  const versionCases = [
    ['0.100.0', '0.100.0', standalone],
    ['0.101.0', '0.100.0', standalone],
    ['0.162.0', '0.171.0-alpha.13', bundled],
    ['0.172.0', '0.171.0-alpha.13', standalone],
    ['0.171.0', '0.171.0-alpha.13', standalone],
    ['0.171.0-alpha.13', '0.171.0', bundled],
    ['0.171.0-alpha.9', '0.171.0-alpha.13', bundled],
    ['0.171.0-alpha.13', '0.171.0-alpha.9', standalone],
    ['0.171.0+build.1', '0.171.0+build.2', standalone],
    ['0.171.0-alpha.13+build.1', '0.171.0-alpha.13+build.2', standalone],
    ['0.162.0', 'unknown', standalone],
    ['unknown', '0.171.0', standalone],
  ] as const;
  for (const [standaloneVersion, bundledVersion, expected] of versionCases) {
    await t.test(`standalone ${standaloneVersion}, bundled ${bundledVersion}`, async () => {
      await Promise.all([writeCli(standalone, standaloneVersion), writeCli(bundled, bundledVersion)]);
      clearLocalAgentResolveCache();
      assert.equal(await resolveLocalAgent('codex'), expected);
      assert.equal(await resolveAgent('codex'), expected);
    });
  }
});

test('Agent discovery excludes hidden models and parses CLI, help, Pi and spinner outputs cleanly', () => {
  assert.deepEqual(
    parseAgentModels('codex', JSON.stringify({
      models: [
        { slug: 'model-1', display_name: 'One', supported_reasoning_levels: [{ effort: 'high' }], base_instructions: 'private' },
        { slug: 'hidden', visibility: 'hide' },
        { slug: 'model-1' },
      ],
    })),
    [{ id: 'model-1', label: 'One', source: 'cli', reasoning: ['high'] }],
  );
  assert.deepEqual(
    parseAgentModels('codex', JSON.stringify({
      data: [
        { id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
        { id: 'internal', model: 'internal', hidden: true },
      ],
    })),
    [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', source: 'cli', reasoning: ['low', 'high'] }],
  );
  assert.deepEqual(
    parseAgentModels('lines', [
      '\x1b[32mprovider/model-1\x1b[0m',
      'Not logged in',
      'Fetching available models...\rgemini-4-neon-high\tGemini 4 Neon (High)',
      'claude-opus-5-5-high             Claude Opus 5.5 (High)',
      'model-2 - Model two',
      'auto - Auto (default)',
      'Aider v0.82.0',
      'Models which match "":',
      '- gpt-4-turbo (openai/gpt-4-turbo)',
      'Tip: run agent login first',
      'https://example.com/docs',
      'v1.2.3',
    ].join('\n')),
    [
      { id: 'provider/model-1', label: 'provider/model-1', source: 'cli' },
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', source: 'cli' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', source: 'cli' },
      { id: 'model-2', label: 'Model two', source: 'cli' },
      { id: 'auto', label: 'Auto (default)', source: 'cli' },
      { id: 'openai/gpt-4-turbo', label: 'gpt-4-turbo', source: 'cli' },
    ],
  );
  assert.deepEqual(
    parseAgentModels('help', '  --model <model>  Select model\n                   (choices: "gpt-5.2", "claude-sonnet-5")'),
    [{ id: 'gpt-5.2', label: 'gpt-5.2', source: 'cli' }, { id: 'claude-sonnet-5', label: 'claude-sonnet-5', source: 'cli' }],
  );
  assert.deepEqual(
    parseAgentModels('help', '  --model <MODEL>  Model [possible values: deepseek-chat, deepseek-reasoner]'),
    [{ id: 'deepseek-chat', label: 'deepseek-chat', source: 'cli' }, { id: 'deepseek-reasoner', label: 'deepseek-reasoner', source: 'cli' }],
  );
  assert.deepEqual(
    parseAgentModels('help', '  --model  Currently supported: (glm-5, deepseek-v4)'),
    [{ id: 'glm-5', label: 'glm-5', source: 'cli' }, { id: 'deepseek-v4', label: 'deepseek-v4', source: 'cli' }],
  );
  assert.deepEqual(
    parseAgentModels('pi', 'provider        model           context\n--------        -----           -------\nopenai.codex    gpt-6.2-sol     500k\namazon-bedrock  claude-opus-5   1M\n'),
    [{ id: 'openai.codex/gpt-6.2-sol', label: 'openai.codex/gpt-6.2-sol', source: 'cli' }, { id: 'amazon-bedrock/claude-opus-5', label: 'amazon-bedrock/claude-opus-5', source: 'cli' }],
  );
  assert.equal(validModelId('claude-opus-5[1m]'), true);
  assert.equal(validModelId('model; rm -rf'), false);
  assert.equal(parseAgentAuth('codex', true, 'Logged in using ChatGPT'), 'signed-in');
  assert.equal(parseAgentAuth('codex', false, 'Not logged in'), 'signed-out');
  assert.equal(parseAgentAuth('claude', true, '{"loggedIn":false}'), 'signed-out');
  assert.equal(parseAgentAuth('other', true, 'OK'), 'unknown');
  assert(!localAgents.some(agent => ['ollama', 'lmstudio', 'comfyui'].includes(agent.id)));
  assert(localAgents.every(agent => Boolean(agent.discovery)), 'every registered Local Agent must declare a discovery strategy');
});

test('extractAcpModels prefers configOptions, derives per-model reasoning and disambiguates names', () => {
  // Antigravity 1.5+ shape: clean families in configOptions + suffix variants in availableModels + thought_level
  const agy = extractAcpModels(
    [
      {
        id: 'model', category: 'model', type: 'select', currentValue: 'gemini-4-neon',
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
          { value: 'gemini-pro-orchestrator', name: 'Orchestrator' },
          { value: 'gemini-pro-orchestrator-v2', name: 'Orchestrator' },
        ],
      },
      {
        id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }],
      },
    ],
    [
      { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
      { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
      { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
      { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
      { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator' },
    ],
  );
  assert.deepEqual(agy, [
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', source: 'cli', reasoning: ['low', 'high', 'xhigh'] },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', source: 'cli', reasoning: ['low', 'high'] },
    { id: 'gemini-pro-orchestrator', label: 'Orchestrator', source: 'cli' },
    { id: 'gemini-pro-orchestrator-v2', label: 'Orchestrator (gemini-pro-orchestrator-v2)', source: 'cli' },
  ]);

  // Grok Build shape: per-model _meta.reasoningEfforts and supportsReasoningEffort === false
  const grok = extractAcpModels(
    [{ id: 'reasoning', category: 'thought_level', type: 'select', options: [{ value: 'low' }, { value: 'high' }] }],
    [
      { modelId: 'grok-4', name: 'Grok 4', _meta: { reasoningEfforts: [{ value: 'low' }, { value: 'max' }] } },
      { modelId: 'grok-fast', name: 'Grok Fast', _meta: { supportsReasoningEffort: false } },
    ],
  );
  assert.deepEqual(grok, [
    { id: 'grok-4', label: 'Grok 4', source: 'cli', reasoning: ['low', 'max'] },
    { id: 'grok-fast', label: 'Grok Fast', source: 'cli' },
  ]);

  // Mistral Vibe shape: grouped model options + `category: 'thinking'`
  const vibe = extractAcpModels(
    [
      { id: 'model', category: 'model', type: 'select', options: [{ group: 'Mistral', options: [{ value: 'devstral-2', name: 'Devstral 2' }] }] },
      { id: 'thinking', category: 'thinking', type: 'select', options: [{ value: 'off' }, { value: 'high' }] },
    ],
    undefined,
  );
  assert.deepEqual(vibe, [{ id: 'devstral-2', label: 'Devstral 2', source: 'cli', reasoning: ['off', 'high'] }]);
});

test('Agent defaults persist outside the checkout and selected model reaches the scoped terminal command', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-agent-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let signedIn = true, launches = 0;
  const probes: string[][] = [];
  const directory = new LocalAgentDirectory(root, async bin => bin === 'codex' ? '/Applications/Agent Space/codex' : null, async (_bin, args) => {
    probes.push(args);
    return { ok: true, text: args[0] === '--version' ? 'codex-cli 1.2.3' : args[0] === '--help' ? '--model MODEL' : args[0] === 'login' ? signedIn ? 'Logged in' : 'Not logged in' : JSON.stringify({ models: [{ slug: 'model-1', supported_reasoning_levels: [{ effort: 'high' }] }] }) };
  }, async (_dir, command) => { launches++; assert.match(command, /--model' 'model-1'/); });
  await directory.list(); assert.equal(probes.length, 0, 'listing must not launch every installed CLI');
  await directory.inspect('codex');
  const choice = { agent: 'codex', model: 'model-1', reasoning: 'high' };
  await directory.choose(choice);
  assert.deepEqual((await directory.list()).default, choice);
  assert.equal((await stat(directory.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(directory.file, 'utf8'), /token|credential|Logged in/);
  const plan = await directory.prepare(choice, "/projects/a 'quote' $(touch bad)", 'http://127.0.0.1:49937', 'launch');
  assert(plan.modelInCommand); assert.match(plan.command, /model_reasoning_effort="high"/);
  assert.doesNotMatch(plan.command, /dangerously|skip-permissions|approval_policy/);
  assert.match(plan.instruction, /connect\/guide\?host=codex/);
  assert.equal(launches, 0, 'prepare is read-only');
  await directory.open(choice, '/projects/test', 'http://localhost', 'launch'); assert.equal(launches, 1);
  await assert.rejects(directory.choose({ agent: 'claude', model: 'default' }), /Install/);
  await assert.rejects(directory.choose({ agent: 'codex', model: 'unknown' }), /Refresh/);
  await assert.rejects(directory.choose({ ...choice, reasoning: 'unknown' }), /reasoning/);
  await assert.rejects(directory.addModel('codex', 'model; rm -rf'), /Invalid/);
  await directory.addModel('codex', 'custom-model'); await directory.choose({ agent: 'codex', model: 'custom-model' });
  const restarted = new LocalAgentDirectory(root, directory.resolve, directory.probe);
  assert.equal((await restarted.list()).default?.model, 'custom-model');
  signedIn = false; await directory.inspect('codex'); await assert.rejects(directory.choose(choice), /Sign in/);
  assert.match((await directory.prepare(choice, '/project', 'http://localhost', 'login')).command, /'login'/);
});

test('terminal quoting keeps metacharacters literal on POSIX and Windows', () => {
  assert.equal(terminalCommand('/bin/cli', ['a\'b', '$(echo bad)'], '/p a'), "cd '/p a' && '/bin/cli' 'a'\\''b' '$(echo bad)'");
  assert.equal(terminalCommand('C:\\cli.cmd', ["a'b", '$x'], 'C:\\project', 'win32'), "Set-Location -LiteralPath 'C:\\project'\n& 'C:\\cli.cmd' 'a''b' '$x'");
});

test('ACP discovery lists session models, denies client operations, handles async config updates and auth errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-acp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'agent.mjs'), log = path.join(root, 'calls.json');
  await writeFile(script, `import readline from 'node:readline'; import {writeFileSync} from 'node:fs'; const calls=[]; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); calls.push(m); writeFileSync(process.argv[2],JSON.stringify(calls)); if(m.method==='initialize') send({id:1,result:{protocolVersion:1,agentInfo:{version:'1.5.14'},agentCapabilities:{sessionCapabilities:{delete:{}}}}}); else if(m.method==='session/new'){send({id:99,method:'fs/read_text_file',params:{path:'/private'}});} else if(m.id===99 && m.error) send({id:2,result:{sessionId:'sess-1',models:{availableModels:[{modelId:'acp-model',name:'ACP model'},{modelId:'acp-model-2',name:'ACP model 2'}]}}}); });`);
  const result = await discoverAcp(process.execPath, [script, log], { catalogGraceMs: 200 });
  assert.equal(result.models[0].id, 'acp-model');
  assert.equal(result.version, '1.5.14');
  const calls = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(calls.filter((call: any) => call.method).map((call: any) => call.method), ['initialize', 'session/new', 'session/delete']);
  assert.deepEqual(calls[1].params.mcpServers, []); assert.equal(calls[2].error.code, -32601);

  // Async config_option_update (Qoder CLI / OpenCode behavior)
  const asyncScript = path.join(root, 'async-acp.mjs');
  await writeFile(asyncScript, `import readline from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize') send({id:1,result:{protocolVersion:1}}); else if(m.method==='session/new'){send({id:2,result:{sessionId:'s1',configOptions:[]}}); setTimeout(()=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'config_option_update',configOptions:[{id:'model',category:'model',type:'select',options:[{value:'qoder-1',name:'Qoder 1'},{value:'qoder-2',name:'Qoder 2'}]}]}}}), 40);} });`);
  const asyncResult = await discoverAcp(process.execPath, [asyncScript], { catalogGraceMs: 1_500 });
  assert.deepEqual(asyncResult.models.map(m => m.id), ['qoder-1', 'qoder-2']);

  // ACP -32000 auth error
  const authScript = path.join(root, 'auth-acp.mjs');
  await writeFile(authScript, `import readline from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize') send({id:1,result:{protocolVersion:1}}); else if(m.method==='session/new') send({id:2,error:{code:-32000,message:'Authentication required'}}); });`);
  const authResult = await discoverAcp(process.execPath, [authScript], { catalogGraceMs: 100 });
  assert.equal(authResult.auth, 'signed-out');
  assert.deepEqual(authResult.models, []);

  // DeepSeek Harness temp --patch isolation
  const dshScript = path.join(root, 'dsh-acp.mjs');
  await writeFile(dshScript, `import readline from 'node:readline'; import {readFileSync} from 'node:fs'; const send=v=>console.log(JSON.stringify(v)); const idx=process.argv.indexOf('--patch'); const patch=idx>0?JSON.parse(readFileSync(process.argv[idx+1],'utf8')):[]; readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize') send({id:1,result:{protocolVersion:1}}); else if(m.method==='session/new') send({id:2,result:{configOptions:[{id:'model',category:'model',type:'select',options:patch.length?[{value:'deepseek-v4',name:'DeepSeek V4'},{value:'deepseek-r2',name:'DeepSeek R2'}]:[]}]}}); });`);
  const dshResult = await discoverAcp(process.execPath, [dshScript], { isolateDeepSeek: true, catalogGraceMs: 100 });
  assert.deepEqual(dshResult.models.map(m => m.id), ['deepseek-v4', 'deepseek-r2']);

  const shim = path.join(root, 'agent.cmd'); await writeFile(shim, '"%dp0%\\node_modules\\agent\\cli.js" %*');
  assert.deepEqual(await agentInvocation(shim, ['--version']), { bin: process.execPath, args: [path.join(root, 'node_modules/agent/cli.js'), '--version'] });
});

test('Codex app-server, Claude stdio initialize and Pi RPC protocol discoverers parse live catalogs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-proto-test-')); t.after(() => rm(root, { recursive: true, force: true }));

  const codexMock = path.join(root, 'codex-mock.mjs');
  await writeFile(codexMock, `#!/usr/bin/env node\nimport readline from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize') send({id:m.id,result:{userAgent:'codex'}}); else if(m.method==='model/list' && !m.params?.cursor) send({id:m.id,result:{data:[{id:'gpt-6.2-sol',model:'gpt-6.2-sol',displayName:'GPT-6.2-Sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{id:'secret',hidden:true}],nextCursor:'p2'}}); else if(m.method==='model/list' && m.params?.cursor==='p2') send({id:m.id,result:{data:[{id:'gpt-6.1-terra',model:'gpt-6.1-terra',displayName:'GPT-6.1 Terra'}],nextCursor:null}}); });`, { mode: 0o755 });
  const codexResult = await discoverCodexAppServer(codexMock, 5_000);
  assert.deepEqual(codexResult.models, [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', source: 'cli', reasoning: ['low', 'high'] },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', source: 'cli' },
  ]);

  const claudeMock = path.join(root, 'claude-mock.mjs');
  await writeFile(claudeMock, `#!/usr/bin/env node\nimport readline from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.type==='control_request' && m.request?.subtype==='initialize') send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{claude_code_version:'2.1.329',models:[{value:'default',displayName:'Default'},{value:'opus',displayName:'Opus',description:'Opus 5.5 · Best',supportsEffort:true,supportedEffortLevels:['low','high','max']},{value:'fable',displayName:'Fable',description:'Fable 5.2 · Hardest',supportsEffort:true,supportedEffortLevels:['high','max']}]}}}); });`, { mode: 0o755 });
  const claudeResult = await discoverClaudeModels(claudeMock, 5_000);
  assert.equal(claudeResult.version, '2.1.329');
  assert.deepEqual(claudeResult.models, [
    { id: 'opus', label: 'Opus 5.5', source: 'cli', reasoning: ['low', 'high', 'max'] },
    { id: 'fable', label: 'Fable 5.2', source: 'cli', reasoning: ['high', 'max'] },
  ]);

  const piMock = path.join(root, 'pi-mock.mjs');
  await writeFile(piMock, `#!/usr/bin/env node\nimport readline from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.type==='get_available_models') send({type:'response',command:'get_available_models',success:true,data:{models:[{provider:'anthropic',id:'claude-opus-5',name:'Claude Opus 5',reasoning:true,thinkingLevelMap:{xhigh:'xhigh'}},{provider:'openai',id:'gpt-4o-mini',name:'GPT-4o Mini',reasoning:false}]}}); });`, { mode: 0o755 });
  const piResult = await discoverPiRpc(piMock, 5_000);
  assert.deepEqual(piResult.models, [
    { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', source: 'cli', reasoning: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', source: 'cli' },
  ]);
});

test('LocalAgentDirectory routes Antigravity, Claude, Kiro, Gemini, Qwen, Vibe and OpenCode with fallbacks and --effort', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-agents-multi-')); t.after(() => rm(root, { recursive: true, force: true }));
  const acpCalls: { bin: string; args: string[]; clientInfo?: { name: string; version: string } }[] = [];

  // 1. Antigravity: ACP primary + legacy clientInfo for < 1.5.1 + --effort flag in launch command
  let agyVersion = '1.4.5';
  let agyAcpWorks = true;
  const dir = new LocalAgentDirectory(
    root,
    async bin => `/usr/local/bin/${bin}`,
    async (bin, args) => {
      if (args[0] === '--version') return { ok: true, text: bin.endsWith('/agy') ? agyVersion : '1.0.0' };
      if (args.includes('--help')) return { ok: true, text: 'Usage:\n  --model <id>\n  --effort <level>\n' };
      if (bin.endsWith('/agy') && args[0] === 'models') return { ok: true, text: 'gemini-4-neon-high\tGemini 4 Neon (High)\n' };
      if (bin.endsWith('/claude') && args[0] === 'auth') return { ok: true, text: '{"loggedIn":true}' };
      if (bin.endsWith('/opencode') && args[0] === 'models') return { ok: false, text: 'command failed' };
      return { ok: false, text: '' };
    },
    async () => {},
    {
      acp: async (bin, args, options) => {
        acpCalls.push({ bin, args, clientInfo: options?.clientInfo });
        if (bin.endsWith('/agy')) {
          if (!agyAcpWorks) throw new Error('no acp');
          return { auth: 'unknown', models: [{ id: 'gemini-4-neon', label: 'Gemini 4 Neon', source: 'cli', reasoning: ['low', 'high'] }] };
        }
        if (bin.endsWith('/kiro-cli') && args.includes('--agent-engine=v3')) throw new Error('v2 only');
        if (bin.endsWith('/gemini') && args[0] === '--acp') throw new Error('legacy flag');
        return { auth: 'unknown', models: [{ id: `${path.basename(bin)}-m1`, label: 'Model 1', source: 'cli' }] };
      },
      claude: async () => ({ models: [{ id: 'fable', label: 'Fable 5.2', source: 'cli', reasoning: ['high', 'max'] }] }),
    },
  );

  const agyLegacy = await dir.inspect('antigravity');
  assert.equal(agyLegacy.models[0].id, 'gemini-4-neon');
  assert.equal(acpCalls.at(-1)?.clientInfo?.name, 'zed');
  const agyPlan = await dir.prepare({ agent: 'antigravity', model: 'gemini-4-neon', reasoning: 'high' }, '/proj', 'http://127.0.0.1:4000', 'launch');
  assert.match(agyPlan.command, /'--model' 'gemini-4-neon' '--effort' 'high'/);

  agyVersion = '1.5.14';
  await dir.inspect('antigravity');
  assert.equal(acpCalls.at(-1)?.clientInfo?.name, 'openmotion-model-discovery');

  // Antigravity fallback to `agy models` when ACP fails
  agyAcpWorks = false;
  const agyFallback = await dir.inspect('antigravity');
  assert.deepEqual(agyFallback.models, [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', source: 'cli' }]);

  // Claude live discovery + --effort launch
  const claude = await dir.inspect('claude');
  assert.equal(claude.models[0].id, 'fable');
  const claudePlan = await dir.prepare({ agent: 'claude', model: 'fable', reasoning: 'max' }, '/proj', 'http://127.0.0.1:4000', 'launch');
  assert.match(claudePlan.command, /'--model' 'fable' '--effort' 'max'/);

  // Kiro falls back from v3 args to plain `acp`
  const kiro = await dir.inspect('kiro');
  assert.equal(kiro.models[0].id, 'kiro-cli-m1');

  // Gemini falls back from `--acp` to `--experimental-acp`
  const gemini = await dir.inspect('gemini');
  assert.equal(gemini.models[0].id, 'gemini-m1');

  // OpenCode falls back to ACP when `opencode models` fails
  const opencode = await dir.inspect('opencode');
  assert.equal(opencode.models[0].id, 'opencode-m1');

  // Qwen returns [] cleanly when settings file is absent, and Vibe parses config.toml
  const prevQwen = process.env.QWEN_SETTINGS_FILE;
  const prevVibe = process.env.VIBE_HOME;
  try {
    process.env.QWEN_SETTINGS_FILE = path.join(root, 'missing-qwen.json');
    assert.deepEqual(await qwenModels(), []);

    process.env.VIBE_HOME = root;
    await writeFile(path.join(root, 'config.toml'), 'active_model = "devstral-2"\n\n[[models]]\nname = "devstral-small-2"\nalias = "ollama-devstral"\n');
    assert.deepEqual(await vibeConfigModels(), [
      { id: 'devstral-2', label: 'devstral-2', source: 'cli' },
      { id: 'ollama-devstral', label: 'devstral-small-2', source: 'cli' },
    ]);
  } finally {
    if (prevQwen === undefined) delete process.env.QWEN_SETTINGS_FILE; else process.env.QWEN_SETTINGS_FILE = prevQwen;
    if (prevVibe === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = prevVibe;
  }
});

test('LocalAgentDirectory warms up Antigravity by default and hydrates persisted models across restarts without probing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-agy-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let acpCalls = 0;
  let probeCalls = 0;

  const first = new LocalAgentDirectory(
    root,
    async bin => (bin === 'agy' ? '/usr/local/bin/agy' : null),
    async (_bin, args) => {
      probeCalls += 1;
      if (args[0] === '--version') return { ok: true, text: '1.5.14' };
      return { ok: true, text: 'Usage: --model <id>' };
    },
    async () => {},
    {
      acp: async () => {
        acpCalls += 1;
        return {
          auth: 'unknown',
          models: [
            { id: 'gemini-4-neon', label: 'Gemini 4 Neon', source: 'cli', reasoning: ['medium', 'high'] },
            { id: 'gemini-4-flash', label: 'Gemini 4 Flash', source: 'cli' },
          ],
        };
      },
    },
  );

  const warmed = await first.warmup();
  assert.equal(acpCalls, 1);
  assert.equal(warmed.agents.find(a => a.id === 'antigravity')?.models.length, 2);

  // Restarted directory hydrates Antigravity models immediately from disk with 0 CLI probes
  let restartedProbes = 0;
  const restarted = new LocalAgentDirectory(
    root,
    async bin => (bin === 'agy' ? '/usr/local/bin/agy' : null),
    async () => {
      restartedProbes += 1;
      return { ok: true, text: '' };
    },
  );
  const listed = await restarted.list();
  const agy = listed.agents.find(a => a.id === 'antigravity');
  assert.equal(restartedProbes, 0);
  assert.equal(probeCalls > 0, true);
  assert.deepEqual(agy?.models.map(m => m.id), ['gemini-4-neon', 'gemini-4-flash']);
  assert.ok(agy?.checkedAt);
  assert.ok(agy?.connectedAt);
});

test('Antigravity is listed first and pickPreferredLocalAgent selects the most recently connected Agent unless manually chosen', () => {
  assert.equal(localAgents[0]?.id, 'antigravity');

  const mk = (id: string, overrides: Partial<LocalAgent> = {}): LocalAgent => ({
    ...localAgents.find(a => a.id === id)!,
    installed: true,
    auth: 'signed-in',
    models: [{ id: `${id}-model`, label: `${id} Model`, source: 'cli' }],
    ...overrides,
  });

  const agy = mk('antigravity', { connectedAt: '2026-11-23T10:00:00.000Z' });
  const codex = mk('codex', { connectedAt: '2026-11-23T12:00:00.000Z' });
  const claude = mk('claude', { auth: 'signed-out', connectedAt: undefined });
  const failed = mk('gemini', { discoveryError: 'Could not discover models', connectedAt: '2026-11-23T13:00:00.000Z' });

  // Without explicit manual default -> picks most recently connected valid agent (codex at 12:00 > antigravity at 10:00)
  assert.equal(pickPreferredLocalAgent([agy, codex, claude, failed], null)?.id, 'codex');

  // If Antigravity connected more recently -> picks Antigravity
  const agyNewer = mk('antigravity', { connectedAt: '2026-11-23T14:00:00.000Z' });
  assert.equal(pickPreferredLocalAgent([agyNewer, codex, claude], null)?.id, 'antigravity');

  // With explicit manual default -> honors the user's manual selection
  assert.equal(pickPreferredLocalAgent([agyNewer, codex, claude], { agent: 'codex', model: 'default' })?.id, 'codex');

  // Before any connection checks complete -> falls back to top runnable agent (Antigravity)
  const uncheckedAgy = mk('antigravity', { auth: 'unknown', models: [], connectedAt: undefined });
  const uncheckedCodex = mk('codex', { auth: 'unknown', models: [], connectedAt: undefined });
  assert.equal(pickPreferredLocalAgent([uncheckedAgy, uncheckedCodex], null)?.id, 'antigravity');
});
