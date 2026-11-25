import { gameAssetInstructions, stripGameBriefPromptSuffixes } from '../../../../shared/game-contract';
import type { CapabilityResourceRef } from '../../../../shared/capability-hub';
import { gameGenres, gameSettings, gameStyles } from '../../../../shared/game-contract';
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
    label: game.playableAd ? t('Playable ad') : game.multiplayer ? t('Multiplayer') : t('Single player'),
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

export function buildGameHiddenInstructions(game: GameCard, instruction: string, userNotes?: string): string {
  const layout = game.orientation === 'portrait' ? 'portrait 9:16 phone layout (390x844)' : 'landscape 16:9 widescreen layout';
  const trimmedNotes = userNotes?.trim();
  const extraNotes = trimmedNotes && trimmedNotes !== game.description.trim()
    ? `Additional user notes: ${trimmedNotes}`
    : '';
  const contextParts = [
    `genre=${game.genre}`,
    game.style ? `style=${game.style}` : '',
    game.setting ? `setting=${game.setting}` : '',
    `multiplayer=${game.multiplayer}`,
    `orientation=${layout}`,
    // The draft instruction already carries the ad recipe; repeating the format here keeps it visible in Super Agent turns.
    game.playableAd ? 'format=playable ad (follow the openmotion-game playable-ad recipe: first-frame play with a hand tutorial, short levels, win/fail end cards with a store CTA, one self-contained HTML)' : '',
  ].filter(Boolean);
  const assetNote = game.playableAd || instruction.includes('openmotion_media_use') ? '' : ` ${gameAssetInstructions}`;
  const consentNote = game.playableAd ? '' : ' (except a single batched spend-consent check when priced media generation is planned)';
  return [
    instruction,
    extraNotes,
    `Game Studio context: ${contextParts.join(', ')}. Proceed directly to building and testing without unnecessary questions${consentNote}.${assetNote} Always finish by calling openmotion_present_artifact(kind="game-project", projectId="${game.id}") so the playable result opens in the Browser Artifact Viewer.`,
  ].filter(Boolean).join('\n\n');
}

export function buildDirectGamePrompt(game: GameCard, instruction: string, userNotes?: string): string {
  return buildGameHiddenInstructions(game, instruction, userNotes);
}

const gameBriefOption = `(?:(?:${gameStyles.join('|')}) style|with multiplayer|${gameGenres.join('|')}|(?:${gameSettings.join('|')}) setting)`;
const gameBriefOptions = new RegExp(`^${gameBriefOption}(?:, ${gameBriefOption})*\\. `);

/** Show the brief from a stored Game Studio handoff without altering the original turn. */
export function readDirectGameBrief(text: string, gameId: string): string | undefined {
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
  const context = text.lastIndexOf('\n\nGame Studio context: ');
  const instructionEnd = context < 0 ? text.length : context;
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
