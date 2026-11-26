import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import {
  isPaidWebPublishPlan,
  type WebPublicationRecord,
  type WebPublishMode,
  type WebPublishStatusResponse,
  type WebPublishTargetKind,
  type WebPublishVisibility,
} from '../../../shared/web-publish';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useAccountSummary } from '../motion/AccountSettings';
import { gatewayRequest } from '../motion/gatewayClient';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { newTrackingId, send } from '../motion/reporting';
import { Popover } from './ui/Popover';
import { WebPublishApiError, webPublishClient } from './webPublishClient';
import './webPublishPopover.css';

export interface WebPublishPopoverProps {
  targetKind: WebPublishTargetKind;
  targetId: string;
  filePath?: string;
  sourcePath?: string;
  embedUrl?: string;
  title?: string;
  revisionKey?: string;
  compact?: boolean;
  lazy?: boolean;
  disabled?: boolean;
  triggerLabel?: string;
  triggerIcon?: string;
  triggerClassName?: string;
  autoOpen?: boolean;
  onAutoOpenConsumed?: () => void;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  onNotify?: (message: string, variant?: 'info' | 'error') => void;
  onCopyUrl?: (url: string) => void | Promise<void>;
  onOpenAccount?: () => void;
}

type ActiveOp = WebPublishMode | 'stop' | 'visibility' | null;

function mergePublicationStatus(
  prev: WebPublishStatusResponse | null,
  targetKind: WebPublishTargetKind,
  targetId: string,
  publication: WebPublicationRecord,
  freshness: WebPublishStatusResponse['freshness'],
): WebPublishStatusResponse {
  const previousList = prev?.publications ?? [];
  const nextList = [publication, ...previousList.filter(item => item.filePath !== publication.filePath)];
  return {
    ...(prev ?? {}),
    targetKind: prev?.targetKind ?? targetKind,
    targetId: prev?.targetId ?? targetId,
    projectId: prev?.projectId ?? targetId,
    accountSignedIn: true,
    accountState: 'signed-in',
    freshness,
    fileCount: publication.fileCount,
    totalBytes: publication.totalBytes,
    bundledAssetCount: publication.bundledAssetCount ?? prev?.bundledAssetCount ?? 0,
    publications: nextList,
    deployments: nextList,
    active: publication,
  };
}

/**
 * Unified cloud-publishing popover used across Design Studio, Game Studio,
 * and Super Agent's Artifact Browser Pane. Handles all four publish target
 * kinds (`design`, `game`, `motion`, `html`), automatic local media bundling,
 * SHA-256 freshness detection, in-popover OpenDesign sign-in, and link access
 * lifecycle (`publish`, `resume`, `new_link`, `unpublish`).
 */
