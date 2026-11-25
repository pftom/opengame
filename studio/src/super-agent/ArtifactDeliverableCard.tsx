import { Button } from 'open-design-ui/button';
import { useState } from 'react';
import type { DesignExportFormat } from '../../../shared/design-project';
import { isPlayableAdArtifact, type SuperAgentArtifact } from '../../../shared/super-agent';
import type { WebPublishTargetKind } from '../../../shared/web-publish';
import { Popover } from '../components/ui/Popover';
import { WebPublishPopover } from '../components/WebPublishPopover';
import { designClient } from '../design/designClient';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export type DeliverableTone = 'agent' | 'coding' | 'image' | 'video' | 'audio';

export type ArtifactDeliverableMeta = {
  icon: string;
  tone: DeliverableTone;
  typeLabel: string;
  primaryActionLabel: string;
  primaryActionIcon: string;
};

export type ArtifactCloudTarget = {
  targetKind: WebPublishTargetKind;
  targetId: string;
  embedUrl?: string;
  filePath?: string;
};

export function artifactDeliverableMeta(artifact: SuperAgentArtifact): ArtifactDeliverableMeta {
  switch (artifact.kind) {
    case 'design-project':
      if (artifact.scenario === 'deck' || artifact.scenario === 'document') {
        return {
          icon: 'slideshow-line',
          tone: 'audio',
          typeLabel: 'Slides & Docs',
          primaryActionLabel: 'Open editor',
          primaryActionIcon: 'slideshow-line',
        };
      }
      return {
        icon: 'layout-line',
        tone: 'agent',
        typeLabel: 'Interactive Prototype',
        primaryActionLabel: 'Open editor',
        primaryActionIcon: 'layout-line',
      };
    case 'motion-project':
      return {
        icon: 'movie-line',
        tone: 'video',
        typeLabel: 'Motion Video',
        primaryActionLabel: 'Open editor',
        primaryActionIcon: 'movie-line',
      };
    case 'motion-export':
      return {
        icon: 'clapperboard-line',
        tone: 'video',
        typeLabel: 'Motion Video',
        primaryActionLabel: 'Play',
        primaryActionIcon: 'play-fill',
      };
    case 'asset-image':
      return {
        icon: 'image-line',
        tone: 'image',
        typeLabel: 'Image Artwork',
        primaryActionLabel: 'Preview',
        primaryActionIcon: 'eye-line',
      };
    case 'asset-video':
      return {
        icon: 'film-line',
        tone: 'video',
        typeLabel: 'Video Asset',
        primaryActionLabel: 'Play',
        primaryActionIcon: 'play-fill',
      };
    case 'asset-audio':
      return {
        icon: 'music-2-line',
        tone: 'audio',
        typeLabel: 'Audio Track',
        primaryActionLabel: 'Play',
        primaryActionIcon: 'play-fill',
      };
    case 'brand-kit':
      return {
        icon: 'palette-line',
        tone: 'image',
        typeLabel: 'Brand Kit',
        primaryActionLabel: 'Preview',
        primaryActionIcon: 'eye-line',
      };
    case 'game-project':
      return {
        icon: 'gamepad-line',
        tone: 'agent',
        typeLabel: 'HTML Game',
        primaryActionLabel: 'Play game',
        primaryActionIcon: 'play-fill',
      };
    case 'web':
      return {
        icon: 'global-line',
        tone: 'coding',
        typeLabel: 'Web Page',
        primaryActionLabel: 'Preview',
        primaryActionIcon: 'eye-line',
      };
    default:
      return {
        icon: 'file-line',
        tone: 'agent',
        typeLabel: 'Artifact',
        primaryActionLabel: 'Open',
        primaryActionIcon: 'arrow-right-up-line',
      };
  }
}

export function resolveArtifactCloudTarget(artifact: SuperAgentArtifact): ArtifactCloudTarget | null {
  if (artifact.kind === 'game-project') {
    const targetId = artifact.projectId || (artifact.id.startsWith('game:') ? artifact.id.slice('game:'.length) : '');
    if (!targetId) return null;
    if (artifact.projectId) {
      return { targetKind: 'game', targetId, filePath: artifact.entry };
    }
    if (artifact.url && /^https:\/\//i.test(artifact.url)) {
      return { targetKind: 'game', targetId, embedUrl: artifact.url };
    }
    return null;
  }
  if (artifact.kind === 'design-project' && artifact.projectId) {
    return { targetKind: 'design', targetId: artifact.projectId, filePath: artifact.entry };
  }
  if (artifact.kind === 'motion-project' && artifact.projectId) {
    return { targetKind: 'motion', targetId: artifact.projectId, filePath: artifact.entry };
  }
  return null;
}

