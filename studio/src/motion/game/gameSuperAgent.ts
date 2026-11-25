import { gameAssetInstructions, gameGenreLabels, gameGenres, gameSettings, gameStyles, stripGameBriefPromptSuffixes } from '../../../../shared/game-contract';
import type { CapabilityResourceRef } from '../../../../shared/capability-hub';
import type { GameCard, GameGenre, GameSetting, GameStyle } from '../../../../shared/game-contract';
import type { SuperAgentArtifact, SuperAgentContextTag, SuperAgentResourceAttachment } from '../../../../shared/super-agent';
import { coverUrl, genreLabels, settingLabels, styleLabels } from './gameCatalog';

export function gamePlayPath(id: string): string {
  return `/motion-api/games/${encodeURIComponent(id)}/play/index.html`;
}

function playerLabel(game: GameCard): string {
  return game.playableAd ? 'Playable ad' : game.multiplayer ? 'Multiplayer' : 'Single player';
}

export function isMultiplayerGameArtifact(artifact: Pick<SuperAgentArtifact, 'kind' | 'subtitle'>): boolean {
  return artifact.kind === 'game-project' && artifact.subtitle?.endsWith(' · Multiplayer') === true;
}

export function localizedGameTitle(game: GameCard, locale: string): string {
  return game.i18n?.[locale]?.title || game.title;
}

export function localizedGameDescription(game: GameCard, locale: string): string {
  return game.i18n?.[locale]?.description || game.description;
}

export function localizedGameControls(game: GameCard, locale: string): string {
  return game.i18n?.[locale]?.controls || game.controls || '';
}

export function matchesDefaultGameDescription(game: Pick<GameCard, 'description' | 'i18n'>, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === game.description.trim()) return true;
  if (game.i18n) {
    for (const loc of Object.values(game.i18n)) {
      if (loc?.description && trimmed === loc.description.trim()) return true;
    }
  }
  return false;
}

export function toGameCapabilityRef(game: GameCard, displayTitle: string): CapabilityResourceRef {
  return {
    kind: 'game-project',
    id: game.id,
    title: displayTitle,
    subtitle: `${game.genre} · ${playerLabel(game)}`,
    genre: game.genre,
    playUrl: gamePlayPath(game.id),
    ...(coverUrl(game) ? { coverUrl: coverUrl(game)! } : {}),
  };
}

export function toGameArtifact(game: GameCard, displayTitle: string): Partial<SuperAgentArtifact> {
  const isExternal = Boolean(game.external);
  return {
    id: `game:${game.id}`,
    kind: 'game-project',
    title: displayTitle,
    subtitle: game.external
      ? `${game.external.author} · ${game.external.model}`
      : `${game.genre} · ${game.playableAd ? 'Playable ad' : game.multiplayer ? 'Multiplayer' : 'Game Studio'}`,
    playableAd: game.playableAd === true,
    ...(isExternal ? {} : { projectId: game.id }),
    scenario: game.orientation === 'portrait' ? 'portrait' : 'landscape',
    revision: game.updatedAt,
    url: game.external ? game.external.url : gamePlayPath(game.id),
  };
}

export function toGameResourceAttachment(game: GameCard, displayTitle: string): SuperAgentResourceAttachment {
  return {
    kind: 'game-project',
    id: game.id,
    title: displayTitle,
    subtitle: `${game.genre} · ${playerLabel(game)}`,
    playableAd: game.playableAd === true,
    ...(coverUrl(game) ? { previewUrl: coverUrl(game)! } : {}),
  };
}

export function buildGameContextTags(
  game: Pick<GameCard, 'genre' | 'style' | 'setting' | 'orientation' | 'multiplayer'> & { playableAd?: boolean },
  t: (text: string) => string,
): SuperAgentContextTag[] {
  const tags: SuperAgentContextTag[] = [
    { kind: 'mode', label: t('Game'), icon: 'gamepad-line', tone: 'agent' },
    { kind: 'param', label: t(genreLabels[game.genre]) },
  ];
  if (game.style) tags.push({ kind: 'param', label: t(styleLabels[game.style]) });
  if (game.setting) tags.push({ kind: 'param', label: t(settingLabels[game.setting]) });
  tags.push({ kind: 'param', label: game.orientation === 'portrait' ? '9:16' : '16:9' });
  tags.push({
    kind: 'param',
    label: game.playableAd ? t('Ad-revenue game') : game.multiplayer ? t('Multiplayer') : t('Single player'),
  });
  return tags;
}

export function buildGameUserPrompt(game: GameCard, locale: string, userNotes?: string): string {
  const notes = userNotes?.trim();
  if (notes) return notes;
  const desc = localizedGameDescription(game, locale)?.trim();
  if (desc) return desc;
  const title = localizedGameTitle(game, locale)?.trim() || game.title;
  return locale.toLowerCase().startsWith('zh')
    ? `帮我制作小游戏「${title}」。`
    : `Build the game "${title}".`;
}

