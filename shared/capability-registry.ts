import type { Modality, Model } from './gateway.ts';
import { modelCapabilities } from './model-capabilities.ts';

export type CapabilityModality = Modality | '3d';
export type CapabilityStatus = 'live' | 'coming_soon' | 'deprecated' | 'hidden';
export type CapabilityCategory = 'generate' | 'atomic-edit' | 'audio-voice' | 'pipeline';
export type CapabilityCostTier = 'low' | 'medium' | 'high';
export type CapabilityModelRequirement =
  | 'image-edit'
  | 'image-multi-reference'
  | 'image-transparent-background'
  | 'video-text-to-video';

export type CapabilityChoice = {
  value: string;
  label: string;
  prompt: string;
};

export type CapabilityControl = {
  key: string;
  label: string;
  defaultValue?: string;
  choices: readonly [CapabilityChoice, ...CapabilityChoice[]];
};

export function defaultCapabilityControlChoice(control: CapabilityControl): CapabilityChoice {
  return (control.defaultValue ? control.choices.find(choice => choice.value === control.defaultValue) : undefined)
    ?? control.choices[0];
}

export type CapabilityExecutor =
  | {
      kind: 'model';
      mode?: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
    }
  | {
      kind: 'prompt-preset';
      providers: readonly string[];
      models: readonly string[];
      modelRequires?: CapabilityModelRequirement;
      recommendedModel: string;
      mode?: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
      defaultParameters?: Record<string, unknown>;
      defaultDuration?: number;
      forceAudio?: boolean;
    }
  | {
      kind: 'dedicated-model';
      providers: readonly string[];
      models: readonly string[];
      recommendedModel: string;
      mode?: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
      defaultParameters?: Record<string, unknown>;
      optionToParameter?: Record<string, string>;
    }
  | {
      kind: 'service';
      serviceId: 'asr-transcribe';
    }
  | {
      kind: 'script';
      scriptId: string;
    };

export type CapabilityDefinition = {
  id: string;
  title: string;
  summary: string;
  modality: CapabilityModality;
  category: CapabilityCategory;
  icon: string;
  status: CapabilityStatus;
  channels: { gui: boolean; mcp: boolean };
  replacementCapabilityId?: string;
  costTier: CapabilityCostTier;
  requiresExplicitApproval: boolean;
  input: {
    promptRequired: boolean;
    minReferences: number;
    maxReferences: number;
    controls?: readonly CapabilityControl[];
  };
  executor: CapabilityExecutor;
};

export type CapabilityOverride = Partial<Pick<
  CapabilityDefinition,
  'title' | 'summary' | 'status' | 'channels' | 'replacementCapabilityId' | 'costTier' | 'requiresExplicitApproval' | 'executor'
>> & { id: string } & Partial<CapabilityDefinition>;

const openDesignFeatureProviders = ['opendesign', 'account'] as const;

export const relightCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'direction',
    label: 'Light direction',
    choices: [
      { value: 'left', label: 'Left side light', prompt: 'key light from the left side' },
      { value: 'right', label: 'Right side light', prompt: 'key light from the right side' },
      { value: 'front', label: 'Front light', prompt: 'soft frontal key light' },
      { value: 'top', label: 'Top light', prompt: 'overhead top light' },
      { value: 'back', label: 'Backlight', prompt: 'backlight with a rim of light around the subject' },
    ],
  },
  {
    key: 'temperature',
    label: 'Color temperature',
    choices: [
      { value: 'warm', label: 'Warm light', prompt: 'warm color temperature around 3200K' },
      { value: 'neutral', label: 'Neutral daylight', prompt: 'neutral daylight around 5600K' },
      { value: 'cool', label: 'Cool light', prompt: 'cool color temperature around 7500K' },
    ],
  },
  {
    key: 'mood',
    label: 'Lighting mood',
    choices: [
      { value: 'studio', label: 'Soft studio', prompt: 'soft, even studio lighting with gentle shadows' },
      { value: 'golden-hour', label: 'Golden hour', prompt: 'low golden-hour sunlight with long soft shadows' },
      { value: 'dramatic', label: 'Dramatic contrast', prompt: 'dramatic high-contrast lighting with deep shadows' },
      { value: 'neon', label: 'Neon night', prompt: 'colorful neon night lighting with glowing reflections' },
      { value: 'moonlight', label: 'Moonlight', prompt: 'dim blue moonlight' },
    ],
  },
];

