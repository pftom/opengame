import { Button } from 'open-design-ui/button';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { designRoutes, findDesignScenario } from '../../../shared/design-project';
import {
  formatAttachmentBytes,
  resourceAttachmentKey,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCatalog,
  type SuperAgentResourceKind,
} from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';
import type { Translate } from '../i18n/manifest';
import { RemixIcon } from '../icons/RemixIcons';
import { genreLabels } from '../motion/game/gameCatalog';
import { fetchWorkspaceResources, uploadSuperAgentFile } from './superAgentClient';

export type ResourceCategoryTab =
  | 'all'
  | 'asset'
  | 'brand-kit'
  | 'motion-template'
  | 'design-template'
  | 'skills'
  | 'projects'
  | 'workflow'
  | 'model';

const CATEGORY_TABS: { id: ResourceCategoryTab; label: string; icon: string }[] = [
  { id: 'all', label: 'All resources', icon: 'apps-2-line' },
  { id: 'asset', label: 'Assets', icon: 'folder-open-line' },
  { id: 'brand-kit', label: 'Brand Kits', icon: 'palette-line' },
  { id: 'motion-template', label: 'Motion templates', icon: 'movie-line' },
  { id: 'design-template', label: 'Design templates', icon: 'layout-line' },
  { id: 'skills', label: 'Skill library', icon: 'sparkling-line' },
  { id: 'projects', label: 'Projects', icon: 'stack-line' },
  { id: 'workflow', label: 'Workflows', icon: 'route-line' },
  { id: 'model', label: 'Models', icon: 'robot-line' },
];

export function resourceKey(item: Pick<SuperAgentResourceAttachment, 'kind' | 'id' | 'versionId'>): string {
  return resourceAttachmentKey(item);
}

export function fileAttachmentIcon(filePath?: string, mimeType?: string): string {
  const lower = (filePath || '').toLowerCase();
  if (/\.mdx?$/.test(lower)) return 'markdown-line';
  if (/\.json$/.test(lower)) return 'braces-line';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|html?|css|scss|py|go|rs|sh|ya?ml|xml)$/.test(lower)) return 'file-code-line';
  if ((mimeType || '').startsWith('image/') || /\.(?:png|jpe?g|webp|gif|avif|svg)$/.test(lower)) return 'file-image-line';
  if (/\.(?:txt|csv|log|pdf)$/.test(lower) || (mimeType || '').startsWith('text/')) return 'file-text-line';
  return 'file-line';
}