export type GameHiddenInstructionOptions = {
  /** True when the project was copied from a ready/published built-in local template. */
  builtInTemplateRemix?: boolean;
  /** True when the user supplied their own custom prompt text beyond the default template description. */
  hasUserPromptText?: boolean;
  /** Explicit parameter overrides chosen by the user that differ from the template defaults. */
  parameterOverrides?: string[];
  /** True when the user attached additional workspace files/assets/brand kits in this turn. */
  hasExtraAttachments?: boolean;
  /** Active UI locale, used to surface localized title/controls for instant delivery. */
  locale?: string;
};

export function buildGameHiddenInstructions(
  game: GameCard,
  instruction: string,
  userNotes?: string,
  options?: GameHiddenInstructionOptions,
): string {
  const layout = game.orientation === 'portrait' ? 'portrait 9:16 phone layout (390x844)' : 'landscape 16:9 widescreen layout';
  const trimmedNotes = userNotes?.trim();
  const extraNotes = trimmedNotes && !matchesDefaultGameDescription(game, trimmedNotes)
    ? `Additional user notes: ${trimmedNotes}`
    : '';
  const contextParts = [
    `genre=${game.genre === 'story' ? 'story (visual novel)' : game.genre}`,
    game.style ? `style=${game.style}` : '',
    game.setting ? `setting=${game.setting}` : '',
    `multiplayer=${game.multiplayer}`,
    `orientation=${layout}`,
    // The draft instruction already carries the ad recipe; repeating the format here keeps it visible in Super Agent turns.
    game.playableAd ? 'format=playable ad (follow the openmotion-game playable-ad recipe: first-frame play with a hand tutorial, short levels, win/fail end cards with a store CTA, one self-contained HTML)' : '',
  ].filter(Boolean);

  if (options?.builtInTemplateRemix) {
    const locale = options.locale || 'en';
    const displayTitle = localizedGameTitle(game, locale).trim() || game.title;
    const controls = localizedGameControls(game, locale).trim();
    const overrides = options.parameterOverrides?.filter(Boolean) ?? [];
    const turnSignals = [
      overrides.length > 0
        ? `Explicit parameter overrides: ${overrides.join(', ')} (treat as requested custom modifications).`
        : 'No template parameters were overridden.',
      options.hasUserPromptText
        ? 'The user wrote custom text in this turn — infer from its meaning whether they are requesting any custom changes to the game or simply asking to create/deliver it as-is.'
        : 'The user did not write custom modification text in this turn.',
      options.hasExtraAttachments
        ? 'The user also attached extra workspace resources/files — check whether they expect those assets or brand styling to be integrated into the game.'
        : '',
    ].filter(Boolean).join(' ');
    const readyMeta = [
      `Display title: ${JSON.stringify(displayTitle)}`,
      controls ? `Controls: ${controls}` : '',
    ].filter(Boolean).join('. ');
    return [
      instruction,
      extraNotes,
      `Game Studio context: ${contextParts.join(', ')}.${readyMeta ? ` ${readyMeta}.` : ''} Built-in template remix turn signals: ${turnSignals} If NO custom modifications are requested, deliver immediately without reading workflow docs, editing files, validating, playtesting, or capturing a cover: silently call openmotion_game_set_status(id="${game.id}", status="ready") and openmotion_present_artifact(kind="game-project", projectId="${game.id}", title=${JSON.stringify(displayTitle)}) without any pre-tool "opening preview" message. If custom modifications ARE requested, read the existing project files with openmotion_game_get / openmotion_game_read_file and edit them in place, verify the changes, and finish with openmotion_present_artifact(kind="game-project", projectId="${game.id}", title=${JSON.stringify(displayTitle)}). On BOTH paths, open your final reply in the user's language as the builder who just coded and finished the game for them (e.g. "《${displayTitle}》已为你制作完成……" / "I've built ${displayTitle} for you — ..."), never open with passive "opened the preview" or "updated" wording, never mention templates, source copying, internal skills, or skipped checks, and never fabricate unexecuted checks.`,
    ].filter(Boolean).join('\n\n');
  }

  const assetNote = game.playableAd || instruction.includes('openmotion_media_use') ? '' : ` ${gameAssetInstructions}`;
  const consentNote = game.playableAd ? '' : ' (except a single batched spend-consent check when priced media generation is planned)';
  return [
    instruction,
    extraNotes,
    `Game Studio context: ${contextParts.join(', ')}. Proceed directly to building and testing without unnecessary questions${consentNote}.${assetNote} Always finish by calling openmotion_present_artifact(kind="game-project", projectId="${game.id}") so the playable result opens in the Browser Artifact Viewer.`,
  ].filter(Boolean).join('\n\n');
}

export function buildDirectGamePrompt(
  game: GameCard,
  instruction: string,
  userNotes?: string,
  options?: GameHiddenInstructionOptions,
): string {
  return buildGameHiddenInstructions(game, instruction, userNotes, options);
}