export const cameraControlCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'movement',
    label: 'Camera movement',
    choices: [
      { value: 'push-in', label: 'Push in', prompt: 'slow steady dolly push-in toward the subject' },
      { value: 'pull-out', label: 'Pull out', prompt: 'smooth pull-back reveal widening to show the full scene' },
      { value: 'orbit', label: 'Orbit', prompt: 'continuous smooth 360-degree camera orbit around the subject' },
      { value: 'pan', label: 'Pan', prompt: 'fluid horizontal camera pan across the scene' },
      { value: 'crane-up', label: 'Crane up', prompt: 'sweeping crane shot rising upward' },
      { value: 'drone', label: 'Aerial drone', prompt: 'cinematic aerial drone tracking shot' },
      { value: 'static', label: 'Locked tripod', prompt: 'locked tripod static camera with all motion inside the frame' },
    ],
  },
  {
    key: 'pace',
    label: 'Motion pace',
    choices: [
      { value: 'slow', label: 'Slow cinematic', prompt: 'slow, deliberate cinematic pacing' },
      { value: 'smooth', label: 'Steady smooth', prompt: 'steady, balanced natural motion' },
      { value: 'dynamic', label: 'Dynamic', prompt: 'energetic, dynamic camera momentum' },
    ],
  },
];

export const multiShotCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'shots',
    label: 'Shot count',
    defaultValue: '3',
    choices: [
      { value: '2', label: '2 shots', prompt: 'a cohesive 2-shot sequence' },
      { value: '3', label: '3 shots', prompt: 'a cohesive 3-shot narrative sequence' },
      { value: '4', label: '4 shots', prompt: 'a cohesive 4-shot storyboard sequence' },
    ],
  },
  {
    key: 'style',
    label: 'Shot progression',
    choices: [
      { value: 'narrative', label: 'Wide → Medium → Close-up', prompt: 'progressing from an establishing wide shot to medium action and an intimate close-up' },
      { value: 'cut', label: 'Clean editorial cuts', prompt: 'connected by crisp editorial cuts keeping subject, wardrobe, and lighting consistent across shots' },
      { value: 'match', label: 'Match-cut flow', prompt: 'linked by seamless visual match cuts with unified color grading and atmosphere' },
    ],
  },
];

export const nativeAudioCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'audioStyle',
    label: 'Sound direction',
    choices: [
      { value: 'ambience', label: 'Natural ambience', prompt: 'rich synchronized natural environmental ambience and realistic foley sound effects' },
      { value: 'dialogue', label: 'Dialogue & voices', prompt: 'clear, natural synchronized spoken dialogue matching the character and scene acoustics' },
      { value: 'cinematic', label: 'Cinematic score', prompt: 'immersive cinematic sound design, impactful foley, and subtle atmospheric score' },
    ],
  },
];

export const upscaleCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'scale',
    label: 'Target scale',
    choices: [
      { value: '4x', label: '4K Ultra HD', prompt: '4K ultra-high-definition upscale' },
      { value: '2x', label: '2x Crisp HD', prompt: '2x crisp detail upscale' },
    ],
  },
];

export const lipsyncCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'syncMode',
    label: 'Lip-sync precision',
    choices: [
      { value: 'natural', label: 'Natural expression', prompt: 'natural facial micro-expressions and balanced lip sync' },
      { value: 'precise', label: 'Strict phoneme lock', prompt: 'frame-accurate phoneme lip articulation' },
    ],
  },
];

export const dubbingCapabilityControls: readonly CapabilityControl[] = [
  {
    key: 'targetLanguage',
    label: 'Target language',
    choices: [
      { value: 'zh-CN', label: 'Chinese (Mandarin)', prompt: 'dub into natural Mandarin Chinese' },
      { value: 'en', label: 'English', prompt: 'dub into natural English' },
      { value: 'ja', label: 'Japanese', prompt: 'dub into natural Japanese' },
      { value: 'es', label: 'Spanish', prompt: 'dub into natural Spanish' },
      { value: 'fr', label: 'French', prompt: 'dub into natural French' },
    ],
  },
  {
    key: 'preserveBgm',
    label: 'Background audio',
    choices: [
      { value: 'yes', label: 'Keep music & ambience', prompt: 'preserve original background music and ambience stems' },
      { value: 'voice-only', label: 'Voice track only', prompt: 'output isolated dubbed speech track only' },
    ],
  },
  {
    key: 'lipSync',
    label: 'Visual lip-sync',
    choices: [
      { value: 'off', label: 'Audio dubbing only', prompt: 're-voice audio without altering video pixels' },
      { value: 'on', label: 'Match speaker lips', prompt: 'synchronize speaker lip movements to translated audio' },
    ],
  },
];

