import { randomUUID } from 'node:crypto';
import { ToolInputError } from '../shared/tool-input-error.ts';
import type { OmTracking } from '../shared/tracking.ts';
import type { HostContext } from '../tracking/host.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { GenerateInput, GatewayStatus, Modality, ProviderState } from '../shared/gateway.ts';
import type { ProviderSetupEntry } from '../shared/workspace-url.ts';
import { isMediaProvider, registeredProvider } from '../shared/provider-registry.ts';
import { gatewayFor } from './service.ts';
import { getWorkflow } from '../shared/workflow.ts';

type MediaProviderLike = Pick<ProviderState, 'id' | 'available'> & Partial<Pick<ProviderState, 'mediaEntitlement'>>;
type SetupProviderLike = Pick<ProviderState, 'id' | 'available' | 'configured' | 'verification'>
  & Partial<Pick<ProviderState, 'mediaEntitlement' | 'plan'>>;

export function isMediaProviderUsable(provider: MediaProviderLike): boolean {
  return Boolean(provider.available && !(provider.id === 'account' && provider.mediaEntitlement === 'not-included'));
}

export function resolveMediaSetupEntry(
  providers: readonly SetupProviderLike[],
  options?: {
    modality?: Modality;
    capabilities?: GatewayStatus['capabilities'];
  },
): ProviderSetupEntry | undefined {
  const hasUsableForScope = options?.capabilities
    ? (options.modality
      ? options.capabilities.some(cap => cap.modality === options.modality && cap.available)
      : options.capabilities.some(cap => cap.available))
    : providers.some(isMediaProviderUsable);
  if (hasUsableForScope) return undefined;
  const account = providers.find(p => p.id === 'account');
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'go') return 'agent_media_upgrade_go';
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'free') return 'agent_media_upgrade_free';
  if (providers.some(p => p.id !== 'account' && p.configured && p.verification === 'rejected')) return 'agent_media_key_rejected';
  if (!account?.configured) return 'agent_media_signed_out';
  return undefined;
}

export function buildMediaSettingsHandoff(entry?: ProviderSetupEntry) {
  return {
    tool: 'openmotion_open_preview' as const,
    arguments: { target: 'providers' as const, ...(entry ? { entry } : {}) },
  };
}

