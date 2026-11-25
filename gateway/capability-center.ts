import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ToolInputError } from '../shared/tool-input-error.ts';
import type { OmTracking } from '../shared/tracking.ts';
import type { HostContext } from '../tracking/host.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { AssetReference, AssetVersion, LibraryAsset } from '../shared/asset-library.ts';
import { mediaProviders, modelReferenceLimit, type Modality, type Model } from '../shared/gateway.ts';
import { generationOptions, resolveGenerationParameters, validateGenerationOptions } from '../shared/generation-options.ts';
import {
  buildCapabilityParameters,
  buildCapabilityPrompt,
  capabilityControlSchema,
  capabilitySupportsModel,
  findCapability,
  listCapabilitiesForChannel,
  resolveCapabilityCatalog,
  resolveCapabilityOptions,
  type CapabilityCostTier,
  type CapabilityDefinition,
  type CapabilityOverride,
} from '../shared/capability-registry.ts';
import { videoFeatureParameters, type VideoFeatureId } from '../shared/video-features.ts';
import { atomicAssetJson, AssetLibrary, assetHash } from './asset-library.ts';
import { assetOperation } from './asset-operations.ts';
import { brandKitOperation } from './brand-kit-operation.ts';
import { brandKitsFor } from './brand-kits.ts';
import {
  builtinCapabilityScripts,
  type CapabilityScriptContext,
  type CapabilityScriptHandler,
  type CapabilityScriptOutput,
} from './capability-scripts.ts';
import { mediaUse } from './media-use.ts';
import { gatewayFor } from './service.ts';
import { transcriptOperation } from './transcript-operations.ts';
import { transcriptsFor } from './transcription.ts';
import { requireNativeRuntime } from '../scripts/npm-runtime.mjs';
import { pluginRoot } from '../hyperframes.ts';

export type { CapabilityScriptContext, CapabilityScriptHandler, CapabilityScriptOutput };

const scriptExecutors = new Map<string, CapabilityScriptHandler>();

export function registerCapabilityScriptExecutor(scriptId: string, handler: CapabilityScriptHandler) {
  scriptExecutors.set(scriptId, handler);
}

export function unregisterCapabilityScriptExecutor(scriptId: string) {
  scriptExecutors.delete(scriptId);
}

function resolveScriptExecutor(scriptId: string): CapabilityScriptHandler | undefined {
  return scriptExecutors.get(scriptId) ?? builtinCapabilityScripts[scriptId];
}

// ==================== PLUGGABLE REMOTE HOT-CONFIG HOOK ====================
export type CapabilityRemoteConfigFetcher = () => Promise<readonly CapabilityOverride[]>;

let remoteConfigFetcher: CapabilityRemoteConfigFetcher | undefined;

/**
 * Extension hook for OpenDesign Cloud / AMR remote capability directory.
 * Registering a fetcher (or setting `OPENMOTION_CAPABILITY_CONFIG_URL`) enables
 * zero-release capability hot-swapping and soft-deprecation cached per workspace.
 */
export function setCapabilityRemoteConfigFetcher(fetcher: CapabilityRemoteConfigFetcher | undefined) {
  remoteConfigFetcher = fetcher;
}

// ==================== PLUGGABLE SPEND QUOTE ESTIMATOR HOOK ====================
export type CapabilityQuote = {
  capabilityId: string;
  costTier: CapabilityCostTier;
  requiresExplicitApproval: boolean;
  estimatedCredits: number | null;
  currency: string | null;
  quoteSource: 'static-policy' | 'cloud-quote';
  selectedModel?: string | null;
};

export type CapabilityQuoteContext = {
  store: WorkspaceStore;
  capability?: CapabilityDefinition;
  modality?: Modality;
  model?: Model;
  options: Record<string, unknown>;
  parameters: Record<string, unknown>;
  referenceCount: number;
};

export type CapabilityQuoteEstimator = (ctx: CapabilityQuoteContext) => Promise<CapabilityQuote>;

let customQuoteEstimator: CapabilityQuoteEstimator | undefined;

/**
 * Extension hook for AMR real-time billing / credit estimation.
 * Defaults to static tier policy until the cloud billing quote API is wired in.
 */
export function registerCapabilityQuoteEstimator(estimator: CapabilityQuoteEstimator | undefined) {
  customQuoteEstimator = estimator;
}

async function estimateCapabilityQuote(ctx: CapabilityQuoteContext): Promise<CapabilityQuote> {
  if (customQuoteEstimator) return customQuoteEstimator(ctx);
  const modality = ctx.capability?.modality ?? ctx.modality ?? ctx.model?.modality;
  const costTier: CapabilityCostTier = ctx.capability?.costTier ?? (modality === 'video' ? 'medium' : 'low');
  const requiresExplicitApproval = ctx.capability?.requiresExplicitApproval ?? (ctx.capability?.executor.kind !== 'service');
  return {
    capabilityId: ctx.capability?.id ?? 'raw-model',
    costTier,
    requiresExplicitApproval,
    estimatedCredits: null,
    currency: null,
    quoteSource: 'static-policy',
    selectedModel: ctx.model?.id ?? null,
  };
}

const overrideFilename = 'capabilities-override.json';
const remoteCacheFilename = 'capabilities-remote-cache.json';