/**
 * Canonical Unified Capability Center catalog shared across Studio GUI menus,
 * AssetComposer, HTTP routes, and MCP meta-tools.
 */
export const defaultCapabilities: readonly CapabilityDefinition[] = [
  // ==================== IMAGE: LIVE ====================
  {
    id: 'text-to-image',
    title: 'Create image',
    summary: 'Generate a standalone image from a text prompt into Workspace Assets.',
    modality: 'image',
    category: 'generate',
    icon: 'image-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 20 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'image-edit',
    title: 'Edit image',
    summary: 'Edit or fuse pinned reference images with a text instruction.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'edit-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 20 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'remove-background',
    title: 'Remove background',
    summary: 'Isolate the main subject from 1 reference image onto a clean transparent PNG background.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'scissors-cut-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1 },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'],
      modelRequires: 'image-transparent-background',
      recommendedModel: 'gpt-image-2.6-sunburst',
      mode: 'text-to-image',
      defaultParameters: { background: 'transparent' },
    },
  },
  {
    id: 'image-blend',
    title: 'Image blend',
    summary: 'Combine 2 to 5 pinned reference images seamlessly into one cohesive image with unified lighting and composition.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'layout-2-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 2, maxReferences: 5 },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'seedream-5.0-flash'],
      modelRequires: 'image-multi-reference',
      recommendedModel: 'gpt-image-2.6-sunburst',
      mode: 'text-to-image',
    },
  },
  {
    id: 'relight',
    title: 'Relight',
    summary: 'Change light direction, color temperature and mood on 1 reference image while preserving subject geometry and details.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'sun-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1, controls: relightCapabilityControls },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['seedream-5.5', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'seedream-5.0-flash'],
      modelRequires: 'image-edit',
      recommendedModel: 'seedream-5.5',
      mode: 'text-to-image',
    },
  },
  {
    id: 'character',
    title: 'Character reference',
    summary: 'Deprecated in favor of image-blend (combine 2 to 5 pinned reference images into one cohesive scene).',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'user-3-line',
    status: 'deprecated',
    replacementCapabilityId: 'image-blend',
    channels: { gui: false, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 2, maxReferences: 5 },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'seedream-5.0-flash'],
      modelRequires: 'image-multi-reference',
      recommendedModel: 'gpt-image-2.6-sunburst',
      mode: 'text-to-image',
    },
  },
  {
    id: 'shot-image',
    title: 'Video first frame',
    summary: 'Generate a framed still image ready to animate as a video first frame.',
    modality: 'image',
    category: 'generate',
    icon: 'camera-line',
    status: 'live',
    channels: { gui: false, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },

  // ==================== IMAGE: COMING SOON ====================
  {
    id: 'inpainting',
    title: 'Inpaint',
    summary: 'Regenerate a masked or targeted local region of an image while preserving surrounding pixels.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'edit-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'expand-image',
    title: 'Expand image',
    summary: 'Outpaint beyond the borders of an image to extend framing or adapt aspect ratios.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'expand-horizontal-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'upscale-4k',
    title: '4K upscale',
    summary: 'Upscale and sharpen an image asset to crisp 4K resolution.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'fullscreen-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1, controls: upscaleCapabilityControls },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'batch-set',
    title: 'Batch',
    summary: 'Generate a coordinated multi-angle or multi-ratio image set from one product or style reference.',
    modality: 'image',
    category: 'pipeline',
    icon: 'layout-grid-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 5 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },
  {
    id: 'image-layers',
    title: 'Image layers',
    summary: 'Decompose an image into editable foreground, subject and clean background layers.',
    modality: 'image',
    category: 'atomic-edit',
    icon: 'stack-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-image' },
  },

  // ==================== VIDEO: LIVE ====================
  {
    id: 'text-to-video',
    title: 'Create video',
    summary: 'Generate a video clip from a text prompt.',
    modality: 'video',
    category: 'generate',
    icon: 'film-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 0 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'image-to-video',
    title: 'Image to video',
    summary: 'Animate 1 pinned first-frame image asset into a motion video clip.',
    modality: 'video',
    category: 'generate',
    icon: 'movie-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'camera-control',
    title: 'Camera control',
    summary: 'Direct structured camera movement and pacing with an optional pinned first frame.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'camera-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 1, controls: cameraControlCapabilityControls },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115', 'wan-2.7'],
      modelRequires: 'video-text-to-video',
      recommendedModel: 'doubao-seedance-2-5-260628',
      mode: 'text-to-video',
    },
  },
  {
    id: 'multi-shot',
    title: 'Multi-shot',
    summary: 'Direct a connected 2–4 shot sequence in a single coherent video clip.',
    modality: 'video',
    category: 'pipeline',
    icon: 'clapperboard-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 1, controls: multiShotCapabilityControls },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115', 'wan-2.7'],
      modelRequires: 'video-text-to-video',
      recommendedModel: 'doubao-seedance-2-5-260628',
      mode: 'text-to-video',
      defaultDuration: 10,
    },
  },
  {
    id: 'native-audio',
    title: 'Native audio video',
    summary: 'Generate video with synchronized environmental ambience, dialogue or cinematic score.',
    modality: 'video',
    category: 'generate',
    icon: 'volume-up-line',
    status: 'live',
    channels: { gui: false, mcp: true },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 1, controls: nativeAudioCapabilityControls },
    executor: {
      kind: 'prompt-preset',
      providers: openDesignFeatureProviders,
      models: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115', 'wan-2.7'],
      modelRequires: 'video-text-to-video',
      recommendedModel: 'doubao-seedance-2-5-260628',
      mode: 'text-to-video',
      forceAudio: true,
    },
  },

  // ==================== VIDEO: COMING SOON ====================
  {
    id: 'start-end-frames',
    title: 'Start & end frames',
    summary: 'Bridge two pinned keyframe images into a continuous video transition.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'slideshow-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 2, maxReferences: 2 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'omni-reference',
    title: 'Omni reference',
    summary: 'Combine images, video clips and audio references to guide subjects, motion and style in one video clip.',
    modality: 'video',
    category: 'generate',
    icon: 'stack-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 5 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'video-edit',
    title: 'Edit video',
    summary: 'Modify subjects, outfits or backgrounds in an existing video clip.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'edit-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 2 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'video-extend',
    title: 'Extend',
    summary: 'Continue motion and audio seamlessly beyond the end of an existing video clip.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'time-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'video-upscale-4k',
    title: '4K upscale',
    summary: 'Upscale and temporally stabilize a video clip to 4K resolution.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'fullscreen-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'motion-control',
    title: 'Motion control',
    summary: 'Drive subject or object trajectories along explicit motion paths.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'route-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: 'lipsync',
    title: 'Lip sync',
    summary: 'Synchronize facial lip movements in a portrait image or video clip to a speech audio asset.',
    modality: 'video',
    category: 'atomic-edit',
    icon: 'voiceprint-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 2, maxReferences: 2, controls: lipsyncCapabilityControls },
    executor: { kind: 'model', mode: 'text-to-video' },
  },

  // ==================== AUDIO & VOICE: LIVE + COMING SOON ====================
  {
    id: 'music',
    title: 'Music',
    summary: 'Generate instrumental music or sound effects from mood, tempo and style prompts.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'music-2-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 0 },
    executor: { kind: 'model', mode: 'text-to-audio' },
  },
  {
    id: 'speech',
    title: 'Text to speech',
    summary: 'Synthesize spoken narration or dialogue from text with a selected voice model.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'voiceprint-line',
    status: 'live',
    channels: { gui: true, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 0 },
    executor: { kind: 'model', mode: 'text-to-speech' },
  },
  {
    id: 'asr-transcribe',
    title: 'Speech to text (ASR)',
    summary: 'Transcribe speech from an audio or video file into timestamped transcript segments.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'clipboard-line',
    status: 'live',
    channels: { gui: false, mcp: true },
    costTier: 'low',
    requiresExplicitApproval: false,
    input: { promptRequired: false, minReferences: 0, maxReferences: 1 },
    executor: { kind: 'service', serviceId: 'asr-transcribe' },
  },
  {
    id: 'voice-clone',
    title: 'Voice cloning',
    summary: 'Create a reusable voice profile from a clean 10–30 second speech sample.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'mic-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-speech' },
  },
  {
    id: 'voice-changer',
    title: 'Voice changer',
    summary: 'Convert a source voice recording into a target timbre while preserving prosody and timing.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'voiceprint-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'medium',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 2 },
    executor: { kind: 'model', mode: 'text-to-audio' },
  },
  {
    id: 'dubbing',
    title: 'Dubbing',
    summary: 'Translate and re-voice a video or audio track into target languages while preserving background stems.',
    modality: 'audio',
    category: 'pipeline',
    icon: 'global-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1, controls: dubbingCapabilityControls },
    executor: { kind: 'model', mode: 'text-to-speech' },
  },
  {
    id: 'stems',
    title: 'Isolate & stems',
    summary: 'Denoise or split mixed audio into isolated vocal, music and sound-effect stems.',
    modality: 'audio',
    category: 'audio-voice',
    icon: 'stack-line',
    status: 'coming_soon',
    channels: { gui: true, mcp: false },
    costTier: 'low',
    requiresExplicitApproval: true,
    input: { promptRequired: false, minReferences: 1, maxReferences: 1 },
    executor: { kind: 'model', mode: 'text-to-audio' },
  },

  // ==================== MULTIMODAL / 3D ROADMAP ====================
  {
    id: 'digital-human',
    title: 'Digital human presenter',
    summary: 'Create a reusable digital presenter identity and render talking-head footage with synchronized speech.',
    modality: 'video',
    category: 'pipeline',
    icon: 'user-3-line',
    status: 'coming_soon',
    channels: { gui: false, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 2 },
    executor: { kind: 'model', mode: 'text-to-video' },
  },
  {
    id: '3d-asset',
    title: '3D asset generation',
    summary: 'Generate textured 3D mesh assets (.glb) from text or product reference images.',
    modality: '3d',
    category: 'generate',
    icon: 'box-3-line',
    status: 'coming_soon',
    channels: { gui: false, mcp: false },
    costTier: 'high',
    requiresExplicitApproval: true,
    input: { promptRequired: true, minReferences: 0, maxReferences: 4 },
    executor: { kind: 'model' },
  },
];