export async function mediaUse(store: WorkspaceStore, args: any, tracking?: OmTracking, host?: HostContext) {
  const gateway = gatewayFor(store, tracking);
  const connections = await gateway.connections.list();
  // Codex is a local image Agent: Settings offers it for images, so discovery accepts it; new images go through openmotion_assets_use.
  const supported = (id: string) => isMediaProvider(id) || id === 'codex' || registeredProvider(id)?.integration === 'account' || connections.some(p => p.id === id && p.protocol === 'openai' && !p.setupRequired);
  const referenceSection = (id: string) => registeredProvider(id)?.reference ?? 'compatible';
  if (args.provider !== undefined && !supported(args.provider)) throw new ToolInputError('unsupported media provider', 'provider', 'invalid_enum');
  if (args.action === 'inspect') {
    const status = await gateway.status(false, { refreshAccount: true });
    const providers = status.providers.filter(p => supported(p.id) && (isMediaProvider(p.id) || p.configured || p.id === 'account'));
    const modality = typeof args.modality === 'string' && ['image', 'video', 'audio'].includes(args.modality)
      ? args.modality as Modality
      : undefined;
    const entry = resolveMediaSetupEntry(providers, modality ? { modality, capabilities: status.capabilities } : undefined);
    let upgrade: { url: string; entryId: string; plan: 'plus'; instruction: string } | undefined;
    let upgradeLinkResult: { entry_from: 'agent_media_upgrade_free' | 'agent_media_upgrade_go'; outcome: 'success' | 'failure'; entry_id?: string } | undefined;
    if (entry === 'agent_media_upgrade_free' || entry === 'agent_media_upgrade_go') {
      try {
        const entryId = randomUUID();
        const { url } = await gateway.account.upgradeLink(entryId);
        upgrade = { url, entryId, plan: 'plus', instruction: 'Present url to the user as a clickable "Upgrade to Plus / 升级到 Plus" link, then inspect again after payment and continue the original request.' };
        upgradeLinkResult = { entry_from: entry, outcome: 'success', entry_id: entryId };
      } catch {
        upgradeLinkResult = { entry_from: entry, outcome: 'failure' };
      }
    }
    return { providers,
      defaults: status.routes,
      settings: 'Open Settings > Model providers > OpenDesign to sign in or upgrade to Plus in place. Save or replace API keys in Model providers.',
      settingsHandoff: buildMediaSettingsHandoff(entry),
      ...(upgrade ? { upgrade } : {}),
      // Service metadata crosses the local HTTP bridge; only stdio MCP records it.
      ...(upgradeLinkResult ? { _upgradeLinkResult: upgradeLinkResult } : {}),
      references: status.providers.filter(p => supported(p.id)).map(p => ({ provider: p.id, uri: `openmotion://workflow/media/${referenceSection(p.id)}` })),
      credentials: 'Read by the local service; keys are never returned to the Agent.' };
  }
  if (args.action === 'reference') {
    if (!args.provider) throw new ToolInputError('provider is required', 'provider', 'missing');
    return getWorkflow(referenceSection(args.provider), 'media');
  }
  if (args.action === 'models') {
    const providers = (await gateway.status()).providers.filter(p => supported(p.id) && (!args.provider || p.id === args.provider) && p.available);
    const pages = await Promise.all(providers.map(provider => gateway.listModels({ provider: provider.id, modality: args.modality, refresh: args.refresh, query: args.query, offset: args.offset, limit: args.limit })));
    return { providers: providers.map(p => p.id), catalogs: pages, setupRequired: !providers.length };
  }
  if (!args.projectId) throw new ToolInputError('projectId is required', 'projectId', 'missing');
  if (!store.projectCatalog().projects.some(p => p.id === args.projectId)) throw new Error('PROJECT_NOT_FOUND');
  if (args.action === 'generate') {
    if (args.provider === 'codex') throw new ToolInputError('Generate Codex images with openmotion_assets_use (model codex:image-generation); project-direct generation does not accept Codex', 'provider', 'invalid_enum');
    const missing = ['provider', 'model', 'requestId', 'modality'].find(field => !args[field]);
    if (missing || typeof args.prompt !== 'string') {
      throw new ToolInputError('provider, model, projectId, requestId, modality and prompt are required', missing ?? 'prompt', 'missing');
    }
    const job = await gateway.submit({ projectId: args.projectId, model: `${args.provider}:${args.model}`, modality: args.modality,
      prompt: args.prompt, parameters: args.parameters, mode: args.mode, referenceAsset: args.referenceAsset, idempotencyKey: args.requestId } as GenerateInput, host);
    return { projectId: job.projectId, job, next: { action: 'status', projectId: job.projectId, jobId: job.id } };
  }
  if (args.action === 'status' || args.action === 'cancel' || args.action === 'retry_save' || args.action === 'resume') {
    const job = await gateway.getJob(args.jobId);
    if (job.projectId !== args.projectId || job.model.provider === 'codex') throw new Error('GENERATION_NOT_FOUND: job does not belong to this project');
    if (args.action !== 'status' && !args.requestId) throw new ToolInputError('requestId is required', 'requestId', 'missing');
    if (args.action === 'resume') return { projectId: job.projectId, job: await gateway.resume(job.id, args.requestId) };
    return { projectId: job.projectId, job: args.action === 'retry_save' ? await gateway.retrySave(job.id) : args.action === 'cancel' ? await gateway.cancel(job.id) : job };
  }
  throw new ToolInputError('unsupported media action', 'action', 'invalid_enum');
}