export function WebPublishPopover({
  targetKind,
  targetId,
  filePath,
  sourcePath,
  embedUrl,
  title,
  revisionKey,
  compact = false,
  lazy = false,
  disabled = false,
  triggerLabel,
  triggerIcon = 'share-forward-line',
  triggerClassName,
  autoOpen = false,
  onAutoOpenConsumed,
  side = 'bottom',
  align = 'end',
  onNotify,
  onCopyUrl,
  onOpenAccount,
}: WebPublishPopoverProps) {
  const { t } = useI18n();
  const [open, setOpenState] = useState(false);
  // Opening the popover is the share intent; the operations below report their observed results.
  const openRef = useRef(false);
  const setOpen = useCallback((next: boolean) => {
    if (next && !openRef.current) send('ui_click', { page_name: 'creative_studio', area: 'web_publish', element: 'open_publish', publish_target: targetKind });
    openRef.current = next;
    setOpenState(next);
  }, [targetKind]);
  const publishHookId = targetKind === 'game' ? 'game_publish_signin' as const : 'cloud_share_signin' as const;
  const reportPublish = useCallback((action: 'publish' | 'resume' | 'new_link' | 'stop' | 'copy_link' | 'sign_in', outcome: 'success' | 'failure' | 'cancelled',
    extra: { copied?: boolean; error_kind?: 'auth_required' | 'conflict' | 'other'; hook_id?: typeof publishHookId; entry_id?: string } = {}) => {
    send('web_publish_result', { publish_target: targetKind, action, outcome, publish_attempt_id: newTrackingId(), ...extra });
  }, [targetKind]);
  const { account, refresh: refreshAccount, setAccount } = useAccountSummary({ eager: !lazy });
  const [status, setStatus] = useState<WebPublishStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeOp, setActiveOp] = useState<ActiveOp>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [prepublishEnabled, setPrepublishEnabled] = useState(true);
  const [draftVisibility, setDraftVisibility] = useState<WebPublishVisibility>('public');
  const [showUpgradeHint, setShowUpgradeHint] = useState(false);
  const currentTargetKey = `${targetKind}:${targetId}:${filePath ?? ''}`;
  const deployAfterSignInTargetRef = useRef<string | null>(null);
  const prevAccountStateRef = useRef<AccountSummary['state'] | undefined>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    deployAfterSignInTargetRef.current = null;
    setOpen(false);
    setStatus(null);
    setError(null);
    setPrepublishEnabled(true);
    setDraftVisibility('public');
    setShowUpgradeHint(false);
    setCopied(false);
  }, [targetKind, targetId, filePath]);

  useEffect(() => {
    if (!autoOpen) return;
    setOpen(true);
    onAutoOpenConsumed?.();
  }, [autoOpen, onAutoOpenConsumed]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const refreshStatus = useCallback(async (refreshRemote = false) => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await webPublishClient.getStatus(targetKind, targetId, {
        filePath,
        sourcePath,
        embedUrl,
        title,
        refresh: refreshRemote,
      });
      setStatus(next);
      if (next.active?.visibility) {
        setDraftVisibility(next.active.visibility);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not check share status'));
    } finally {
      setLoading(false);
    }
  }, [embedUrl, filePath, sourcePath, t, targetId, targetKind, title]);

  useEffect(() => {
    if (!open) return;
    void refreshAccount();
    void refreshStatus(false);
  }, [open, targetId, filePath, revisionKey, refreshAccount, refreshStatus]);

  const copyUrl = useCallback(async (url: string, notifyUser = true) => {
    try {
      if (notifyUser && onCopyUrl) {
        await onCopyUrl(url);
      } else {
        await navigator.clipboard.writeText(url);
        if (notifyUser) onNotify?.(t('Share link copied'), 'info');
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      // A copy that follows a publish is part of that publish result.
      if (notifyUser) reportPublish('copy_link', 'success');
      return true;
    } catch {
      if (notifyUser) { reportPublish('copy_link', 'failure'); onNotify?.(t('Could not copy share link'), 'error'); }
      return false;
    }
  }, [onCopyUrl, onNotify, reportPublish, t]);

  const pub = status?.active ?? null;
  const linkStatus = pub?.status ?? 'none';
  const isPublished = linkStatus === 'published';
  const effectiveVisibility: WebPublishVisibility =
    isPublished ? (pub?.visibility ?? draftVisibility) : draftVisibility;

  const runMutation = useCallback(async (op: WebPublishMode | 'stop', copyOnSuccess = false) => {
    if (activeOp) return;
    setActiveOp(op);
    setError(null);
    try {
      if (op === 'stop') {
        const stopped = await webPublishClient.unpublish(targetKind, targetId, { filePath, sourcePath, embedUrl });
        setStatus(prev => mergePublicationStatus(prev, targetKind, targetId, stopped.publication, prev?.freshness ?? 'unknown'));
        if (stopped.publication.visibility) {
          setDraftVisibility(stopped.publication.visibility);
        }
        reportPublish('stop', 'success');
        onNotify?.(t('Share link disabled'), 'info');
        return;
      }

      const published = await webPublishClient.publish(targetKind, targetId, {
        filePath,
        sourcePath,
        embedUrl,
        deployMode: op,
        name: title,
        ...(targetKind === 'game' ? { visibility: effectiveVisibility } : {}),
      });
      setStatus(prev =>
        mergePublicationStatus(
          prev,
          targetKind,
          targetId,
          published.publication,
          published.publication.contentFingerprint ? 'fresh' : (prev?.freshness ?? 'unknown'),
        ),
      );

      const copiedLink = Boolean(published.url && copyOnSuccess) && await copyUrl(published.url!, false);
      reportPublish(op, 'success', { copied: copiedLink });
      if (published.url && copyOnSuccess) {
        onNotify?.(t('Deployed and copied share link'), 'info');
      } else if (op === 'resume') {
        onNotify?.(t('Share link reopened'), 'info');
      } else {
        onNotify?.(t('Cloud preview link updated'), 'info');
      }
    } catch (err) {
      if (err instanceof WebPublishApiError && err.code === 'PRIVATE_SHARE_REQUIRES_PAID_PLAN') {
        setShowUpgradeHint(true);
        setDraftVisibility('public');
        setError(null);
      } else {
        const msg = err instanceof Error ? err.message : t('Cloud share operation failed');
        setError(msg);
      }
      const authRequired = err instanceof WebPublishApiError && (err.status === 401 || err.code === 'AUTH_REQUIRED');
      reportPublish(op, 'failure', { error_kind: authRequired ? 'auth_required' : err instanceof WebPublishApiError && err.status === 409 ? 'conflict' : 'other' });
      if (err instanceof WebPublishApiError && (err.status === 401 || err.code === 'AUTH_REQUIRED')) {
        void refreshAccount();
      }
      if (err instanceof WebPublishApiError && err.status === 409) {
        void refreshStatus(false);
      }
    } finally {
      setActiveOp(null);
    }
  }, [activeOp, copyUrl, effectiveVisibility, embedUrl, filePath, onNotify, refreshAccount, refreshStatus, reportPublish, sourcePath, t, targetId, targetKind, title]);

  // Automatically continue deploying as soon as an in-popover OpenDesign sign-in completes for this exact target.
  useEffect(() => {
    const nextState = account?.state;
    const prevState = prevAccountStateRef.current;
    prevAccountStateRef.current = nextState;
    if (nextState === 'signed-in' && prevState && prevState !== 'signed-in') {
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      if (deployAfterSignInTargetRef.current === currentTargetKey) {
        deployAfterSignInTargetRef.current = null;
        void runMutation('publish', true);
      } else if (open) {
        void refreshStatus(false);
      }
    }
  }, [account?.state, currentTargetKey, open, refreshStatus, runMutation]);

  const handleAccountAction = async (action: 'login' | 'cancel') => {
    setAuthBusy(true);
    setError(null);
    const targetAtSignIn = currentTargetKey;
    deployAfterSignInTargetRef.current = action === 'login' ? targetAtSignIn : null;
    const entryId = action === 'login' ? newTrackingId() : undefined;
    if (action === 'login' && entryId) {
      send('ui_click', { page_name: 'creative_studio', area: 'web_publish', element: 'sign_in', publish_target: targetKind, hook_id: publishHookId, entry_id: entryId });
    }
    try {
      const payload = action === 'login' && entryId ? { hookId: publishHookId, entryId } : {};
      const next = await gatewayRequest<AccountSummary>(`settings/account/${action}`, 'POST', payload);
      // The sign-in itself is reported by the connector (account_sign_in_result); this records that it started from sharing.
      reportPublish('sign_in', action === 'cancel' ? 'cancelled' : 'success', entryId ? { hook_id: publishHookId, entry_id: entryId } : {});
      setAccount(next);
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      if (action === 'login' && next.state === 'signed-in' && deployAfterSignInTargetRef.current === targetAtSignIn) {
        deployAfterSignInTargetRef.current = null;
        void runMutation('publish', true);
      }
    } catch (err) {
      if (deployAfterSignInTargetRef.current === targetAtSignIn) deployAfterSignInTargetRef.current = null;
      if (action === 'login') reportPublish('sign_in', 'failure', { error_kind: 'other', ...(entryId ? { hook_id: publishHookId, entry_id: entryId } : {}) });
      setError(err instanceof Error ? err.message : t('Could not connect OpenDesign account'));
    } finally {
      setAuthBusy(false);
    }
  };

  const accountResolved = account !== null || status !== null;
  const accountState = account?.state ?? status?.accountState ?? (status?.accountSignedIn ? 'signed-in' : 'signed-out');
  const signedIn = accountState === 'signed-in';
  const authorizing = accountState === 'authorizing';
  const signInGateReportedRef = useRef(false);
  useEffect(() => {
    if (!open || signedIn) { signInGateReportedRef.current = false; return; }
    if (accountResolved && !authorizing && !signInGateReportedRef.current) {
      signInGateReportedRef.current = true;
      send('surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: publishHookId, publish_target: targetKind });
    }
  }, [open, accountResolved, signedIn, authorizing, publishHookId, targetKind]);
  const mutating = activeOp !== null;
  const isStopped = linkStatus === 'stopped';
  const linkAccessOn = isPublished || (linkStatus === 'none' && prepublishEnabled);
  const effectivePlan = status?.accountPlan ?? account?.plan ?? null;
  const canUsePrivateShare =
    typeof status?.canUsePrivateShare === 'boolean'
      ? status.canUsePrivateShare || (!status.accountPlan && isPaidWebPublishPlan(effectivePlan))
      : isPaidWebPublishPlan(effectivePlan);

  const handleSelectVisibility = async (next: WebPublishVisibility) => {
    if (mutating) return;
    if (next === 'unlisted' && !canUsePrivateShare) {
      setShowUpgradeHint(true);
      return;
    }
    setShowUpgradeHint(false);
    if (!isPublished || !pub) {
      setDraftVisibility(next);
      return;
    }
    if (pub.visibility === next) return;
    setActiveOp('visibility');
    setError(null);
    try {
      const updated = await webPublishClient.setVisibility(targetKind, targetId, {
        visibility: next,
        filePath,
        sourcePath,
        embedUrl,
      });
      setStatus(prev =>
        mergePublicationStatus(prev, targetKind, targetId, updated.publication, prev?.freshness ?? 'unknown'),
      );
      setDraftVisibility(updated.publication.visibility ?? next);
      onNotify?.(
        t(next === 'unlisted' ? 'Switched to link-only sharing' : 'Switched to public sharing'),
        'info',
      );
    } catch (err) {
      if (err instanceof WebPublishApiError && err.code === 'PRIVATE_SHARE_REQUIRES_PAID_PLAN') {
        setShowUpgradeHint(true);
      } else {
        setError(err instanceof Error ? err.message : t('Cloud share operation failed'));
      }
    } finally {
      setActiveOp(null);
    }
  };

  const handleToggleLinkAccess = () => {
    if (!signedIn || mutating) return;
    if (isPublished) void runMutation('stop');
    else if (isStopped) void runMutation('resume');
    else setPrepublishEnabled(v => !v);
  };

  const fileCount = status?.fileCount ?? pub?.fileCount ?? 0;
  const bundledAssetCount = status?.bundledAssetCount ?? pub?.bundledAssetCount ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align={align}
      initialFocus={false}
      aria-label={t('Cloud share')}
      className="om-web-publish-popover"
      trigger={
        <Button
          variant={compact ? 'plain' : 'ghost'}
          type="button"
          disabled={disabled}
          className={
            triggerClassName
              ? triggerClassName
              : compact
                ? 'om-web-publish-trigger om-web-publish-trigger--compact'
                : 'om-button om-web-publish-trigger'
          }
          data-primary={compact || triggerClassName ? undefined : true}
          data-active={open || undefined}
          data-live={isPublished || undefined}
          aria-label={triggerLabel ?? t('Share')}
          title={triggerLabel ?? t('Share')}
          aria-expanded={open}
        >
          <RemixIcon name={triggerIcon} size={14} />
          <span className="om-web-publish-trigger-label">{triggerLabel ?? t('Share')}</span>
          {isPublished && <span className="om-web-publish-dot" aria-hidden="true" />}
        </Button>
      }
    >
      <div className="om-web-publish-head">
        <div className="om-web-publish-head-title">
          <strong>{t('Share')}</strong>
          {isPublished && status?.freshness === 'outdated' && (
            <span className="om-web-publish-freshness" data-state="outdated">
              {t('Changes pending')}
            </span>
          )}
          {isPublished && status?.freshness === 'fresh' && (
            <span className="om-web-publish-freshness" data-state="fresh">
              {t('Up to date')}
            </span>
          )}
        </div>
        <div className="om-web-publish-head-actions">
          <IconButton
            variant="plain"
            className="om-web-publish-head-btn"
            aria-label={t('Refresh status')}
            title={t('Refresh status')}
            disabled={loading || mutating}
            onClick={() => void refreshStatus(true)}
            icon={<RemixIcon name="refresh-line" size={15} className={loading ? 'om-web-publish-spin' : undefined} />}
          />
          <IconButton
            variant="plain"
            className="om-web-publish-head-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={() => setOpen(false)}
            icon={<RemixIcon name="close-line" size={15} />}
          />
        </div>
      </div>

      {signedIn ? (
        <>
          {isStopped && (
            <p className="om-web-publish-banner" role="status">
              {t('The link is disabled. Turn Link access back on to reopen this preview.')}
            </p>
          )}

          <div className="om-web-publish-row">
            <div className="om-web-publish-row-text">
              <strong>{t('Link access')}</strong>
              <span>
                {targetKind === 'game'
                  ? t('Anyone with the link can play this game directly in their browser.')
                  : t('Recipients can view and play this live preview — not your conversation or code.')}
              </span>
            </div>
            <Button
              variant="plain"
              type="button"
              role="switch"
              aria-checked={linkAccessOn}
              aria-label={t('Link access')}
              disabled={mutating || (loading && !status)}
              className="om-web-publish-switch"
              onClick={handleToggleLinkAccess}
            >
              <span className="om-web-publish-switch-thumb" aria-hidden="true" />
            </Button>
          </div>

          {targetKind === 'game' && (
            <div className="om-web-publish-visibility" data-game-visibility-control="">
              <div className="om-web-publish-visibility-head">
                <strong>{t('Visibility')}</strong>
                {isPublished && (
                  <span
                    className="om-web-publish-community-pill"
                    data-tone={effectiveVisibility === 'public' ? 'public' : undefined}
                  >
                    {effectiveVisibility === 'unlisted'
                      ? t('Link only')
                      : pub?.feedStatus === 'featured' || pub?.feedStatus === 'approved'
                        ? t('In community')
                        : t('In review')}
                  </span>
                )}
              </div>
              <div className="om-web-publish-visibility-segment" role="radiogroup" aria-label={t('Visibility')}>
                <Button
                  variant="plain"
                  type="button"
                  role="radio"
                  aria-checked={effectiveVisibility === 'public'}
                  disabled={mutating}
                  className="om-web-publish-visibility-option"
                  data-selected={effectiveVisibility === 'public' ? 'true' : undefined}
                  onClick={() => void handleSelectVisibility('public')}
                >
                  <RemixIcon name="global-line" size={13} />
                  <span>{t('Public')}</span>
                </Button>
                <Button
                  variant="plain"
                  type="button"
                  role="radio"
                  aria-checked={effectiveVisibility === 'unlisted'}
                  disabled={mutating}
                  className="om-web-publish-visibility-option"
                  data-selected={effectiveVisibility === 'unlisted' ? 'true' : undefined}
                  data-visibility-option="unlisted"
                  onClick={() => void handleSelectVisibility('unlisted')}
                >
                  <RemixIcon name="eye-off-line" size={13} />
                  <span>{t('Unlisted')}</span>
                  {!canUsePrivateShare && (
                    <span className="om-web-publish-visibility-badge">{t('Go+')}</span>
                  )}
                </Button>
              </div>
              <p className="om-web-publish-visibility-hint">
                {effectiveVisibility === 'unlisted'
                  ? t('Only people with the link can play. Hidden from community and search.')
                  : canUsePrivateShare
                    ? t('Eligible for community discovery and Remix. Switch to Unlisted anytime.')
                    : t('Public by default. Great games may be featured in the community and remixed.')}
              </p>
              {showUpgradeHint && !canUsePrivateShare && (
                <div className="om-web-publish-upgrade-note" role="status" data-private-upgrade-hint="">
                  <span>
                    {t('Upgrade to Go+ to share games privately with link-only access.')}
                  </span>
                  <a
                    className="om-web-publish-upgrade-link"
                    href={`${(account?.consoleUrl || 'https://open-design.ai').replace(/\/$/, '')}/subscription`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>{t('Upgrade to Go+')}</span>
                    <RemixIcon name="external-link-line" size={12} />
                  </a>
                </div>
              )}
            </div>
          )}

          {isPublished && pub?.url && (
            <div className="om-web-publish-url-row">
              <RemixIcon name="link" size={13} />
              <span className="om-web-publish-url-text" title={pub.url}>{pub.url}</span>
              <a
                className="om-web-publish-url-open"
                href={pub.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('Open in new window')}
              >
                <RemixIcon name="external-link-line" size={13} />
              </a>
            </div>
          )}

          {error && (
            <div className="om-web-publish-error" role="alert">
              <RemixIcon name="error-warning-line" size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="om-web-publish-actions">
            {isPublished && pub?.url ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary
                  disabled={mutating}
                  onClick={() => void copyUrl(pub.url!)}
                >
                  <RemixIcon name={copied ? 'check-line' : 'link'} size={15} />
                  <span>{t(copied ? 'Share link copied' : 'Copy share link')}</span>
                </Button>
                {status?.freshness === 'outdated' && (
                  <Button
                    variant="ghost"
                    type="button"
                    className="om-button om-web-publish-full"
                    disabled={mutating}
                    onClick={() => void runMutation('publish')}
                  >
                    <RemixIcon
                      name={activeOp === 'publish' ? 'loader-4-line' : 'refresh-line'}
                      size={15}
                      className={activeOp === 'publish' ? 'om-web-publish-spin' : undefined}
                    />
                    <span>{t(activeOp === 'publish' ? 'Deploying update…' : 'Update live link')}</span>
                  </Button>
                )}
              </>
            ) : isStopped ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary
                  disabled={mutating}
                  onClick={() => void runMutation('resume')}
                >
                  <RemixIcon
                    name={activeOp === 'resume' ? 'loader-4-line' : 'refresh-line'}
                    size={15}
                    className={activeOp === 'resume' ? 'om-web-publish-spin' : undefined}
                  />
                  <span>{t(activeOp === 'resume' ? 'Reopening link…' : 'Reopen share link')}</span>
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  disabled={mutating}
                  onClick={() => void runMutation('new_link', true)}
                >
                  <RemixIcon
                    name={activeOp === 'new_link' ? 'loader-4-line' : 'upload-line'}
                    size={15}
                    className={activeOp === 'new_link' ? 'om-web-publish-spin' : undefined}
                  />
                  <span>{t('Publish new link')}</span>
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                data-primary
                disabled={mutating || loading || !prepublishEnabled}
                onClick={() => void runMutation('publish', true)}
              >
                <RemixIcon
                  name={activeOp === 'publish' ? 'loader-4-line' : 'upload-line'}
                  size={15}
                  className={activeOp === 'publish' ? 'om-web-publish-spin' : undefined}
                />
                <span>{t(activeOp === 'publish' ? 'Deploying to OpenDesign Cloud…' : 'Deploy & copy link')}</span>
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="om-web-publish-row-text">
            <strong>{t('Link access')}</strong>
            <span>
              {t('Sign in with your OpenDesign account to deploy this interactive preview and generate a shareable cloud link.')}
            </span>
          </div>

          {isPublished && pub?.url && (
            <>
              <div className="om-web-publish-url-row">
                <RemixIcon name="link" size={13} />
                <span className="om-web-publish-url-text" title={pub.url}>{pub.url}</span>
                <a
                  className="om-web-publish-url-open"
                  href={pub.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('Open in new window')}
                >
                  <RemixIcon name="external-link-line" size={13} />
                </a>
              </div>
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                onClick={() => void copyUrl(pub.url!)}
              >
                <RemixIcon name={copied ? 'check-line' : 'link'} size={15} />
                <span>{t(copied ? 'Share link copied' : 'Copy share link')}</span>
              </Button>
            </>
          )}

          {authorizing && (
            <div className="om-web-publish-auth-box" role="status">
              <div className="om-web-publish-auth-row">
                <RemixIcon name="loader-4-line" size={14} className="om-web-publish-spin" />
                <span>{t('Complete OpenDesign sign-in in your browser…')}</span>
              </div>
              {account?.userCode && (
                <code className="om-web-publish-auth-code">{account.userCode}</code>
              )}
              {account?.authorizationUrl && (
                <a
                  className="om-web-publish-auth-link"
                  href={account.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>{t('Open sign-in page')}</span>
                  <RemixIcon name="external-link-line" size={13} />
                </a>
              )}
            </div>
          )}

          {error && (
            <div className="om-web-publish-error" role="alert">
              <RemixIcon name="error-warning-line" size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="om-web-publish-actions">
            {authorizing ? (
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                disabled={authBusy}
                onClick={() => void handleAccountAction('cancel')}
              >
                <span>{t('Cancel sign-in')}</span>
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary={!(isPublished && pub?.url) || undefined}
                  disabled={authBusy}
                  onClick={() => void handleAccountAction('login')}
                >
                  <span className="om-opendesign-mark" aria-hidden="true" />
                  <span>
                    {t(accountState === 'reauth-required' ? 'Sign in again with OpenDesign' : 'Sign in with OpenDesign')}
                  </span>
                </Button>
                {onOpenAccount && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-button om-web-publish-full"
                    onClick={() => {
                      setOpen(false);
                      onOpenAccount();
                    }}
                  >
                    <span>{t('Open account settings')}</span>
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {status && (
        <div className="om-web-publish-meta">
          <span>
            {pub?.workspaceName || status.accountEmail || account?.user?.email || t('OpenDesign Cloud')}
            {pub?.version ? ` · v${pub.version}` : ''}
          </span>
          <span>
            {t('{count} files', { count: fileCount })}
            {bundledAssetCount > 0 ? ` · +${bundledAssetCount}` : ''}
          </span>
        </div>
      )}
    </Popover>
  );
}