export function resolveCapabilityCatalog(overrides: readonly CapabilityOverride[] = []): CapabilityDefinition[] {
  const byId = new Map<string, CapabilityDefinition>(
    defaultCapabilities.map(entry => [entry.id, { ...entry, channels: { ...entry.channels }, input: { ...entry.input } }]),
  );
  for (const patch of overrides) {
    if (!patch || typeof patch.id !== 'string' || !patch.id) continue;
    const base = byId.get(patch.id);
    if (base) {
      byId.set(patch.id, {
        ...base,
        ...patch,
        channels: patch.channels ? { ...base.channels, ...patch.channels } : base.channels,
        input: patch.input ? { ...base.input, ...patch.input } : base.input,
        executor: patch.executor ?? base.executor,
      });
    } else if (patch.title && patch.summary && patch.modality && patch.category && patch.executor) {
      byId.set(patch.id, {
        ...(patch as CapabilityDefinition),
        icon: patch.icon ?? 'sparkling-line',
        status: patch.status ?? 'live',
        channels: patch.channels ?? { gui: true, mcp: true },
        costTier: patch.costTier ?? 'low',
        requiresExplicitApproval: patch.requiresExplicitApproval ?? false,
        input: patch.input ?? { promptRequired: true, minReferences: 0, maxReferences: 1 },
      });
    }
  }
  return [...byId.values()];
}

