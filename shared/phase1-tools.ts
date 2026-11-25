import { copyAttemptPattern, templateEntries } from './template-attribution.ts';
import { gameTools } from './game-tools.ts';
import { ToolInputError } from './tool-input-error.ts';
import { inlineVideoUri } from './inline-video.ts';
import { templateGuideDraftSchema } from './template-guide.ts';
import { publicToolName, legacyToolName } from './public-names.mjs';
import { templateDiscoveryGuide, skillDiscoveryGuide } from './workflow-entry.js';
import { projectArchiveTool } from './project-archive.ts';
import { projectManagementTool } from './project-management.ts';
import { assetLibraryTool, workspaceAssetUseTool } from './asset-tools.ts';
import { capabilityMetaTools } from './capability-tools.ts';
import { designTools } from './design-tools.ts';
import { providerSetupEntries } from './workspace-url.ts';
import { canvasPresets } from './composition-canvas.ts';
const providerEntry = { enum: [...providerSetupEntries], description: 'Optional entry reason when target=providers (for example agent_media_signed_out, agent_media_upgrade_free, agent_media_upgrade_go, agent_media_balance_low, agent_media_key_rejected, agent_media_handbook); defaults to agent_providers.' } as const;
const id = { type: 'string', minLength: 1, maxLength: 100 };
const projectId = { type: 'string', pattern: '^(project|[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$' };
const workId = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text = { type: 'string', minLength: 1, maxLength: 8000 };
const presentation = { enum: ['foreground', 'background', 'now'], description: 'Default foreground shows the calling chat panel when active and queues only while inactive, without switching chats. Use now only for an explicit request to display immediately in this turn; background skips presentation.' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const review = object({ objectId: id, versionId: id, range: object({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']),
  conclusion: { enum: ['passed', 'failed', 'pending', 'unable_to_view'] }, evidence: text, source: { enum: ['agent', 'user'] } }, ['objectId', 'versionId', 'conclusion', 'evidence', 'source']);
const display = object({ revision, versionId: id, previewUrl: { type: 'string', minLength: 1, maxLength: 4000 },
  visibility: { enum: ['visible', 'queued', 'hidden', 'unavailable'], description: 'Observed native panel visibility. Use queued only when the host confirms the calling chat is inactive; a queued acknowledgment alone is insufficient. Otherwise use hidden or unavailable and report the display failure.' }, hostStatus: { type: 'string', minLength: 1, maxLength: 80, description: 'Host action acknowledgment, such as queued; independent of observed panel visibility (optional; omit when unset).' }, hostTabId: { ...id, description: 'Actual native host Tab ID, such as providerTabId; never the CUA wrapper id. A reuse hint, not proof of current visibility (optional; omit when unset).' }, contentVerified: { type: 'boolean' }, evidence: text },
  ['revision', 'versionId', 'previewUrl', 'visibility', 'contentVerified', 'evidence']);
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const phase1Tools = [
  ...gameTools,
  ...capabilityMetaTools,
  workspaceAssetUseTool,
  assetLibraryTool,
  projectArchiveTool,
  projectManagementTool,
  { name: 'openmotion_media_use', title: 'OpenMotion · Media Use', description: 'Discover configured media providers with inspect (refreshes account billing and returns advisory mediaEntitlement, normalized plan and hasBalance, never raw balances); inspect returns `upgrade.url` (attributed OpenMotion upgrade link) when Free/Go blocks multimodal generation. Read the selected provider guide with reference, then query models and schemas. The preferred route for NEW generation is openmotion_assets_use: supply the full model ID, generate into workspace Assets, poll the original jobId, inspect a pinned assetId/versionId, and import_to_project only when adopting a result. Credentials stay in the local service. Existing project-direct generation is retained as a COMPATIBILITY route: generate still requires explicit projectId, stable requestId, provider, provider-native model, modality and prompt; it returns queued, not media. Optional referenceAsset uses a project-relative image with a model that supports editing; it snapshots one PNG/JPEG/WebP under 2 MiB for OpenDesign account/Cloud or under 20 MB for other local adapters. Audio follows the selected model: speech uses text-to-speech, music and sound effects use text-to-audio; read its native input schema. Old jobs keep this Tool and their original projectId/jobId for status, cancel, retry_save or resume; do not regenerate them through another Tool. Project-direct results save to the library and original project paths; never import those files again. retry_save with the same jobId and stable requestId saves retained local outputs without invoking a model. Composition editing is separate. Use resume with the original jobId and a stable requestId to check a failed/interrupted Cloud task or account image task with a known remoteId, without uploading inputs or submitting another paid generation. Cancelled jobs and confirmed remote failures cannot resume. Use retry_save only for retained local outputs (savePending); regeneration is a separate paid request requiring authorization. Studio offers Check original task for Cloud jobs and Continue download for account images. Account image recovery reuses the original prompt/model and remote task; draft edits apply only to a new generation. Partial files resume only with verified asset identity, local checksum and strong ETag; otherwise the same image downloads from zero. Account video/audio recovery is not supported. Reference counts follow the selected model before any reference file is read; there is no fixed library count ceiling. Local Codex/account editing remains one image, video remains one first frame, and project referenceAsset remains image-only. No automatic paid fallback or resubmission.',
    inputSchema: object({ action: { enum: ['inspect', 'reference', 'models', 'generate', 'status', 'cancel', 'retry_save', 'resume'], description: 'inspect returns provider setup state and reference URIs; reference returns the selected provider guide; models discovers capabilities; generate submits a job; status reads that original job; cancel requests cancellation; retry_save retries only local saving; resume rechecks the original eligible failed Cloud task without another generation.' }, provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$', description: 'Required for reference and generate; optional provider filter for models. Read this provider reference before constructing model queries or generation inputs.' },
      projectId, requestId: id, jobId: id, model: { type: 'string', minLength: 1, maxLength: 180 }, modality: { enum: ['image', 'video', 'audio'] },
      referenceAsset: { type: 'string', minLength: 1, maxLength: 1024, description: 'Optional project-relative PNG/JPEG/WebP under 2 MiB for OpenDesign account/Cloud, or under 20 MB for other local adapters. Requires an image model with supportsImageReference. Snapshotted when queued; never changes the original image.' },
      mode: { enum: ['text-to-image', 'text-to-video', 'text-to-audio', 'text-to-speech'] }, prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      parameters: { type: 'object', additionalProperties: true }, refresh: { type: 'boolean' }, query: { type: 'string', maxLength: 200 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['action']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'openmotion_list_templates', title: 'OpenMotion · List Templates', description: 'Index templates from the loaded local repository; NPM installations without repository catalog files read the latest OpenMotion hosted `main` catalog, while explicit CMS mode uses the configured publication. Returns source, indexPath (local JSONL, one summary per template), total and catalogVersion, not search results. Read or grep/jq the file to select a template, then call openmotion_get_template. Rows with shortForm=true are portrait works or original short video posts. Repository summaries include localSource paths and hosted entries do not expose local paths. No query or pagination arguments. ' + templateDiscoveryGuide, inputSchema: object({}), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_get_template', title: 'OpenMotion · Get Template', description: 'Read one exact template ID and its TEMPLATE.md guidance. Library Skill IDs are rejected; read them with openmotion_get_skill. Repository entries include localSource absolute paths and local motionDocument content; hosted catalog entries return motionDocument without localSource paths. Built-in examples resolve locally without a catalog request. Guidance-only examples remain distinct from editable Studio projects. Follow the returned workflowGuide: template means openmotion_create_project with projectType=template copies the editable project; recreate means openmotion-recreate rebuilds from the guidance package and its linked reference video. An explicit guideDraft can instead create this entry’s declared title/accent motion example; this does not reconstruct its reference film or change the default workflowGuide. Known IDs do not require listing first.', inputSchema: object({ templateId: id, copyAttemptId: { type: 'string', pattern: copyAttemptPattern, description: 'Optional original copy UUID from the copied instruction. Preserve it on retries; never generate or infer it.' }, templateEntry: { enum: templateEntries, description: 'Optional original template copy surface. Pass only the value explicitly supplied in the instruction.' } }, ['templateId']), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_list_skills', title: 'OpenMotion · List Skills', description: 'Index every library video Skill (for example de-AI copy, growth teardown, long-to-short), whether or not it is installed locally, to find a technique by scenario. Repository checkouts read library/skills; NPM installations without the repository read the latest hosted `main` catalog; CMS mode returns no Skills. Returns source, indexPath (local JSONL, one row per Skill with skillId, title, description, tags and optional repository/license/localSource), total and skillVersion, not search results. Read or grep/jq the file, then call openmotion_get_skill. No query or pagination arguments. ' + skillDiscoveryGuide, inputSchema: object({}), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_get_skill', title: 'OpenMotion · Get Skill', description: 'Read one exact library Skill ID. Returns the complete SKILL.md in instructions and motionDocument.content plus a relative file inventory. Repository entries include the absolute localSource directory; hosted entries list objects[] with path, bytes, sha256 and a content-addressed URL instead of local paths, so download only the files SKILL.md references and verify them. Follow the instructions and create a natural_language project when needed; a Skill is not a template and cannot be applied or copied as one. Known IDs do not require listing first.', inputSchema: object({ skillId: id }, ['skillId']), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_create_project', title: 'OpenMotion · Create Project', description: 'Create an independent editable native OpenMotion project from a prompt, an editable template ID or reference-video ID. The host Agent authors the film; creation does not generate a finished video. Persist requirements, namingLanguage and source, return project/session IDs and the initial content version. A requestId is required for safe retries.',
    inputSchema: object({ requestId: id, projectType: { enum: ['natural_language', 'template', 'reference_video'] }, title: { type: 'string', minLength: 1, maxLength: 100 }, requirements: text, namingLanguage: { type: 'string', minLength: 2, maxLength: 50, description: 'BCP 47 language for newly assigned asset names. Choose explicit user preference, otherwise initial brief language, otherwise interface language. Saved once; existing meaningful names remain unchanged.' },
      sessionId: projectId, templateId: id, guideDraft: { ...templateGuideDraftSchema, description: 'Optional title and accent for this catalog entry’s own authored motion-guide example. Creates that canvas example with native Variables, not a reconstruction of its reference film. Requires projectType=template and templateId.' }, referenceVideoId: id, referenceUrl: { type: 'string', maxLength: 2000 } }, ['requestId', 'projectType', 'title', 'requirements']), annotations: write },
  { name: 'openmotion_open_preview', title: 'OpenMotion · Open Preview', description: 'Manage preview handoff, authoring work rounds, and workspace pages. Required fields by action: open (default) with target=project requires projectId or sessionId (never pass target=explore|templates|providers together with projectId/sessionId/workId/requestId/expectedRevision/expectedVersionId); begin requires projectId, requestId, mode=create|modify; complete_generation requires projectId, requestId, workId, expectedRevision, expectedVersionId; record_display requires projectId, requestId, display; record_review requires projectId, requestId, review. For video production, action=begin creates a business work round silently before authoring. No production or editor action mounts an inline component. Open the editor only after the final authored video is ready for preview; after MP4 verification, prefer the host-native video preview (Codex: one final-reply embed). Use the separately discovered openmotion_show_video only if the host cannot preview the video; never combine both players for the same export. Once the requested video artifact exists, call action=complete_generation with workId, expectedRevision and expectedVersionId. Carry its workId through saves and the final export; begin does not open Studio or render. Explicit editor-only requests, unchanged template browsing and review flows do not begin a round. Omit unused optional fields rather than sending null.',
    inputSchema: object({ target: { enum: ['project', 'explore', 'templates', 'providers'], description: 'Defaults to "project". Use "explore" for installation onboarding, "templates" for explicit template browsing, or "providers" for provider setup; use these only with action="open" (no project/session/work/version/request fields).' }, action: { enum: ['open', 'record_review', 'record_display', 'begin', 'complete_generation'], description: 'Defaults to "open". Choose "begin" before authoring a video, "complete_generation" when finished, "open" to obtain previewUrl/handoff, "record_display" after verifying preview visibility, "record_review" to record playback inspection.' }, mode: { enum: ['create', 'modify'], description: 'Required when action="begin". Use "create" for new videos or "modify" after feedback/export.' }, generation: { type: 'boolean', description: 'Begin defaults to a generation attempt. Set false only for export-only playback of already accepted content.' }, projectId, sessionId: projectId, workId: { ...workId, description: 'Work round UUID returned by action="begin" (inlineWork.id).' }, embedded: { type: 'boolean' }, presentation, entry: providerEntry, expectedRevision: revision, expectedVersionId: id, requestId: id, review, display }, []), annotations: write },
  { name: 'openmotion_import_assets', title: 'OpenMotion · Import Assets', description: 'Persist a batch of real local attachments into this project, at most 500 MB (500000000 bytes) per file. Probe media or parse TTF/OTF/TTC/WOFF fonts and return per-item asset IDs, types, sizes, paths and errors. Fonts include actual family/weight/style and project-relative @font-face CSS; an optional licensePath is copied in the same version. Successful items survive other failures. Existing history is not overwritten. Import does not place media on the timeline. Reuse the same requestId/itemId to retry without duplicate assets.',
    inputSchema: object({ projectId, requestId: id, items: { type: 'array', minItems: 1, maxItems: 100, items: object({ itemId: id, sourcePath: { type: 'string', minLength: 1, maxLength: 4096 }, licensePath: { type: 'string', minLength: 1, maxLength: 4096, description: 'Optional absolute path to the font license text; it must sit in the same directory as the font file, otherwise the item fails with FONT_LICENSE_NOT_BESIDE_FONT. Copied with a font only.' }, name: { type: 'string', maxLength: 200, description: 'Readable display name. Preserve meaningful source names; name generated or unnamed assets by content and optional purpose in the project namingLanguage. Never use UUIDs or the full generation prompt.' } }, ['itemId', 'sourcePath']) } }, ['projectId', 'requestId', 'items']), annotations: write },
  { name: 'openmotion_get_project', title: 'OpenMotion · Get Project', description: 'Without projectId list projects in the current workspace, newest creation first, exactly five per page (except the last); use nextCursor. Set trashed=true to list projects in Trash instead. With projectId read that project, current revision/version, requirements, native file inventory, asset references and associated export state. file supports bounded UTF-8 reads; exportJobId reads a historical task. With workId read one fixed work round; includeVideo=true returns its verified media privately to the component. This does not switch Studio or create projects.',
    inputSchema: object({ projectId, sessionId: projectId, trashed: { type: 'boolean' }, cursor: { type: 'string', maxLength: 2000 }, file: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 2097152 } }, ['path']), expectedRevision: revision, exportJobId: id, workId, includeVideo: { type: 'boolean' } }, []), annotations: read },
  { name: 'openmotion_edit_project', title: 'OpenMotion · Edit Project', description: 'Optional canvas changes a native composition to a preset ratio with contain (letterbox) or cover (center crop), without stretching. Existing authored content stays grouped at its original design size; subsequent ratio changes reuse it. Supply files and/or canvas with expectedRevision and expectedVersionId. Save the host Agent\'s native text-file batch, optional assetNames display metadata and namingLanguage into the explicitly named project. Check both expectedRevision and expectedVersionId, commit all files or none, protect GUI writes, record one complete content version and let Studio refresh. Production saves with workId defer editor presentation until the final video is ready. Every save returns a version-bound previewHandoff: preserve the current chat by default, queue when inactive and confirm the latest content on return. An accepted queued preview may be reported as saved and waiting for return. Only an explicit show-now request permits presentation=now for this turn; background skips presentation. The service does not generate code. Read project/version again after conflicts.',
    inputSchema: object({ canvas: object({ compositionPath: { type: 'string', minLength: 1, maxLength: 240 }, ratio: { enum: canvasPresets.map(item => item.ratio) }, fit: { enum: ['contain', 'cover'] } }, ['compositionPath', 'ratio', 'fit']), projectId, requestId: id, workId, expectedRevision: revision, expectedVersionId: id, presentation, requirements: text, summary: { type: 'string', maxLength: 300 },
      namingLanguage: { type: 'string', minLength: 2, maxLength: 50, description: 'Set a missing project naming language; change an existing value only on explicit user request. Does not translate existing names.' },
      assetNames: { type: 'array', maxItems: 100, items: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['path', 'name']), description: 'Metadata-only display names for existing media or fonts. Paths, IDs and composition references stay unchanged. Explicit renames or missing-name repairs only.' },
      files: { type: 'array', maxItems: 100, items: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, content: { type: 'string' } }, ['path', 'content']) } }, ['projectId', 'requestId', 'expectedRevision', 'expectedVersionId']), annotations: write },
  { name: 'openmotion_export_request', title: 'OpenMotion · Export Request', description: 'Queue a background MP4 of the explicit project version and immutable source/media snapshot. Optional compositionPath exports an existing scene instead of index.html. Automatically lint and fully technically verify the result. Return jobId; read progress/results with openmotion_get_project exportJobId. Export does not open the editor or complete an outstanding editable-preview handoff; follow openmotion_open_preview separately for creation/edit delivery. Repeated requestId returns the original task. action=record_review only records actual playback/visual/audio evidence for an existing job; it never starts another render.',
    inputSchema: object({ action: { enum: ['request', 'record_review'] }, projectId, requestId: id, workId, expectedRevision: revision, versionId: id, jobId: id,
      compositionPath: { type: 'string', minLength: 1, maxLength: 240, description: 'Optional existing HTML composition to export; defaults to index.html. Uses the same immutable project snapshot and native render engine.' }, audio: { enum: ['required', 'silent', 'optional'] }, review }, ['projectId', 'requestId']), annotations: write },
  { name: 'openmotion_list_versions', title: 'OpenMotion · List Versions', description: 'List consistent project content snapshots, not individual file save counts. Return current-version identity and five snapshots per page with a cursor for older pages, including stable IDs, vN labels, source, summary and restorability. Five is a page size, not a retention limit.',
    inputSchema: object({ projectId, cursor: { type: 'string', maxLength: 2000 } }, ['projectId']), annotations: read },
  { name: 'openmotion_restore_version', title: 'OpenMotion · Restore Version', description: 'Restore the explicitly selected project snapshot as a NEW version. Restoring v3 while current is v5 produces v6 with v3 content; v4 and v5 remain. Check current version/revision, restore native source, styles, timing and retained media together, and reject missing historical resources without changing the current project. Returns the same previewHandoff as a source edit; explicit background requests use presentation=background.',
    inputSchema: object({ projectId, requestId: id, versionId: id, expectedRevision: revision, expectedVersionId: id, presentation }, ['projectId', 'requestId', 'versionId', 'expectedRevision', 'expectedVersionId']), annotations: write },
  { name: 'openmotion_export_cancel', title: 'OpenMotion · Export Cancel', description: 'Cancel the specified export owned by this project. Distinguish cancellation accepted/cancelling from a confirmed cancelled terminal state. A completed task stays completed. Cancellation does not restore source, delete older results or promise a refund. Stopping a host conversation does not automatically call this tool.',
    inputSchema: object({ projectId, requestId: id, jobId: id }, ['projectId', 'requestId', 'jobId']), annotations: write },
  ...designTools,
];

