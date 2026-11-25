import { Button } from 'open-design-ui/button';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  designScenarios,
  findDesignScenario,
  type DesignScenarioId,
} from '../../../shared/design-project';
import {
  gameGenres,
  gameSettings,
  gameStyles,
  type GameCard,
  type GameGenre,
  type GameSetting,
  type GameStyle,
} from '../../../shared/game-contract';
import type { GatewayStatus, Modality, Model } from '../../../shared/gateway';
import type { SuperAgentContextTag, SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { Popover } from '../components/ui/Popover';
import { Tooltip } from '../components/ui/Tooltip';
import { PlayableAdPreview } from './PlayableAdPreview';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import {
  genreCovers,
  genreLabels,
  genrePlaceholders,
  settingCovers,
  settingLabels,
  styleCovers,
  styleLabels,
} from '../motion/game/gameCatalog';
import { providerRank, providerReady } from '../motion/imageMenuModels';
import { ModelAvatar } from '../motion/settingsPrimitives';
import { useMediaCatalog } from '../motion/useMediaCatalog';
import { Toggle } from '../ui';
import {
  buildMediaHiddenDirective,
  migrateModelParameters,
  preferredAudioModelFilters,
  preferredImageModelFilters,
  preferredVideoModelFilter,
  resolveEffectiveMediaModel,
  resolveSubmittedMediaParameters,
  resolveSuperAgentModelSchema,
  type ModelFilter,
} from './modelParams';
import { ModelParameterPills, type ModelParamMenuKey } from './ModelParameterPills';
import type { SuperAgentCreationModeId, SuperAgentModeSpec } from './ModeResourceShowcase';
import type { ResourceCategoryTab } from './ResourcePickerDialog';

export type DesignModeFormat = 'html' | 'image';
export type DesignViewportTarget = 'responsive' | 'desktop' | 'tablet' | 'mobile';
export type ImageDesignScene = 'text-to-image' | 'image-edit' | 'remove-background' | 'relight' | 'image-blend';
export type ImageDesignStyle = 'auto' | 'photorealistic' | 'editorial' | '3d-render' | 'illustration' | 'poster' | 'minimalist';
export type ImageDesignLighting = 'auto' | 'studio' | 'natural' | 'dramatic' | 'neon' | 'warm';
export type ImageDesignBackground = 'auto' | 'transparent' | 'solid';
export type HtmlDesignStyle = 'auto' | 'minimal' | 'editorial' | 'saas' | 'bento' | 'brutalist';
export type HtmlDesignTheme = 'auto' | 'light' | 'dark' | 'both';
export type HtmlDesignInteraction = 'single' | 'multi-screen' | 'interactive';
export type HtmlDesignMotion = 'subtle' | 'expressive';
export type DocPaperFormat = 'a4' | 'letter' | 'report';
export type WebCloneFidelity = 'faithful' | 'brand-remix' | 'responsive-refresh';
export type LiveArtifactView = 'kpi' | 'charts' | 'table';
export type WebglSceneType = 'particles' | 'product-3d' | 'shader' | 'hero';
export type WebglInteractionType = 'pointer' | 'orbit' | 'scroll';
export type ResearchDeliverableFormat = 'report' | 'decision-room' | 'deck' | 'memo';
export type ResearchDepth = 'quick' | 'balanced' | 'deep';
export type VisualizationType = 'dashboard' | 'chart' | 'infographic' | 'diagram' | 'webgl';
export type VisualizationEngine = 'html-svg' | 'd3' | 'webgl';
export type VisualizationStyle = 'editorial' | 'minimal' | 'dark-terminal' | 'bento';

export type ModeComposerOptions = {
  // Design Studio (unified Image design + HTML Design)
  designFormat: DesignModeFormat;
  designScenario: DesignScenarioId;
  designViewport: DesignViewportTarget;
  designStyle: HtmlDesignStyle;
  designTheme: HtmlDesignTheme;
  designInteraction: HtmlDesignInteraction;
  designMotion: HtmlDesignMotion;
  deckSpeakerNotes: boolean;
  docPaper: DocPaperFormat;
  cloneFidelity: WebCloneFidelity;
  liveDataView: LiveArtifactView;
  webglScene: WebglSceneType;
  webglInteraction: WebglInteractionType;

  // Research a topic
  researchFormat: ResearchDeliverableFormat;
  researchDepth: ResearchDepth;
  researchVisuals: boolean;
  researchCitations: boolean;

  // Visualization
  vizType: VisualizationType;
  vizEngine: VisualizationEngine;
  vizStyle: VisualizationStyle;
  vizLiveData: boolean;

  // Image Artwork / Image design
  imageScene: ImageDesignScene;
  imageStyle: ImageDesignStyle;
  imageLighting: ImageDesignLighting;
  imageBackground: ImageDesignBackground;
  imageModelId: string;
  imageParams: Record<string, unknown>;
  imageAspect: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2';
  imageQuality: 'standard' | 'high';
  imageCount: 1 | 2 | 4;

  // Cinema Video (also supports switching directly to Motion graphics)
  mediaSubMode: 'video' | 'motion';
  videoModelId: string;
  videoParams: Record<string, unknown>;
  videoAspect: '16:9' | '9:16' | '1:1' | '21:9';
  videoDuration: '5s' | '8s' | '10s' | '15s';
  videoSpeed: 'fast' | 'standard' | 'cinema';

  // Audio & Sound
  audioModelId: string;
  audioType: 'music' | 'voiceover' | 'sfx';
  audioParams: Record<string, unknown>;
  audioDuration: '10s' | '30s' | '60s';

  // Motion Video (also supports switching directly to AI Video models like Seedance)
  motionEngine: 'motion' | 'video-model';
  motionAspect: '16:9' | '9:16' | '1:1' | '4:5';
  motionDuration: '10s' | '15s' | '20s' | '30s';
  motionFps: '30fps' | '60fps';
  motionStyle: 'kinetic' | 'product' | 'editorial' | 'minimal';

  // Slides & Docs
  deckFormat: 'slides' | 'document' | 'report';
  deckSlides: '5-7' | '8-12' | '12-16' | 'auto';
  deckDensity: 'visual' | 'balanced' | 'detailed';

  // Website & App
  webTarget: 'responsive' | 'mobile' | 'dashboard';
  webReferenceUrl: string;

  // Game Studio
  gameGenre: GameGenre | null;
  gameStyle: GameStyle | null;
  gameSetting: GameSetting | null;
  gameOrientation: 'landscape' | 'portrait' | null;
  /** Portrait only: build a playable ad. */
  gamePlayableAd: boolean;
  gameTemplate: GameCard | null;

  // Pure Coding
  codingWorkdir: string;
  codingFocus: 'general' | 'debug' | 'refactor' | 'test' | 'review';
};

/** A local template is copied as it is (remix takes only its id), so the ad option cannot apply to it. */
export function canChoosePlayableAd(options: Partial<Pick<ModeComposerOptions, 'gameTemplate'>>): boolean {
  return !options.gameTemplate || Boolean(options.gameTemplate.external);
}

/** A portrait, single-player game brief with the ad option on is built as a playable ad. */
export function isPlayableAd(options: Pick<ModeComposerOptions, 'gameOrientation' | 'gamePlayableAd'> & Partial<Pick<ModeComposerOptions, 'gameTemplate'>>): boolean {
  return options.gameOrientation === 'portrait' && options.gamePlayableAd && canChoosePlayableAd(options);
}

export const DEFAULT_MODE_COMPOSER_OPTIONS: ModeComposerOptions = {
  designFormat: 'image',
  designScenario: 'prototype',
  designViewport: 'responsive',
  designStyle: 'auto',
  designTheme: 'auto',
  designInteraction: 'interactive',
  designMotion: 'subtle',
  deckSpeakerNotes: true,
  docPaper: 'a4',
  cloneFidelity: 'faithful',
  liveDataView: 'kpi',
  webglScene: 'particles',
  webglInteraction: 'pointer',

  researchFormat: 'report',
  researchDepth: 'balanced',
  researchVisuals: true,
  researchCitations: true,

  vizType: 'dashboard',
  vizEngine: 'html-svg',
  vizStyle: 'editorial',
  vizLiveData: true,

  imageScene: 'text-to-image',
  imageStyle: 'auto',
  imageLighting: 'auto',
  imageBackground: 'auto',
  imageModelId: 'auto',
  imageParams: {},
  imageAspect: '16:9',
  imageQuality: 'standard',
  imageCount: 1,

  mediaSubMode: 'video',
  videoModelId: 'auto',
  videoParams: {},
  videoAspect: '16:9',
  videoDuration: '5s',
  videoSpeed: 'standard',
  audioModelId: 'auto',
  audioType: 'music',
  audioParams: {},
  audioDuration: '30s',

  motionEngine: 'motion',
  motionAspect: '16:9',
  motionDuration: '15s',
  motionFps: '30fps',
  motionStyle: 'kinetic',

  deckFormat: 'slides',
  deckSlides: '8-12',
  deckDensity: 'visual',

  webTarget: 'responsive',
  webReferenceUrl: '',

  gameGenre: null,
  gameStyle: null,
  gameSetting: null,
  gameOrientation: null,
  gamePlayableAd: false,
  gameTemplate: null,

  codingWorkdir: '',
  codingFocus: 'general',
};

const WEB_TARGET_LABELS: Record<ModeComposerOptions['webTarget'], string> = {
  responsive: 'Responsive Web',
  mobile: 'Mobile App',
  dashboard: 'Dashboard',
};

const DECK_FORMAT_LABELS: Record<ModeComposerOptions['deckFormat'], string> = {
  slides: 'Slides (16:9)',
  document: 'Document (A4)',
  report: 'Visual Report',
};

const DECK_DENSITY_LABELS: Record<ModeComposerOptions['deckDensity'], string> = {
  visual: 'Visual',
  balanced: 'Balanced',
  detailed: 'Detailed',
};

const MOTION_STYLE_LABELS: Record<ModeComposerOptions['motionStyle'], string> = {
  kinetic: 'Kinetic Type',
  product: 'Product Launch',
  editorial: 'Editorial',
  minimal: 'Minimal',
};

const AUDIO_TYPE_LABELS: Record<ModeComposerOptions['audioType'], string> = {
  music: 'Music',
  voiceover: 'Voiceover',
  sfx: 'Sound FX',
};

const CODING_FOCUS_LABELS: Record<ModeComposerOptions['codingFocus'], string> = {
  general: 'General coding',
  debug: 'Debug & fix',
  refactor: 'Refactor',
  test: 'Tests',
  review: 'Code review',
};

const DESIGN_VIEWPORT_LABELS: Record<DesignViewportTarget, string> = {
  responsive: 'Responsive',
  desktop: 'Desktop',
  tablet: 'Tablet',
  mobile: 'Mobile',
};

export const IMAGE_SCENE_CHOICES: readonly {
  id: ImageDesignScene;
  label: string;
  icon: string;
  description: string;
}[] = [
  { id: 'text-to-image', label: 'Text to image', icon: 'image-line', description: 'Generate original posters, hero visuals & artwork' },
  { id: 'image-edit', label: 'Image edit', icon: 'edit-line', description: 'Modify, restyle, or refine an attached reference image' },
  { id: 'remove-background', label: 'Remove background', icon: 'scissors-line', description: 'Isolate a crisp subject with transparent or clean backdrop' },
  { id: 'relight', label: 'Relight', icon: 'flashlight-line', description: 'Change lighting mood, direction & atmosphere cleanly' },
  { id: 'image-blend', label: 'Image blend', icon: 'group-line', description: 'Blend subjects, props, and references into one cohesive scene' },
];

const IMAGE_STYLE_LABELS: Record<ImageDesignStyle, string> = {
  auto: 'Auto',
  photorealistic: 'Photorealistic',
  editorial: 'Editorial',
  '3d-render': '3D Render',
  illustration: 'Illustration',
  poster: 'Poster',
  minimalist: 'Minimalist',
};

const IMAGE_LIGHTING_LABELS: Record<ImageDesignLighting, string> = {
  auto: 'Auto',
  studio: 'Studio',
  natural: 'Natural',
  dramatic: 'Dramatic',
  neon: 'Neon',
  warm: 'Warm',
};

const IMAGE_BACKGROUND_LABELS: Record<ImageDesignBackground, string> = {
  auto: 'Auto',
  transparent: 'Transparent',
  solid: 'Clean solid',
};

const HTML_DESIGN_STYLE_LABELS: Record<HtmlDesignStyle, string> = {
  auto: 'Auto',
  minimal: 'Minimal',
  editorial: 'Editorial',
  saas: 'SaaS Modern',
  bento: 'Bento',
  brutalist: 'Brutalist',
};

const HTML_DESIGN_THEME_LABELS: Record<HtmlDesignTheme, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
  both: 'Light & Dark',
};

const HTML_DESIGN_INTERACTION_LABELS: Record<HtmlDesignInteraction, string> = {
  single: 'Single view',
  'multi-screen': 'Multi-screen',
  interactive: 'Interactive app',
};

const HTML_DESIGN_MOTION_LABELS: Record<HtmlDesignMotion, string> = {
  subtle: 'Subtle',
  expressive: 'Expressive',
};

const DOC_PAPER_LABELS: Record<DocPaperFormat, string> = {
  a4: 'A4 Portrait',
  letter: 'Letter',
  report: 'Visual Report',
};

const CLONE_FIDELITY_LABELS: Record<WebCloneFidelity, string> = {
  faithful: 'Faithful clone',
  'brand-remix': 'Brand remix',
  'responsive-refresh': 'Responsive refresh',
};

const LIVE_DATA_VIEW_LABELS: Record<LiveArtifactView, string> = {
  kpi: 'KPI Dashboard',
  charts: 'Charts & Filters',
  table: 'Table & Drilldown',
};

const WEBGL_SCENE_LABELS: Record<WebglSceneType, string> = {
  particles: 'Particle field',
  'product-3d': '3D Product stage',
  shader: 'Fluid shader',
  hero: 'Interactive hero',
};

const WEBGL_INTERACTION_LABELS: Record<WebglInteractionType, string> = {
  pointer: 'Pointer',
  orbit: 'Orbit',
  scroll: 'Scroll',
};

export const RESEARCH_FORMAT_CHOICES: readonly {
  id: ResearchDeliverableFormat;
  label: string;
  icon: string;
  description: string;
}[] = [
  { id: 'report', label: 'Visual Report', icon: 'file-text-line', description: 'Editorial analysis report with charts, KPIs, and sources' },
  { id: 'decision-room', label: 'Decision Room', icon: 'layout-2-line', description: 'Interactive evidence ledger, confidence matrix, and tradeoffs' },
  { id: 'deck', label: 'Research Deck', icon: 'slideshow-line', description: 'Presentation slides synthesizing key findings and narrative' },
  { id: 'memo', label: 'Briefing Memo', icon: 'book-open-line', description: 'Crisp executive summary brief ready for PDF export' },
];