async function readOverrideFile(file: string): Promise<CapabilityOverride[]> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(raw) ? raw : Array.isArray(raw?.overrides) ? raw.overrides : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function syncCapabilityRemoteConfig(store: WorkspaceStore): Promise<CapabilityDefinition[]> {
  const root = (store.workspaceStore ?? store).directory;
  const remoteUrl = process.env.OPENMOTION_CAPABILITY_CONFIG_URL;
  let fetched: readonly CapabilityOverride[] | undefined;
  if (remoteConfigFetcher) {
    fetched = await remoteConfigFetcher();
  } else if (remoteUrl) {
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Remote capability config HTTP ${res.status}`);
    const data = await res.json();
    fetched = Array.isArray(data) ? data : Array.isArray(data?.overrides) ? data.overrides : [];
  }
  if (fetched) {
    await atomicAssetJson(path.join(root, remoteCacheFilename), {
      syncedAt: Date.now(),
      overrides: fetched,
    });
  }
  return loadCapabilityCatalog(store);
}

export async function loadCapabilityCatalog(store: WorkspaceStore): Promise<CapabilityDefinition[]> {
  const root = (store.workspaceStore ?? store).directory;
  const [remoteCached, localPinned] = await Promise.all([
    readOverrideFile(path.join(root, remoteCacheFilename)),
    readOverrideFile(path.join(root, overrideFilename)),
  ]);
  return resolveCapabilityCatalog([...remoteCached, ...localPinned]);
}

export async function saveCapabilityOverrides(store: WorkspaceStore, overrides: readonly CapabilityOverride[]) {
  const root = (store.workspaceStore ?? store).directory;
  await atomicAssetJson(path.join(root, overrideFilename), { overrides });
  return loadCapabilityCatalog(store);
}

function providerRank(providerId: string): number {
  if (providerId === 'account') return 0;
  if (providerId === 'opendesign') return 1;
  return 2;
}

function recommendedModelFor(capability: CapabilityDefinition): string | undefined {
  if (capability.executor.kind === 'prompt-preset' || capability.executor.kind === 'dedicated-model') {
    return capability.executor.recommendedModel;
  }
  return undefined;
}

function selectCompatibleModels(
  capability: CapabilityDefinition,
  models: readonly Model[],
  availableProviders: ReadonlySet<string>,
  referenceCount = capability.input.minReferences,
): Model[] {
  const recId = recommendedModelFor(capability);
  const matches = models.filter(model => {
    if (!availableProviders.has(model.provider)) return false;
    if (!capabilitySupportsModel(capability, model)) return false;
    if (referenceCount >= 1 && (model.modality === 'image' || model.modality === 'video') && modelReferenceLimit(model) < referenceCount) return false;
    return true;
  });
  return matches.sort((a, b) => {
    if (recId) {
      const aRec = a.modelId === recId ? 0 : 1;
      const bRec = b.modelId === recId ? 0 : 1;
      if (aRec !== bRec) return aRec - bRec;
    }
    const pDiff = providerRank(a.provider) - providerRank(b.provider);
    if (pDiff !== 0) return pDiff;
    return a.id.localeCompare(b.id);
  });
}

type ScriptReceipt = {
  inputHash: string;
  assetId: string;
  status?: 'pending' | 'completed';
  versionId?: string;
};

type ScriptExecutionResult = {
  capabilityId: string;
  executorKind: 'script';
  costTier: CapabilityCostTier;
  asset: LibraryAsset;
  version: AssetVersion;
};

const inFlightScriptRuns = new Map<string, Promise<ScriptExecutionResult>>();

async function readScriptReceipt(receiptPath: string): Promise<ScriptReceipt | undefined> {
  return readFile(receiptPath, 'utf8').then(
    raw => JSON.parse(raw) as ScriptReceipt,
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return undefined;
    },
  );
}

function validateCapabilityOptions(capability: CapabilityDefinition, options: unknown): Record<string, unknown> {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw new ToolInputError('options must be an object', 'options', 'invalid_type');
  }
  const controls = capability.input.controls ?? [];
  const record = (options ?? {}) as Record<string, unknown>;
  if (controls.length > 0) {
    for (const [key, value] of Object.entries(record)) {
      const control = controls.find(item => item.key === key);
      if (!control) throw new ToolInputError(`unknown options.${key} for capability ${capability.id}`, 'unknown_field', 'unknown_field');
      if (typeof value !== 'string' || !control.choices.some(choice => choice.value === value)) {
        throw new ToolInputError(`invalid choice for options.${key}`, 'options', 'invalid_enum');
      }
    }
  }
  return resolveCapabilityOptions(capability, record);
}

export async function capabilityDiscover(
  store: WorkspaceStore,
  args: any,
  tracking?: OmTracking,
  channel: 'gui' | 'mcp' = 'mcp',
) {
  if (args.action === 'providers') {
    if (args.provider) return mediaUse(store, { action: 'reference', provider: args.provider }, tracking);
    return mediaUse(store, { action: 'inspect' }, tracking);
  }
  if (args.action === 'models') {
    if (args.modality === '3d') return { providers: [], catalogs: [], setupRequired: true };
    return mediaUse(
      store,
      {
        action: 'models',
        provider: args.provider,
        modality: args.modality,
        refresh: args.refresh,
        query: args.query,
        offset: args.offset,
        limit: args.limit,
      },
      tracking,
    );
  }

  if (args.refresh === true) {
    await syncCapabilityRemoteConfig(store).catch(() => {});
  }
  const catalog = await loadCapabilityCatalog(store);
  const gateway = gatewayFor(store, tracking);
  const [status, models, asrCatalog] = await Promise.all([
    gateway.status(),
    gateway.models(),
    transcriptsFor(store).models().catch(() => ({ models: [] as unknown[] })),
  ]);
  const availableProviders = new Set(
    status.providers
      .filter(p => p.available && !(p.id === 'account' && p.mediaEntitlement === 'not-included'))
      .map(p => p.id),
  );

  const summarize = (cap: CapabilityDefinition) => {
    if (cap.executor.kind === 'script') {
      const ready = Boolean(resolveScriptExecutor(cap.executor.scriptId)) && cap.status === 'live';
      return {
        id: cap.id,
        title: cap.title,
        summary: cap.summary,
        modality: cap.modality,
        category: cap.category,
        icon: cap.icon,
        status: cap.status,
        channels: cap.channels,
        costTier: cap.costTier,
        requiresExplicitApproval: cap.requiresExplicitApproval,
        executorKind: cap.executor.kind,
        available: ready,
        recommendedModel: `script:${cap.executor.scriptId}`,
        compatibleModelCount: ready ? 1 : 0,
      };
    }
    if (cap.executor.kind === 'service' && cap.executor.serviceId === 'asr-transcribe') {
      const count = Array.isArray(asrCatalog.models) ? asrCatalog.models.length : 0;
      return {
        id: cap.id,
        title: cap.title,
        summary: cap.summary,
        modality: cap.modality,
        category: cap.category,
        icon: cap.icon,
        status: cap.status,
        channels: cap.channels,
        costTier: cap.costTier,
        requiresExplicitApproval: cap.requiresExplicitApproval,
        executorKind: cap.executor.kind,
        available: cap.status === 'live' && count > 0,
        recommendedModel: null,
        compatibleModelCount: count,
      };
    }
    const compatible = selectCompatibleModels(cap, models, availableProviders);
    const defaultRoute = cap.modality !== '3d' ? status.routes[cap.modality] : undefined;
    const preferred = compatible.find(m => m.id === defaultRoute) ?? compatible[0];
    return {
      id: cap.id,
      title: cap.title,
      summary: cap.summary,
      modality: cap.modality,
      category: cap.category,
      icon: cap.icon,
      status: cap.status,
      channels: cap.channels,
      costTier: cap.costTier,
      requiresExplicitApproval: cap.requiresExplicitApproval,
      executorKind: cap.executor.kind,
      available: cap.status === 'live' && compatible.length > 0,
      recommendedModel: preferred?.id ?? recommendedModelFor(cap) ?? null,
      compatibleModelCount: compatible.length,
    };
  };

  if (args.action === 'list') {
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
      throw new ToolInputError('offset must be a non-negative integer', 'offset', 'out_of_range');
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
      throw new ToolInputError('limit must be an integer between 1 and 100', 'limit', 'out_of_range');
    }
    const entries = listCapabilitiesForChannel(catalog, channel, {
      modality: args.modality,
      includeComingSoon: args.includeComingSoon,
    }).map(summarize);
    const offset = args.offset ?? 0;
    const sliced = args.limit === undefined ? entries.slice(offset) : entries.slice(offset, offset + args.limit);
    const inspected = (await mediaUse(store, { action: 'inspect' }, tracking)) as {
      providers: unknown;
      defaults: unknown;
      settingsHandoff: unknown;
      upgrade?: unknown;
      _upgradeLinkResult?: unknown;
    };
    return {
      capabilities: sliced,
      total: entries.length,
      offset,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      hasMore: offset + sliced.length < entries.length,
      providers: inspected.providers,
      defaults: inspected.defaults,
      settingsHandoff: inspected.settingsHandoff,
      // MCP callers get the same attributed Free/Go upgrade link as inspect; the MCP boundary strips and tracks
      // _upgradeLinkResult. The Studio (gui) list never exposes either field.
      ...(channel === 'mcp' && inspected.upgrade ? { upgrade: inspected.upgrade } : {}),
      ...(channel === 'mcp' && inspected._upgradeLinkResult ? { _upgradeLinkResult: inspected._upgradeLinkResult } : {}),
    };
  }

  if (args.action === 'describe') {
    const cap = findCapability(args.capabilityId, catalog);
    if (!cap) throw new Error(`CAPABILITY_NOT_FOUND: Unknown capability ${String(args.capabilityId)}`);
    const base = summarize(cap);
    const isModelBacked =
      cap.executor.kind === 'model' || cap.executor.kind === 'prompt-preset' || cap.executor.kind === 'dedicated-model';
    const compatible = isModelBacked
      ? selectCompatibleModels(cap, models, availableProviders).map(m => ({
          id: m.id,
          provider: m.provider,
          modelId: m.modelId,
          label: m.label,
          mode: m.mode,
        }))
      : [];
    return {
      capability: {
        ...base,
        ...(cap.replacementCapabilityId ? { replacementCapabilityId: cap.replacementCapabilityId } : {}),
        input: {
          promptRequired: cap.input.promptRequired,
          minReferences: cap.input.minReferences,
          maxReferences: cap.input.maxReferences,
          controls: cap.input.controls ?? [],
          optionsSchema: capabilityControlSchema(cap),
        },
        compatibleModels: compatible,
      },
    };
  }

  if (args.action === 'quote') {
    const cap = findCapability(args.capabilityId, catalog);
    if (!cap) throw new Error(`CAPABILITY_NOT_FOUND: Unknown capability ${String(args.capabilityId)}`);
    const options = validateCapabilityOptions(cap, args.options);
    const compatible = selectCompatibleModels(cap, models, availableProviders);
    const chosen = args.model ? models.find(m => m.id === args.model) : compatible[0];
    const quote = await estimateCapabilityQuote({
      store,
      capability: cap,
      model: chosen,
      options,
      parameters: args.parameters ?? {},
      referenceCount: cap.input.minReferences,
    });
    return { quote };
  }

  throw new ToolInputError('unsupported capability discover action', 'action', 'invalid_enum');
}

export async function preflightAssetCapabilityGenerate(
  store: WorkspaceStore,
  args: {
    capabilityId: string;
    capabilityOptions?: Record<string, unknown>;
    model: string;
    modality?: string;
    prompt?: string;
    references?: AssetReference[];
  },
  tracking?: OmTracking,
  channel: 'gui' | 'mcp' = 'gui',
): Promise<{ capability: CapabilityDefinition; options: Record<string, unknown>; model: Model }> {
  const catalog = await loadCapabilityCatalog(store);
  const cap = findCapability(args.capabilityId, catalog);
  if (!cap) throw new Error(`CAPABILITY_NOT_FOUND: Unknown capability ${args.capabilityId}`);
  if (cap.status === 'coming_soon') {
    throw new Error(`CAPABILITY_COMING_SOON: ${cap.title} (${cap.id}) is coming soon and cannot be executed yet`);
  }
  if (cap.status === 'deprecated' || cap.status === 'hidden') {
    throw new Error(
      `CAPABILITY_DEPRECATED: ${cap.id} is no longer active${cap.replacementCapabilityId ? `; use ${cap.replacementCapabilityId} instead` : ''}`,
    );
  }
  if (!cap.channels[channel]) {
    throw new Error(`CAPABILITY_CHANNEL_DISABLED: ${cap.id} is not enabled on channel ${channel}`);
  }
  if (cap.modality === '3d' || (args.modality && args.modality !== cap.modality)) {
    throw new Error(`CAPABILITY_UNAVAILABLE: Capability ${cap.id} (${cap.modality}) cannot execute for modality ${args.modality ?? 'unknown'}`);
  }
  if (cap.executor.kind === 'script' || cap.executor.kind === 'service') {
    throw new Error(
      `CAPABILITY_EXECUTOR_UNSUPPORTED: ${cap.id} uses the ${cap.executor.kind} executor; run it through openmotion_capability_run or /motion-api/capabilities/run`,
    );
  }

  const options = validateCapabilityOptions(cap, args.capabilityOptions);
  const rawPrompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (cap.input.promptRequired && !rawPrompt.trim()) {
    throw new ToolInputError(`prompt is required for capability ${cap.id}`, 'prompt', 'missing');
  }
  const references: AssetReference[] = Array.isArray(args.references) ? args.references : [];
  if (references.length < cap.input.minReferences || references.length > cap.input.maxReferences) {
    throw new ToolInputError(
      `capability ${cap.id} requires ${cap.input.minReferences}..${cap.input.maxReferences} reference assets`,
      'references',
      'out_of_range',
    );
  }

  const gateway = gatewayFor(store, tracking);
  const [status, models] = await Promise.all([gateway.status(), gateway.models()]);
  const availableProviders = new Set(
    status.providers
      .filter(p => p.available && !(p.id === 'account' && p.mediaEntitlement === 'not-included'))
      .map(p => p.id),
  );
  const compatible = selectCompatibleModels(cap, models, availableProviders, references.length);
  const chosen = compatible.find(m => m.id === args.model);
  if (!chosen) {
    const catalogModel = models.find(m => m.id === args.model);
    if (catalogModel && capabilitySupportsModel(cap, catalogModel)) {
      if (!availableProviders.has(catalogModel.provider)) {
        throw new Error(`CAPABILITY_UNAVAILABLE: Provider ${catalogModel.provider} is not ready for model ${args.model}`);
      }
      if (references.length >= 1 && (catalogModel.modality === 'image' || catalogModel.modality === 'video') && modelReferenceLimit(catalogModel) < references.length) {
        throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Model ${args.model} accepts at most ${modelReferenceLimit(catalogModel)} reference image(s)`);
      }
    }
    throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Model ${args.model} does not support capability ${cap.id}`);
  }

  return { capability: cap, options, model: chosen };
}

export async function capabilityRun(
  store: WorkspaceStore,
  args: any,
  tracking?: OmTracking,
  channel: 'gui' | 'mcp' = 'mcp',
  host?: HostContext,
) {
  const action = args.action ?? 'run';
  if (action !== 'run') throw new ToolInputError('unsupported capability run action', 'action', 'invalid_enum');
  if (args.dryRun !== true && (typeof args.requestId !== 'string' || !/^[\w-]{1,100}$/.test(args.requestId))) {
    throw new ToolInputError('requestId is required', 'requestId', 'missing');
  }

  const gateway = gatewayFor(store, tracking);
  const library = new AssetLibrary(store);

  if (args.capabilityId) {
    const catalog = await loadCapabilityCatalog(store);
    const cap = findCapability(args.capabilityId, catalog);
    if (!cap) throw new Error(`CAPABILITY_NOT_FOUND: Unknown capability ${args.capabilityId}`);
    if (cap.status === 'coming_soon') {
      throw new Error(`CAPABILITY_COMING_SOON: ${cap.title} (${cap.id}) is coming soon and cannot be executed yet`);
    }
    if (cap.status === 'deprecated' || cap.status === 'hidden') {
      throw new Error(
        `CAPABILITY_DEPRECATED: ${cap.id} is no longer active${cap.replacementCapabilityId ? `; use ${cap.replacementCapabilityId} instead` : ''}`,
      );
    }
    if (!cap.channels[channel]) {
      throw new Error(`CAPABILITY_CHANNEL_DISABLED: ${cap.id} is not enabled on channel ${channel}`);
    }

    const options = validateCapabilityOptions(cap, args.options);
    const rawPrompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (cap.input.promptRequired && !rawPrompt.trim()) {
      throw new ToolInputError(`prompt is required for capability ${cap.id}`, 'prompt', 'missing');
    }

    const references: AssetReference[] = args.references ?? [];
    if (cap.executor.kind !== 'service') {
      if (references.length < cap.input.minReferences || references.length > cap.input.maxReferences) {
        throw new ToolInputError(
          `capability ${cap.id} requires ${cap.input.minReferences}..${cap.input.maxReferences} reference assets`,
          'references',
          'out_of_range',
        );
      }
    }

    if (cap.executor.kind === 'script') {
      const handler = resolveScriptExecutor(cap.executor.scriptId);
      if (!handler) throw new Error(`CAPABILITY_UNAVAILABLE: Script executor ${cap.executor.scriptId} is not registered`);
      if (args.dryRun === true) {
        const quote = await estimateCapabilityQuote({
          store,
          capability: cap,
          options,
          parameters: args.parameters ?? {},
          referenceCount: references.length,
        });
        return { dryRun: true, capabilityId: cap.id, executorKind: 'script' as const, selectedModel: `script:${cap.executor.scriptId}`, quote };
      }
      await requireNativeRuntime(pluginRoot, 'media');
      await library.validateGeneration({
        assetId: args.assetId,
        title: args.name,
        parentVersionId: args.parentVersionId,
        capabilityId: cap.id,
        capabilityOptions: Object.keys(options).length ? options : undefined,
        references,
        conversationId: args.conversationId,
      });
      const inputHash = assetHash({
        capabilityId: cap.id,
        prompt: rawPrompt,
        options,
        parameters: args.parameters ?? {},
        assetId: args.assetId ?? null,
        parentVersionId: args.parentVersionId ?? null,
        references,
      });
      const receiptPath = path.join(library.root, 'requests', `${assetHash(`script:${args.requestId}`)}.json`);
      const workspaceLock = store.workspaceStore ?? store;
      const reservation = await workspaceLock.lock(async () => {
        const existingReceipt = await readScriptReceipt(receiptPath);
        if (existingReceipt) {
          if (existingReceipt.inputHash !== inputHash) {
            throw new Error('REQUEST_ID_CONFLICT: requestId was already used with different capability inputs');
          }
          const saved = await library.get(existingReceipt.assetId).catch(() => undefined);
          const priorVersion = saved?.versions.find(v => v.requestId === args.requestId);
          if (saved && priorVersion) {
            return {
              kind: 'replayed' as const,
              result: {
                capabilityId: cap.id,
                executorKind: 'script' as const,
                costTier: cap.costTier,
                asset: saved,
                version: priorVersion,
                replayed: true,
              },
            };
          }
          if (existingReceipt.status === 'pending') {
            const inFlight = inFlightScriptRuns.get(receiptPath);
            if (inFlight) {
              return { kind: 'wait' as const, promise: inFlight };
            }
          }
        }
        const targetAssetId = existingReceipt?.assetId ?? args.assetId ?? crypto.randomUUID();
        await atomicAssetJson(receiptPath, {
          inputHash,
          assetId: targetAssetId,
          status: 'pending',
        } satisfies ScriptReceipt);
        let resolveInFlight!: (value: ScriptExecutionResult) => void;
        let rejectInFlight!: (reason?: unknown) => void;
        const gate = new Promise<ScriptExecutionResult>((resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        });
        gate.catch(() => {});
        inFlightScriptRuns.set(receiptPath, gate);
        return {
          kind: 'run' as const,
          targetAssetId,
          gate,
          resolveInFlight,
          rejectInFlight,
        };
      });

      if (reservation.kind === 'replayed') return reservation.result;
      if (reservation.kind === 'wait') {
        const completed = await reservation.promise;
        return { ...completed, replayed: true };
      }

      try {
        const resolvedRefs = await Promise.all(
          references.map(async ref => {
            const item = await library.resolve(ref);
            return { assetId: ref.assetId, versionId: ref.versionId, filename: item.filename };
          }),
        );
        const output = await handler({
          store,
          capability: cap,
          requestId: args.requestId,
          prompt: rawPrompt,
          options,
          parameters: args.parameters ?? {},
          references: resolvedRefs,
        });
        let prepared: Awaited<ReturnType<AssetLibrary['prepare']>> | undefined;
        try {
          prepared = await library.prepare(output.sourcePath);
          const committed = await workspaceLock.lock(async () => {
            const latestReceipt = await readScriptReceipt(receiptPath);
            if (latestReceipt && latestReceipt.inputHash !== inputHash) {
              throw new Error('REQUEST_ID_CONFLICT: requestId was already used with different capability inputs');
            }
            if (latestReceipt) {
              const saved = await library.get(latestReceipt.assetId).catch(() => undefined);
              const priorVersion = saved?.versions.find(v => v.requestId === args.requestId);
              if (saved && priorVersion) {
                return { asset: saved, version: priorVersion, replayed: true };
              }
            }
            const asset = await library.addLocked(prepared!, {
              assetId: args.assetId,
              createId: latestReceipt?.assetId ?? reservation.targetAssetId,
              name: args.name || output.name || cap.title,
              expectedModality: cap.modality === '3d' ? undefined : cap.modality,
              version: {
                source: 'generated',
                prompt: rawPrompt || cap.title,
                model: `script:${cap.executor.kind === 'script' ? cap.executor.scriptId : cap.id}`,
                parameters: args.parameters ?? {},
                capabilityId: cap.id,
                ...(Object.keys(options).length ? { capabilityOptions: options } : {}),
                references,
                parentVersionId: args.parentVersionId,
                requestId: args.requestId,
                requestHash: inputHash,
                conversationId: args.conversationId,
              },
            });
            const version = asset.versions.find(v => v.requestId === args.requestId) ?? asset.versions[asset.versions.length - 1];
            await atomicAssetJson(receiptPath, {
              inputHash,
              assetId: asset.id,
              status: 'completed',
              versionId: version.id,
            } satisfies ScriptReceipt);
            return { asset, version, replayed: false };
          });
          const result: ScriptExecutionResult = {
            capabilityId: cap.id,
            executorKind: 'script',
            costTier: cap.costTier,
            asset: committed.asset,
            version: committed.version,
          };
          reservation.resolveInFlight(result);
          return committed.replayed ? { ...result, replayed: true } : result;
        } finally {
          if (prepared) await rm(prepared.file, { force: true }).catch(() => {});
          await output.cleanup?.();
        }
      } catch (error) {
        await workspaceLock.lock(async () => {
          const latestReceipt = await readScriptReceipt(receiptPath).catch(() => undefined);
          if (latestReceipt?.status === 'pending' && latestReceipt.inputHash === inputHash) {
            const saved = await library.get(latestReceipt.assetId).catch(() => undefined);
            if (!saved?.versions.some(v => v.requestId === args.requestId)) {
              await rm(receiptPath, { force: true }).catch(() => {});
            }
          }
        }).catch(() => {});
        reservation.rejectInFlight(error);
        throw error;
      } finally {
        if (inFlightScriptRuns.get(receiptPath) === reservation.gate) {
          inFlightScriptRuns.delete(receiptPath);
        }
      }
    }

    if (cap.executor.kind === 'service' && cap.executor.serviceId === 'asr-transcribe') {
      let sourcePath = args.sourcePath;
      if (!sourcePath && references.length === 1) {
        sourcePath = (await library.resolve(references[0])).filename;
      }
      if (!sourcePath) {
        throw new ToolInputError('sourcePath or 1 audio/video asset reference is required for asr-transcribe', 'sourcePath', 'missing');
      }
      if (args.dryRun === true) {
        if (args.language !== undefined && (typeof args.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(args.language))) {
          throw new Error('Choose an ISO language code or auto');
        }
        const asrCatalog = await transcriptsFor(store).models();
        const asrModel = asrCatalog.models.find(item => item.id === (args.model ?? asrCatalog.defaultModel));
        if (!asrModel) {
          throw new Error('CAPABILITY_UNAVAILABLE: Configure an enabled transcription model in Settings > Model providers');
        }
        const quote = await estimateCapabilityQuote({
          store,
          capability: cap,
          options,
          parameters: args.parameters ?? {},
          referenceCount: references.length,
        });
        return {
          dryRun: true,
          capabilityId: cap.id,
          executorKind: 'service' as const,
          selectedModel: asrModel.id,
          quote: { ...quote, selectedModel: quote.selectedModel ?? asrModel.id },
        };
      }
      const submitted = await transcriptOperation(store, {
        command: 'submit',
        projectId: args.projectId ?? 'project',
        sourcePath,
        requestId: args.requestId,
        model: args.model,
        language: args.language,
        parameters: args.parameters,
      });
      return {
        capabilityId: cap.id,
        executorKind: 'service' as const,
        costTier: cap.costTier,
        ...submitted,
      };
    }

    if (cap.modality === '3d') {
      throw new Error(`CAPABILITY_UNAVAILABLE: No 3D executor is configured for ${cap.id}`);
    }

    const [status, models] = await Promise.all([gateway.status(), gateway.models()]);
    const availableProviders = new Set(
      status.providers
        .filter(p => p.available && !(p.id === 'account' && p.mediaEntitlement === 'not-included'))
        .map(p => p.id),
    );
    const compatible = selectCompatibleModels(cap, models, availableProviders, references.length);
    let chosen: Model | undefined;
    if (args.model) {
      chosen = compatible.find(m => m.id === args.model);
      if (!chosen) {
        const catalogModel = models.find(m => m.id === args.model);
        if (catalogModel && capabilitySupportsModel(cap, catalogModel)) {
          if (!availableProviders.has(catalogModel.provider)) {
            throw new Error(`CAPABILITY_UNAVAILABLE: Provider ${catalogModel.provider} is not ready for model ${args.model}`);
          }
          if (references.length >= 1 && (catalogModel.modality === 'image' || catalogModel.modality === 'video') && modelReferenceLimit(catalogModel) < references.length) {
            throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Model ${args.model} accepts at most ${modelReferenceLimit(catalogModel)} reference image(s)`);
          }
        }
        throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Model ${args.model} does not support capability ${cap.id}`);
      }
    } else {
      const routeId = status.routes[cap.modality];
      chosen = (cap.executor.kind === 'model' ? compatible.find(m => m.id === routeId) : undefined) ?? compatible[0];
    }
    if (!chosen) {
      throw new Error(`CAPABILITY_UNAVAILABLE: No configured provider/model is ready for capability ${cap.id}`);
    }

    if (args.mode !== undefined) {
      if (!['text-to-image', 'text-to-video', 'text-to-audio', 'text-to-speech'].includes(args.mode)) {
        throw new ToolInputError('Unsupported generation mode', 'mode', 'invalid_enum');
      }
      if (args.mode !== `text-to-${cap.modality}` && !(cap.modality === 'audio' && args.mode === 'text-to-speech')) {
        throw new ToolInputError('Generation mode does not match modality', 'mode', 'invalid_enum');
      }
    }
    const executorMode =
      cap.executor.kind === 'model' || cap.executor.kind === 'prompt-preset' || cap.executor.kind === 'dedicated-model'
        ? cap.executor.mode
        : undefined;
    const requestedMode = args.mode ?? executorMode;
    if (['account', 'opendesign'].includes(chosen.provider) && requestedMode && requestedMode !== chosen.mode) {
      throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Generation mode ${requestedMode} does not match the selected ${chosen.provider === 'account' ? 'account' : 'Cloud'} model`);
    }
    const resolvedModel: Model = requestedMode ? { ...chosen, mode: requestedMode } : chosen;

    const videoPresetParams: Record<string, unknown> =
      cap.id === 'camera-control' || cap.id === 'multi-shot'
        ? videoFeatureParameters(cap.id as VideoFeatureId, resolvedModel)
        : {};
    if (cap.executor.kind === 'prompt-preset' && cap.executor.forceAudio) {
      const audioField = (resolvedModel.generationOptions ?? generationOptions(resolvedModel))?.fields.find(
        field => field.key === 'generate_audio' || field.key === 'audio',
      );
      videoPresetParams[audioField?.key ?? 'generate_audio'] = true;
    }
    const mergedParameters = buildCapabilityParameters(cap, options, { ...videoPresetParams, ...(args.parameters ?? {}) });
    const resolvedParameters = resolveGenerationParameters(resolvedModel, mergedParameters, references.length > 0);
    validateGenerationOptions(resolvedModel, resolvedParameters, references.length > 0);
    if (resolvedModel.provider === 'opendesign' && references.length > 0 && resolvedParameters.images !== undefined) {
      throw new Error('Choose pinned references or parameters.images for Cloud input');
    }
    const effectivePrompt =
      cap.executor.kind === 'dedicated-model'
        ? rawPrompt.trim() || cap.title
        : buildCapabilityPrompt(cap.id, rawPrompt, options, catalog);

    const quote = await estimateCapabilityQuote({
      store,
      capability: cap,
      model: resolvedModel,
      options,
      parameters: resolvedParameters,
      referenceCount: references.length,
    });
    if (args.dryRun === true) {
      return {
        dryRun: true,
        capabilityId: cap.id,
        executorKind: cap.executor.kind,
        selectedModel: resolvedModel.id,
        mode: resolvedModel.mode,
        effectiveParameters: resolvedParameters,
        quote,
      };
    }

    await requireNativeRuntime(pluginRoot, 'media');
    const job = await gateway.submit({
      modality: cap.modality,
      prompt: effectivePrompt,
      model: resolvedModel.id,
      mode: requestedMode ?? resolvedModel.mode,
      idempotencyKey: args.requestId,
      parameters: mergedParameters,
      capabilityId: cap.id,
      ...(Object.keys(options).length ? { capabilityOptions: options } : {}),
      library: {
        assetId: args.assetId,
        title: args.name,
        parentVersionId: args.parentVersionId,
        capabilityId: cap.id,
        ...(Object.keys(options).length ? { capabilityOptions: options } : {}),
        references,
        conversationId: args.conversationId,
      },
    }, host);
    return {
      capabilityId: cap.id,
      executorKind: cap.executor.kind,
      selectedModel: job.model.id,
      costTier: cap.costTier,
      quote,
      job,
      next: { tool: 'openmotion_job_manage', action: 'status', jobId: job.id },
    };
  }

  // Raw model fallback when no dedicated capabilityId is specified
  if (!args.model) throw new ToolInputError('capabilityId or model is required', 'capabilityId', 'missing');
  if (args.modality !== 'image' && args.modality !== 'video' && args.modality !== 'audio') {
    throw new ToolInputError('modality must be image, video, or audio when calling by raw model', 'modality', args.modality ? 'invalid_enum' : 'missing');
  }
  const rawModality = args.modality as Modality;
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw new ToolInputError('prompt is required when calling by raw model', 'prompt', 'missing');
  }
  if (args.mode !== undefined) {
    if (!['text-to-image', 'text-to-video', 'text-to-audio', 'text-to-speech'].includes(args.mode)) {
      throw new ToolInputError('Unsupported generation mode', 'mode', 'invalid_enum');
    }
    if (args.mode !== `text-to-${rawModality}` && !(rawModality === 'audio' && args.mode === 'text-to-speech')) {
      throw new ToolInputError('Generation mode does not match modality', 'mode', 'invalid_enum');
    }
  }
  if (args.dryRun === true) {
    const [status, models] = await Promise.all([gateway.status(), gateway.models()]);
    const availableProviders = new Set(
      status.providers
        .filter(p => p.available && !(p.id === 'account' && p.mediaEntitlement === 'not-included'))
        .map(p => p.id),
    );
    let chosen = models.find(m => m.id === args.model && m.modality === rawModality);
    if (!chosen && models.some(m => m.id === args.model)) {
      throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Model ${args.model} does not match modality ${rawModality}`);
    }
    if (!chosen && typeof args.model === 'string') {
      const colon = args.model.indexOf(':');
      const provider = colon > 0 ? mediaProviders.find(id => id === args.model.slice(0, colon)) : undefined;
      const modelId = colon > 0 ? args.model.slice(colon + 1) : '';
      if (provider && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,140}$/.test(modelId)) {
        chosen = {
          id: args.model,
          provider,
          modelId,
          label: modelId,
          modality: rawModality,
          mode: args.mode ?? `text-to-${rawModality}`,
          source: 'custom',
        };
      }
    }
    if (!chosen || !availableProviders.has(chosen.provider)) {
      throw new Error(`CAPABILITY_UNAVAILABLE: Selected model ${args.model} is unavailable; configure an available provider or choose a different model`);
    }
    if (['account', 'opendesign'].includes(chosen.provider) && args.mode && args.mode !== chosen.mode) {
      throw new Error(`CAPABILITY_MODEL_INCOMPATIBLE: Generation mode ${args.mode} does not match the selected ${chosen.provider === 'account' ? 'account' : 'Cloud'} model`);
    }
    const resolvedModel: Model = args.mode ? { ...chosen, mode: args.mode } : chosen;
    const rawRefs: AssetReference[] = Array.isArray(args.references) ? args.references : [];
    const rawParams = args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
      ? args.parameters as Record<string, unknown>
      : {};
    const resolvedParameters = resolveGenerationParameters(resolvedModel, rawParams, rawRefs.length > 0);
    validateGenerationOptions(resolvedModel, resolvedParameters, rawRefs.length > 0);
    const referenceLimit = modelReferenceLimit(resolvedModel);
    if (rawRefs.length && resolvedModel.provider === 'opendesign' && resolvedModel.modality === 'image' && resolvedModel.supportsImageReference === undefined) {
      throw new Error('Image editing capability is unknown. Sync Cloud models before using references.');
    }
    if (rawRefs.length && !referenceLimit) {
      throw new Error(rawModality === 'video'
        ? 'This video model does not accept an input image. Choose a video model with maxInputImages, or remove the reference.'
        : 'This model does not support asset references. Choose an image model that supports editing, or remove the reference.');
    }
    if (rawRefs.length > referenceLimit) {
      throw new Error(`This model accepts at most ${referenceLimit} input image${referenceLimit === 1 ? '' : 's'}`);
    }
    if (resolvedModel.provider === 'opendesign' && rawRefs.length && resolvedParameters.images !== undefined) {
      throw new Error('Choose pinned references or parameters.images for Cloud input');
    }
    const quote = await estimateCapabilityQuote({
      store,
      modality: rawModality,
      model: resolvedModel,
      options: {},
      parameters: resolvedParameters,
      referenceCount: rawRefs.length,
    });
    return {
      dryRun: true,
      executorKind: 'model' as const,
      selectedModel: resolvedModel.id,
      modality: rawModality,
      mode: resolvedModel.mode,
      effectiveParameters: resolvedParameters,
      quote,
    };
  }
  await requireNativeRuntime(pluginRoot, 'media');
  const job = await gateway.submit({
    modality: rawModality,
    prompt: args.prompt,
    model: args.model,
    mode: args.mode,
    idempotencyKey: args.requestId,
    parameters: args.parameters,
    library: {
      assetId: args.assetId,
      title: args.name,
      parentVersionId: args.parentVersionId,
      references: args.references,
      conversationId: args.conversationId,
    },
  }, host);
  return {
    executorKind: 'model' as const,
    selectedModel: job.model.id,
    job,
    next: { tool: 'openmotion_job_manage', action: 'status', jobId: job.id },
  };
}

export async function jobManage(store: WorkspaceStore, args: any, tracking?: OmTracking) {
  const gateway = gatewayFor(store, tracking);
  if (args.action === 'list') {
    const cap = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 100;
    const jobs = (await gateway.listJobs(args.projectId))
      .filter(job => !args.conversationId || job.library?.conversationId === args.conversationId)
      .slice(0, cap);
    return { jobs };
  }
  if (args.action === 'status' || args.action === 'cancel' || args.action === 'retry_save' || args.action === 'resume') {
    const job = await gateway.getJob(args.jobId);
    if (args.projectId && job.projectId !== args.projectId) {
      throw new Error('GENERATION_NOT_FOUND: job does not belong to this project');
    }
    if ((args.action === 'retry_save' || args.action === 'resume') && !args.requestId) {
      throw new ToolInputError('requestId is required', 'requestId', 'missing');
    }
    if (args.action === 'resume') return { job: await gateway.resume(job.id, args.requestId) };
    if (args.action === 'retry_save') return { job: await gateway.retrySave(job.id) };
    if (args.action === 'cancel') return { job: await gateway.cancel(job.id) };
    return { job };
  }
  throw new ToolInputError('unsupported job manage action', 'action', 'invalid_enum');
}

export async function assetManage(
  store: WorkspaceStore,
  args: any,
  importProject?: (input: any, options?: { receiptName: string; reusePinnedContent: boolean }) => Promise<any>,
  origin?: string,
  tracking?: OmTracking,
) {
  if (args.action === 'brand_kit') {
    return brandKitOperation(brandKitsFor((store.workspaceStore ?? store).directory), args.brandKit, origin ?? '');
  }
  if (['list', 'get', 'read', 'import', 'update', 'import_to_project'].includes(args.action)) {
    return assetOperation(store, args, importProject, tracking);
  }
  throw new ToolInputError('unsupported asset manage action', 'action', 'invalid_enum');
}