// Increment for incompatible request/response semantics; optional fields and new Tools are additive.
export const phase1McpCapabilities = { protocol: 1, tools: phase1Tools.map(tool => tool.name) };

export function phase1TransportTool(health: { mcp?: { protocol?: unknown; tools?: unknown } }, tool?: string): string | undefined {
  const name = publicToolName(tool);
  if (typeof name !== 'string' || !phase1McpCapabilities.tools.includes(name)
    || health.mcp?.protocol !== phase1McpCapabilities.protocol || !Array.isArray(health.mcp.tools)) return;
  // Newer domain tools require explicit host/service advertisement rather than legacy aliases.
  if (['openmotion_assets_use', 'openmotion_capability_discover', 'openmotion_capability_run', 'openmotion_job_manage', 'openmotion_asset_manage'].includes(name)) {
    return health.mcp.tools.includes(name) ? name : undefined;
  }
  return [name, legacyToolName(name)].find(candidate => (health.mcp!.tools as unknown[]).includes(candidate));
}

export function supportsPhase1Tool(health: { mcp?: { protocol?: unknown; tools?: unknown } }, tool?: string): boolean {
  return phase1TransportTool(health, tool) !== undefined;
}

function allowsNullValue(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  return Array.isArray(schema.type) && schema.type.includes('null');
}