const RESEARCH_DEPTH_CHOICES: readonly {
  id: ResearchDepth;
  label: string;
  description: string;
}[] = [
  { id: 'quick', label: 'Quick brief', description: 'Fast executive synthesis highlighting the key takeaways' },
  { id: 'balanced', label: 'Balanced', description: 'Structured multi-source comparison with data tables' },
  { id: 'deep', label: 'Deep dive', description: 'Thorough investigation with full evidence and citations' },
];

export const VIZ_TYPE_CHOICES: readonly {
  id: VisualizationType;
  label: string;
  icon: string;
  description: string;
}[] = [
  { id: 'dashboard', label: 'KPI Dashboard', icon: 'grid-line', description: 'Multi-metric cockpit backed by interactive data filters' },
  { id: 'chart', label: 'Chart & Graph', icon: 'bar-chart-box-line', description: 'Custom interactive D3/SVG charts with tooltips and zoom' },
  { id: 'infographic', label: 'Infographic', icon: 'layout-2-line', description: 'Editorial visual story combining callouts and graphics' },
  { id: 'diagram', label: 'Diagram & Map', icon: 'route-line', description: 'Architecture flows, knowledge graphs, and visual maps' },
  { id: 'webgl', label: '3D & WebGL', icon: 'sparkling-line', description: 'GPU-accelerated spatial scenes and particle fields' },
];

const VIZ_ENGINE_LABELS: Record<VisualizationEngine, string> = {
  'html-svg': 'Interactive HTML & SVG',
  d3: 'D3.js',
  webgl: 'Canvas / WebGL',
};

const VIZ_STYLE_LABELS: Record<VisualizationStyle, string> = {
  editorial: 'Editorial NYT',
  minimal: 'Minimal Swiss',
  'dark-terminal': 'Dark Terminal',
  bento: 'Bento SaaS',
};

export function researchDesignScenario(format: ResearchDeliverableFormat): DesignScenarioId {
  if (format === 'deck') return 'deck';
  if (format === 'decision-room') return 'prototype';
  return 'document';
}

export function visualizationDesignScenario(type: VisualizationType): DesignScenarioId {
  if (type === 'webgl') return 'webgl';
  if (type === 'dashboard' || type === 'chart') return 'live-artifact';
  return 'prototype';
}

export function visualizationOptionsPatch(type: VisualizationType): Partial<ModeComposerOptions> {
  return {
    vizType: type,
    vizEngine: type === 'webgl' ? 'webgl' : type === 'chart' ? 'd3' : 'html-svg',
    vizLiveData: type === 'dashboard' || type === 'chart',
  };
}

export const DESIGN_VIEWPORT_CHOICES: readonly {
  id: DesignViewportTarget;
  label: string;
  icon: string;
  badge: string;
  description: string;
}[] = [
  {
    id: 'responsive',
    label: 'Responsive',
    icon: 'layout-line',
    badge: 'Fluid',
    description: 'Fluid layout across desktop & mobile',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: 'computer-line',
    badge: '1440px',
    description: '1440px widescreen desktop canvas',
  },
  {
    id: 'tablet',
    label: 'Tablet',
    icon: 'tablet-line',
    badge: '820×1180',
    description: '820×1180 tablet viewport',
  },
  {
    id: 'mobile',
    label: 'Mobile',
    icon: 'smartphone-line',
    badge: '390×844',
    description: '390×844 mobile phone frame',
  },
];

export function designScenarioOptionsPatch(scenario: DesignScenarioId): Partial<ModeComposerOptions> {
  if (scenario === 'mobile-app') {
    return { designFormat: 'html', designScenario: scenario, designViewport: 'mobile' };
  }
  if (scenario === 'deck') {
    return { designFormat: 'html', designScenario: scenario, deckFormat: 'slides' };
  }
  if (scenario === 'document') {
    return { designFormat: 'html', designScenario: scenario, deckFormat: 'document' };
  }
  return { designFormat: 'html', designScenario: scenario, designViewport: 'responsive' };
}

export type MediaPromptExtra = {
  routes?: GatewayStatus['routes'];
  providers?: GatewayStatus['providers'];
  hasInputImage?: boolean;
  attachedImageReferences?: { assetId: string; versionId: string }[];
};

function resolveImageWireParameters(
  imageScene: ImageDesignScene,
  schemaFields: readonly { standardKey?: string; key: string }[],
  submittedWire: Record<string, unknown>,
): { hasNativeBackground: boolean; wireParameters: Record<string, unknown> } {
  const hasNativeBackground = schemaFields.some(
    field => field.standardKey === 'background' || field.key === 'background',
  );
  const wireParameters = imageScene === 'remove-background'
    && hasNativeBackground
    && submittedWire.background === undefined
    ? { ...submittedWire, background: 'transparent' }
    : submittedWire;
  return { hasNativeBackground, wireParameters };
}

export function buildDesignHiddenDirective(
  options: ModeComposerOptions,
  mediaModels: Model[] = [],
  extra?: MediaPromptExtra,
): string {
  if (options.designFormat === 'image') {
    const imageFilter = preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage));
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      'image',
      options.imageModelId,
      imageFilter,
      extra?.providers,
    );
    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      options.imageParams,
      'image',
      Boolean(extra?.hasInputImage),
    );
    const { hasNativeBackground, wireParameters } = resolveImageWireParameters(
      options.imageScene,
      submitted.schema.fields,
      submitted.wireParameters,
    );
    const artNotes: string[] = [];
    if (options.imageStyle !== 'auto') artNotes.push(`style=${IMAGE_STYLE_LABELS[options.imageStyle]}`);
    if (options.imageLighting !== 'auto') artNotes.push(`lighting=${IMAGE_LIGHTING_LABELS[options.imageLighting]}`);
    if (!hasNativeBackground && options.imageBackground !== 'auto') {
      artNotes.push(`background=${IMAGE_BACKGROUND_LABELS[options.imageBackground]}`);
    }
    return buildMediaHiddenDirective({
      modality: 'image',
      effectiveModel,
      selectedModelId: options.imageModelId,
      wireParameters,
      hasInputImage: extra?.hasInputImage,
      attachedImageReferences: extra?.attachedImageReferences,
      sceneNote: options.imageScene !== 'text-to-image' ? `scene="${options.imageScene}"` : undefined,
      styleNotes: artNotes,
    });
  }

  const refUrl = options.webReferenceUrl.trim();
  const detailNotes: string[] = [];
  if (options.designStyle !== 'auto') detailNotes.push(`style=${HTML_DESIGN_STYLE_LABELS[options.designStyle]}`);
  if (options.designTheme !== 'auto') detailNotes.push(`theme=${HTML_DESIGN_THEME_LABELS[options.designTheme]}`);
  if (options.designScenario === 'prototype' || options.designScenario === 'mobile-app') {
    detailNotes.push(`scope=${HTML_DESIGN_INTERACTION_LABELS[options.designInteraction]}`);
    detailNotes.push(`motion=${HTML_DESIGN_MOTION_LABELS[options.designMotion]}`);
  } else if (options.designScenario === 'deck') {
    detailNotes.push(options.deckSpeakerNotes ? 'include speaker notes' : 'omit speaker notes');
  } else if (options.designScenario === 'document') {
    detailNotes.push(`pageFormat=${DOC_PAPER_LABELS[options.docPaper]}`);
  } else if (options.designScenario === 'web-clone') {
    detailNotes.push(`rebuildMode=${CLONE_FIDELITY_LABELS[options.cloneFidelity]}`);
  } else if (options.designScenario === 'live-artifact') {
    detailNotes.push(`dataView=${LIVE_DATA_VIEW_LABELS[options.liveDataView]}`);
  } else if (options.designScenario === 'webgl') {
    detailNotes.push(`webglScene=${WEBGL_SCENE_LABELS[options.webglScene]}`);
    detailNotes.push(`interaction=${WEBGL_INTERACTION_LABELS[options.webglInteraction]}`);
  }
  return `Design Studio HTML mode (scenario="${options.designScenario}"): read openmotion://workflow/design/start and the scenario guide via openmotion_design_catalog if needed; if a design-project is already attached or open in this conversation, edit that existing project directly with openmotion_design_edit(action="write") instead of creating a duplicate, otherwise create via openmotion_design_project(action="create", scenario="${options.designScenario}") and openmotion_design_edit(action="write")${detailNotes.length ? ` (${detailNotes.join(', ')})` : ''}${refUrl ? `, inspect reference URL ${refUrl} when adapting layout/brand` : ''}, and ensure openmotion_present_artifact(kind="design-project", projectId=...) is presented so it stays live in the Artifact Viewer.`;
}

export function buildModeHiddenDirective(
  mode: SuperAgentModeSpec,
  options: ModeComposerOptions,
  mediaModels: Model[] = [],
  extra?: MediaPromptExtra,
): string | undefined {
  if (mode.id === 'design') {
    return buildDesignHiddenDirective(options, mediaModels, extra);
  }
  if (mode.id === 'research') {
    const scenario = researchDesignScenario(options.researchFormat);
    const refUrl = options.webReferenceUrl.trim();
    const skillHint = options.researchFormat === 'decision-room'
      ? 'research-decision-room'
      : options.researchFormat === 'deck'
        ? 'frontend-slides'
        : 'data-report';
    return `Research a topic mode (deliverable="${options.researchFormat}", depth="${options.researchDepth}", scenario="${scenario}"): gather and verify facts from available tools, workspace files, or URLs without fabricating citations; inspect "${skillHint}" and the "${scenario}" guide via openmotion_design_catalog; build a clean, editorial-grade HTML artifact using openmotion_design_project(action="create", scenario="${scenario}") and openmotion_design_edit(action="write") (${options.researchVisuals ? 'include comparison matrices and data visualizations' : 'focus on crisp structured prose'}, ${options.researchCitations ? 'include explicit source attributions and confidence notes' : 'concise synthesis'}${refUrl ? `, incorporate reference URL ${refUrl}` : ''}); finish by calling openmotion_present_artifact(kind="design-project", projectId=...) so it opens in the Artifact Viewer.`;
  }
  if (mode.id === 'visualization') {
    const scenario = visualizationDesignScenario(options.vizType);
    const refUrl = options.webReferenceUrl.trim();
    const skillHint = options.vizEngine === 'd3' ? 'd3-visualization' : 'frame-data-chart-nyt';
    return `Visualization mode (type="${options.vizType}", engine="${options.vizEngine}", style="${VIZ_STYLE_LABELS[options.vizStyle]}", scenario="${scenario}"): consult "${skillHint}" and the "${scenario}" guide via openmotion_design_catalog; author a publication-grade interactive visualization using openmotion_design_project(action="create", scenario="${scenario}") and openmotion_design_edit(action="write") with clear typography, color-coded legends, interactive tooltips/filters${options.vizLiveData ? ', and a structured data.json file backing the charts' : ''}${refUrl ? `, grounded on reference URL ${refUrl}` : ''}; finish by calling openmotion_present_artifact(kind="design-project", projectId=...) so it opens in the Artifact Viewer.`;
  }
  if ((mode.id === 'motion' && options.motionEngine !== 'video-model') || (mode.id === 'media' && options.mediaSubMode === 'motion')) {
    return `Editable Motion graphics mode (aspect="${options.motionAspect}", duration="${options.motionDuration}", fps="${options.motionFps}", style="${MOTION_STYLE_LABELS[options.motionStyle]}"): read openmotion://workflow/production/start via openmotion_read_workflow if needed; if a motion-project is already attached or open in this conversation, inspect and edit that existing project directly via openmotion_edit_project instead of creating a duplicate, otherwise create via openmotion_create_project and edit HTML/CSS/GSAP files with openmotion_edit_project, and ensure openmotion_present_artifact(kind="motion-project", projectId=...) (or openmotion_open_preview) is presented so the Motion Studio Editor updates live in the Artifact Viewer.`;
  }
  if (mode.id === 'image') {
    const imageFilter = preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage));
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      'image',
      options.imageModelId,
      imageFilter,
      extra?.providers,
    );
    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      options.imageParams,
      'image',
      Boolean(extra?.hasInputImage),
    );
    const { wireParameters } = resolveImageWireParameters(
      options.imageScene,
      submitted.schema.fields,
      submitted.wireParameters,
    );
    return buildMediaHiddenDirective({
      modality: 'image',
      effectiveModel,
      selectedModelId: options.imageModelId,
      wireParameters,
      hasInputImage: extra?.hasInputImage,
      attachedImageReferences: extra?.attachedImageReferences,
      sceneNote: options.imageScene !== 'text-to-image' ? `scene="${options.imageScene}"` : undefined,
    });
  }
  if ((mode.id === 'media' && options.mediaSubMode === 'video') || (mode.id === 'motion' && options.motionEngine === 'video-model')) {
    const videoFilter = preferredVideoModelFilter(Boolean(extra?.hasInputImage));
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      'video',
      options.videoModelId,
      videoFilter,
      extra?.providers,
    );
    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      options.videoParams,
      'video',
      Boolean(extra?.hasInputImage),
    );
    return buildMediaHiddenDirective({
      modality: 'video',
      effectiveModel,
      selectedModelId: options.videoModelId,
      wireParameters: submitted.wireParameters,
      hasInputImage: extra?.hasInputImage,
      attachedImageReferences: extra?.attachedImageReferences,
      inputImageRatioLocked: submitted.schema.inputImageRatioLocked,
      alwaysOnAudio: submitted.schema.alwaysOnAudio,
    });
  }
  if (mode.id === 'audio') {
    const audioFilter = preferredAudioModelFilters(options.audioType);
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      'audio',
      options.audioModelId,
      audioFilter,
      extra?.providers,
    );
    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      options.audioParams,
      'audio',
      false,
      options.audioType,
    );
    return buildMediaHiddenDirective({
      modality: 'audio',
      effectiveModel,
      selectedModelId: options.audioModelId,
      wireParameters: submitted.wireParameters,
      sceneNote: `audioType=${AUDIO_TYPE_LABELS[options.audioType]}`,
    });
  }
  return undefined;
}