export function findCapability(
  id: string,
  catalog: readonly CapabilityDefinition[] = defaultCapabilities,
): CapabilityDefinition | undefined {
  return catalog.find(item => item.id === id);
}

export function listCapabilitiesForChannel(
  catalog: readonly CapabilityDefinition[],
  channel: 'gui' | 'mcp',
  options: { modality?: CapabilityModality; includeComingSoon?: boolean } = {},
): CapabilityDefinition[] {
  return catalog.filter(entry => {
    if (options.modality && entry.modality !== options.modality) return false;
    if (entry.status === 'hidden' || entry.status === 'deprecated') return false;
    if (entry.status === 'coming_soon') {
      return Boolean(options.includeComingSoon && (channel === 'mcp' || entry.channels.gui));
    }
    return entry.channels[channel];
  });
}

function matchesModelRequirement(requirement: CapabilityModelRequirement, model: Model): boolean {
  const caps = modelCapabilities(model);
  if (requirement === 'image-transparent-background') {
    return caps.image.edit && caps.image.maxReferences >= 1 && caps.image.transparentBackground;
  }
  if (requirement === 'image-multi-reference') {
    return caps.image.edit && caps.image.maxReferences >= 2;
  }
  if (requirement === 'image-edit') {
    return caps.image.edit && caps.image.maxReferences >= 1;
  }
  return caps.video.textToVideo;
}

