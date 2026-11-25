import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixtures.ts';
import { execute, pluginRoot } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import { Phase1Service } from '../phase1.ts';
import { gatewayFor } from '../gateway/service.ts';
import {
  capabilityRun,
  registerCapabilityQuoteEstimator,
  registerCapabilityScriptExecutor,
  saveCapabilityOverrides,
  setCapabilityRemoteConfigFetcher,
  syncCapabilityRemoteConfig,
  unregisterCapabilityScriptExecutor,
} from '../gateway/capability-center.ts';
import {
  buildCapabilityParameters,
  buildCapabilityPrompt,
  capabilityControlSchema,
  defaultCapabilities,
  findCapability,
  resolveCapabilityCatalog,
  resolveCapabilityOptions,
} from '../shared/capability-registry.ts';
import { findLandingScene } from '../shared/studio-catalog.ts';
import { isStandaloneSpaPath } from '../shared/spa-routes.ts';
import { imageFeatures, imageFeaturePrompt } from '../shared/image-features.ts';
import { videoFeatures, videoFeaturePrompt } from '../shared/video-features.ts';

const service = (store: any) =>
  new Phase1Service(store, pluginRoot, {
    origin: () => 'http://localhost:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async task => task(),
    cancel: async () => {},
  });

async function makePng(directory: string, filename: string, color: string) {
  const file = path.join(directory, filename);
  const result = await execute(
    verificationBinaries().ffmpeg,
    ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x24`, '-frames:v', '1', '-y', file],
    directory,
    20_000,
  );
  assert.equal(result.code, 0, result.stderr);
  return file;
}

test('Unified Capability Registry drives shared image/video features and separates live vs coming-soon capabilities', () => {
  assert.deepEqual(imageFeatures['remove-background'].parameters, { background: 'transparent' });
  assert.equal(imageFeatures.relight.recommended, 'seedream-5.5');
  assert.equal(videoFeatures['multi-shot'].defaultDuration, 10);
  const nativeAudio = findCapability('native-audio');
  assert.ok(nativeAudio && nativeAudio.executor.kind === 'prompt-preset' && nativeAudio.executor.forceAudio === true);
  assert.equal(nativeAudio.channels.gui, false);
  assert.equal(nativeAudio.channels.mcp, true);
  assert.match(imageFeaturePrompt('relight', 'Sharp rim.', { direction: 'back', temperature: 'warm', mood: 'neon' }), /backlight.*3200K.*neon/i);
  assert.match(videoFeaturePrompt('camera-control', 'Mountain peak', { movement: 'orbit', pace: 'slow' }), /360-degree camera orbit.*Mountain peak/);

  assert.equal(defaultCapabilities.length, 33);
  const liveIds = defaultCapabilities.filter(c => c.status === 'live').map(c => c.id);
  assert.equal(liveIds.length, 14);
  for (const id of ['text-to-image', 'remove-background', 'image-blend', 'relight', 'camera-control', 'multi-shot', 'native-audio', 'music', 'speech', 'asr-transcribe']) {
    assert.ok(liveIds.includes(id), `expected live capability ${id}`);
  }
  const deprecatedCharacter = defaultCapabilities.find(c => c.id === 'character');
  assert.equal(deprecatedCharacter?.status, 'deprecated');
  assert.equal(deprecatedCharacter?.replacementCapabilityId, 'image-blend');
  assert.equal(liveIds.includes('character'), false);
  const soonIds = defaultCapabilities.filter(c => c.status === 'coming_soon').map(c => c.id);
  assert.equal(soonIds.length, 18);
  for (const id of ['inpainting', 'expand-image', 'upscale-4k', 'omni-reference', 'lipsync', 'voice-changer', 'dubbing', 'digital-human', '3d-asset']) {
    assert.ok(soonIds.includes(id), `expected coming_soon capability ${id}`);
  }
});

test('4 MCP meta-tools discover schemas, execute capabilities, manage jobs and persist capability provenance on AssetVersion', () =>
  fixture(async store => {
    const api = service(store);
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];
    gateway.options.codex = async () => readFile(await makePng(store.directory, 'generated.png', 'teal'));

    // 1. Discover live MCP capabilities (coming_soon excluded by default)
    const listed = await api.call('openmotion_capability_discover', { action: 'list' });
    assert.ok(listed.capabilities.some((c: any) => c.id === 'text-to-image' && c.available === true));
    assert.ok(listed.capabilities.some((c: any) => c.id === 'remove-background'));
    assert.ok(!listed.capabilities.some((c: any) => c.status === 'coming_soon'));

    const withSoon = await api.call('openmotion_capability_discover', { action: 'list', includeComingSoon: true });
    assert.ok(withSoon.capabilities.some((c: any) => c.id === 'lipsync' && c.status === 'coming_soon'));

    // 2. Describe capability options schema
    const relightMeta = await api.call('openmotion_capability_discover', { action: 'describe', capabilityId: 'relight' });
    assert.equal(relightMeta.capability.id, 'relight');
    assert.equal(relightMeta.capability.input.minReferences, 1);
    assert.deepEqual(relightMeta.capability.input.optionsSchema.properties.direction.enum, ['left', 'right', 'front', 'top', 'back']);

    // 3. Reject coming_soon capability execution cleanly
    await assert.rejects(
      api.call('openmotion_capability_run', { action: 'run', requestId: 'soon-1', capabilityId: 'lipsync' }),
      /CAPABILITY_COMING_SOON/,
    );

    // 4. Execute text-to-image through capability_run, poll via job_manage, inspect provenance via asset_manage
    const submitted = await api.call('openmotion_capability_run', {
      action: 'run',
      requestId: 'cap-t2i-1',
      capabilityId: 'text-to-image',
      prompt: 'Minimal ceramic mug',
      name: 'Ceramic Mug',
    });
    assert.equal(submitted.capabilityId, 'text-to-image');
    assert.equal(submitted.selectedModel, 'codex:image-generation');
    assert.equal(submitted.next.tool, 'openmotion_job_manage');

    // Idempotent replay with same requestId returns the exact same job without re-running
    const replayed = await api.call('openmotion_capability_run', {
      action: 'run',
      requestId: 'cap-t2i-1',
      capabilityId: 'text-to-image',
      prompt: 'Minimal ceramic mug',
      name: 'Ceramic Mug',
    });
    assert.equal(replayed.job.id, submitted.job.id);

    await gateway.tick();
    await Promise.all([...gateway.active.values()].map(task => task.done));

    const jobState = await api.call('openmotion_job_manage', { action: 'status', jobId: submitted.job.id });
    assert.equal(jobState.job.state, 'completed');
    assert.equal(jobState.job.capabilityId, 'text-to-image');
    const createdRef = jobState.job.libraryAssets[0];
    assert.ok(createdRef?.assetId && createdRef?.versionId);

    const inspected = await api.call('openmotion_asset_manage', {
      action: 'get',
      assetId: createdRef.assetId,
      versionId: createdRef.versionId,
    });
    assert.equal(inspected.version.capabilityId, 'text-to-image');
    assert.equal(inspected.asset.name, 'Ceramic Mug');

    const preview = await api.call('openmotion_asset_manage', {
      action: 'read',
      assetId: createdRef.assetId,
      versionId: createdRef.versionId,
    });
    assert.equal(preview.versionId, createdRef.versionId);
    assert.ok(preview.content.some((block: any) => block.type === 'image'));
  }, false));

test('Unified Capability Center supports runtime hot-swapping to a local script executor and two-step soft deprecation', () =>
  fixture(async store => {
    const api = service(store);
    const scriptId = 'test-fast-matting-v1';

    // Import an initial source image asset
    const sourcePng = await makePng(store.directory, 'product-raw.png', 'orange');
    const imported = await api.call('openmotion_asset_manage', {
      action: 'import',
      requestId: 'import-raw-1',
      sourcePath: sourcePng,
      name: 'Raw Product',
    });
    const ref = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };

    registerCapabilityScriptExecutor(scriptId, async ctx => {
      assert.equal(ctx.references.length, 1);
      assert.equal(ctx.references[0].assetId, ref.assetId);
      const cutout = await makePng(store.directory, 'cutout.png', 'white');
      return { sourcePath: cutout, name: 'Cutout Product' };
    });

    try {
      // Hot-swap `remove-background` to the script executor AND soft-deprecate `relight` -> `image-edit`
      await saveCapabilityOverrides(store, [
        {
          id: 'remove-background',
          executor: { kind: 'script', scriptId },
        },
        {
          id: 'relight',
          status: 'deprecated',
          replacementCapabilityId: 'image-edit',
        },
      ]);

      // 1. Deprecated `relight` immediately disappears from active discovery list
      const discovered = await api.call('openmotion_capability_discover', { action: 'list' });
      assert.ok(!discovered.capabilities.some((c: any) => c.id === 'relight'));
      const rmBg = discovered.capabilities.find((c: any) => c.id === 'remove-background');
      assert.ok(rmBg);
      assert.equal(rmBg.executorKind, 'script');
      assert.equal(rmBg.available, true);

      // 2. Calling deprecated `relight` returns actionable replacement guidance
      await assert.rejects(
        api.call('openmotion_capability_run', {
          action: 'run',
          requestId: 'dep-relight-1',
          capabilityId: 'relight',
          references: [ref],
        }),
        /CAPABILITY_DEPRECATED: relight is no longer active; use image-edit instead/,
      );

      // 3. Calling hot-swapped `remove-background` runs the script and creates a linked v2 on the same asset
      const executed = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-rmbg-1',
        capabilityId: 'remove-background',
        assetId: imported.asset.id,
        parentVersionId: imported.asset.currentVersionId,
        references: [ref],
      });
      assert.equal(executed.executorKind, 'script');
      assert.equal(executed.version.capabilityId, 'remove-background');
      assert.equal(executed.version.parentVersionId, ref.versionId);
      assert.deepEqual(executed.version.references, [ref]);
      assert.equal(executed.asset.versions.length, 2);

      // 4. Standalone script execution deduplicates by requestId and rejects input conflicts
      const standalone = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-standalone-1',
        capabilityId: 'remove-background',
        references: [ref],
      });
      const standaloneReplay = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-standalone-1',
        capabilityId: 'remove-background',
        references: [ref],
      });
      assert.equal(standaloneReplay.asset.id, standalone.asset.id);
      assert.equal(standaloneReplay.version.id, standalone.version.id);
      await assert.rejects(
        api.call('openmotion_capability_run', {
          action: 'run',
          requestId: 'script-standalone-1',
          capabilityId: 'remove-background',
          prompt: 'Different note',
          references: [ref],
        }),
        /REQUEST_ID_CONFLICT/,
      );
    } finally {
      unregisterCapabilityScriptExecutor(scriptId);
    }
  }, false));

test('extension hooks cover dedicated-model structured parameter mapping, remote hot-config sync, spend quotes, and on-demand Library Skills', () =>
  fixture(async store => {
    const api = service(store);
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];

    try {
      // 1. Remote hot-config lights up `upscale-4k` as a `dedicated-model` with optionToParameter mapping
      setCapabilityRemoteConfigFetcher(async () => [
        {
          id: 'upscale-4k',
          status: 'live',
          channels: { gui: true, mcp: true },
          costTier: 'high',
          requiresExplicitApproval: true,
          executor: {
            kind: 'dedicated-model',
            providers: ['codex'],
            models: ['image-generation'],
            recommendedModel: 'image-generation',
            mode: 'text-to-image',
            defaultParameters: { format: 'png' },
            optionToParameter: { scale: 'upscale_factor' },
          },
        },
      ]);
      await syncCapabilityRemoteConfig(store);

      // 2. Custom cloud quote estimator plugs into both `action=quote` and `dryRun=true`
      registerCapabilityQuoteEstimator(async ({ capability, modality, options, model }) => ({
        capabilityId: capability?.id ?? 'raw-model',
        costTier: capability?.costTier ?? (modality === 'video' ? 'medium' : 'low'),
        requiresExplicitApproval: capability?.requiresExplicitApproval ?? modality === 'video',
        estimatedCredits: capability ? (options.scale === '4x' ? 12 : 6) : 3,
        currency: 'credits',
        quoteSource: 'cloud-quote',
        selectedModel: model?.id ?? null,
      }));

      const quoted = await api.call('openmotion_capability_discover', {
        action: 'quote',
        capabilityId: 'upscale-4k',
        options: { scale: '4x' },
      });
      assert.equal(quoted.quote.quoteSource, 'cloud-quote');
      assert.equal(quoted.quote.estimatedCredits, 12);
      assert.equal(quoted.quote.requiresExplicitApproval, true);

      const sourcePng = await makePng(store.directory, 'lowres.png', 'navy');
      const imported = await api.call('openmotion_asset_manage', {
        action: 'import',
        requestId: 'import-lowres-1',
        sourcePath: sourcePng,
        name: 'Lowres Shot',
      });
      const ref = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };

      const dryRun = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'dry-upscale-1',
        capabilityId: 'upscale-4k',
        options: { scale: '4x' },
        references: [ref],
        dryRun: true,
      });
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.executorKind, 'dedicated-model');
      assert.deepEqual(dryRun.effectiveParameters, { format: 'png', upscale_factor: '4x' });
      assert.equal(dryRun.quote.estimatedCredits, 12);
    } finally {
      setCapabilityRemoteConfigFetcher(undefined);
      registerCapabilityQuoteEstimator(undefined);
    }

    // 3. Progressive-disclosure Library Skills for digital-human & video-dubbing are indexed and readable
    const skillIndex = await api.call('openmotion_list_skills', {});
    const rows = (await readFile(skillIndex.indexPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    for (const id of ['openmotion-digital-human-presenter', 'openmotion-video-dubbing']) {
      assert.ok(rows.some(row => row.skillId === id), `missing library skill ${id}`);
      const detail = await api.call('openmotion_get_skill', { skillId: id });
      assert.match(detail.instructions, /openmotion_capability_discover/);
    }
  }, false));

test('dryRun blocks paid submission across raw model, unavailable explicit model, and ASR service paths; discover list validates pagination', () =>
  fixture(async store => {
    const api = service(store);
    const gateway = gatewayFor(store);
    let codexInvocations = 0;
    gateway.options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];
    gateway.options.codex = async () => {
      codexInvocations += 1;
      return readFile(await makePng(store.directory, 'should-not-run.png', 'red'));
    };

    try {
      // 1. Raw model fallback dryRun (no capabilityId, no requestId) must NEVER submit a job
      registerCapabilityQuoteEstimator(async ({ capability, modality, model }) => ({
        capabilityId: capability?.id ?? 'raw-model',
        costTier: modality === 'video' ? 'medium' : 'low',
        requiresExplicitApproval: modality === 'video',
        estimatedCredits: 4,
        currency: 'credits',
        quoteSource: 'cloud-quote',
        selectedModel: model?.id ?? null,
      }));

      const rawDry = await api.call('openmotion_capability_run', {
        model: 'codex:image-generation',
        modality: 'image',
        prompt: 'A quiet paper lantern at dusk',
        dryRun: true,
      });
      assert.equal(rawDry.dryRun, true);
      assert.equal(rawDry.executorKind, 'model');
      assert.equal(rawDry.selectedModel, 'codex:image-generation');
      assert.equal(rawDry.quote.quoteSource, 'cloud-quote');
      assert.equal(rawDry.quote.estimatedCredits, 4);
      assert.equal(codexInvocations, 0);
      assert.equal((await gateway.listJobs()).length, 0);

      // 2. Raw model fallback rejects mismatched modality and unavailable providers on dryRun
      await assert.rejects(
        api.call('openmotion_capability_run', {
          model: 'codex:image-generation',
          modality: 'video',
          prompt: 'Mismatched modality',
          dryRun: true,
        }),
        /CAPABILITY_MODEL_INCOMPATIBLE/,
      );
      await assert.rejects(
        api.call('openmotion_capability_run', {
          model: 'fal:flux-pro',
          modality: 'image',
          prompt: 'Unconfigured provider',
          dryRun: true,
        }),
        /CAPABILITY_UNAVAILABLE/,
      );

      // 3. Explicit args.model for a capability cannot bypass provider availability on dryRun
      await assert.rejects(
        api.call('openmotion_capability_run', {
          capabilityId: 'remove-background',
          model: 'opendesign:gpt-image-2.6-sunburst',
          references: [{ assetId: '00000000-0000-4000-8000-000000000001', versionId: '00000000-0000-4000-8000-000000000002' }],
          dryRun: true,
        }),
        /CAPABILITY_UNAVAILABLE|CAPABILITY_MODEL_INCOMPATIBLE/,
      );

      // 4. Service executor (asr-transcribe) validates ASR availability and language format during dryRun
      await assert.rejects(
        api.call('openmotion_capability_run', {
          capabilityId: 'asr-transcribe',
          sourcePath: 'sample.wav',
          language: 'not-a-code',
          dryRun: true,
        }),
        /ISO language code/,
      );
      await assert.rejects(
        api.call('openmotion_capability_run', {
          capabilityId: 'asr-transcribe',
          sourcePath: 'sample.wav',
          language: 'en',
          dryRun: true,
        }),
        /CAPABILITY_UNAVAILABLE/,
      );

      // 5. capabilityDiscover(action="list") supports offset/limit pagination and rejects invalid bounds
      const full = await api.call('openmotion_capability_discover', { action: 'list' });
      assert.equal(full.offset, 0);
      assert.equal(full.hasMore, false);
      assert.equal(full.capabilities.length, full.total);

      const page = await api.call('openmotion_capability_discover', { action: 'list', offset: 2, limit: 3 });
      assert.equal(page.total, full.total);
      assert.equal(page.offset, 2);
      assert.equal(page.limit, 3);
      assert.equal(page.capabilities.length, 3);
      assert.equal(page.hasMore, 2 + 3 < full.total);
      assert.deepEqual(
        page.capabilities.map((c: any) => c.id),
        full.capabilities.slice(2, 5).map((c: any) => c.id),
      );

      const pastEnd = await api.call('openmotion_capability_discover', { action: 'list', offset: 99, limit: 5 });
      assert.deepEqual(pastEnd.capabilities, []);
      assert.equal(pastEnd.total, full.total);
      assert.equal(pastEnd.hasMore, false);

      await assert.rejects(
        api.call('openmotion_capability_discover', { action: 'list', offset: -1 }),
        /offset|minimum/i,
      );
      await assert.rejects(
        api.call('openmotion_capability_discover', { action: 'list', limit: 0 }),
        /limit|minimum/i,
      );
    } finally {
      registerCapabilityQuoteEstimator(undefined);
    }
  }, false));

test('Studio assetOperation(generate) enforces capability preflight, findLandingScene excludes coming_soon, and multi-shot defaults to 3 shots', () =>
  fixture(async store => {
    // 1. multi-shot preserves defaultValue: '3' in schema and prompt builder
    const multiShot = findCapability('multi-shot')!;
    const schema = capabilityControlSchema(multiShot) as { properties: Record<string, { default?: string }> };
    assert.equal(schema.properties.shots.default, '3');
    assert.match(buildCapabilityPrompt('multi-shot', 'A lunar rover', {}), /a cohesive 3-shot narrative sequence/);

    // 2. findLandingScene and isStandaloneSpaPath exclude coming_soon capabilities by default and admit live overrides
    assert.equal(findLandingScene('inpainting'), undefined);
    assert.equal(findLandingScene('upscale-4k'), undefined);
    assert.equal(isStandaloneSpaPath('/create/inpainting'), false);
    assert.equal(isStandaloneSpaPath('/create/upscale-4k'), false);
    const withLiveUpscale = resolveCapabilityCatalog([
      { id: 'upscale-4k', status: 'live', channels: { gui: true, mcp: true } },
    ]);
    const liveScene = findLandingScene('upscale-4k', withLiveUpscale);
    assert.equal(liveScene?.id, 'upscale-4k');
    assert.equal(liveScene?.modality, 'image');
    assert.equal(isStandaloneSpaPath('/create/upscale-4k', '', '', withLiveUpscale), true);
    assert.equal(isStandaloneSpaPath('/create/inpainting', '', '', withLiveUpscale), false);

    // 3. openmotion_assets_use(action="generate") executes full capability preflight before gateway.submit
    const gateway = gatewayFor(store);
    let submitCalls = 0;
    const origSubmit = gateway.submit.bind(gateway);
    gateway.submit = (async (...args: Parameters<typeof gateway.submit>) => {
      submitCalls += 1;
      return origSubmit(...args);
    }) as typeof gateway.submit;

    (gateway as any).options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];
    (gateway as any).models = async () => [
      { id: 'codex:image-generation', provider: 'codex', modelId: 'image-generation', label: 'Codex Image', modality: 'image', source: 'builtin', mode: 'text-to-image', supportsImageReference: true, maxInputImages: 5 },
      { id: 'opendesign:gpt-image-2.6-sunburst', provider: 'opendesign', modelId: 'gpt-image-2.6-sunburst', label: 'Sunburst', modality: 'image', source: 'live', mode: 'text-to-image', supportsImageReference: true, maxInputImages: 16, generationOptions: { delivery: 'provider', fields: [{ key: 'background', label: 'Background', kind: 'choice', choices: [{ value: 'transparent', label: 'Transparent' }] }] } },
    ];

    const api = service(store);
    const ref1 = { assetId: '00000000-0000-4000-8000-000000000001', versionId: '00000000-0000-4000-8000-000000000002' };
    const ref2 = { assetId: '00000000-0000-4000-8000-000000000003', versionId: '00000000-0000-4000-8000-000000000004' };

    try {
      // 3a. coming_soon capability rejected before submit
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-soon',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Inpaint sky',
          capabilityId: 'inpainting',
          references: [ref1],
        }),
        /CAPABILITY_COMING_SOON/,
      );

      // 3b. Channel enforcement distinguishes GUI vs MCP callers
      // shot-image is live with channels: { gui: false, mcp: true }: rejected on GUI, accepted on MCP
      await assert.rejects(
        api.call(
          'openmotion_assets_use',
          {
            action: 'generate',
            requestId: 'preflight-channel-gui',
            modality: 'image',
            model: 'codex:image-generation',
            prompt: 'First frame',
            capabilityId: 'shot-image',
          },
          undefined,
          { channel: 'gui' },
        ),
        /CAPABILITY_CHANNEL_DISABLED/,
      );
      await saveCapabilityOverrides(store, [
        { id: 'expand-image', status: 'live', channels: { gui: true, mcp: false } },
      ]);
      // expand-image overridden to GUI-only: rejected on MCP channel
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-channel-mcp',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Expand borders',
          capabilityId: 'expand-image',
          references: [ref1],
        }),
        /CAPABILITY_CHANNEL_DISABLED/,
      );

      // 3c. Live script override rejected with CAPABILITY_EXECUTOR_UNSUPPORTED instead of running generic model
      await saveCapabilityOverrides(store, [
        { id: 'remove-background', status: 'live', channels: { gui: true, mcp: true }, executor: { kind: 'script', scriptId: 'local-rmbg' } },
        { id: 'upscale-4k', status: 'live', channels: { gui: true, mcp: true }, executor: { kind: 'dedicated-model', providers: ['codex'], models: ['real-esrgan-4k'], recommendedModel: 'real-esrgan-4k', mode: 'text-to-image' } },
      ]);
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-script',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Cut out subject',
          capabilityId: 'remove-background',
          references: [ref1],
        }),
        /CAPABILITY_EXECUTOR_UNSUPPORTED/,
      );

      // 3d. Live dedicated-model override rejects incompatible generic model and out-of-range references
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-refs',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Upscale',
          capabilityId: 'upscale-4k',
          references: [ref1, ref2],
        }),
        /references|out_of_range|0\.\.|1\.\.1/i,
      );
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-model',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Upscale',
          capabilityId: 'upscale-4k',
          references: [ref1],
        }),
        /CAPABILITY_MODEL_INCOMPATIBLE/,
      );

      // 3e. Invalid capabilityOptions rejected before submit
      await assert.rejects(
        api.call('openmotion_assets_use', {
          action: 'generate',
          requestId: 'preflight-opt',
          modality: 'image',
          model: 'codex:image-generation',
          prompt: 'Relight',
          capabilityId: 'relight',
          capabilityOptions: { direction: 'nonexistent-angle' },
          references: [ref1],
        }),
        /invalid choice|invalid_enum/i,
      );

      assert.equal(submitCalls, 0, 'gateway.submit must never be invoked when capability preflight fails');

      // 3f. MCP-only live capability (shot-image) succeeds on default MCP channel
      const origRun = gateway.submit.bind(gateway);
      gateway.submit = (async (input: any) => {
        submitCalls += 1;
        return { id: '00000000-0000-4000-8000-000000000099', state: 'queued', modality: input.modality, capabilityId: input.capabilityId };
      }) as typeof gateway.submit;
      const mcpAccepted = await api.call('openmotion_assets_use', {
        action: 'generate',
        requestId: 'preflight-mcp-shot-image',
        modality: 'image',
        model: 'codex:image-generation',
        prompt: 'Opening shot frame',
        capabilityId: 'shot-image',
      });
      assert.equal(mcpAccepted.job.capabilityId, 'shot-image');
      assert.equal(submitCalls, 1);
      void origRun;
    } finally {
      gateway.submit = origSubmit;
    }
  }, false));

test('concurrent script requestId reservation, capability dryRun parameter validation, and default control option mapping', () =>
  fixture(async store => {
    const root = store.directory;
    const sampleImage = path.join(root, 'concurrent-sample.png');
    const api = service(store);
    const { writeFile } = await import('node:fs/promises');
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+8X8AAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(sampleImage, tinyPng);

    // 1. Concurrent script requests share one execution and conflict on differing inputs
    let handlerCalls = 0;
    let releaseGate!: () => void;
    let enteredGate!: () => void;
    const gateEntered = new Promise<void>(resolve => { enteredGate = resolve; });
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });

    registerCapabilityScriptExecutor('test-concurrent-script', async () => {
      handlerCalls += 1;
      enteredGate();
      await gate;
      const outPath = path.join(root, `concurrent-out-${handlerCalls}.png`);
      await writeFile(outPath, tinyPng);
      return { sourcePath: outPath, name: 'Concurrent Output' };
    });

    let failOnce = true;
    registerCapabilityScriptExecutor('test-retry-script', async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('TRANSIENT_SCRIPT_FAILURE');
      }
      const outPath = path.join(root, 'retry-out.png');
      await writeFile(outPath, tinyPng);
      return { sourcePath: outPath, name: 'Retry Output' };
    });

    const gateway = gatewayFor(store);
    let submitCalls = 0;
    const origSubmit = gateway.submit.bind(gateway);
    gateway.submit = (async (...args: Parameters<typeof gateway.submit>) => {
      submitCalls += 1;
      return origSubmit(...args);
    }) as typeof gateway.submit;
    (gateway as any).options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];
    (gateway as any).models = async () => [
      { id: 'codex:image-generation', provider: 'codex', modelId: 'image-generation', label: 'Codex Image', modality: 'image', source: 'builtin', mode: 'text-to-image', supportsImageReference: true, maxInputImages: 5 },
      { id: 'codex:real-esrgan-4k', provider: 'codex', modelId: 'real-esrgan-4k', label: 'Real-ESRGAN 4K', modality: 'image', source: 'live', mode: 'text-to-image', supportsImageReference: true, maxInputImages: 1 },
    ];

    try {
      await saveCapabilityOverrides(store, [
        {
          id: 'remove-background',
          status: 'live',
          channels: { gui: true, mcp: true },
          executor: { kind: 'script', scriptId: 'test-concurrent-script' },
          input: { promptRequired: false, minReferences: 0, maxReferences: 1 },
        },
        {
          id: 'expand-image',
          status: 'live',
          channels: { gui: true, mcp: true },
          executor: { kind: 'script', scriptId: 'test-retry-script' },
          input: { promptRequired: false, minReferences: 0, maxReferences: 1 },
        },
        {
          id: 'upscale-4k',
          status: 'live',
          channels: { gui: true, mcp: true },
          executor: {
            kind: 'dedicated-model',
            providers: ['codex'],
            models: ['real-esrgan-4k'],
            recommendedModel: 'real-esrgan-4k',
            mode: 'text-to-image',
            optionToParameter: { scale: 'upscale_factor' },
            defaultParameters: { face_enhance: false },
          },
        },
      ]);

      const firstPromise = capabilityRun(store, {
        capabilityId: 'remove-background',
        requestId: 'script-concurrent-req-1',
        prompt: 'Cut out subject',
      });
      await gateEntered;

      // Concurrent identical call waits on the reserved execution; conflicting input rejects immediately
      const secondPromise = capabilityRun(store, {
        capabilityId: 'remove-background',
        requestId: 'script-concurrent-req-1',
        prompt: 'Cut out subject',
      });
      await assert.rejects(
        capabilityRun(store, {
          capabilityId: 'remove-background',
          requestId: 'script-concurrent-req-1',
          prompt: 'Different conflicting prompt',
        }),
        /REQUEST_ID_CONFLICT/,
      );

      releaseGate();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      assert.equal(handlerCalls, 1, 'concurrent identical script calls must invoke handler exactly once');
      assert.equal(first.asset.id, second.asset.id);
      assert.equal(first.version.id, second.version.id);
      assert.equal(Boolean(first.replayed || second.replayed), true);

      // Failed script execution releases pending receipt so the same requestId can be retried cleanly
      await assert.rejects(
        capabilityRun(store, {
          capabilityId: 'expand-image',
          requestId: 'script-retry-req-1',
          prompt: 'Retry me',
        }),
        /TRANSIENT_SCRIPT_FAILURE/,
      );
      const retried = await capabilityRun(store, {
        capabilityId: 'expand-image',
        requestId: 'script-retry-req-1',
        prompt: 'Retry me',
      });
      assert.equal(retried.executorKind, 'script');
      assert.ok(retried.asset.id);

      // 2. Registered-capability dryRun validates model parameters and mode just like real submission
      await assert.rejects(
        api.call('openmotion_capability_run', {
          capabilityId: 'text-to-image',
          model: 'codex:image-generation',
          prompt: 'Poster',
          parameters: { aspect_ratio: '99:1' },
          dryRun: true,
        }),
        /Invalid Aspect ratio: aspect_ratio/,
      );
      const validDryRun = await api.call('openmotion_capability_run', {
        capabilityId: 'text-to-image',
        model: 'codex:image-generation',
        prompt: 'Poster',
        parameters: { aspect_ratio: '16:9' },
        dryRun: true,
      });
      assert.equal(validDryRun.dryRun, true);
      assert.equal(validDryRun.effectiveParameters.aspect_ratio, '16:9');

      // 3. Dedicated-model option mapping applies control defaults when options are omitted
      const imported = await api.call('openmotion_asset_manage', {
        action: 'import',
        requestId: 'import-upscale-src',
        sourcePath: sampleImage,
        name: 'Upscale Src',
      });
      const srcRef = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };
      const liveCatalog = resolveCapabilityCatalog([
        {
          id: 'upscale-4k',
          status: 'live',
          channels: { gui: true, mcp: true },
          executor: {
            kind: 'dedicated-model',
            providers: ['codex'],
            models: ['real-esrgan-4k'],
            recommendedModel: 'real-esrgan-4k',
            mode: 'text-to-image',
            optionToParameter: { scale: 'upscale_factor' },
            defaultParameters: { face_enhance: false },
          },
        },
      ]);
      const upscaleCap = findCapability('upscale-4k', liveCatalog)!;
      assert.deepEqual(resolveCapabilityOptions(upscaleCap, {}), { scale: '4x' });
      assert.deepEqual(buildCapabilityParameters(upscaleCap, {}), { face_enhance: false, upscale_factor: '4x' });

      const upscaleDryRun = await api.call('openmotion_capability_run', {
        capabilityId: 'upscale-4k',
        references: [srcRef],
        dryRun: true,
      });
      assert.equal(upscaleDryRun.dryRun, true);
      assert.equal(upscaleDryRun.effectiveParameters.upscale_factor, '4x');
      assert.equal(upscaleDryRun.effectiveParameters.face_enhance, false);

      let capturedOptions: Record<string, unknown> | undefined;
      registerCapabilityQuoteEstimator(async input => {
        capturedOptions = input.options;
        return { currency: 'USD', estimatedCost: 0.04, source: 'test-default-options' };
      });
      await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'upscale-4k' });
      assert.deepEqual(capturedOptions, { scale: '4x' });
      assert.equal(submitCalls, 0, 'dryRun and quote checks must never invoke gateway.submit');
    } finally {
      registerCapabilityQuoteEstimator(undefined);
      unregisterCapabilityScriptExecutor('test-concurrent-script');
      unregisterCapabilityScriptExecutor('test-retry-script');
      gateway.submit = origSubmit;
    }
  }, false));

test('static-policy quotes require explicit approval for all billed media capabilities (image, music, speech) and raw models', () =>
  fixture(async store => {
    const api = service(store);
    const musicQuote = await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'music' });
    assert.equal(musicQuote.quote.requiresExplicitApproval, true);
    const imageQuote = await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'text-to-image' });
    assert.equal(imageQuote.quote.requiresExplicitApproval, true);
    const speechQuote = await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'speech' });
    assert.equal(speechQuote.quote.requiresExplicitApproval, true);
    const removeBgQuote = await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'remove-background' });
    assert.equal(removeBgQuote.quote.requiresExplicitApproval, true);
    const asrQuote = await api.call('openmotion_capability_discover', { action: 'quote', capabilityId: 'asr-transcribe' });
    assert.equal(asrQuote.quote.requiresExplicitApproval, false);
  }, false));