export function getModeComposerPlaceholder(
  mode: SuperAgentModeSpec | null,
  options: ModeComposerOptions,
  t: (text: string) => string,
): string {
  if (!mode) return t('Ask Super Agent to build a game, website, video, deck, or asset…');
  if (mode.id === 'design') {
    if (options.designFormat === 'image') {
      switch (options.imageScene) {
        case 'image-edit':
          return t('Attach a reference image and describe the edits, restyling, or details to change…');
        case 'remove-background':
          return t('Attach an image and describe the subject to isolate or new backdrop to use…');
        case 'relight':
          return t('Attach a photo and describe the target lighting mood, direction, and color tone…');
        case 'image-blend':
          return t('Attach reference images and describe how to blend subjects, style, and scene together…');
        default:
          return t('Describe the poster, illustration, product visual, or image edit you want to generate…');
      }
    }
    switch (options.designScenario) {
      case 'prototype':
        return t('Describe the website, landing page, or interactive web prototype you want to build…');
      case 'mobile-app':
        return t('Describe the mobile app flows, screens, and navigation you want to prototype…');
      case 'deck':
        return t('Describe the slide deck topic, key narrative, and slide count…');
      case 'document':
        return t('Describe the document, resume, or visual report you want to create…');
      case 'web-clone':
        return t('Paste a website URL or describe the page layout you want to rebuild in editable HTML…');
      case 'live-artifact':
        return t('Describe the live data dashboard, metrics, and interactive filters driven by data.json…');
      case 'webgl':
        return t('Describe the interactive WebGL shader, 3D stage, or particle scene you want to build…');
    }
  }
  if (mode.id === 'research') {
    return t('Enter a topic, market question, or source URL to research and turn into a visual deliverable…');
  }
  if (mode.id === 'visualization') {
    return t('Describe the chart, KPI dashboard, infographic, or interactive diagram you want to build…');
  }
  if (mode.id === 'coding') {
    if (options.codingFocus === 'debug') return t('Describe the bug, stack trace, or failing behavior to investigate and fix…');
    if (options.codingFocus === 'refactor') return t('Describe the module or code pattern to refactor cleanly…');
    if (options.codingFocus === 'test') return t('Describe the tests to write or run in this repository…');
    if (options.codingFocus === 'review') return t('Describe the diff, branch, or files to review…');
    return t(mode.placeholder);
  }
  if (mode.id === 'media') {
    if (options.mediaSubMode === 'motion') {
      return t('Describe the editable Motion graphics film you want to build…');
    }
    return t('Describe the cinema video shot, camera motion, and lighting you want to generate…');
  }
  if (mode.id === 'audio') {
    if (options.audioType === 'voiceover') {
      return t('Write the narration script or describe the voiceover tone you want to generate…');
    }
    if (options.audioType === 'sfx') {
      return t('Describe the sound effects or foley audio cues you want to generate…');
    }
    return t('Describe the soundtrack, mood, tempo, or audio you want to create…');
  }
  if (mode.id === 'motion' && options.motionEngine === 'video-model') {
    return t('Describe the AI video shot you want to generate with Seedance or your video model…');
  }
  if (mode.id === 'game') {
    return t(genrePlaceholders[options.gameGenre ?? 'none']);
  }
  return t(mode.placeholder);
}

export function formatModePromptPrefix(
  mode: SuperAgentModeSpec,
  options: ModeComposerOptions,
  mediaModels: Model[],
  extra?: MediaPromptExtra,
): string {
  const parts: string[] = [];
  const findModelLabel = (id: string) => {
    if (!id || id === 'auto') return null;
    const found = mediaModels.find(item => item.id === id);
    return found ? `${found.label} (${found.id})` : id;
  };
  const appendMediaParamParts = (
    modality: Modality,
    selectedId: string,
    rawValues: Record<string, unknown>,
    preferredFilter?: ModelFilter | readonly ModelFilter[],
    audioType?: 'music' | 'voiceover' | 'sfx',
    includeBackgroundStyle?: boolean,
  ) => {
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      modality,
      selectedId,
      preferredFilter,
      extra?.providers,
    );
    const modelLabel = findModelLabel(selectedId)
      ?? (effectiveModel ? `${effectiveModel.label} (${effectiveModel.id})` : null);
    const labelKey = modality === 'image' ? 'Image Model' : modality === 'video' ? 'Video Model' : 'Audio Model';
    if (modelLabel) parts.push(`${labelKey}: ${modelLabel}`);

    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      rawValues,
      modality,
      Boolean(extra?.hasInputImage),
      audioType,
    );
    if (includeBackgroundStyle) {
      const hasNativeBackground = submitted.schema.fields.some(
        field => field.standardKey === 'background' || field.key === 'background',
      );
      if (!hasNativeBackground && options.imageBackground !== 'auto') {
        parts.push(`Background: ${IMAGE_BACKGROUND_LABELS[options.imageBackground]}`);
      }
    }
    if (submitted.schema.inputImageRatioLocked) {
      parts.push('Aspect ratio: Follows first frame');
    }
    if (submitted.schema.alwaysOnAudio) {
      parts.push('Native audio: On');
    }
    for (const entry of submitted.entries) {
      if (entry.tier === 'primary' || entry.isOverride) {
        parts.push(`${entry.label}: ${entry.displayValue}`);
      }
    }
  };

  if (mode.id === 'design') {
    if (options.designFormat === 'image') {
      parts.push('Mode: Design Studio · Image Artwork');
      const sceneMeta = IMAGE_SCENE_CHOICES.find(item => item.id === options.imageScene);
      if (sceneMeta) parts.push(`Scene: ${sceneMeta.label}`);
      if (options.imageStyle !== 'auto') parts.push(`Style: ${IMAGE_STYLE_LABELS[options.imageStyle]}`);
      if (options.imageLighting !== 'auto') parts.push(`Lighting: ${IMAGE_LIGHTING_LABELS[options.imageLighting]}`);
      appendMediaParamParts(
        'image',
        options.imageModelId,
        options.imageParams,
        preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage)),
        undefined,
        true,
      );
    } else {
      const scenario = findDesignScenario(options.designScenario) ?? designScenarios[0];
      parts.push('Mode: Design Studio · HTML Design');
      parts.push(`Module: ${scenario.label} (scenario=${scenario.id})`);
      if (scenario.id === 'deck') {
        parts.push('Format: Slides (16:9)');
        if (options.deckSlides !== 'auto') parts.push(`Length: ${options.deckSlides} slides`);
        parts.push(`Density: ${DECK_DENSITY_LABELS[options.deckDensity]}`);
        parts.push(`Speaker Notes: ${options.deckSpeakerNotes ? 'Included' : 'None'}`);
      } else if (scenario.id === 'document') {
        parts.push(`Format: ${DOC_PAPER_LABELS[options.docPaper]}`);
        parts.push(`Density: ${DECK_DENSITY_LABELS[options.deckDensity]}`);
      } else {
        parts.push(`Viewport: ${DESIGN_VIEWPORT_LABELS[options.designViewport]}`);
        if (scenario.id === 'prototype' || scenario.id === 'mobile-app') {
          parts.push(`Scope: ${HTML_DESIGN_INTERACTION_LABELS[options.designInteraction]}`);
          parts.push(`Motion: ${HTML_DESIGN_MOTION_LABELS[options.designMotion]}`);
        } else if (scenario.id === 'web-clone') {
          parts.push(`Rebuild: ${CLONE_FIDELITY_LABELS[options.cloneFidelity]}`);
        } else if (scenario.id === 'live-artifact') {
          parts.push(`Data View: ${LIVE_DATA_VIEW_LABELS[options.liveDataView]}`);
        } else if (scenario.id === 'webgl') {
          parts.push(`Scene: ${WEBGL_SCENE_LABELS[options.webglScene]}`);
          parts.push(`Controls: ${WEBGL_INTERACTION_LABELS[options.webglInteraction]}`);
        }
      }
      if (options.designStyle !== 'auto') parts.push(`Style: ${HTML_DESIGN_STYLE_LABELS[options.designStyle]}`);
      if (options.designTheme !== 'auto') parts.push(`Theme: ${HTML_DESIGN_THEME_LABELS[options.designTheme]}`);
      if (options.webReferenceUrl.trim()) parts.push(`Reference URL: ${options.webReferenceUrl.trim()}`);
    }
  } else if (mode.id === 'research') {
    const fmtMeta = RESEARCH_FORMAT_CHOICES.find(item => item.id === options.researchFormat) ?? RESEARCH_FORMAT_CHOICES[0];
    const depthMeta = RESEARCH_DEPTH_CHOICES.find(item => item.id === options.researchDepth) ?? RESEARCH_DEPTH_CHOICES[1];
    parts.push('Mode: Research a topic');
    parts.push(`Deliverable: ${fmtMeta.label} (scenario=${researchDesignScenario(options.researchFormat)})`);
    parts.push(`Depth: ${depthMeta.label}`);
    parts.push(`Visuals: ${options.researchVisuals ? 'Charts & matrices' : 'Text focused'}`);
    parts.push(`Citations: ${options.researchCitations ? 'Included' : 'Minimal'}`);
    if (options.webReferenceUrl.trim()) parts.push(`Reference URL: ${options.webReferenceUrl.trim()}`);
  } else if (mode.id === 'visualization') {
    const vizMeta = VIZ_TYPE_CHOICES.find(item => item.id === options.vizType) ?? VIZ_TYPE_CHOICES[0];
    parts.push('Mode: Visualization');
    parts.push(`Type: ${vizMeta.label} (scenario=${visualizationDesignScenario(options.vizType)})`);
    parts.push(`Engine: ${VIZ_ENGINE_LABELS[options.vizEngine]}`);
    parts.push(`Style: ${VIZ_STYLE_LABELS[options.vizStyle]}`);
    if (options.designTheme !== 'auto') parts.push(`Theme: ${HTML_DESIGN_THEME_LABELS[options.designTheme]}`);
    if (options.vizLiveData) parts.push('Data: Live data.json');
    if (options.webReferenceUrl.trim()) parts.push(`Reference URL: ${options.webReferenceUrl.trim()}`);
  } else if (mode.id === 'image') {
    parts.push('Mode: Image Artwork');
    appendMediaParamParts(
      'image',
      options.imageModelId,
      options.imageParams,
      preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage)),
    );
  } else if (mode.id === 'media') {
    if (options.mediaSubMode === 'motion') {
      parts.push('Mode: Motion graphics (Editable HyperFrames Code)');
      parts.push(`Format: ${options.motionAspect} · ${options.motionDuration} · ${options.motionFps}`);
      parts.push(`Style: ${MOTION_STYLE_LABELS[options.motionStyle]}`);
    } else {
      parts.push('Mode: AI Cinema Video (Video Model)');
      appendMediaParamParts('video', options.videoModelId, options.videoParams, preferredVideoModelFilter(Boolean(extra?.hasInputImage)));
    }
  } else if (mode.id === 'audio') {
    parts.push('Mode: Audio & Sound');
    parts.push(`Type: ${AUDIO_TYPE_LABELS[options.audioType]}`);
    appendMediaParamParts(
      'audio',
      options.audioModelId,
      options.audioParams,
      preferredAudioModelFilters(options.audioType),
      options.audioType,
    );
  } else if (mode.id === 'motion') {
    if (options.motionEngine === 'video-model') {
      parts.push('Mode: AI Cinema Video (Video Model)');
      appendMediaParamParts('video', options.videoModelId, options.videoParams, preferredVideoModelFilter(Boolean(extra?.hasInputImage)));
    } else {
      parts.push('Mode: Motion graphics (Editable HyperFrames Code)');
      parts.push(`Format: ${options.motionAspect} · ${options.motionDuration} · ${options.motionFps}`);
      parts.push(`Style: ${MOTION_STYLE_LABELS[options.motionStyle]}`);
    }
  } else if (mode.id === 'deck') {
    parts.push('Mode: Slides & Docs');
    parts.push(`Format: ${DECK_FORMAT_LABELS[options.deckFormat]}`);
    if (options.deckSlides !== 'auto') parts.push(`Length: ${options.deckSlides} slides`);
    parts.push(`Style: ${DECK_DENSITY_LABELS[options.deckDensity]}`);
  } else if (mode.id === 'website') {
    parts.push('Mode: Website & App');
    parts.push(`Target: ${WEB_TARGET_LABELS[options.webTarget]}`);
    if (options.webReferenceUrl.trim()) parts.push(`Reference URL: ${options.webReferenceUrl.trim()}`);
  } else if (mode.id === 'coding') {
    if (options.codingFocus === 'general') return '';
    return `[Coding: ${CODING_FOCUS_LABELS[options.codingFocus]}]`;
  } else if (mode.id === 'game') {
    parts.push('Mode: Game Studio');
    if (options.gameGenre) parts.push(`Genre: ${genreLabels[options.gameGenre]}`);
    if (options.gameStyle) parts.push(`Style: ${styleLabels[options.gameStyle]}`);
    if (options.gameSetting) parts.push(`Setting: ${settingLabels[options.gameSetting]}`);
    if (options.gameOrientation) {
      parts.push(`Layout: ${options.gameOrientation === 'portrait' ? 'Portrait (9:16)' : 'Landscape (16:9)'}`);
    }
    parts.push(`Players: ${isPlayableAd(options) ? 'Playable ad' : 'Single player'}`);
    if (options.gameTemplate) parts.push(`Template: ${options.gameTemplate.title}`);
  } else {
    parts.push(`Mode: ${mode.label}`);
  }

  return `[${parts.join(' | ')}]`;
}