const gameBriefGenreTokens = Array.from(new Set([
  ...gameGenres,
  ...Object.values(gameGenreLabels).map(label => label.toLowerCase()),
]));
const gameBriefOption = `(?:(?:${gameStyles.join('|')}) style|with multiplayer|${gameBriefGenreTokens.join('|')}|(?:${gameSettings.join('|')}) setting)`;
const gameBriefOptions = new RegExp(`^${gameBriefOption}(?:, ${gameBriefOption})*\\. `, 'i');

/** Show the brief from a stored Game Studio handoff without altering the original turn. */
export function readDirectGameBrief(text: string, gameId: string): string | undefined {
  const context = text.lastIndexOf('\n\nGame Studio context: ');
  const instructionEnd = context < 0 ? text.length : context;

  const builtInTemplatePrefix = `This workspace game ${gameId} is a remix game copied from a complete, playable built-in template (code, assets, cover, controls, and metadata are already in place). Brief: `;
  if (text.startsWith(builtInTemplatePrefix)) {
    const briefStart = builtInTemplatePrefix.length;
    const steps = text.lastIndexOf('\nFirst, infer from the user\'s message in this turn', instructionEnd);
    if (steps < briefStart) return;
    const notesMarker = '\n\nAdditional user notes: ';
    const notesStart = text.indexOf(notesMarker, steps);
    if (notesStart >= 0 && notesStart < context) return text.slice(notesStart + notesMarker.length, context).trim();
    const overrideStart = text.lastIndexOf('\nExplicit parameter overrides vs template defaults: ', steps);
    const briefEnd = overrideStart >= briefStart ? overrideStart : steps;
    const brief = stripGameBriefPromptSuffixes(text.slice(briefStart, briefEnd))
      .replace(gameBriefOptions, '')
      .trim();
    return brief || undefined;
  }

  const header = `game ${gameId} in this workspace. Read openmotion://workflow/game/start`;
  const prefix = ['build', 'remix']
    .map(action => `Use the openmotion-game Skill to ${action} ${header}`)
    .find(candidate => text.startsWith(candidate));
  if (!prefix) return;
  // Handoffs may include a parenthetical hint about the host's workflow reader and either current or legacy tool syntax.
  const briefMarkers = [
    ` and openmotion_game_get(id=${gameId}). Brief: `,
    ` and openmotion_game_get with id=${gameId}. Brief: `,
  ];
  let markerStart = -1;
  let briefStart = -1;
  for (const briefMarker of briefMarkers) {
    const idx = text.indexOf(briefMarker, prefix.length);
    if (idx >= 0 && /^(?: \([^()\r\n]*\))?$/.test(text.slice(prefix.length, idx))) {
      markerStart = idx;
      briefStart = idx + briefMarker.length;
      break;
    }
  }
  if (markerStart < 0 || briefStart < 0) return;
  const steps = Math.max(
    text.lastIndexOf('\nBuild a single-player game. Ask for local-market publication consent only when missing.', instructionEnd),
    text.lastIndexOf('\nAsk whether to publish to the local market only when the decision is missing.', instructionEnd),
    text.lastIndexOf('\nAsk at most two short questions (multiplayer mode and local-market publication)', instructionEnd),
  );
  if (steps < briefStart) return;

  const notesMarker = '\n\nAdditional user notes: ';
  const notesStart = text.indexOf(notesMarker, steps);
  if (notesStart >= 0 && notesStart < context) return text.slice(notesStart + notesMarker.length, context).trim();
  const brief = stripGameBriefPromptSuffixes(text.slice(briefStart, steps))
    .replace(gameBriefOptions, '')
    .trim();
  return brief || undefined;
}

export type GameQuickIdea = {
  title: string;
  genre: GameGenre;
  style: GameStyle | null;
  setting: GameSetting | null;
  orientation: 'landscape' | 'portrait';
  /** Portrait single-player ideas can start as a playable ad. */
  playableAd?: boolean;
  prompt: string;
};

export const GAME_STUDIO_QUICK_IDEAS: readonly GameQuickIdea[] = [
  {
    title: 'Retro pixel platformer',
    genre: 'platformer',
    style: 'pixel',
    setting: 'retro',
    orientation: 'landscape',
    prompt: 'Build a crisp pixel-art platformer with tight jump physics, hidden coins, hazards, and a dramatic boss arena.',
  },
  {
    title: 'Portrait one-tap arcade',
    genre: 'casual',
    style: 'minimal',
    setting: 'modern',
    orientation: 'portrait',
    prompt: 'Create an addictive 9:16 portrait one-tap arcade game playable with one thumb, instant restarts, and combo multipliers.',
  },
  {
    title: 'Pull-the-pin playable ad',
    genre: 'casual',
    style: '3d',
    setting: null,
    orientation: 'portrait',
    playableAd: true,
    prompt: 'Make a pull-the-pin coin playable ad: coins pour through ×2 and ×5 rings into a piggy bank, with a hand tutorial and a Play now end card.',
  },
  {
    title: 'Cyberpunk drift racer',
    genre: 'racing',
    style: '3d',
    setting: 'cyberpunk',
    orientation: 'landscape',
    prompt: 'Build a neon night-time 3D street racing game with smooth drifting, nitro boost pads, and lap time records.',
  },
];