const NON_IMAGE_URL_RE = /\.(?:x?html?|htm)(?:$|[?#])/i;

export function resourceImagePreviewUrl(
  item: Pick<SuperAgentResourceAttachment, 'kind' | 'modality' | 'mimeType' | 'previewUrl' | 'swatches' | 'annotation'>,
): string | null {
  const annotation = item.annotation;
  if (item.kind === 'browser-annotation' && annotation?.mode === 'design-comment'
    && annotation.projectId && annotation.commentId
    && annotation.screenshotSource !== 'saved-design-comment') {
    return designRoutes.commentPreview(annotation.projectId, annotation.commentId);
  }
  const raw = item.previewUrl?.trim();
  if (!raw || NON_IMAGE_URL_RE.test(raw) || /^data:text\/html\b/i.test(raw)) {
    return null;
  }
  switch (item.kind) {
    case 'motion-template':
    case 'game-project':
    case 'browser-annotation':
      return raw;
    case 'asset':
      return item.modality === 'image' ? raw : null;
    case 'file':
      return item.mimeType?.startsWith('image/') ? raw : null;
    case 'brand-kit':
      return item.swatches?.length ? null : raw;
    default:
      return null;
  }
}

export function ResourceThumbImage({
  src,
  className,
  fallback,
}: {
  src: string | null | undefined;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function resourceIcon(
  item: Pick<SuperAgentResourceAttachment, 'kind' | 'modality' | 'annotation' | 'filePath' | 'mimeType' | 'title' | 'scenario'>,
): string {
  if (item.kind === 'browser-annotation') {
    if (item.annotation?.mode === 'screenshot') return 'camera-line';
    if (item.annotation?.mode === 'console') return 'terminal-box-fill';
    if (item.annotation?.mode === 'motion-selection') return 'movie-line';
    if (item.annotation?.mode === 'design-comment') return 'chat-1-line';
    if (item.annotation?.mode === 'code-selection') return 'code-s-slash-line';
    return 'focus-3-line';
  }
  if (item.kind === 'file') return fileAttachmentIcon(item.filePath || item.title, item.mimeType);
  if (item.kind === 'folder') return 'folder-line';
  if (item.kind === 'chat') return 'chat-1-line';
  if (item.kind === 'asset' || item.kind === 'model') {
    if (item.modality === 'video') return 'movie-line';
    if (item.modality === 'audio') return 'music-2-line';
    return item.kind === 'model' ? 'robot-line' : 'image-line';
  }
  if (item.kind === 'brand-kit') return 'palette-line';
  if (item.kind === 'motion-template') return 'film-line';
  if (item.kind === 'design-template' || item.kind === 'design-project') {
    return findDesignScenario(item.scenario)?.icon ?? (item.kind === 'design-template' ? 'layout-line' : 'code-s-slash-line');
  }
  if (item.kind === 'skill' || item.kind === 'design-skill') return 'sparkling-line';
  if (item.kind === 'motion-project') return 'clapperboard-line';
  if (item.kind === 'game-project') return 'gamepad-line';
  if (item.kind === 'workflow') return 'route-line';
  return 'code-s-slash-line';
}

export function resourceKindLabel(kind: SuperAgentResourceKind): string {
  switch (kind) {
    case 'asset': return 'Asset';
    case 'file': return 'File';
    case 'folder': return 'Folder';
    case 'chat': return 'Conversation';
    case 'brand-kit': return 'Brand Kit';
    case 'motion-template': return 'Motion template';
    case 'design-template': return 'Design template';
    case 'skill': return 'Creative skill';
    case 'design-skill': return 'Design skill';
    case 'design-project': return 'Design project';
    case 'motion-project': return 'Motion project';
    case 'workflow': return 'Workflow';
    case 'model': return 'Model';
    case 'game-project': return 'Game project';
    case 'browser-annotation': return 'Browser annotation';
    default: return 'Resource';
  }
}

export function resourceDisplayTitle({ kind, title }: SuperAgentResourceAttachment, t: Translate): string {
  return kind === 'skill' || kind === 'design-skill' || kind === 'workflow' ? t(title) : title;
}

export function resourceDisplaySubtitle({ kind, subtitle, scenario, modality, sizeBytes }: SuperAgentResourceAttachment, t: Translate): string | undefined {
  if (kind === 'file') {
    const size = formatAttachmentBytes(sizeBytes);
    const cleanSub = subtitle === 'Uploaded file' ? t('Uploaded file') : subtitle;
    return [cleanSub, size].filter(Boolean).join(' · ') || undefined;
  }
  if (kind === 'folder' || kind === 'chat') return subtitle ? t(subtitle) : undefined;
  if (!subtitle) return undefined;
  if (kind === 'model' || kind === 'browser-annotation') return subtitle;
  if (kind === 'asset') {
    if (subtitle === 'upload') return t('Local upload');
    if (subtitle === 'generated') return t('AI generated');
    if (subtitle !== modality) return subtitle;
    return t(modality === 'image' ? 'Image' : modality === 'video' ? 'Video' : 'Audio');
  }

  const scenarioLabel = findDesignScenario(scenario)?.label;
  return subtitle.split(' · ').map(part => {
    if (scenarioLabel && part === scenario) return t(scenarioLabel);
    if (kind === 'game-project' && Object.hasOwn(genreLabels, part)) {
      return t(genreLabels[part as keyof typeof genreLabels]);
    }
    return t(part);
  }).join(' · ');
}

export function ResourcePickerPanel({
  open,
  initialCategory = 'all',
  selected,
  onToggle,
  onClear,
  onAddItems,
  onUploaded,
  onError,
}: {
  open: boolean;
  initialCategory?: ResourceCategoryTab;
  selected: SuperAgentResourceAttachment[];
  onToggle: (item: SuperAgentResourceAttachment) => void;
  onClear: () => void;
  onAddItems: (items: SuperAgentResourceAttachment[]) => void;
  onUploaded?: () => void;
  onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const [category, setCategory] = useState<ResourceCategoryTab>(initialCategory);
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [catalog, setCatalog] = useState<SuperAgentResourceCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setCategory(initialCategory);
  }, [open, initialCategory]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    const timer = setTimeout(() => {
      void fetchWorkspaceResources({ kind: category, query: committedQuery, limit: 200, locale, signal: controller.signal })
        .then(result => {
          if (!cancelled) setCatalog(result);
        })
        .catch(() => {
          if (!cancelled && !controller.signal.aborted) setLoadFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, committedQuery ? 160 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, category, committedQuery, retryToken, locale]);

  const selectedKeys = new Set(selected.map(resourceKey));

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const added: SuperAgentResourceAttachment[] = [];
      for (const file of Array.from(files)) {
        added.push(await uploadSuperAgentFile(file));
      }
      onAddItems(added);
      setRetryToken(value => value + 1);
      onUploaded?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : t('Could not upload file'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="om-sa-resource-popover-body" onKeyDown={event => event.stopPropagation()}>
      <div className="om-sa-resource-popover-toolbar">
        <label className="om-sa-resource-search">
          <RemixIcon name={loading ? 'loader-4-line' : 'search-line'} size={14} />
          <input
            type="search"
            value={query}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={event => {
              const next = event.currentTarget.value;
              composingRef.current = false;
              setQuery(next);
              setCommittedQuery(next);
            }}
            onChange={event => {
              const next = event.target.value;
              setQuery(next);
              if (!composingRef.current && !(event.nativeEvent as InputEvent).isComposing) {
                setCommittedQuery(next);
              }
            }}
            placeholder={t('Search assets, Brand Kits, templates, skills…')}
            aria-label={t('Search workspace resources')}
          />
        </label>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={event => void handleUploadFiles(event.target.files)}
        />
        <Button
          variant="plain"
          type="button"
          className="om-sa-resource-upload-btn"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <RemixIcon name={uploading ? 'loader-4-line' : 'upload-2-line'} size={14} />
          <span>{t(uploading ? 'Uploading…' : 'Upload')}</span>
        </Button>
      </div>

      <div className="om-sa-resource-tabs" role="tablist" aria-label={t('Resource categories')}>
        {CATEGORY_TABS.map(tab => (
          <Button
            key={tab.id}
            variant="plain"
            type="button"
            role="tab"
            aria-selected={category === tab.id}
            className="om-sa-resource-tab"
            onClick={() => setCategory(tab.id)}
          >
            <RemixIcon name={tab.icon} size={13} />
            <span>{t(tab.label)}</span>
          </Button>
        ))}
      </div>

      <div className="om-sa-resource-popover-list" aria-busy={loading}>
        {loading && !catalog ? (
          Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="om-sa-resource-skeleton">
              <Skeleton style={{ width: '100%', height: 42 }} />
            </div>
          ))
        ) : loadFailed ? (
          <div className="om-empty om-sa-resource-empty">
            <RemixIcon name="error-warning-line" size={20} />
            <p>{t('Could not load workspace resources')}</p>
            <Button variant="ghost" className="om-button h-auto" onClick={() => setRetryToken(value => value + 1)}>
              {t('Retry')}
            </Button>
          </div>
        ) : !catalog?.items.length ? (
          <div className="om-empty om-sa-resource-empty">
            <RemixIcon name="folder-open-line" size={20} />
            <p>{t('No matching resources found')}</p>
          </div>
        ) : (
          catalog.items.map(item => {
            const isSelected = selectedKeys.has(resourceKey(item));
            const subtitle = resourceDisplaySubtitle(item, t);
            const thumbUrl = resourceImagePreviewUrl(item);
            const fallbackThumb = item.swatches?.length ? (
              <div className="om-sa-resource-swatches">
                {item.swatches.slice(0, 4).map((swatch, idx) => (
                  <span key={idx} style={{ background: swatch }} />
                ))}
              </div>
            ) : (
              <RemixIcon name={resourceIcon(item)} size={15} />
            );
            return (
              <Button
                key={resourceKey(item)}
                variant="plain"
                type="button"
                className="om-sa-resource-row"
                data-selected={isSelected || undefined}
                aria-pressed={isSelected}
                onClick={() => onToggle(item)}
              >
                <div className="om-sa-resource-thumb" aria-hidden="true">
                  <ResourceThumbImage src={thumbUrl} fallback={fallbackThumb} />
                </div>
                <div className="om-sa-resource-meta">
                  <strong>{resourceDisplayTitle(item, t)}</strong>
                  <small>{t(resourceKindLabel(item.kind))}{subtitle ? ` · ${subtitle}` : ''}</small>
                </div>
                <span className="om-sa-resource-check" aria-hidden="true">
                  {isSelected && <RemixIcon name="check-line" size={14} />}
                </span>
              </Button>
            );
          })
        )}
      </div>

      <footer className="om-sa-resource-popover-foot">
        <span className="om-muted">
          {catalog ? t('{count} matching', { count: catalog.items.length }) : ''}
          {selected.length > 0 ? ` · ${t('{count} selected', { count: selected.length })}` : ''}
        </span>
        {selected.length > 0 && (
          <Button variant="plain" type="button" className="om-sa-chip-clear" onClick={onClear}>
            {t('Clear')}
          </Button>
        )}
      </footer>
    </div>
  );
}