export function buildModeContextTags(
  mode: SuperAgentModeSpec,
  options: ModeComposerOptions,
  mediaModels: Model[],
  t: (text: string) => string,
  locale = 'en',
  extra?: MediaPromptExtra,
): SuperAgentContextTag[] {
  const findModelLabel = (id: string) => {
    if (!id || id === 'auto') return null;
    const found = mediaModels.find(item => item.id === id);
    return found ? found.label : id;
  };
  const tags: SuperAgentContextTag[] = [];
  const appendMediaContextTags = (
    modality: Modality,
    selectedId: string,
    rawValues: Record<string, unknown>,
    preferredFilter?: ModelFilter | readonly ModelFilter[],
    audioType?: 'music' | 'voiceover' | 'sfx',
  ) => {
    const effectiveModel = resolveEffectiveMediaModel(
      mediaModels,
      extra?.routes,
      modality,
      selectedId,
      preferredFilter,
      extra?.providers,
    );
    const modelLabel = findModelLabel(selectedId) ?? effectiveModel?.label;
    if (modelLabel) tags.push({ kind: 'param', label: modelLabel });

    const submitted = resolveSubmittedMediaParameters(
      effectiveModel,
      rawValues,
      modality,
      Boolean(extra?.hasInputImage),
      audioType,
    );
    if (submitted.schema.inputImageRatioLocked) {
      tags.push({ kind: 'param', label: t('Follows first frame') });
    }
    const ordered = [
      ...submitted.entries.filter(entry => entry.isOverride),
      ...submitted.entries.filter(entry => !entry.isOverride && entry.tier === 'primary'),
    ];
    let added = 0;
    for (const entry of ordered) {
      if (added >= 4) break;
      const valText = ['Auto', 'On', 'Off', 'Custom'].includes(entry.displayValue)
        ? t(entry.displayValue)
        : entry.displayValue;
      const compactLabel = entry.standardKey === 'count'
        ? `${entry.value}×`
        : typeof entry.value === 'boolean' || entry.tier === 'advanced'
          ? `${t(entry.label)}: ${valText}`
          : valText;
      tags.push({ kind: 'param', label: compactLabel });
      added += 1;
    }
  };

  if (mode.id === 'game') {
    tags.push({ kind: 'mode', label: t('Game'), icon: 'gamepad-line', tone: 'agent' });
    if (options.gameGenre) tags.push({ kind: 'param', label: t(genreLabels[options.gameGenre]) });
    if (options.gameStyle) tags.push({ kind: 'param', label: t(styleLabels[options.gameStyle]) });
    if (options.gameSetting) tags.push({ kind: 'param', label: t(settingLabels[options.gameSetting]) });
    if (options.gameOrientation) {
      tags.push({ kind: 'param', label: options.gameOrientation === 'portrait' ? '9:16' : '16:9' });
    }
    const playableAd = canChoosePlayableAd(options) ? isPlayableAd(options) : options.gameTemplate?.playableAd;
    tags.push({
      kind: 'param',
      label: t(playableAd ? 'Playable ad' : 'Single player'),
    });
    if (options.gameTemplate) {
      const tplTitle = options.gameTemplate.i18n?.[locale]?.title || options.gameTemplate.title;
      tags.push({ kind: 'param', label: `${t('Remix')} · ${tplTitle}` });
    }
    return tags;
  }

  if (mode.id === 'design') {
    tags.push({ kind: 'mode', label: t('Design Studio'), icon: 'palette-line', tone: 'image' });
    if (options.designFormat === 'image') {
      tags.push({ kind: 'param', label: t('Image design') });
      const sceneChoice = IMAGE_SCENE_CHOICES.find(item => item.id === options.imageScene);
      if (sceneChoice && sceneChoice.id !== 'text-to-image') {
        tags.push({ kind: 'param', label: t(sceneChoice.label) });
      }
      appendMediaContextTags(
        'image',
        options.imageModelId,
        options.imageParams,
        preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage)),
      );
    } else {
      const scenario = findDesignScenario(options.designScenario);
      if (scenario) tags.push({ kind: 'param', label: t(scenario.label) });
      if (options.designStyle !== 'auto') {
        tags.push({ kind: 'param', label: t(HTML_DESIGN_STYLE_LABELS[options.designStyle]) });
      }
      if (options.designTheme !== 'auto') {
        tags.push({ kind: 'param', label: t(options.designTheme === 'dark' ? 'Dark' : 'Light') });
      }
    }
    return tags;
  }

  if (mode.id === 'research') {
    const fmtMeta = RESEARCH_FORMAT_CHOICES.find(item => item.id === options.researchFormat) ?? RESEARCH_FORMAT_CHOICES[0];
    const depthMeta = RESEARCH_DEPTH_CHOICES.find(item => item.id === options.researchDepth) ?? RESEARCH_DEPTH_CHOICES[1];
    tags.push({ kind: 'mode', label: t('Research a topic'), icon: 'book-open-line', tone: 'agent' });
    tags.push({ kind: 'param', label: t(fmtMeta.label) });
    tags.push({ kind: 'param', label: t(depthMeta.label) });
    return tags;
  }

  if (mode.id === 'visualization') {
    const vizMeta = VIZ_TYPE_CHOICES.find(item => item.id === options.vizType) ?? VIZ_TYPE_CHOICES[0];
    tags.push({ kind: 'mode', label: t('Visualization'), icon: 'bar-chart-box-line', tone: 'coding' });
    tags.push({ kind: 'param', label: t(vizMeta.label) });
    tags.push({ kind: 'param', label: t(VIZ_ENGINE_LABELS[options.vizEngine]) });
    return tags;
  }

  if (mode.id === 'image') {
    tags.push({ kind: 'mode', label: t('Image'), icon: 'image-line', tone: 'image' });
    appendMediaContextTags(
      'image',
      options.imageModelId,
      options.imageParams,
      preferredImageModelFilters(options.imageScene, Boolean(extra?.hasInputImage)),
    );
    return tags;
  }

  if (mode.id === 'media' || mode.id === 'motion') {
    const useVideoModel = (mode.id === 'media' && options.mediaSubMode === 'video')
      || (mode.id === 'motion' && options.motionEngine === 'video-model');
    if (useVideoModel) {
      tags.push({ kind: 'mode', label: t('Video'), icon: 'clapperboard-line', tone: 'video' });
      appendMediaContextTags('video', options.videoModelId, options.videoParams, preferredVideoModelFilter(Boolean(extra?.hasInputImage)));
    } else {
      tags.push({ kind: 'mode', label: t('Motion'), icon: 'movie-line', tone: 'video' });
      tags.push({ kind: 'param', label: options.motionAspect });
      tags.push({ kind: 'param', label: options.motionDuration });
      tags.push({ kind: 'param', label: options.motionFps });
      tags.push({ kind: 'param', label: t(MOTION_STYLE_LABELS[options.motionStyle]) });
    }
    return tags;
  }

  if (mode.id === 'audio') {
    tags.push({ kind: 'mode', label: t('Audio'), icon: 'music-2-line', tone: 'audio' });
    tags.push({ kind: 'param', label: t(AUDIO_TYPE_LABELS[options.audioType]) });
    appendMediaContextTags(
      'audio',
      options.audioModelId,
      options.audioParams,
      preferredAudioModelFilters(options.audioType),
      options.audioType,
    );
    return tags;
  }

  if (mode.id === 'deck') {
    tags.push({ kind: 'mode', label: t('Slides & Docs'), icon: 'slideshow-line', tone: 'audio' });
    tags.push({ kind: 'param', label: t(DECK_FORMAT_LABELS[options.deckFormat]) });
    if (options.deckSlides !== 'auto') tags.push({ kind: 'param', label: options.deckSlides });
    tags.push({ kind: 'param', label: t(DECK_DENSITY_LABELS[options.deckDensity]) });
    return tags;
  }

  if (mode.id === 'website') {
    tags.push({ kind: 'mode', label: t('Website & App'), icon: 'layout-line', tone: 'agent' });
    tags.push({ kind: 'param', label: t(WEB_TARGET_LABELS[options.webTarget]) });
    if (options.webReferenceUrl.trim()) {
      try {
        const host = new URL(options.webReferenceUrl.trim()).hostname;
        if (host) tags.push({ kind: 'param', label: host });
      } catch {
        tags.push({ kind: 'param', label: options.webReferenceUrl.trim().slice(0, 40) });
      }
    }
    return tags;
  }

  if (mode.id === 'coding') {
    tags.push({ kind: 'mode', label: t('Coding'), icon: 'code-s-slash-line', tone: 'coding' });
    if (options.codingFocus !== 'general') {
      tags.push({ kind: 'param', label: t(CODING_FOCUS_LABELS[options.codingFocus]) });
    }
    if (options.codingWorkdir.trim()) {
      const clean = options.codingWorkdir.trim().replace(/[\\/]+$/, '');
      const base = clean.split(/[\\/]/).pop();
      if (base) tags.push({ kind: 'param', label: base });
    }
    return tags;
  }

  tags.push({ kind: 'mode', label: t(mode.label), icon: mode.icon, tone: mode.tone });
  return tags;
}

function modelShortDescription(model: Model, t: (text: string) => string): string {
  if (model.description?.trim()) return t(model.description.trim());
  const hints: string[] = [];
  if (model.modality === 'image' && model.supportsImageReference) hints.push(t('Supports image reference & edit'));
  if (model.modality === 'video' && (model.maxInputImages ?? 0) > 0) hints.push(t('Supports start-frame reference'));
  if (model.modality === 'audio') {
    hints.push(t(model.mode === 'text-to-speech' ? 'Text to speech' : 'Audio'));
  }
  if (hints.length) return hints.join(' · ');
  return model.provider;
}

/**
 * Keeps model, generation route, and reference choices above the composer.
 */