const RAW_ARTIFACT_SUBTITLES = new Set([
  'prototype',
  'website',
  'deck',
  'document',
  'game',
  'motion',
  'video',
  'image',
  'audio',
  'brand-kit',
  'design-project',
  'motion-project',
  'game-project',
  'game studio',
  'design studio',
  'motion studio',
]);

const GAME_GENRE_LABELS: Readonly<Record<string, string>> = {
  platformer: 'Platformer',
  shooter: 'Shooter',
  story: 'Story',
  casual: 'Hyper-casual',
  racing: 'Racing',
  horror: 'Horror',
  arcade: 'Arcade',
  puzzle: 'Puzzle',
  rpg: 'RPG',
  strategy: 'Strategy',
  action: 'Action',
  simulation: 'Simulation',
  adventure: 'Adventure',
};

function formatArtifactSubDetail(rawSub: string, t: (key: string) => string): string {
  if (!rawSub) return '';
  const parts = rawSub
    .split('·')
    .map(part => part.trim())
    .filter(part => part && !RAW_ARTIFACT_SUBTITLES.has(part.toLowerCase()))
    .map(part => {
      const mappedGenre = GAME_GENRE_LABELS[part.toLowerCase()];
      return mappedGenre ? t(mappedGenre) : t(part);
    });
  return parts.join(' · ');
}

function safeFilenameSlug(title: string, fallback: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function appendDownloadParam(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (!parsed.searchParams.has('download')) {
      parsed.searchParams.set('download', '1');
    }
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.href;
  } catch {
    return rawUrl.includes('?') ? `${rawUrl}&download=1` : `${rawUrl}?download=1`;
  }
}

async function triggerFetchDownload(url: string, fallbackFilename: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Non-JSON error body; keep HTTP status.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  const plainMatch = disposition.match(/filename="([^"]+)"/i);
  const filename = utf8Match?.[1]
    ? decodeURIComponent(utf8Match[1])
    : plainMatch?.[1] || fallbackFilename;
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1500);
  return filename;
}

const DECK_EXPORT_OPTIONS: { format: DesignExportFormat; label: string; icon: string }[] = [
  { format: 'pdf', label: 'Export PDF', icon: 'file-line' },
  { format: 'pptx', label: 'Export PPTX', icon: 'slideshow-line' },
  { format: 'html', label: 'Export HTML', icon: 'global-line' },
  { format: 'zip', label: 'Export ZIP', icon: 'download-2-line' },
];

const WEB_EXPORT_OPTIONS: { format: DesignExportFormat; label: string; icon: string }[] = [
  { format: 'zip', label: 'Export ZIP', icon: 'download-2-line' },
  { format: 'html', label: 'Export HTML', icon: 'global-line' },
  { format: 'open-design', label: 'OpenDesign ZIP', icon: 'layout-line' },
];

export type ArtifactDeliverableCardProps = {
  artifact: SuperAgentArtifact;
  onOpenArtifactId: (artifactId: string) => void;
  onCopyText?: (text: string) => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
  onOpenAccountSettings?: () => void;
  onOpenInDesignStudio?: (projectId: string) => void;
  onOpenInMotionStudio?: (projectId: string) => void;
  onOpenInAssets?: (assetId: string, versionId?: string) => void;
  onOpenInBrandKit?: (kitId?: string) => void;
};

/**
 * Universal post-task deliverable card inside the Super Agent conversation stream.
 * Guides users from any generated artifact (HTML game, Design prototype/deck,
 * Motion video, media asset, Brand Kit, or web page) straight into Preview/Play,
 * OpenDesign Cloud deploy & sharing, or direct export/download.
 */
