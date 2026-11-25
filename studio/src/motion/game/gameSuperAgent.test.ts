import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameProjects } from '../../../../game-projects';
import { isReadyBuiltInTemplate, type GameCard } from '../../../../shared/game-contract';
import { isPlayableAdArtifact } from '../../../../shared/super-agent';
import { canChoosePlayableAd, DEFAULT_MODE_COMPOSER_OPTIONS, effectiveGameOrientation, isPlayableAd, withoutImplicitPlayableAd } from '../../super-agent/ModeComposerControls';
import {
  buildDirectGamePrompt,
  buildGameHiddenInstructions,
  GAME_STUDIO_QUICK_IDEAS,
  matchesDefaultGameDescription,
  readDirectGameBrief,
  toGameArtifact,
} from './gameSuperAgent';

const game = (patch: Partial<GameCard> = {}): GameCard => ({
  id: 'g1', title: 'Coin Cascade', description: 'Pull pins', genre: 'casual', style: '3d', setting: null, multiplayer: false, maxPlayers: 1,
  orientation: 'portrait', status: 'draft', cover: null, playUrl: '/api/games/g1/play/index.html', plays: 0, likes: 0, dislikes: 0,
  reaction: 0, favorite: false, source: 'mine', remixOf: null, controls: '', ...patch,
} as GameCard);