export function capabilitySupportsModel(capability: CapabilityDefinition, model: Model): boolean {
  if (capability.modality !== model.modality) return false;
  if (capability.executor.kind === 'prompt-preset') {
    if (!capability.executor.providers.includes(model.provider)) return false;
    if (capability.executor.modelRequires) {
      return matchesModelRequirement(capability.executor.modelRequires, model);
    }
    return capability.executor.models.includes(model.modelId);
  }
  if (capability.executor.kind === 'dedicated-model') {
    return capability.executor.providers.includes(model.provider)
      && capability.executor.models.includes(model.modelId);
  }
  if (capability.executor.kind === 'model') {
    if (capability.executor.mode && model.mode !== capability.executor.mode) return false;
    if (capability.input.minReferences > 0) {
      return Boolean(model.supportsImageReference || (model.maxInputImages ?? 0) > 0);
    }
    return !/^(image|video)-to-/.test(model.mode);
  }
  return false;
}

export function resolveCapabilityOptions(
  capability: CapabilityDefinition,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  const controls = capability.input.controls ?? [];
  const resolved: Record<string, unknown> = { ...options };
  for (const control of controls) {
    if (resolved[control.key] === undefined) {
      resolved[control.key] = defaultCapabilityControlChoice(control).value;
    }
  }
  return resolved;
}

export function buildCapabilityParameters(
  capability: CapabilityDefinition,
  options: Record<string, unknown> = {},
  extraParameters: Record<string, unknown> = {},
): Record<string, unknown> {
  if (capability.executor.kind === 'dedicated-model') {
    const effectiveOptions = resolveCapabilityOptions(capability, options);
    const mapped: Record<string, unknown> = { ...(capability.executor.defaultParameters ?? {}) };
    const keyMap = capability.executor.optionToParameter ?? {};
    for (const [key, value] of Object.entries(effectiveOptions)) {
      if (value !== undefined) mapped[keyMap[key] ?? key] = value;
    }
    return { ...mapped, ...extraParameters };
  }
  if (capability.executor.kind === 'prompt-preset') {
    return { ...(capability.executor.defaultParameters ?? {}), ...extraParameters };
  }
  return { ...extraParameters };
}

export function capabilityControlSchema(capability: CapabilityDefinition): Record<string, unknown> {
  const controls = capability.input.controls ?? [];
  const properties: Record<string, unknown> = {};
  for (const control of controls) {
    properties[control.key] = {
      type: 'string',
      description: control.label,
      enum: control.choices.map(choice => choice.value),
      default: defaultCapabilityControlChoice(control).value,
    };
  }
  return {
    type: 'object',
    properties,
    additionalProperties: controls.length === 0,
  };
}

export function buildCapabilityPrompt(
  capabilityId: string,
  prompt: string,
  options: Record<string, unknown> = {},
  catalog: readonly CapabilityDefinition[] = defaultCapabilities,
): string {
  const note = prompt.trim();
  const capability = findCapability(capabilityId, catalog);
  if (capabilityId === 'remove-background') {
    return 'Remove the entire background and isolate only the main subject cleanly on a transparent background. '
      + 'Keep the subject identical in shape, texture, and lighting.' + (note ? ' ' + note : '');
  }
  if (capabilityId === 'relight') {
    const controls = capability?.input.controls ?? relightCapabilityControls;
    const light = controls
      .map(control => (control.choices.find(choice => choice.value === options[control.key]) ?? defaultCapabilityControlChoice(control)).prompt)
      .join(', ');
    return 'Relight this image. Keep the subject, composition, pose and every detail unchanged; change only the lighting, shadows and reflections. '
      + `Lighting: ${light}.` + (note ? ' ' + note : '');
  }
  if (capabilityId === 'image-blend') {
    return 'Combine the provided reference images (Image 1, Image 2, and any additional images in order) seamlessly into a single cohesive image with unified lighting, perspective, shadows, and color harmony. '
      + note;
  }
  if (capabilityId === 'camera-control' || capabilityId === 'multi-shot' || capabilityId === 'native-audio') {
    if (!note) return '';
    const controls = capability?.input.controls ?? [];
    const parts = controls.map(control => (control.choices.find(choice => choice.value === options[control.key]) ?? defaultCapabilityControlChoice(control)).prompt);
    if (capabilityId === 'camera-control') return `Camera direction: ${parts.join(', ')}. Scene: ${note}`;
    if (capabilityId === 'multi-shot') return `Multi-shot direction: ${parts.join(', ')}. Story: ${note}`;
    return `Audio direction: ${parts.join(', ')}. Scene: ${note}`;
  }
  return note;
}