export function normalizeToolInput<T = unknown>(schema: any, value: T): T {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) return value;
  if (schema.oneOf) {
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    const variants: any[] = schema.oneOf;
    const discriminator = ['action', 'command', 'operation'].find(key =>
      variants.every(variant => variant.properties?.[key]?.enum?.length === 1));
    if (!discriminator) return value;
    const rawCommand = (value as Record<string, unknown>)[discriminator];
    const command = typeof rawCommand === 'string' ? rawCommand.trim() : rawCommand;
    const selected = variants.find(variant => variant.properties[discriminator].enum[0] === command);
    if (!selected) return value;
    const adjusted = typeof rawCommand === 'string' && command !== rawCommand
      ? Object.defineProperty({ ...value }, discriminator, { value: command, enumerable: true, writable: true, configurable: true })
      : value;
    return normalizeToolInput(selected, adjusted) as T;
  }
  if (schema.type === 'string' || Array.isArray(schema.enum)) {
    if (typeof value !== 'string') return value;
    let next: string = value;
    if (schema.enum || schema.pattern) next = next.trim();
    if (typeof schema.pattern === 'string' && schema.pattern.includes('[a-f0-9]')) next = next.toLowerCase();
    return next as unknown as T;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || !schema.items) return value;
    return value.map(item => normalizeToolInput(schema.items, item)) as unknown as T;
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hasKnown = Boolean(schema.properties && Object.hasOwn(schema.properties, key));
      const propSchema = hasKnown
        ? schema.properties[key]
        : (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      if (!hasKnown && !propSchema) {
        // Preserve unknown and prototype-named own keys so validateInput rejects them.
        Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
        continue;
      }
      const isRequired = required.has(key);
      if ((child === null || child === undefined) && !isRequired && !allowsNullValue(propSchema)) continue;
      if (!isRequired && typeof child === 'string' && child.trim() === ''
        && ((propSchema?.type === 'string' && ((propSchema.minLength ?? 0) >= 1 || propSchema.pattern))
          || (Array.isArray(propSchema?.enum) && !propSchema.enum.includes('')))) {
        continue;
      }
      const normalized = normalizeToolInput(propSchema, child);
      if (!isRequired && (normalized === null || normalized === undefined) && !allowsNullValue(propSchema)) continue;
      Object.defineProperty(out, key, { value: normalized, enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}

function describeExpectedPattern(pattern: string): string {
  if (pattern === '^(project|[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$') {
    return 'must be "project" or a lowercase UUID';
  }
  if (pattern === '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') {
    return 'must be a UUID';
  }
  if (pattern === '^[a-f0-9]{64}$') {
    return 'must be a 64-character lowercase hex revision hash';
  }
  return `must match ${pattern}`;
}

export function validateInput(schema: any, value: any, field = 'arguments', knownField = 'arguments'): void {
  const childField = (key: string) => knownField === 'arguments' ? key : knownField === 'unknown_field' ? knownField : knownField + '.' + key;
  if (schema.oneOf) {
    const variants: any[] = schema.oneOf;
    const failures = variants.map(variant => {
      try { validateInput(variant, value, field, knownField); return undefined; }
      catch (error) { if (error instanceof ToolInputError) return error; throw error; }
    });
    const valid = failures.filter(error => !error).length;
    if (valid !== 1) {
      const discriminator = ['action', 'command', 'operation'].find(key =>
        variants.every(variant => variant.properties?.[key]?.enum?.length === 1));
      const allowedCommands = discriminator ? variants.map(v => v.properties[discriminator].enum[0]).join(', ') : '';
      const message = allowedCommands
        ? `${field} must match one ${discriminator} (${allowedCommands}) and its required fields`
        : field + ' must match one action and its required fields';
      if (variants.every(variant => variant.type === 'object') && (!value || typeof value !== 'object' || Array.isArray(value))) {
        throw new ToolInputError(message, knownField, 'invalid_type');
      }
      if (!discriminator) throw new ToolInputError(message, knownField, 'invalid_combination');
      const command = value?.[discriminator];
      if (command === undefined) throw new ToolInputError(`${field}.${discriminator} is required (${allowedCommands})`, childField(discriminator), 'missing');
      if (valid > 1) throw new ToolInputError(message, knownField, 'invalid_combination');
      const selected = variants.findIndex(variant => variant.properties[discriminator].enum[0] === command);
      if (selected < 0) {
        throw new ToolInputError(`${field}.${discriminator} must be one of [${allowedCommands}]`, childField(discriminator), 'invalid_enum');
      }
      const failure = failures[selected];
      const detailMessage = failure?.message ? failure.message.replace(/^INVALID_ARGUMENT:\s*/, '') : message;
      throw new ToolInputError(detailMessage, failure?.invalid_field ?? childField(discriminator), failure?.validation_rule ?? 'invalid_enum');
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolInputError(`${field} must be one of [${schema.enum.join(', ')}]`, knownField, 'invalid_enum');
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError(field + ' must be an object', knownField, 'invalid_type');
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        const enumHint = Array.isArray(schema.properties?.[key]?.enum) ? ` (${schema.properties[key].enum.join(', ')})` : '';
        throw new ToolInputError(field + '.' + key + ' is required' + enumHint, childField(key), 'missing');
      }
    }
    const allowedKeys = Object.keys(schema.properties ?? {});
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateInput(schema.properties[key], child, field + '.' + key, childField(key));
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateInput(schema.additionalProperties, child, field + '.' + key, 'unknown_field');
      } else if (schema.additionalProperties !== true) {
        const hint = allowedKeys.length && allowedKeys.length <= 14 ? `; allowed keys: ${allowedKeys.join(', ')}` : '';
        throw new ToolInputError('unknown ' + field + '.' + key + hint, 'unknown_field', 'unknown_field');
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolInputError(field + ' must be an array', knownField, 'invalid_type');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      throw new ToolInputError(`${field} length must be ${schema.minItems ?? 0}..${schema.maxItems ?? 'unlimited'}`, knownField, 'out_of_range');
    }
    value.forEach((item, i) => validateInput(schema.items, item, field + '[' + i + ']', knownField === 'unknown_field' ? knownField : knownField + '[]'));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolInputError(field + ' must be a string', knownField, 'invalid_type');
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) {
      throw new ToolInputError(`${field} length must be ${schema.minLength ?? 0}..${schema.maxLength ?? 'unlimited'}`, knownField, 'out_of_range');
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new ToolInputError(`${field} ${describeExpectedPattern(schema.pattern)}`, knownField, 'invalid_format');
    }
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new ToolInputError(field + ' must be a boolean', knownField, 'invalid_type');
  else if (['number', 'integer'].includes(schema.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new ToolInputError(`${field} must be a${schema.type === 'integer' ? 'n integer' : ' finite number'}`, knownField, 'invalid_type');
    }
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) {
      throw new ToolInputError(`${field} must be between ${schema.minimum ?? '-Infinity'} and ${schema.maximum ?? 'Infinity'}`, knownField, 'out_of_range');
    }
  }
}

/** Presentation is separate from business operations so authoring never mounts an App. */
export const finalVideoTool = {
  name: 'openmotion_show_video', title: 'OpenMotion · Final Video',
  description: 'Optional fallback player for a final completed, technically verified MP4. Prefer the host-native video preview; Codex defaults to one final-reply video embed and does not need this Tool. Use only when native preview is unavailable. Never combine this player with a native embed of the same export. When selected, call once after export completes, never during generation or editing. This read-only presentation creates no project, work round, render or editor page. Keep workId from the silent openmotion_open_preview(action=begin) through saves and export. Old final videos remain bound to their own immutable export. A ready editable Studio handoff is separate; use only discovered Tools.',
  inputSchema: object({ projectId, workId }, ['projectId', 'workId']), annotations: read,
  _meta: { ui: { resourceUri: inlineVideoUri }, 'openai/ui': { preferredModelDisplayMode: 'inline' } },
};