describe('playable ads in Super Agent', () => {
  it('counts only portrait briefs with the ad option on', () => {
    expect(isPlayableAd({ gameOrientation: 'portrait', gamePlayableAd: true })).toBe(true);
    expect(isPlayableAd({ gameOrientation: 'landscape', gamePlayableAd: true })).toBe(false);
    expect(isPlayableAd({ gameOrientation: 'portrait', gamePlayableAd: false })).toBe(false);
  });

  it('starts new briefs as a portrait money-making mini game, but not template remixes or follow-up edits', () => {
    const fresh = { gameOrientation: null, gamePlayableAd: true };
    expect(isPlayableAd(fresh)).toBe(true);
    expect(effectiveGameOrientation(fresh)).toBe('portrait');
    const community = game({ source: 'community', external: { url: 'https://x.test', author: 'a', postUrl: 'https://x.test/p', model: 'm', embeddable: true } });
    expect(isPlayableAd({ ...fresh, gameTemplate: community })).toBe(false);
    const followUp = withoutImplicitPlayableAd({ ...DEFAULT_MODE_COMPOSER_OPTIONS, gameOrientation: null, gamePlayableAd: true });
    expect(isPlayableAd(followUp)).toBe(false);
    expect(effectiveGameOrientation(followUp)).toBeNull();
    const explicit = withoutImplicitPlayableAd({ ...DEFAULT_MODE_COMPOSER_OPTIONS, gameOrientation: 'portrait', gamePlayableAd: true });
    expect(isPlayableAd(explicit)).toBe(true);
  });

  it('does not offer the ad option while a local template is selected, because remix copies it unchanged', () => {
    const base = { gameOrientation: 'portrait' as const, gamePlayableAd: true };
    expect(canChoosePlayableAd({ gameTemplate: game({ source: 'template' }) })).toBe(false);
    expect(isPlayableAd({ ...base, gameTemplate: game({ source: 'template' }) })).toBe(false);
    const community = game({ source: 'community', external: { url: 'https://x.test', author: 'a', postUrl: 'https://x.test/p', model: 'm', embeddable: true } });
    expect(isPlayableAd({ ...base, gameTemplate: community })).toBe(true);
  });

  it('tells the Super Agent turn to follow the playable-ad recipe while sharing unified media discovery and consent rules', () => {
    const adPrompt = buildDirectGamePrompt(game({ playableAd: true }), 'Build it');
    const normalPrompt = buildDirectGamePrompt(game(), 'Build it');
    expect(adPrompt).toContain('format=playable ad');
    expect(adPrompt).not.toContain('one self-contained HTML');
    expect(adPrompt).toContain('openmotion_media_use');
    expect(adPrompt).toContain('spend-consent');
    expect(normalPrompt).not.toContain('playable ad');
    expect(normalPrompt).toContain('openmotion_media_use');
    expect(toGameArtifact(game({ playableAd: true }), 'Coin Cascade').subtitle).toContain('Playable ad');
    expect(toGameArtifact(game({ playableAd: true }), 'Coin Cascade').playableAd).toBe(true);
    expect(isPlayableAdArtifact({ kind: 'game-project', subtitle: 'casual · Playable ad' })).toBe(true);
    expect(isPlayableAdArtifact({ kind: 'game-project', subtitle: 'casual · Game Studio' })).toBe(false);
  });

  it('recovers the user brief from the instructions Game Studio actually returns', async () => {
    const brief = '制作竖屏街机小游戏。\n支持快速重开。';
    const workspace = await mkdtemp(join(tmpdir(), 'openmotion-game-brief-'));
    try {
      const service = new GameProjects(workspace);
      const { game: created, agentInstruction: instruction } = await service.create({
        prompt: brief, genre: 'casual', style: 'pixel', setting: 'modern',
        multiplayer: false, orientation: 'portrait', playableAd: true,
      });
      const savedText = buildDirectGamePrompt(created, instruction);
      expect(savedText).not.toContain('inline in index.html');
      expect(savedText).not.toContain('loads nothing from the network');
      expect(savedText).toContain('openmotion_media_use');
      expect(readDirectGameBrief(savedText, created.id)).toBe(brief);
      expect(readDirectGameBrief(instruction, created.id)).toBe(brief);
      const remix = await service.remix(created.id);
      expect(readDirectGameBrief(buildDirectGamePrompt(remix.game, remix.agentInstruction), remix.game.id)).toBe(brief);

      const previousInstruction = instruction
        .replace(
          ` and openmotion_game_get(id=${created.id}). Brief: `,
          ` (or use your host's workflow reader if provided) and openmotion_game_get with id=${created.id}. Brief: `,
        )
        .replace(
          '\nBuild a single-player game. Ask for local-market publication consent only when missing.',
          '\nAsk whether to publish to the local market only when the decision is missing. Build a single-player game.',
        );
      expect(readDirectGameBrief(buildDirectGamePrompt(created, previousInstruction), created.id)).toBe(brief);

      const legacyInstruction = previousInstruction
        .replace(" (or use your host's workflow reader if provided)", '')
        .replace(
          'Ask whether to publish to the local market only when the decision is missing.',
          'Ask at most two short questions (multiplayer mode and local-market publication), only when missing.',
        );
      expect(readDirectGameBrief(buildDirectGamePrompt(created, legacyInstruction), created.id)).toBe(brief);
      const notes = '把画面改成暖色。';
      expect(readDirectGameBrief(buildDirectGamePrompt(created, instruction, notes), created.id)).toBe(notes);
      expect(readDirectGameBrief(savedText, 'other-game')).toBeUndefined();
      expect(readDirectGameBrief(brief, created.id)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('formats story genre as visual novel in handoffs and strips both visual novel and legacy story prefixes', async () => {
    const brief = '用一封封信讲完的分支悬疑故事';
    const workspace = await mkdtemp(join(tmpdir(), 'openmotion-game-vn-'));
    try {
      const service = new GameProjects(workspace);
      const { game: created, agentInstruction: instruction } = await service.create({
        prompt: brief, genre: 'story', style: 'anime', setting: 'retro',
        multiplayer: false, orientation: 'landscape',
      });
      expect(instruction).toContain('Brief: anime style, visual novel, retro setting.');
      const savedText = buildDirectGamePrompt(created, instruction);
      expect(savedText).toContain('genre=story (visual novel)');
      expect(readDirectGameBrief(savedText, created.id)).toBe(brief);
      const legacyStoryInstruction = instruction.replace('visual novel', 'story');
      expect(readDirectGameBrief(buildDirectGamePrompt(created, legacyStoryInstruction), created.id)).toBe(brief);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('offers a portrait single-player playable-ad quick idea', () => {
    const idea = GAME_STUDIO_QUICK_IDEAS.find(item => item.playableAd);
    expect(idea).toMatchObject({ orientation: 'portrait' });
  });

  it('builds host-agent inference instructions for built-in template remixes without leaking template copy or forcing rebuild', async () => {
    const templateCard = game({
      id: 'remixed-1',
      title: 'Jelly Ball Chain Pop',
      description: 'Trace glossy chains to pop clusters.',
      controls: 'Drag matching balls.',
      remixOf: 'ball-match',
      i18n: {
        'zh-CN': {
          title: '弹珠连线爆爆乐',
          description: '一指划过彩球连消。',
          controls: '按住相邻同色彩球拖动消除。',
        },
      },
    });
    expect(matchesDefaultGameDescription(templateCard, '一指划过彩球连消。')).toBe(true);
    expect(matchesDefaultGameDescription(templateCard, '把彩球换成小猫头像')).toBe(false);
    expect(isReadyBuiltInTemplate({ source: 'template', status: 'published' })).toBe(true);
    expect(isReadyBuiltInTemplate({ source: 'template', status: 'ready' })).toBe(true);
    expect(isReadyBuiltInTemplate({ source: 'template', status: 'draft' })).toBe(false);
    expect(isReadyBuiltInTemplate({ source: 'template', status: 'published', external: { url: 'https://x.test' } })).toBe(false);
    expect(isReadyBuiltInTemplate({ source: 'mine', status: 'published' })).toBe(false);

    const asIsPrompt = buildGameHiddenInstructions(templateCard, 'Base instruction.', '一指划过彩球连消。', {
      builtInTemplateRemix: true,
      hasUserPromptText: false,
      parameterOverrides: [],
      hasExtraAttachments: false,
      locale: 'zh-CN',
    });
    expect(asIsPrompt).not.toContain('Additional user notes:');
    expect(asIsPrompt).not.toContain('Proceed directly to building and testing');
    expect(asIsPrompt).toContain('No template parameters were overridden.');
    expect(asIsPrompt).toContain('The user did not write custom modification text in this turn.');
    expect(asIsPrompt).toContain('Display title: "弹珠连线爆爆乐"');
    expect(asIsPrompt).toContain('Controls: 按住相邻同色彩球拖动消除。');
    expect(asIsPrompt).toContain('openmotion_game_set_status(id="remixed-1", status="ready")');
    expect(asIsPrompt).toContain('openmotion_present_artifact(kind="game-project", projectId="remixed-1", title="弹珠连线爆爆乐")');
    expect(asIsPrompt).toContain('never mention templates, source copying, internal skills, or skipped checks');
    expect(asIsPrompt).toContain('On BOTH paths, open your final reply');

    const customPrompt = buildGameHiddenInstructions(
      templateCard,
      'Base instruction.',
      'Requested remix overrides: Style: Pixel art.\n把难度调高一倍',
      {
        builtInTemplateRemix: true,
        hasUserPromptText: true,
        parameterOverrides: ['Style: Pixel art'],
        hasExtraAttachments: true,
        locale: 'zh-CN',
      },
    );
    expect(customPrompt).toContain('Additional user notes: Requested remix overrides: Style: Pixel art.\n把难度调高一倍');
    expect(customPrompt).toContain('Explicit parameter overrides: Style: Pixel art');
    expect(customPrompt).toContain('The user wrote custom text in this turn');
    expect(customPrompt).toContain('attached extra workspace resources/files');

    // readDirectGameBrief also recovers briefs from built-in template remix instructions produced by GameProjects.
    const workspace = await mkdtemp(join(tmpdir(), 'openmotion-template-brief-'));
    try {
      const templatesDir = join(workspace, 'templates');
      const tplDir = join(templatesDir, 'ball-match');
      await mkdir(tplDir, { recursive: true });
      await writeFile(join(tplDir, 'game.json'), JSON.stringify({
        ...templateCard,
        id: 'ball-match',
        source: 'template',
        status: 'published',
        remixOf: null,
      }));
      await writeFile(join(tplDir, 'index.html'), '<!doctype html><title>Ball Match</title>');
      const service = new GameProjects(workspace, templatesDir);
      const remixed = await service.remix('ball-match');
      expect(readDirectGameBrief(remixed.agentInstruction, remixed.game.id)).toBe('Trace glossy chains to pop clusters.');
      const wrapped = buildDirectGamePrompt(remixed.game, remixed.agentInstruction, '把主角换成小猫', {
        builtInTemplateRemix: true,
        hasUserPromptText: true,
        locale: 'zh-CN',
      });
      expect(readDirectGameBrief(wrapped, remixed.game.id)).toBe('把主角换成小猫');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