export function ArtifactDeliverableCard({
  artifact,
  onOpenArtifactId,
  onCopyText,
  onNotify,
  onOpenAccountSettings,
  onOpenInDesignStudio: _onOpenInDesignStudio,
  onOpenInMotionStudio: _onOpenInMotionStudio,
  onOpenInAssets,
  onOpenInBrandKit,
}: ArtifactDeliverableCardProps) {
  const { t } = useI18n();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  const meta = artifactDeliverableMeta(artifact);
  const rawSub = (artifact.subtitle ?? '').trim();
  const subDetail = formatArtifactSubDetail(rawSub, t);
  const subtitleText = isPlayableAdArtifact(artifact)
    ? t('Playable ad')
    : subDetail ? `${t(meta.typeLabel)} · ${subDetail}` : t(meta.typeLabel);
  const cloudTarget = resolveArtifactCloudTarget(artifact);

  const gameCoverSrc = artifact.kind === 'game-project' && artifact.projectId
    ? `/motion-api/games/${encodeURIComponent(artifact.projectId)}/play/assets/cover.png${artifact.revision ? `?rev=${encodeURIComponent(artifact.revision)}` : ''}`
    : null;
  const thumbUrl = !thumbFailed
    ? (artifact.kind === 'asset-image' && artifact.url ? artifact.url : gameCoverSrc)
    : null;
  const isWideThumb = Boolean(thumbUrl && artifact.kind === 'game-project');

  const isDeckDesign = artifact.kind === 'design-project'
    && (artifact.scenario === 'deck' || artifact.scenario === 'document');
  const designExportOptions = isDeckDesign ? DECK_EXPORT_OPTIONS : WEB_EXPORT_OPTIONS;

  const handleGameExport = async () => {
    if (!artifact.projectId || exportBusy) return;
    setExportBusy(true);
    try {
      const fallback = `${safeFilenameSlug(artifact.title, artifact.projectId)}.zip`;
      const filename = await triggerFetchDownload(
        `/motion-api/games/${encodeURIComponent(artifact.projectId)}/export`,
        fallback,
      );
      onNotify?.(t('Exported {name}', { name: filename }), 'info');
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : t('Export failed'), 'error');
    } finally {
      setExportBusy(false);
    }
  };

  const handleDesignExport = async (format: DesignExportFormat) => {
    if (!artifact.projectId || exportBusy) return;
    setExportMenuOpen(false);
    setExportBusy(true);
    try {
      const filename = await designClient.downloadExport(artifact.projectId, {
        format,
        filePath: artifact.entry ?? null,
      });
      onNotify?.(t('Exported {name}', { name: filename }), 'info');
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : t('Export failed'), 'error');
    } finally {
      setExportBusy(false);
    }
  };

  const handleDirectDownload = async (url: string, fallbackName: string) => {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      const filename = await triggerFetchDownload(url, fallbackName);
      onNotify?.(t('Downloaded {name}', { name: filename }), 'info');
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : t('Download failed'), 'error');
    } finally {
      setExportBusy(false);
    }
  };

  const mediaDownloadUrl =
    artifact.kind === 'motion-export'
      ? artifact.downloadUrl || artifact.url
      : ['asset-image', 'asset-video', 'asset-audio'].includes(artifact.kind)
        ? artifact.downloadUrl || (artifact.url ? appendDownloadParam(artifact.url) : undefined)
        : undefined;

  const isExternalWebUrl = artifact.kind === 'web' && Boolean(artifact.url && /^https?:\/\//i.test(artifact.url));

  return (
    <div
      className="om-sa-deliverable-card"
      data-kind={artifact.kind}
      data-wide-cover={isWideThumb || undefined}
    >
      <Button
        variant="plain"
        type="button"
        className="om-sa-deliverable-main"
        onClick={() => onOpenArtifactId(artifact.id)}
      >
        <span
          className="om-sa-deliverable-icon"
          data-tone={meta.tone}
          data-wide={isWideThumb || undefined}
          aria-hidden="true"
        >
          {thumbUrl ? (
            <img
              className="om-sa-deliverable-thumb"
              src={thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <RemixIcon name={meta.icon} size={20} />
          )}
        </span>
        <span className="om-sa-deliverable-meta">
          <strong>{artifact.title}</strong>
          <small>{subtitleText}</small>
        </span>
        <span className="om-sa-deliverable-open-cue" aria-hidden="true">
          <RemixIcon name={isExternalWebUrl ? 'arrow-right-up-line' : 'arrow-right-s-line'} size={16} />
        </span>
      </Button>

      <div className="om-sa-deliverable-actions" role="group" aria-label={t('Artifact actions')}>
        <Button
          variant="plain"
          type="button"
          className="om-sa-deliverable-btn"
          data-primary
          onClick={() => onOpenArtifactId(artifact.id)}
        >
          <RemixIcon name={meta.primaryActionIcon} size={13} />
          <span>{t(meta.primaryActionLabel)}</span>
        </Button>

        {cloudTarget && (
          <WebPublishPopover
            lazy
            compact
            side="top"
            align="start"
            targetKind={cloudTarget.targetKind}
            targetId={cloudTarget.targetId}
            embedUrl={cloudTarget.embedUrl}
            filePath={cloudTarget.filePath}
            title={artifact.title}
            revisionKey={artifact.revision ?? String(artifact.updatedAt)}
            triggerLabel={t('Share')}
            triggerIcon="share-forward-line"
            triggerClassName="om-sa-deliverable-btn"
            onOpenAccount={onOpenAccountSettings}
            onNotify={onNotify}
          />
        )}

        {artifact.kind === 'game-project' && artifact.projectId && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            disabled={exportBusy}
            onClick={() => void handleGameExport()}
          >
            <RemixIcon name={exportBusy ? 'loader-4-line' : 'download-2-line'} size={13} className={exportBusy ? 'om-sa-deliverable-spin' : undefined} />
            <span>{t('Export ZIP')}</span>
          </Button>
        )}

        {artifact.kind === 'design-project' && artifact.projectId && (
          <Popover
            open={exportMenuOpen}
            onOpenChange={setExportMenuOpen}
            side="top"
            align="start"
            initialFocus={false}
            aria-label={t('Export')}
            className="om-sa-browser-menu-popover"
            trigger={
              <Button
                variant="plain"
                type="button"
                className="om-sa-deliverable-btn"
                disabled={exportBusy}
                aria-expanded={exportMenuOpen}
              >
                <RemixIcon name={exportBusy ? 'loader-4-line' : 'download-2-line'} size={13} className={exportBusy ? 'om-sa-deliverable-spin' : undefined} />
                <span>{t('Export')}</span>
                <RemixIcon name="arrow-down-s-line" size={12} />
              </Button>
            }
          >
            <div className="om-sa-browser-menu" role="menu" aria-label={t('Export formats')}>
              {designExportOptions.map(option => (
                <Button
                  key={option.format}
                  variant="plain"
                  type="button"
                  role="menuitem"
                  className="om-sa-browser-menu-item"
                  onClick={() => void handleDesignExport(option.format)}
                >
                  <RemixIcon name={option.icon} size={14} />
                  <span>{t(option.label)}</span>
                </Button>
              ))}
            </div>
          </Popover>
        )}

        {mediaDownloadUrl && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            disabled={exportBusy}
            onClick={() => {
              const ext = artifact.kind === 'motion-export' || artifact.kind === 'asset-video'
                ? 'mp4'
                : artifact.kind === 'asset-audio'
                  ? 'mp3'
                  : 'png';
              void handleDirectDownload(mediaDownloadUrl, `${safeFilenameSlug(artifact.title, artifact.id)}.${ext}`);
            }}
          >
            <RemixIcon name={exportBusy ? 'loader-4-line' : 'download-2-line'} size={13} className={exportBusy ? 'om-sa-deliverable-spin' : undefined} />
            <span>{t('Download')}</span>
          </Button>
        )}

        {['asset-image', 'asset-video', 'asset-audio'].includes(artifact.kind) && artifact.assetId && onOpenInAssets && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            onClick={() => onOpenInAssets(artifact.assetId!, artifact.versionId)}
          >
            <RemixIcon name="folder-open-line" size={13} />
            <span>{t('Open in Assets')}</span>
          </Button>
        )}

        {artifact.kind === 'brand-kit' && artifact.kitId && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            disabled={exportBusy}
            onClick={() =>
              void handleDirectDownload(
                `/motion-api/brand-kits/${encodeURIComponent(artifact.kitId!)}/files/package.zip`,
                `${safeFilenameSlug(artifact.title, artifact.kitId!)}.zip`,
              )
            }
          >
            <RemixIcon name={exportBusy ? 'loader-4-line' : 'download-2-line'} size={13} className={exportBusy ? 'om-sa-deliverable-spin' : undefined} />
            <span>{t('Export ZIP')}</span>
          </Button>
        )}

        {artifact.kind === 'brand-kit' && onOpenInBrandKit && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            onClick={() => onOpenInBrandKit(artifact.kitId)}
          >
            <RemixIcon name="palette-line" size={13} />
            <span>{t('Open in Brand Kit')}</span>
          </Button>
        )}

        {isExternalWebUrl && onCopyText && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            onClick={() => onCopyText(artifact.url!)}
          >
            <RemixIcon name="link" size={13} />
            <span>{t('Copy link')}</span>
          </Button>
        )}

        {isExternalWebUrl && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-deliverable-btn"
            onClick={() => window.open(artifact.url!, '_blank', 'noopener,noreferrer')}
          >
            <RemixIcon name="external-link-line" size={13} />
            <span>{t('Open in browser')}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