export function ModeComposerTopBar({
  active = true,
  modeId,
  options,
  attachments,
  disabled,
  onChange,
  onCatalogModelsChange,
  onCatalogChange,
  onOpenResourcePicker,
  onOpenModelSettings,
}: {
  active?: boolean;
  modeId: SuperAgentCreationModeId;
  options: ModeComposerOptions;
  attachments?: SuperAgentResourceAttachment[];
  disabled?: boolean;
  onChange: (patch: Partial<ModeComposerOptions>) => void;
  onCatalogModelsChange?: (models: Model[]) => void;
  onCatalogChange?: (catalog: { models: Model[]; routes: GatewayStatus['routes']; providers?: GatewayStatus['providers'] }) => void;
  onOpenResourcePicker: (category: ResourceCategoryTab) => void;
  onOpenModelSettings: () => void;
}) {
  const { t } = useI18n();
  const preAdOrientationRef = useRef<'landscape' | 'portrait' | null | undefined>(undefined);
  const needsMediaCatalog = active && (
    modeId === 'image'
    || modeId === 'media'
    || modeId === 'motion'
    || modeId === 'audio'
    || (modeId === 'design' && options.designFormat === 'image')
  );
  const { catalog } = useMediaCatalog(needsMediaCatalog);
  const [openMenu, setOpenMenu] = useState<
    | 'video-model'
    | 'video-engine'
    | 'image-model'
    | 'audio-model'
    | 'audio-type'
    | 'import'
    | 'coding-workdir'
    | 'design-format'
    | 'design-module'
    | 'design-viewport'
    | 'design-deck'
    | 'design-style'
    | 'design-image-scene'
    | 'design-image-style'
    | 'research-format'
    | 'research-depth'
    | 'research-options'
    | 'viz-type'
    | 'viz-engine'
    | 'viz-style'
    | 'game-genre'
    | 'game-style'
    | 'game-setting'
    | 'game-orientation'
    | ModelParamMenuKey
    | null
  >(null);
  const [urlDraft, setUrlDraft] = useState(options.webReferenceUrl);
  const [workdirDraft, setWorkdirDraft] = useState(options.codingWorkdir);

  useEffect(() => {
    setUrlDraft(options.webReferenceUrl);
  }, [options.webReferenceUrl]);

  useEffect(() => {
    setWorkdirDraft(options.codingWorkdir);
  }, [options.codingWorkdir]);

  useEffect(() => {
    if (!active) setOpenMenu(null);
  }, [active]);

  useEffect(() => {
    setOpenMenu(null);
  }, [modeId]);

  useEffect(() => {
    setOpenMenu(null);
  }, [options.designFormat]);

  useEffect(() => {
    if (catalog?.models) {
      onCatalogModelsChange?.(catalog.models);
      onCatalogChange?.({ models: catalog.models, routes: catalog.status.routes, providers: catalog.status.providers });
    }
  }, [catalog, onCatalogModelsChange, onCatalogChange]);

  const providers = catalog?.status.providers ?? [];

  const getModelsFor = useMemo(() => {
    const all = catalog?.models ?? [];
    return (modality: Modality, preferredFilter?: ModelFilter | readonly ModelFilter[]) => {
      const filters = typeof preferredFilter === 'function'
        ? [preferredFilter]
        : preferredFilter
          ? [...preferredFilter]
          : [];
      const prefRank = (model: Model) => {
        if (!filters.length) return 0;
        const idx = filters.findIndex(fn => fn(model));
        return idx === -1 ? filters.length : idx;
      };
      return all
        .filter(item => item.modality === modality)
        .sort((a, b) => {
          const aReady = providerReady(providers, a.provider) ? 0 : 1;
          const bReady = providerReady(providers, b.provider) ? 0 : 1;
          if (aReady !== bReady) return aReady - bReady;
          const rankDiff = prefRank(a) - prefRank(b);
          if (rankDiff !== 0) return rankDiff;
          const provDiff = providerRank(a.provider) - providerRank(b.provider);
          if (provDiff !== 0) return provDiff;
          return a.label.localeCompare(b.label);
        });
    };
  }, [catalog?.models, providers]);

  const attachedImageAssets = (attachments ?? []).filter(item => item.kind === 'asset' && item.modality === 'image');
  const hasInputImage = attachedImageAssets.length > 0;
  const refImageLabel = attachedImageAssets.length === 1
    ? attachedImageAssets[0].title
    : attachedImageAssets.length > 1
      ? `${t('Reference')} (${attachedImageAssets.length})`
      : t('Reference');

  const renderReferenceImagePill = () => (
    <Button
      variant="plain"
      type="button"
      className="om-sa-composer-top-pill"
      data-active={hasInputImage || undefined}
      disabled={disabled}
      onClick={() => {
        setOpenMenu(null);
        onOpenResourcePicker('asset');
      }}
    >
      <RemixIcon name="image-line" size={13} />
      <span className="om-sa-composer-top-pill-label">{refImageLabel}</span>
    </Button>
  );

  const imageFilter = preferredImageModelFilters(options.imageScene, hasInputImage);
  const imageModelsList = getModelsFor('image', imageFilter);
  const effectiveImageModel = resolveEffectiveMediaModel(
    imageModelsList,
    catalog?.status.routes,
    'image',
    options.imageModelId,
    imageFilter,
    providers,
  );
  const effectiveImageSchema = resolveSuperAgentModelSchema(
    effectiveImageModel,
    'image',
    hasInputImage,
    options.imageParams,
  );
  const hasNativeImageBackground = effectiveImageSchema.fields.some(
    field => field.standardKey === 'background' || field.key === 'background',
  );

  const renderFloatingModelPill = ({
    menuKey,
    modality,
    selectedId,
    modelsActive = true,
    preferredFilter,
    fallbackLabel,
    title,
    onSelect,
  }: {
    menuKey: 'video-model' | 'image-model' | 'audio-model';
    modality: Modality;
    selectedId: string;
    modelsActive?: boolean;
    preferredFilter?: ModelFilter | readonly ModelFilter[];
    fallbackLabel: string;
    title: string;
    onSelect: (id: string, nextModel?: Model) => void;
  }) => {
    const list = getModelsFor(modality, preferredFilter);
    const defaultRouteModel = resolveEffectiveMediaModel(
      list,
      catalog?.status.routes,
      modality,
      'auto',
      preferredFilter,
      providers,
    );
    const selectedModel = selectedId !== 'auto' ? list.find(item => item.id === selectedId) : undefined;
    const displayModel = selectedModel ?? defaultRouteModel;
    const label = displayModel?.label ?? fallbackLabel;
    const autoSelected = modelsActive && selectedId === 'auto';

    return (
      <Popover
        open={openMenu === menuKey}
        onOpenChange={next => setOpenMenu(next ? menuKey : null)}
        side="top"
        align="start"
        initialFocus={false}
        aria-label={title}
        className="om-sa-mode-popover om-sa-mode-model-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-composer-top-pill"
            data-active
            data-open={openMenu === menuKey || undefined}
            disabled={disabled}
          >
            {displayModel ? (
              <span className="om-sa-mode-param-avatar" aria-hidden="true">
                <ModelAvatar
                  name={displayModel.label}
                  modelId={displayModel.modelId}
                  provider={{ id: displayModel.provider, custom: false }}
                />
              </span>
            ) : modality === 'video' ? (
              <span className="om-sa-mode-param-avatar" aria-hidden="true">
                <RemixIcon name="movie-line" size={14} />
              </span>
            ) : (
              <RemixIcon name="add-line" size={13} />
            )}
            <span className="om-sa-composer-top-pill-label">{label}</span>
            <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          <div className="om-sa-mode-menu-head">
            <span className="om-sa-popover-label">{title}</span>
            <span className="om-sa-mode-menu-count">{list.length}</span>
          </div>
          <div className="om-sa-mode-model-list" role="listbox" aria-label={title}>
            <Button
              variant="plain"
              type="button"
              role="option"
              aria-selected={autoSelected}
              data-active={autoSelected || undefined}
              className="om-sa-mode-model-row"
              onClick={() => {
                onSelect('auto', defaultRouteModel);
                setOpenMenu(null);
              }}
            >
              <span className="om-sa-mode-model-avatar" aria-hidden="true">
                <RemixIcon name="sparkling-fill" size={14} />
              </span>
              <span className="om-sa-mode-model-copy">
                <strong>{t('Auto (Recommended)')}</strong>
                <span>{defaultRouteModel ? t('Uses {model}', { model: defaultRouteModel.label }) : t('Pick best configured model automatically')}</span>
              </span>
              {autoSelected && <RemixIcon name="check-line" size={15} />}
            </Button>

            {list.map(model => {
              const isSelected = modelsActive && selectedId === model.id;
              const ready = providerReady(providers, model.provider);
              return (
                <Button
                  key={model.id}
                  variant="plain"
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={isSelected || undefined}
                  className="om-sa-mode-model-row"
                  onClick={() => {
                    onSelect(model.id, model);
                    setOpenMenu(null);
                  }}
                >
                  <span className="om-sa-mode-model-avatar" aria-hidden="true">
                    <ModelAvatar name={model.label} modelId={model.modelId} provider={{ id: model.provider, custom: false }} />
                  </span>
                  <span className="om-sa-mode-model-copy">
                    <span className="om-sa-mode-model-title-line">
                      <strong>{model.label}</strong>
                      <span className="om-sa-model-group-dot" data-ready={ready || undefined} aria-hidden="true" />
                    </span>
                    <span>{modelShortDescription(model, t)}</span>
                  </span>
                  {isSelected && <RemixIcon name="check-line" size={15} />}
                </Button>
              );
            })}

            {list.length === 0 && (
              <div className="om-sa-model-unavailable">
                <p className="om-muted">{t('No configured models yet. Connect a provider in Settings.')}</p>
              </div>
            )}
          </div>
          <div className="om-sa-model-menu-foot">
            <Button
              variant="plain"
              type="button"
              className="om-sa-popover-link-row"
              onClick={() => {
                setOpenMenu(null);
                onOpenModelSettings();
              }}
            >
              <RemixIcon name="settings-3-line" size={15} />
              <span>{t('Manage providers')}</span>
              <RemixIcon name="arrow-right-up-line" size={14} />
            </Button>
          </div>
        </div>
      </Popover>
    );
  };

  const attachedBrandKits = (attachments ?? []).filter(item => item.kind === 'brand-kit');
  const brandKitLabel = attachedBrandKits.length === 1
    ? attachedBrandKits[0].title
    : attachedBrandKits.length > 1
      ? `${t('Brand Kit')} (${attachedBrandKits.length})`
      : t('Brand Kit');
  const hasUrl = Boolean(options.webReferenceUrl.trim());
  const buildUrlShortLabel = (emptyLabel: string) =>
    hasUrl ? options.webReferenceUrl.trim().replace(/^https?:\/\//, '').slice(0, 26) : emptyLabel;

  const renderReferenceUrlPill = (includeBrandKitLink: boolean, emptyLabel = t('Import from…')) => (
    <Popover
      open={openMenu === 'import'}
      onOpenChange={next => setOpenMenu(next ? 'import' : null)}
      side="top"
      align="start"
      aria-label={t('Reference URL')}
      className="om-sa-mode-popover"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-sa-composer-top-pill"
          data-active={hasUrl || openMenu === 'import' || undefined}
          data-open={openMenu === 'import' || undefined}
          disabled={disabled}
        >
          <RemixIcon name="global-line" size={13} />
          <span className="om-sa-composer-top-pill-label">{buildUrlShortLabel(emptyLabel)}</span>
          <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
        </Button>
      }
    >
      <div className="om-sa-mode-menu">
        <div className="om-sa-mode-field">
          <span className="om-sa-popover-label">{t('Reference website URL')}</span>
          <div className="om-sa-mode-url-row">
            <input
              type="url"
              className="om-sa-mode-url-input"
              value={urlDraft}
              placeholder="https://example.com"
              onChange={event => setUrlDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onChange({ webReferenceUrl: urlDraft.trim() });
                  setOpenMenu(null);
                }
              }}
            />
            <Button
              variant="plain"
              type="button"
              className="om-sa-popover-pill"
              data-active
              onClick={() => {
                onChange({ webReferenceUrl: urlDraft.trim() });
                setOpenMenu(null);
              }}
            >
              {t('Apply')}
            </Button>
            {hasUrl && (
              <Button
                variant="plain"
                type="button"
                className="om-sa-popover-pill"
                onClick={() => {
                  setUrlDraft('');
                  onChange({ webReferenceUrl: '' });
                  setOpenMenu(null);
                }}
              >
                {t('Clear')}
              </Button>
            )}
          </div>
        </div>
        <div className="om-sa-model-menu-foot">
          {includeBrandKitLink && (
            <Button
              variant="plain"
              type="button"
              className="om-sa-popover-link-row"
              onClick={() => {
                setOpenMenu(null);
                onOpenResourcePicker('brand-kit');
              }}
            >
              <RemixIcon name="palette-line" size={15} />
              <span>{t('Attach Brand Kit')}</span>
              <RemixIcon name="arrow-right-up-line" size={14} />
            </Button>
          )}
          <Button
            variant="plain"
            type="button"
            className="om-sa-popover-link-row"
            onClick={() => {
              setOpenMenu(null);
              onOpenResourcePicker('design-template');
            }}
          >
            <RemixIcon name="layout-line" size={15} />
            <span>{t('Attach Design Template')}</span>
            <RemixIcon name="arrow-right-up-line" size={14} />
          </Button>
          <Button
            variant="plain"
            type="button"
            className="om-sa-popover-link-row"
            onClick={() => {
              setOpenMenu(null);
              onOpenResourcePicker('skills');
            }}
          >
            <RemixIcon name="book-open-line" size={15} />
            <span>{t('Attach Design Skill')}</span>
            <RemixIcon name="arrow-right-up-line" size={14} />
          </Button>
        </div>
      </div>
    </Popover>
  );

  const renderBrandKitPill = () => (
    <Button
      variant="plain"
      type="button"
      className="om-sa-composer-top-pill"
      data-active={attachedBrandKits.length > 0 || undefined}
      disabled={disabled}
      onClick={() => {
        setOpenMenu(null);
        onOpenResourcePicker('brand-kit');
      }}
    >
      <RemixIcon name="palette-line" size={13} />
      <span className="om-sa-composer-top-pill-label">{brandKitLabel}</span>
    </Button>
  );

  if (modeId === 'design') {
    const isHtml = options.designFormat === 'html';
    const activeScenario = findDesignScenario(options.designScenario) ?? designScenarios[0];
    const activeViewport = DESIGN_VIEWPORT_CHOICES.find(v => v.id === options.designViewport) ?? DESIGN_VIEWPORT_CHOICES[0];
    const refUrlEmptyLabel = activeScenario.id === 'web-clone' ? t('Reference URL') : t('Import from…');
    const renderDesignReferenceUrlPill = (includeBrandKitLink: boolean) =>
      renderReferenceUrlPill(includeBrandKitLink, refUrlEmptyLabel);

    const slidesLabel = options.deckSlides === 'auto' ? t('Auto') : options.deckSlides;
    const docFormatLabel = DOC_PAPER_LABELS[options.docPaper];
    const activeImageScene = IMAGE_SCENE_CHOICES.find(item => item.id === options.imageScene) ?? IMAGE_SCENE_CHOICES[0];
    const imageMoodParts = [
      options.imageStyle !== 'auto' ? t(IMAGE_STYLE_LABELS[options.imageStyle]) : null,
      options.imageLighting !== 'auto' ? t(IMAGE_LIGHTING_LABELS[options.imageLighting]) : null,
      !hasNativeImageBackground && options.imageBackground !== 'auto' ? t(IMAGE_BACKGROUND_LABELS[options.imageBackground]) : null,
    ].filter(Boolean) as string[];
    const imageMoodSummary = imageMoodParts.length ? imageMoodParts.slice(0, 2).join(' · ') : t('Style & Mood');
    const htmlStyleParts = [
      options.designStyle !== 'auto' ? t(HTML_DESIGN_STYLE_LABELS[options.designStyle]) : null,
      options.designTheme !== 'auto' ? t(HTML_DESIGN_THEME_LABELS[options.designTheme]) : null,
    ].filter(Boolean) as string[];
    const htmlStyleSummary = htmlStyleParts.length ? htmlStyleParts.join(' · ') : t('Style & Theme');

    const htmlModuleOptionsSummary = (() => {
      if (activeScenario.id === 'webgl') {
        return `${t(WEBGL_SCENE_LABELS[options.webglScene])} · ${t(WEBGL_INTERACTION_LABELS[options.webglInteraction])}`;
      }
      if (activeScenario.id === 'web-clone') {
        return `${t(CLONE_FIDELITY_LABELS[options.cloneFidelity])} · ${t(activeViewport.label)}`;
      }
      if (activeScenario.id === 'live-artifact') {
        return `${t(LIVE_DATA_VIEW_LABELS[options.liveDataView])} · ${t(activeViewport.label)}`;
      }
      return t(activeViewport.label);
    })();

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Design options')}>
        {/* Pill 1: Format switcher (Image design / HTML Design) */}
        <Popover
          open={openMenu === 'design-format'}
          onOpenChange={next => setOpenMenu(next ? 'design-format' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Design medium')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active
              data-open={openMenu === 'design-format' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'design-format'}
              disabled={disabled}
            >
              <span key={options.designFormat} className="om-sa-pill-swap">
                <RemixIcon name={isHtml ? 'layout-2-line' : 'image-line'} size={13} />
                <span className="om-sa-composer-top-pill-label">
                  {t(isHtml ? 'HTML Design' : 'Image design')}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Design medium')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Design medium')}>
              {([
                {
                  id: 'image' as const,
                  icon: 'image-line',
                  label: 'Image design',
                  badge: 'AI',
                  description: 'Posters, illustrations, product visuals & edits',
                },
                {
                  id: 'html' as const,
                  icon: 'layout-2-line',
                  label: 'HTML Design',
                  badge: 'HTML',
                  description: 'Interactive prototypes, apps, slides, docs & WebGL',
                },
              ]).map(item => {
                const selected = options.designFormat === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      onChange({ designFormat: item.id });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <RemixIcon name={item.icon} size={15} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                        <small>{item.badge}</small>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        {isHtml ? (
          <>
            {/* Pill 2: HTML Design Module selector */}
            <Popover
              open={openMenu === 'design-module'}
              onOpenChange={next => setOpenMenu(next ? 'design-module' : null)}
              side="top"
              align="start"
              initialFocus={false}
              aria-label={t('Design module')}
              className="om-sa-mode-popover om-sa-game-choice-popover"
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-composer-top-pill"
                  data-active
                  data-open={openMenu === 'design-module' || undefined}
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'design-module'}
                  disabled={disabled}
                >
                  <span key={activeScenario.id} className="om-sa-pill-swap">
                    <RemixIcon name={activeScenario.icon} size={13} />
                    <span className="om-sa-composer-top-pill-label">{t(activeScenario.label)}</span>
                  </span>
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                </Button>
              }
            >
              <div className="om-sa-mode-menu">
                <div className="om-sa-mode-menu-head">
                  <span className="om-sa-popover-label">{t('Design module')}</span>
                </div>
                <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Design module')}>
                  {designScenarios.map(sc => {
                    const selected = activeScenario.id === sc.id;
                    return (
                      <Button
                        key={sc.id}
                        variant="plain"
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-active={selected || undefined}
                        className="om-sa-game-choice-row"
                        onClick={() => {
                          onChange(designScenarioOptionsPatch(sc.id));
                          setOpenMenu(null);
                        }}
                      >
                        <span className="om-sa-game-choice-visual" aria-hidden="true">
                          <RemixIcon name={sc.icon} size={15} />
                        </span>
                        <span className="om-sa-game-choice-copy">
                          <span className="om-sa-game-choice-title">
                            <strong>{t(sc.label)}</strong>
                          </span>
                          <span>{t(sc.hint)}</span>
                        </span>
                        <span className="om-sa-game-choice-check" aria-hidden="true">
                          {selected && <RemixIcon name="check-line" size={15} />}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </Popover>

            {activeScenario.id === 'web-clone' && renderDesignReferenceUrlPill(true)}

            {/* Pill 3: Contextual layout / format / module-specific options pill */}
            {activeScenario.id === 'deck' || activeScenario.id === 'document' ? (
              <Popover
                open={openMenu === 'design-deck'}
                onOpenChange={next => setOpenMenu(next ? 'design-deck' : null)}
                side="top"
                align="start"
                initialFocus={false}
                aria-label={t(activeScenario.id === 'deck' ? 'Slides' : 'Document')}
                className="om-sa-mode-popover"
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-composer-top-pill"
                    data-active={openMenu === 'design-deck' || undefined}
                    data-open={openMenu === 'design-deck' || undefined}
                    disabled={disabled}
                  >
                    <RemixIcon name={activeScenario.id === 'deck' ? 'slideshow-line' : 'file-text-line'} size={13} />
                    <span className="om-sa-composer-top-pill-label">
                      {activeScenario.id === 'deck'
                        ? `${t('Slides')} · ${slidesLabel}`
                        : `${t(docFormatLabel)} · ${t(DECK_DENSITY_LABELS[options.deckDensity])}`}
                    </span>
                    <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                  </Button>
                }
              >
                <div className="om-sa-mode-menu">
                  {activeScenario.id === 'deck' ? (
                    <>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('Length')}</span>
                        <div className="om-sa-popover-pills">
                          {(['5-7', '8-12', '12-16', 'auto'] as const).map(len => (
                            <Button
                              key={len}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.deckSlides === len}
                              data-active={options.deckSlides === len || undefined}
                              onClick={() => onChange({ deckSlides: len })}
                            >
                              {len === 'auto' ? t('Auto') : len}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('Speaker notes')}</span>
                        <div className="om-sa-popover-pills">
                          {([true, false] as const).map(include => (
                            <Button
                              key={String(include)}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.deckSpeakerNotes === include}
                              data-active={options.deckSpeakerNotes === include || undefined}
                              onClick={() => onChange({ deckSpeakerNotes: include })}
                            >
                              {t(include ? 'Included' : 'Off')}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="om-sa-mode-field">
                      <span className="om-sa-popover-label">{t('Page format')}</span>
                      <div className="om-sa-popover-pills">
                        {(['a4', 'letter', 'report'] as const).map(paper => (
                          <Button
                            key={paper}
                            variant="plain"
                            type="button"
                            className="om-sa-popover-pill"
                            aria-pressed={options.docPaper === paper}
                            data-active={options.docPaper === paper || undefined}
                            onClick={() => onChange({ docPaper: paper, deckFormat: paper === 'report' ? 'report' : 'document' })}
                          >
                            {t(DOC_PAPER_LABELS[paper])}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="om-sa-mode-field">
                    <span className="om-sa-popover-label">{t('Density')}</span>
                    <div className="om-sa-popover-pills">
                      {(['visual', 'balanced', 'detailed'] as const).map(density => (
                        <Button
                          key={density}
                          variant="plain"
                          type="button"
                          className="om-sa-popover-pill"
                          aria-pressed={options.deckDensity === density}
                          data-active={options.deckDensity === density || undefined}
                          onClick={() => onChange({ deckDensity: density })}
                        >
                          {t(DECK_DENSITY_LABELS[density])}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </Popover>
            ) : (
              <Popover
                open={openMenu === 'design-viewport'}
                onOpenChange={next => setOpenMenu(next ? 'design-viewport' : null)}
                side="top"
                align="start"
                initialFocus={false}
                aria-label={t('Viewport & layout')}
                className="om-sa-mode-popover"
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-composer-top-pill"
                    data-active={
                      options.designViewport !== 'responsive'
                      || activeScenario.id === 'webgl'
                      || openMenu === 'design-viewport'
                      || undefined
                    }
                    data-open={openMenu === 'design-viewport' || undefined}
                    disabled={disabled}
                  >
                    <span key={`${activeScenario.id}-${activeViewport.id}`} className="om-sa-pill-swap">
                      <RemixIcon name={activeScenario.id === 'webgl' ? 'sparkling-line' : activeViewport.icon} size={13} />
                      <span className="om-sa-composer-top-pill-label">{htmlModuleOptionsSummary}</span>
                    </span>
                    <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                  </Button>
                }
              >
                <div className="om-sa-mode-menu">
                  {activeScenario.id === 'webgl' && (
                    <>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('3D scene')}</span>
                        <div className="om-sa-popover-pills">
                          {(['particles', 'product-3d', 'shader', 'hero'] as const).map(scene => (
                            <Button
                              key={scene}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.webglScene === scene}
                              data-active={options.webglScene === scene || undefined}
                              onClick={() => onChange({ webglScene: scene })}
                            >
                              {t(WEBGL_SCENE_LABELS[scene])}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('Interaction')}</span>
                        <div className="om-sa-popover-pills">
                          {(['pointer', 'orbit', 'scroll'] as const).map(ctrl => (
                            <Button
                              key={ctrl}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.webglInteraction === ctrl}
                              data-active={options.webglInteraction === ctrl || undefined}
                              onClick={() => onChange({ webglInteraction: ctrl })}
                            >
                              {t(WEBGL_INTERACTION_LABELS[ctrl])}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {activeScenario.id === 'web-clone' && (
                    <div className="om-sa-mode-field">
                      <span className="om-sa-popover-label">{t('Rebuild mode')}</span>
                      <div className="om-sa-popover-pills">
                        {(['faithful', 'brand-remix', 'responsive-refresh'] as const).map(mode => (
                          <Button
                            key={mode}
                            variant="plain"
                            type="button"
                            className="om-sa-popover-pill"
                            aria-pressed={options.cloneFidelity === mode}
                            data-active={options.cloneFidelity === mode || undefined}
                            onClick={() => onChange({ cloneFidelity: mode })}
                          >
                            {t(CLONE_FIDELITY_LABELS[mode])}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeScenario.id === 'live-artifact' && (
                    <div className="om-sa-mode-field">
                      <span className="om-sa-popover-label">{t('Data layout')}</span>
                      <div className="om-sa-popover-pills">
                        {(['kpi', 'charts', 'table'] as const).map(view => (
                          <Button
                            key={view}
                            variant="plain"
                            type="button"
                            className="om-sa-popover-pill"
                            aria-pressed={options.liveDataView === view}
                            data-active={options.liveDataView === view || undefined}
                            onClick={() => onChange({ liveDataView: view })}
                          >
                            {t(LIVE_DATA_VIEW_LABELS[view])}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="om-sa-mode-field">
                    <span className="om-sa-popover-label">{t('Viewport')}</span>
                    <div className="om-sa-popover-pills">
                      {DESIGN_VIEWPORT_CHOICES.map(item => (
                        <Button
                          key={item.id}
                          variant="plain"
                          type="button"
                          className="om-sa-popover-pill"
                          aria-pressed={options.designViewport === item.id}
                          data-active={options.designViewport === item.id || undefined}
                          onClick={() => onChange({ designViewport: item.id })}
                        >
                          {t(item.label)}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {(activeScenario.id === 'prototype' || activeScenario.id === 'mobile-app') && (
                    <>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('Scope')}</span>
                        <div className="om-sa-popover-pills">
                          {(['single', 'multi-screen', 'interactive'] as const).map(scope => (
                            <Button
                              key={scope}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.designInteraction === scope}
                              data-active={options.designInteraction === scope || undefined}
                              onClick={() => onChange({ designInteraction: scope })}
                            >
                              {t(HTML_DESIGN_INTERACTION_LABELS[scope])}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="om-sa-mode-field">
                        <span className="om-sa-popover-label">{t('Motion')}</span>
                        <div className="om-sa-popover-pills">
                          {(['subtle', 'expressive'] as const).map(motion => (
                            <Button
                              key={motion}
                              variant="plain"
                              type="button"
                              className="om-sa-popover-pill"
                              aria-pressed={options.designMotion === motion}
                              data-active={options.designMotion === motion || undefined}
                              onClick={() => onChange({ designMotion: motion })}
                            >
                              {t(HTML_DESIGN_MOTION_LABELS[motion])}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </Popover>
            )}

            {/* Pill 4: Visual style & Theme */}
            <Popover
              open={openMenu === 'design-style'}
              onOpenChange={next => setOpenMenu(next ? 'design-style' : null)}
              side="top"
              align="start"
              initialFocus={false}
              aria-label={t('Style & Theme')}
              className="om-sa-mode-popover"
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-composer-top-pill"
                  data-active={htmlStyleParts.length > 0 || openMenu === 'design-style' || undefined}
                  data-open={openMenu === 'design-style' || undefined}
                  disabled={disabled}
                >
                  <RemixIcon name="brush-line" size={13} />
                  <span className="om-sa-composer-top-pill-label">{htmlStyleSummary}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                </Button>
              }
            >
              <div className="om-sa-mode-menu">
                <div className="om-sa-mode-field">
                  <span className="om-sa-popover-label">{t('Visual style')}</span>
                  <div className="om-sa-popover-pills">
                    {(['auto', 'minimal', 'editorial', 'saas', 'bento', 'brutalist'] as const).map(style => (
                      <Button
                        key={style}
                        variant="plain"
                        type="button"
                        className="om-sa-popover-pill"
                        aria-pressed={options.designStyle === style}
                        data-active={options.designStyle === style || undefined}
                        onClick={() => onChange({ designStyle: style })}
                      >
                        {t(HTML_DESIGN_STYLE_LABELS[style])}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="om-sa-mode-field">
                  <span className="om-sa-popover-label">{t('Theme')}</span>
                  <div className="om-sa-popover-pills">
                    {(['auto', 'light', 'dark', 'both'] as const).map(theme => (
                      <Button
                        key={theme}
                        variant="plain"
                        type="button"
                        className="om-sa-popover-pill"
                        aria-pressed={options.designTheme === theme}
                        data-active={options.designTheme === theme || undefined}
                        onClick={() => onChange({ designTheme: theme })}
                      >
                        {t(HTML_DESIGN_THEME_LABELS[theme])}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </Popover>

            {/* Pill 5: Brand Kit shortcut pill */}
            {renderBrandKitPill()}

            {/* Pill 6: Import from… pill (when not already shown as Reference URL) */}
            {activeScenario.id !== 'web-clone' && renderDesignReferenceUrlPill(false)}
          </>
        ) : (
          <>
            {/* Pill 2: Image Scene selector */}
            <Popover
              open={openMenu === 'design-image-scene'}
              onOpenChange={next => setOpenMenu(next ? 'design-image-scene' : null)}
              side="top"
              align="start"
              initialFocus={false}
              aria-label={t('Image scene')}
              className="om-sa-mode-popover om-sa-game-choice-popover"
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-composer-top-pill"
                  data-active={options.imageScene !== 'text-to-image' || openMenu === 'design-image-scene' || undefined}
                  data-open={openMenu === 'design-image-scene' || undefined}
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'design-image-scene'}
                  disabled={disabled}
                >
                  <span key={activeImageScene.id} className="om-sa-pill-swap">
                    <RemixIcon name={activeImageScene.icon} size={13} />
                    <span className="om-sa-composer-top-pill-label">{t(activeImageScene.label)}</span>
                  </span>
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                </Button>
              }
            >
              <div className="om-sa-mode-menu">
                <div className="om-sa-mode-menu-head">
                  <span className="om-sa-popover-label">{t('Image scene')}</span>
                </div>
                <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Image scene')}>
                  {IMAGE_SCENE_CHOICES.map(sc => {
                    const selected = options.imageScene === sc.id;
                    return (
                      <Button
                        key={sc.id}
                        variant="plain"
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-active={selected || undefined}
                        className="om-sa-game-choice-row"
                        onClick={() => {
                          const nextFilters = preferredImageModelFilters(sc.id, hasInputImage);
                          const nextAuto = resolveEffectiveMediaModel(
                            getModelsFor('image', nextFilters),
                            catalog?.status.routes,
                            'image',
                            'auto',
                            nextFilters,
                            providers,
                          );
                          const primaryNextFilter = nextFilters[0];
                          const incompatibleExplicit = options.imageModelId !== 'auto'
                            && Boolean(primaryNextFilter && effectiveImageModel && !primaryNextFilter(effectiveImageModel))
                            && Boolean(nextAuto);
                          const nextModelId = incompatibleExplicit ? 'auto' : options.imageModelId;
                          const nextModel = nextModelId === 'auto' ? nextAuto : effectiveImageModel;
                          if (nextModel?.id !== effectiveImageModel?.id || nextModelId !== options.imageModelId) {
                            onChange({
                              imageScene: sc.id,
                              ...(nextModelId !== options.imageModelId ? { imageModelId: nextModelId } : {}),
                              imageParams: migrateModelParameters(
                                effectiveImageModel,
                                nextModel,
                                options.imageParams,
                                'image',
                                hasInputImage,
                              ),
                            });
                          } else {
                            onChange({ imageScene: sc.id });
                          }
                          setOpenMenu(null);
                        }}
                      >
                        <span className="om-sa-game-choice-visual" aria-hidden="true">
                          <RemixIcon name={sc.icon} size={15} />
                        </span>
                        <span className="om-sa-game-choice-copy">
                          <span className="om-sa-game-choice-title">
                            <strong>{t(sc.label)}</strong>
                          </span>
                          <span>{t(sc.description)}</span>
                        </span>
                        <span className="om-sa-game-choice-check" aria-hidden="true">
                          {selected && <RemixIcon name="check-line" size={15} />}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </Popover>

            {/* Pill 3: Image Model */}
            {renderFloatingModelPill({
              menuKey: 'image-model',
              modality: 'image',
              selectedId: options.imageModelId,
              modelsActive: true,
              preferredFilter: imageFilter,
              fallbackLabel: t('Image model'),
              title: t('Image model'),
              onSelect: (id, nextModel) => {
                const resolvedNext = nextModel ?? resolveEffectiveMediaModel(
                  imageModelsList,
                  catalog?.status.routes,
                  'image',
                  id,
                  imageFilter,
                  providers,
                );
                onChange({
                  imageModelId: id,
                  imageParams: migrateModelParameters(
                    effectiveImageModel,
                    resolvedNext,
                    options.imageParams,
                    'image',
                    hasInputImage,
                  ),
                });
              },
            })}

            {/* Pill 4: Style & Mood (prompt-level art direction; avoids duplicating native SSOT background) */}
            <Popover
              open={openMenu === 'design-image-style'}
              onOpenChange={next => setOpenMenu(next ? 'design-image-style' : null)}
              side="top"
              align="start"
              initialFocus={false}
              aria-label={t('Style & Mood')}
              className="om-sa-mode-popover"
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-composer-top-pill"
                  data-active={imageMoodParts.length > 0 || openMenu === 'design-image-style' || undefined}
                  data-open={openMenu === 'design-image-style' || undefined}
                  disabled={disabled}
                >
                  <RemixIcon name="brush-line" size={13} />
                  <span className="om-sa-composer-top-pill-label">{imageMoodSummary}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
                </Button>
              }
            >
              <div className="om-sa-mode-menu">
                <div className="om-sa-mode-field">
                  <span className="om-sa-popover-label">{t('Visual style')}</span>
                  <div className="om-sa-popover-pills">
                    {(['auto', 'photorealistic', 'editorial', '3d-render', 'illustration', 'poster', 'minimalist'] as const).map(style => (
                      <Button
                        key={style}
                        variant="plain"
                        type="button"
                        className="om-sa-popover-pill"
                        aria-pressed={options.imageStyle === style}
                        data-active={options.imageStyle === style || undefined}
                        onClick={() => onChange({ imageStyle: style })}
                      >
                        {t(IMAGE_STYLE_LABELS[style])}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="om-sa-mode-field">
                  <span className="om-sa-popover-label">{t('Lighting')}</span>
                  <div className="om-sa-popover-pills">
                    {(['auto', 'studio', 'natural', 'dramatic', 'neon', 'warm'] as const).map(light => (
                      <Button
                        key={light}
                        variant="plain"
                        type="button"
                        className="om-sa-popover-pill"
                        aria-pressed={options.imageLighting === light}
                        data-active={options.imageLighting === light || undefined}
                        onClick={() => onChange({ imageLighting: light })}
                      >
                        {t(IMAGE_LIGHTING_LABELS[light])}
                      </Button>
                    ))}
                  </div>
                </div>
                {!hasNativeImageBackground && (
                  <div className="om-sa-mode-field">
                    <span className="om-sa-popover-label">{t('Background')}</span>
                    <div className="om-sa-popover-pills">
                      {(['auto', 'transparent', 'solid'] as const).map(bg => (
                        <Button
                          key={bg}
                          variant="plain"
                          type="button"
                          className="om-sa-popover-pill"
                          aria-pressed={options.imageBackground === bg}
                          data-active={options.imageBackground === bg || undefined}
                          onClick={() => onChange({ imageBackground: bg })}
                        >
                          {t(IMAGE_BACKGROUND_LABELS[bg])}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Popover>

            {/* SSOT variable parameter pills derived from the active image model */}
            <ModelParameterPills
              modality="image"
              model={effectiveImageModel}
              values={options.imageParams}
              hasInputImage={hasInputImage}
              openMenu={openMenu}
              disabled={disabled}
              onOpenMenuChange={next => setOpenMenu(next)}
              onChange={nextParams => onChange({ imageParams: nextParams })}
            />

            {/* Reference image shortcut pill */}
            {renderReferenceImagePill()}

            {/* Brand Kit shortcut pill */}
            {renderBrandKitPill()}
          </>
        )}
      </div>
    );
  }

  if (modeId === 'research') {
    const activeFormat = RESEARCH_FORMAT_CHOICES.find(item => item.id === options.researchFormat) ?? RESEARCH_FORMAT_CHOICES[0];
    const activeDepth = RESEARCH_DEPTH_CHOICES.find(item => item.id === options.researchDepth) ?? RESEARCH_DEPTH_CHOICES[1];
    const visualsSummary = options.researchVisuals && options.researchCitations
      ? t('Charts & citations')
      : options.researchVisuals
        ? t('Charts & tables')
        : options.researchCitations
          ? t('Source citations')
          : t('Text only');

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Research options')}>
        <Popover
          open={openMenu === 'research-format'}
          onOpenChange={next => setOpenMenu(next ? 'research-format' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Deliverable')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active
              data-open={openMenu === 'research-format' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'research-format'}
              disabled={disabled}
            >
              <span key={activeFormat.id} className="om-sa-pill-swap">
                <RemixIcon name={activeFormat.icon} size={13} />
                <span className="om-sa-composer-top-pill-label">{t(activeFormat.label)}</span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Deliverable')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Deliverable')}>
              {RESEARCH_FORMAT_CHOICES.map(item => {
                const selected = options.researchFormat === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      onChange({ researchFormat: item.id });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <RemixIcon name={item.icon} size={15} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        <Popover
          open={openMenu === 'research-depth'}
          onOpenChange={next => setOpenMenu(next ? 'research-depth' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Research depth')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={options.researchDepth !== 'balanced' || openMenu === 'research-depth' || undefined}
              data-open={openMenu === 'research-depth' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'research-depth'}
              disabled={disabled}
            >
              <RemixIcon name="focus-3-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{t(activeDepth.label)}</span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Research depth')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Research depth')}>
              {RESEARCH_DEPTH_CHOICES.map(item => {
                const selected = options.researchDepth === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      onChange({ researchDepth: item.id });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <RemixIcon name="focus-3-line" size={15} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        <Popover
          open={openMenu === 'research-options'}
          onOpenChange={next => setOpenMenu(next ? 'research-options' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Charts & citations')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={openMenu === 'research-options' || undefined}
              data-open={openMenu === 'research-options' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="bar-chart-box-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{visualsSummary}</span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Include in output')}</span>
              <div className="om-sa-popover-pills">
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.researchVisuals}
                  data-active={options.researchVisuals || undefined}
                  onClick={() => onChange({ researchVisuals: !options.researchVisuals })}
                >
                  {t('Charts & tables')}
                </Button>
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.researchCitations}
                  data-active={options.researchCitations || undefined}
                  onClick={() => onChange({ researchCitations: !options.researchCitations })}
                >
                  {t('Source citations')}
                </Button>
              </div>
            </div>
          </div>
        </Popover>

        {renderBrandKitPill()}
        {renderReferenceUrlPill(false, t('Import from…'))}
      </div>
    );
  }

  if (modeId === 'visualization') {
    const activeVizType = VIZ_TYPE_CHOICES.find(item => item.id === options.vizType) ?? VIZ_TYPE_CHOICES[0];
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Visualization options')}>
        <Popover
          open={openMenu === 'viz-type'}
          onOpenChange={next => setOpenMenu(next ? 'viz-type' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Visual type')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active
              data-open={openMenu === 'viz-type' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'viz-type'}
              disabled={disabled}
            >
              <span key={activeVizType.id} className="om-sa-pill-swap">
                <RemixIcon name={activeVizType.icon} size={13} />
                <span className="om-sa-composer-top-pill-label">{t(activeVizType.label)}</span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Visual type')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Visual type')}>
              {VIZ_TYPE_CHOICES.map(item => {
                const selected = options.vizType === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      onChange(visualizationOptionsPatch(item.id));
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <RemixIcon name={item.icon} size={15} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        <Popover
          open={openMenu === 'viz-engine'}
          onOpenChange={next => setOpenMenu(next ? 'viz-engine' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Rendering engine')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={options.vizEngine !== 'html-svg' || options.vizLiveData || openMenu === 'viz-engine' || undefined}
              data-open={openMenu === 'viz-engine' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="settings-3-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{t(VIZ_ENGINE_LABELS[options.vizEngine])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Rendering engine')}</span>
              <div className="om-sa-popover-pills">
                {(['html-svg', 'd3', 'webgl'] as const).map(engine => (
                  <Button
                    key={engine}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.vizEngine === engine}
                    data-active={options.vizEngine === engine || undefined}
                    onClick={() => onChange({ vizEngine: engine })}
                  >
                    {t(VIZ_ENGINE_LABELS[engine])}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Data binding')}</span>
              <div className="om-sa-popover-pills">
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.vizLiveData}
                  data-active={options.vizLiveData || undefined}
                  onClick={() => onChange({ vizLiveData: !options.vizLiveData })}
                >
                  {t('Live data.json')}
                </Button>
              </div>
            </div>
          </div>
        </Popover>

        <Popover
          open={openMenu === 'viz-style'}
          onOpenChange={next => setOpenMenu(next ? 'viz-style' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Style & Theme')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={options.vizStyle !== 'editorial' || options.designTheme !== 'auto' || openMenu === 'viz-style' || undefined}
              data-open={openMenu === 'viz-style' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="brush-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{t(VIZ_STYLE_LABELS[options.vizStyle])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Visual style')}</span>
              <div className="om-sa-popover-pills">
                {(['editorial', 'minimal', 'dark-terminal', 'bento'] as const).map(style => (
                  <Button
                    key={style}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.vizStyle === style}
                    data-active={options.vizStyle === style || undefined}
                    onClick={() => onChange({ vizStyle: style })}
                  >
                    {t(VIZ_STYLE_LABELS[style])}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Theme')}</span>
              <div className="om-sa-popover-pills">
                {(['auto', 'light', 'dark', 'both'] as const).map(theme => (
                  <Button
                    key={theme}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.designTheme === theme}
                    data-active={options.designTheme === theme || undefined}
                    onClick={() => onChange({ designTheme: theme })}
                  >
                    {t(HTML_DESIGN_THEME_LABELS[theme])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>

        {renderBrandKitPill()}
        {renderReferenceUrlPill(false, t('Import from…'))}
      </div>
    );
  }

  if (modeId === 'motion' || modeId === 'media') {
    const isVideoModel = modeId === 'motion'
      ? options.motionEngine === 'video-model'
      : options.mediaSubMode === 'video';
    const videoFilter = preferredVideoModelFilter(hasInputImage);
    const videoModelsList = getModelsFor('video', videoFilter);
    const effectiveVideoModel = resolveEffectiveMediaModel(
      videoModelsList,
      catalog?.status.routes,
      'video',
      options.videoModelId,
      videoFilter,
      providers,
    );

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Video generation options')}>
        <Popover
          open={openMenu === 'video-engine'}
          onOpenChange={next => setOpenMenu(next ? 'video-engine' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Engine')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active
              data-open={openMenu === 'video-engine' || undefined}
              disabled={disabled}
            >
              <RemixIcon name={isVideoModel ? 'clapperboard-line' : 'movie-line'} size={13} />
              <span className="om-sa-composer-top-pill-label">
                {t(isVideoModel ? 'AI Video' : 'Motion graphics')}
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Engine')}</span>
            </div>
            <div className="om-sa-popover-pills">
              {([
                { id: 'video' as const, label: 'AI Video', icon: 'clapperboard-line' },
                { id: 'motion' as const, label: 'Motion graphics', icon: 'movie-line' },
              ]).map(choice => {
                const selected = choice.id === 'video' ? isVideoModel : !isVideoModel;
                return (
                  <Button
                    key={choice.id}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={selected}
                    data-active={selected || undefined}
                    onClick={() => {
                      onChange(modeId === 'motion'
                        ? { motionEngine: choice.id === 'video' ? 'video-model' : 'motion' }
                        : { mediaSubMode: choice.id });
                      setOpenMenu(null);
                    }}
                  >
                    <RemixIcon name={choice.icon} size={13} />
                    <span>{t(choice.label)}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        {isVideoModel && (
          <>
            {renderFloatingModelPill({
              menuKey: 'video-model',
              modality: 'video',
              selectedId: options.videoModelId,
              preferredFilter: videoFilter,
              fallbackLabel: t('Auto'),
              title: t('Video model'),
              modelsActive: true,
              onSelect: (id, nextModel) => {
                const resolvedNext = nextModel ?? resolveEffectiveMediaModel(
                  videoModelsList,
                  catalog?.status.routes,
                  'video',
                  id,
                  videoFilter,
                  providers,
                );
                onChange({
                  ...(modeId === 'motion'
                    ? { motionEngine: 'video-model' as const }
                    : { mediaSubMode: 'video' as const }),
                  videoModelId: id,
                  videoParams: migrateModelParameters(
                    effectiveVideoModel,
                    resolvedNext,
                    options.videoParams,
                    'video',
                    hasInputImage,
                  ),
                });
              },
            })}

            <ModelParameterPills
              modality="video"
              model={effectiveVideoModel}
              values={options.videoParams}
              hasInputImage={hasInputImage}
              openMenu={openMenu}
              disabled={disabled}
              onOpenMenuChange={next => setOpenMenu(next)}
              onChange={nextParams => onChange({ videoParams: nextParams })}
            />

            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={hasInputImage || undefined}
              disabled={disabled}
              onClick={() => {
                setOpenMenu(null);
                onOpenResourcePicker('asset');
              }}
            >
              <RemixIcon name="image-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{t('First frame')}</span>
            </Button>
          </>
        )}
      </div>
    );
  }

  if (modeId === 'audio') {
    const audioFilter = preferredAudioModelFilters(options.audioType);
    const audioModelsList = getModelsFor('audio', audioFilter);
    const effectiveAudioModel = resolveEffectiveMediaModel(
      audioModelsList,
      catalog?.status.routes,
      'audio',
      options.audioModelId,
      audioFilter,
      providers,
    );
    const audioTypeIcon = options.audioType === 'voiceover'
      ? 'mic-line'
      : options.audioType === 'sfx'
        ? 'volume-up-line'
        : 'music-2-line';

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Audio & Sound options')}>
        <Popover
          open={openMenu === 'audio-type'}
          onOpenChange={next => setOpenMenu(next ? 'audio-type' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Audio type')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active
              data-open={openMenu === 'audio-type' || undefined}
              disabled={disabled}
            >
              <RemixIcon name={audioTypeIcon} size={13} />
              <span className="om-sa-composer-top-pill-label">{t(AUDIO_TYPE_LABELS[options.audioType])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Audio type')}</span>
            </div>
            <div className="om-sa-popover-pills">
              {([
                { id: 'music' as const, label: 'Music', icon: 'music-2-line' },
                { id: 'voiceover' as const, label: 'Voiceover', icon: 'mic-line' },
                { id: 'sfx' as const, label: 'Sound FX', icon: 'volume-up-line' },
              ]).map(kind => (
                <Button
                  key={kind.id}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.audioType === kind.id}
                  data-active={options.audioType === kind.id || undefined}
                  onClick={() => {
                    const nextFilters = preferredAudioModelFilters(kind.id);
                    const nextList = getModelsFor('audio', nextFilters);
                    const keepExplicit = options.audioModelId !== 'auto'
                      && Boolean(effectiveAudioModel && nextFilters[0]?.(effectiveAudioModel));
                    const nextModelId = keepExplicit ? options.audioModelId : 'auto';
                    const nextModel = keepExplicit
                      ? effectiveAudioModel
                      : resolveEffectiveMediaModel(nextList, catalog?.status.routes, 'audio', 'auto', nextFilters, providers);
                    const migrated = migrateModelParameters(
                      effectiveAudioModel,
                      nextModel,
                      options.audioParams,
                      'audio',
                      false,
                      kind.id,
                    );
                    onChange({
                      audioType: kind.id,
                      ...(nextModelId !== options.audioModelId ? { audioModelId: nextModelId } : {}),
                      audioParams: migrated,
                    });
                    setOpenMenu(null);
                  }}
                >
                  <RemixIcon name={kind.icon} size={13} />
                  <span>{t(kind.label)}</span>
                </Button>
              ))}
            </div>
          </div>
        </Popover>

        {renderFloatingModelPill({
          menuKey: 'audio-model',
          modality: 'audio',
          selectedId: options.audioModelId,
          preferredFilter: audioFilter,
          fallbackLabel: t('Audio model'),
          title: t('Audio model'),
          onSelect: (id, nextModel) => {
            const resolvedNext = nextModel ?? resolveEffectiveMediaModel(
              audioModelsList,
              catalog?.status.routes,
              'audio',
              id,
              audioFilter,
              providers,
            );
            onChange({
              audioModelId: id,
              audioParams: migrateModelParameters(
                effectiveAudioModel,
                resolvedNext,
                options.audioParams,
                'audio',
                false,
                options.audioType,
              ),
            });
          },
        })}

        <ModelParameterPills
          modality="audio"
          model={effectiveAudioModel}
          values={options.audioParams}
          audioType={options.audioType}
          openMenu={openMenu}
          disabled={disabled}
          onOpenMenuChange={next => setOpenMenu(next)}
          onChange={nextParams => onChange({ audioParams: nextParams })}
        />
      </div>
    );
  }

  if (modeId === 'image') {
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Image options')}>
        {renderFloatingModelPill({
          menuKey: 'image-model',
          modality: 'image',
          selectedId: options.imageModelId,
          preferredFilter: imageFilter,
          fallbackLabel: t('Image model'),
          title: t('Image model'),
          onSelect: (id, nextModel) => {
            const resolvedNext = nextModel ?? resolveEffectiveMediaModel(
              imageModelsList,
              catalog?.status.routes,
              'image',
              id,
              imageFilter,
              providers,
            );
            onChange({
              imageModelId: id,
              imageParams: migrateModelParameters(
                effectiveImageModel,
                resolvedNext,
                options.imageParams,
                'image',
                hasInputImage,
              ),
            });
          },
        })}

        <ModelParameterPills
          modality="image"
          model={effectiveImageModel}
          values={options.imageParams}
          hasInputImage={hasInputImage}
          openMenu={openMenu}
          disabled={disabled}
          onOpenMenuChange={next => setOpenMenu(next)}
          onChange={nextParams => onChange({ imageParams: nextParams })}
        />

        {renderReferenceImagePill()}
      </div>
    );
  }

  if (modeId === 'website') {
    const hasUrl = Boolean(options.webReferenceUrl.trim());
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Website references')}>
        <Popover
          open={openMenu === 'import'}
          onOpenChange={next => setOpenMenu(next ? 'import' : null)}
          side="top"
          align="start"
          aria-label={t('Import from URL or Brand Kit')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={hasUrl || openMenu === 'import' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="global-line" size={13} />
              <span className="om-sa-composer-top-pill-label">
                {hasUrl ? options.webReferenceUrl.replace(/^https?:\/\//, '').slice(0, 26) : t('Import from…')}
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Reference website URL')}</span>
              <div className="om-sa-mode-url-row">
                <input
                  type="url"
                  className="om-sa-mode-url-input"
                  value={urlDraft}
                  placeholder="https://example.com"
                  onChange={event => setUrlDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onChange({ webReferenceUrl: urlDraft.trim() });
                      setOpenMenu(null);
                    }
                  }}
                />
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  data-active
                  onClick={() => {
                    onChange({ webReferenceUrl: urlDraft.trim() });
                    setOpenMenu(null);
                  }}
                >
                  {t('Apply')}
                </Button>
                {hasUrl && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    onClick={() => {
                      setUrlDraft('');
                      onChange({ webReferenceUrl: '' });
                      setOpenMenu(null);
                    }}
                  >
                    {t('Clear')}
                  </Button>
                )}
              </div>
            </div>
            <div className="om-sa-model-menu-foot">
              <Button
                variant="plain"
                type="button"
                className="om-sa-popover-link-row"
                onClick={() => {
                  setOpenMenu(null);
                  onOpenResourcePicker('brand-kit');
                }}
              >
                <RemixIcon name="palette-line" size={15} />
                <span>{t('Attach Brand Kit')}</span>
                <RemixIcon name="arrow-right-up-line" size={14} />
              </Button>
              <Button
                variant="plain"
                type="button"
                className="om-sa-popover-link-row"
                onClick={() => {
                  setOpenMenu(null);
                  onOpenResourcePicker('design-template');
                }}
              >
                <RemixIcon name="layout-line" size={15} />
                <span>{t('Attach Design Template')}</span>
                <RemixIcon name="arrow-right-up-line" size={14} />
              </Button>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'coding') {
    const trimmed = options.codingWorkdir.trim();
    const shortDir = trimmed ? (trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed) : '';
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Working directory')}>
        <Popover
          open={openMenu === 'coding-workdir'}
          onOpenChange={next => setOpenMenu(next ? 'coding-workdir' : null)}
          side="top"
          align="start"
          aria-label={t('Working directory')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={Boolean(trimmed) || openMenu === 'coding-workdir' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="folder-line" size={13} />
              <span className="om-sa-composer-top-pill-label" title={trimmed || undefined}>
                {shortDir || t('Workspace folder')}
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Local project folder path')}</span>
              <div className="om-sa-mode-url-row">
                <input
                  type="text"
                  className="om-sa-mode-url-input"
                  value={workdirDraft}
                  placeholder="/path/to/repo"
                  onChange={event => setWorkdirDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onChange({ codingWorkdir: workdirDraft.trim() });
                      setOpenMenu(null);
                    }
                  }}
                />
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  data-active
                  onClick={() => {
                    onChange({ codingWorkdir: workdirDraft.trim() });
                    setOpenMenu(null);
                  }}
                >
                  {t('Apply')}
                </Button>
                {trimmed && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    onClick={() => {
                      setWorkdirDraft('');
                      onChange({ codingWorkdir: '' });
                      setOpenMenu(null);
                    }}
                  >
                    {t('Clear')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'game') {
    const renderGameArtPicker = ({
      menuKey,
      fallbackIcon,
      label,
      clearLabel,
      selectedId,
      items,
      labels,
      covers,
      onSelect,
    }: {
      menuKey: 'game-genre' | 'game-style' | 'game-setting';
      fallbackIcon: string;
      label: string;
      clearLabel: string;
      selectedId: string | null;
      items: readonly string[];
      labels: Record<string, string>;
      covers: Record<string, string | null>;
      onSelect: (id: string | null) => void;
    }) => {
      const selectedCover = selectedId ? covers[selectedId] : null;
      return (
        <Popover
          open={openMenu === menuKey}
          onOpenChange={next => setOpenMenu(next ? menuKey : null)}
          side="top"
          align="start"
          aria-label={t(label)}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={Boolean(selectedId) || openMenu === menuKey || undefined}
              data-open={openMenu === menuKey || undefined}
              disabled={disabled}
            >
              <span key={selectedId ?? 'any'} className="om-sa-pill-swap">
                {selectedCover ? (
                  <img className="om-sa-game-pill-thumb" src={selectedCover} alt="" />
                ) : (
                  <RemixIcon name={fallbackIcon} size={13} />
                )}
                <span className="om-sa-composer-top-pill-label">
                  {selectedId ? t(labels[selectedId]) : t(label)}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t(label)}</span>
              {selectedId && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  onClick={() => {
                    onSelect(null);
                    setOpenMenu(null);
                  }}
                >
                  {t(clearLabel)}
                </Button>
              )}
            </div>
            <div className="om-sa-game-art-grid" role="group" aria-label={t(label)}>
              {items.map(id => {
                const activeItem = selectedId === id;
                const cover = covers[id];
                return (
                  <Button
                    key={id}
                    variant="plain"
                    type="button"
                    className="om-sa-game-art-option"
                    aria-pressed={activeItem}
                    data-active={activeItem || undefined}
                    onClick={() => {
                      onSelect(activeItem ? null : id);
                      setOpenMenu(null);
                    }}
                  >
                    {cover ? (
                      <img src={cover} alt="" />
                    ) : (
                      <span className="om-sa-game-art-fallback" aria-hidden="true">
                        <RemixIcon name={fallbackIcon} size={18} />
                      </span>
                    )}
                    <span>{t(labels[id])}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>
      );
    };

    const playableAd = isPlayableAd(options);
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Game studio options')}>
        {renderGameArtPicker({
          menuKey: 'game-genre',
          fallbackIcon: 'gamepad-line',
          label: 'Genre',
          clearLabel: 'Any genre',
          selectedId: options.gameGenre,
          items: gameGenres,
          labels: genreLabels,
          covers: genreCovers,
          onSelect: id => onChange({ gameGenre: id as GameGenre | null }),
        })}
        {renderGameArtPicker({
          menuKey: 'game-style',
          fallbackIcon: 'brush-line',
          label: 'Art style',
          clearLabel: 'Any style',
          selectedId: options.gameStyle,
          items: gameStyles,
          labels: styleLabels,
          covers: styleCovers,
          onSelect: id => onChange({ gameStyle: id as GameStyle | null }),
        })}
        {renderGameArtPicker({
          menuKey: 'game-setting',
          fallbackIcon: 'landscape-line',
          label: 'Setting',
          clearLabel: 'Any setting',
          selectedId: options.gameSetting,
          items: gameSettings,
          labels: settingLabels,
          covers: settingCovers,
          onSelect: id => onChange({ gameSetting: id as GameSetting | null }),
        })}
        <Popover
          open={openMenu === 'game-orientation'}
          onOpenChange={next => setOpenMenu(next ? 'game-orientation' : null)}
          side="top"
          align="start"
          aria-label={t('Screen layout')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={Boolean(options.gameOrientation) || openMenu === 'game-orientation' || undefined}
              data-open={openMenu === 'game-orientation' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'game-orientation'}
              disabled={disabled}
            >
              <span key={options.gameOrientation ?? 'any'} className="om-sa-pill-swap">
                <RemixIcon
                  name={
                    options.gameOrientation === 'portrait'
                      ? 'smartphone-line'
                      : options.gameOrientation === 'landscape'
                        ? 'computer-line'
                        : 'layout-2-line'
                  }
                  size={13}
                />
                <span className="om-sa-composer-top-pill-label">
                  {options.gameOrientation === 'portrait'
                    ? t('Portrait')
                    : options.gameOrientation === 'landscape'
                      ? t('Landscape')
                      : t('Screen layout')}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Screen layout')}</span>
              {options.gameOrientation && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  onClick={() => {
                    preAdOrientationRef.current = undefined;
                    onChange({ gameOrientation: null, gamePlayableAd: false });
                    setOpenMenu(null);
                  }}
                >
                  {t('Any screen layout')}
                </Button>
              )}
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Screen layout')}>
              {([
                {
                  id: 'landscape' as const,
                  label: 'Landscape',
                  ratio: '16:9',
                  description: 'Desktop & widescreen browser play',
                },
                {
                  id: 'portrait' as const,
                  label: 'Portrait',
                  ratio: '9:16',
                  description: 'Mobile & one-thumb vertical play',
                },
              ]).map(item => {
                const selected = options.gameOrientation === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      preAdOrientationRef.current = undefined;
                      const nextOrientation = selected ? null : item.id;
                      onChange(nextOrientation === 'portrait'
                        ? { gameOrientation: 'portrait' }
                        : { gameOrientation: nextOrientation, gamePlayableAd: false });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <span className="om-sa-ratio-glyph" data-ratio={item.ratio} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                        <small>{item.ratio}</small>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>
        {canChoosePlayableAd(options) && (
          <Tooltip
            label={t('Create an instantly playable portrait game with “Play again” and “Go to store” buttons added automatically.')}
            preview={<PlayableAdPreview />}
          >
            <label
              className="om-sa-composer-top-pill cursor-pointer"
              data-active={playableAd || undefined}
            >
              <span>{t('Playable ad')}</span>
              <Toggle
                label={t('Playable ad')}
                checked={playableAd}
                disabled={disabled}
                onCommit={enabled => {
                  if (enabled) {
                    preAdOrientationRef.current = options.gameOrientation;
                    onChange({ gameOrientation: 'portrait', gamePlayableAd: true });
                  } else {
                    const restore = preAdOrientationRef.current;
                    preAdOrientationRef.current = undefined;
                    onChange(restore !== undefined && restore !== 'portrait'
                      ? { gameOrientation: restore, gamePlayableAd: false }
                      : { gamePlayableAd: false });
                  }
                }}
              />
            </label>
          </Tooltip>
        )}
      </div>
    );
  }

  return null;
}

/**
 * Compact single-pill parameter control inside the composer's bottom toolbar.
 * Keeps the toolbar airy and strictly single-row alongside Mode pill and Agent selector.
 */
export function ModeComposerControls({
  active = true,
  modeId,
  options,
  disabled,
  onChange,
}: {
  active?: boolean;
  modeId: SuperAgentCreationModeId;
  options: ModeComposerOptions;
  disabled?: boolean;
  onChange: (patch: Partial<ModeComposerOptions>) => void;
}) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<'params' | null>(null);

  useEffect(() => {
    if (!active) setOpenMenu(null);
  }, [active]);

  useEffect(() => {
    setOpenMenu(null);
  }, [modeId]);

  if (
    modeId === 'design'
    || modeId === 'research'
    || modeId === 'visualization'
    || modeId === 'image'
    || modeId === 'audio'
    || (modeId === 'media' && options.mediaSubMode === 'video')
    || (modeId === 'motion' && options.motionEngine === 'video-model')
  ) {
    return null;
  }

  const durationLabel = (duration: string) => t('{count}s', { count: Number.parseInt(duration, 10) });

  const renderMotionParamsPopover = () => {
    const motionSummary = `${options.motionAspect} · ${durationLabel(options.motionDuration)} · ${options.motionFps}`;
    return (
      <Popover
        open={openMenu === 'params'}
        onOpenChange={next => setOpenMenu(next ? 'params' : null)}
        side="top"
        align="start"
        aria-label={t('Motion graphics parameters')}
        className="om-sa-mode-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-mode-param-trigger"
            data-active={openMenu === 'params' || undefined}
            disabled={disabled}
          >
            <RemixIcon name="movie-line" size={13} />
            <span className="om-sa-mode-param-label">{motionSummary}</span>
            <RemixIcon name="arrow-down-s-line" size={14} />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Aspect ratio')}</span>
            <div className="om-sa-popover-pills">
              {(['16:9', '9:16', '1:1', '4:5'] as const).map(ratio => (
                <Button
                  key={ratio}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionAspect === ratio}
                  data-active={options.motionAspect === ratio || undefined}
                  onClick={() => onChange({ motionAspect: ratio })}
                >
                  {ratio}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Duration')}</span>
            <div className="om-sa-popover-pills">
              {(['10s', '15s', '20s', '30s'] as const).map(dur => (
                <Button
                  key={dur}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionDuration === dur}
                  data-active={options.motionDuration === dur || undefined}
                  onClick={() => onChange({ motionDuration: dur })}
                >
                  {durationLabel(dur)}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Frame rate & style')}</span>
            <div className="om-sa-popover-pills">
              {(['30fps', '60fps'] as const).map(fps => (
                <Button
                  key={fps}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionFps === fps}
                  data-active={options.motionFps === fps || undefined}
                  onClick={() => onChange({ motionFps: fps })}
                >
                  {fps}
                </Button>
              ))}
            </div>
            <div className="om-sa-popover-pills">
              {(['kinetic', 'product', 'editorial', 'minimal'] as const).map(style => (
                <Button
                  key={style}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionStyle === style}
                  data-active={options.motionStyle === style || undefined}
                  onClick={() => onChange({ motionStyle: style })}
                >
                  {t(MOTION_STYLE_LABELS[style])}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Popover>
    );
  };

  if (modeId === 'media' || modeId === 'motion') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Motion graphics options')}>
        {renderMotionParamsPopover()}
      </div>
    );
  }

  if (modeId === 'deck') {
    const slidesLabel = options.deckSlides === 'auto' ? t('Auto') : options.deckSlides;
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Slides & Docs options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Deck format & length')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="slideshow-line" size={13} />
              <span className="om-sa-mode-param-label">{`${t(DECK_FORMAT_LABELS[options.deckFormat])} · ${slidesLabel}`}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Output format')}</span>
              <div className="om-sa-popover-pills">
                {(['slides', 'document', 'report'] as const).map(fmt => (
                  <Button
                    key={fmt}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckFormat === fmt}
                    data-active={options.deckFormat === fmt || undefined}
                    onClick={() => onChange({ deckFormat: fmt })}
                  >
                    {t(DECK_FORMAT_LABELS[fmt])}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Length')}</span>
              <div className="om-sa-popover-pills">
                {(['5-7', '8-12', '12-16', 'auto'] as const).map(len => (
                  <Button
                    key={len}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckSlides === len}
                    data-active={options.deckSlides === len || undefined}
                    onClick={() => onChange({ deckSlides: len })}
                  >
                    {len === 'auto' ? t('Auto') : len}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Density')}</span>
              <div className="om-sa-popover-pills">
                {(['visual', 'balanced', 'detailed'] as const).map(density => (
                  <Button
                    key={density}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckDensity === density}
                    data-active={options.deckDensity === density || undefined}
                    onClick={() => onChange({ deckDensity: density })}
                  >
                    {t(DECK_DENSITY_LABELS[density])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'coding') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Coding focus')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Coding focus')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="code-s-slash-line" size={13} />
              <span className="om-sa-mode-param-label">{t(CODING_FOCUS_LABELS[options.codingFocus])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Coding focus')}</span>
              <div className="om-sa-popover-pills">
                {(['general', 'debug', 'refactor', 'test', 'review'] as const).map(focus => (
                  <Button
                    key={focus}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.codingFocus === focus}
                    data-active={options.codingFocus === focus || undefined}
                    onClick={() => {
                      onChange({ codingFocus: focus });
                      setOpenMenu(null);
                    }}
                  >
                    {t(CODING_FOCUS_LABELS[focus])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'website') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Website & App options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Target viewport')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="layout-line" size={13} />
              <span className="om-sa-mode-param-label">{t(WEB_TARGET_LABELS[options.webTarget])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Target layout')}</span>
              <div className="om-sa-popover-pills">
                {(['responsive', 'mobile', 'dashboard'] as const).map(target => (
                  <Button
                    key={target}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.webTarget === target}
                    data-active={options.webTarget === target || undefined}
                    onClick={() => {
                      onChange({ webTarget: target });
                      setOpenMenu(null);
                    }}
                  >
                    {t(WEB_TARGET_LABELS[target])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  return null;
}
