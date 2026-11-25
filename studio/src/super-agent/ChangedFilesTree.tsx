import { useMemo, useState, type CSSProperties } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type { SuperAgentFileOperation } from '../../../shared/super-agent';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export type ChangedTreeNode =
  | {
      kind: 'directory';
      name: string;
      dirPath: string;
      fileCount: number;
      children: ChangedTreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      path: string;
      file: SuperAgentFileOperation;
    };

const ROOT_PRIORITY_FILES = [
  'index.html',
  'style.css',
  'styles.css',
  'logic.js',
  'client.js',
  'main.js',
  'game.js',
  'app.js',
];

const INSPECTABLE_EXT_RE =
  /\.(?:html?|css|scss|less|m?js|cjs|tsx?|jsx?|json|md|markdown|txt|csv|ya?ml|xml|svg|glsl|wgsl|vert|frag)$/i;

export function isInspectableChangedFile(filePath: string): boolean {
  return INSPECTABLE_EXT_RE.test(filePath.trim());
}

export function normalizeChangedFilePath(raw: string): string {
  const scratchMatch = raw.match(/super-agent\/work\/[^/]+\/(.+)$/);
  const cleaned = (scratchMatch?.[1] ?? raw)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
  return cleaned || raw;
}

export function compactDirLabel(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || dir;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function formatCompactBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function changedFileMeta(filePath: string, binary?: boolean): { icon: string; tone: string } {
  const lower = filePath.toLowerCase();
  if (/\.(?:html?|xml)$/.test(lower)) return { icon: 'code-s-slash-line', tone: 'html' };
  if (/\.(?:css|scss|less)$/.test(lower)) return { icon: 'palette-line', tone: 'css' };
  if (/\.(?:m?js|cjs|jsx)$/.test(lower)) return { icon: 'braces-line', tone: 'js' };
  if (/\.tsx?$/.test(lower)) return { icon: 'braces-line', tone: 'ts' };
  if (/\.json$/.test(lower)) return { icon: 'braces-line', tone: 'json' };
  if (/\.(?:md|markdown)$/.test(lower)) return { icon: 'markdown-line', tone: 'doc' };
  if (/\.(?:png|jpe?g|webp|gif|avif|svg|ico|bmp)$/.test(lower)) return { icon: 'file-image-line', tone: 'asset' };
  if (/\.(?:txt|csv|ya?ml|toml|ini)$/.test(lower)) return { icon: 'file-text-line', tone: 'plain' };
  if (binary) return { icon: 'file-line', tone: 'plain' };
  return { icon: 'file-code-line', tone: 'plain' };
}

type MutableDir = {
  dirs: Map<string, MutableDir>;
  files: Array<{ name: string; file: SuperAgentFileOperation }>;
};

function createMutableDir(): MutableDir {
  return { dirs: new Map(), files: [] };
}

function sortRootFileNames(a: string, b: string): number {
  const ai = ROOT_PRIORITY_FILES.indexOf(a.toLowerCase());
  const bi = ROOT_PRIORITY_FILES.indexOf(b.toLowerCase());
  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }
  return a.localeCompare(b);
}

function finalizeTreeNodes(dir: MutableDir, prefix: string, depth: number): ChangedTreeNode[] {
  const dirNodes: ChangedTreeNode[] = [];

  for (const [segment, sub] of dir.dirs) {
    let curName = segment;
    let curPath = prefix ? `${prefix}/${segment}` : segment;
    let curDir = sub;

    // Compact chains of single-child empty directories (e.g. src/components) for scannability.
    while (curDir.files.length === 0 && curDir.dirs.size === 1) {
      const next = curDir.dirs.entries().next().value as [string, MutableDir];
      curName = `${curName}/${next[0]}`;
      curPath = `${curPath}/${next[0]}`;
      curDir = next[1];
    }

    const children = finalizeTreeNodes(curDir, curPath, depth + 1);
    const fileCount = children.reduce(
      (sum, child) => sum + (child.kind === 'directory' ? child.fileCount : 1),
      0,
    );
    dirNodes.push({
      kind: 'directory',
      name: curName,
      dirPath: curPath,
      fileCount,
      children,
    });
  }

  dirNodes.sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes: ChangedTreeNode[] = dir.files
    .slice()
    .sort((a, b) => (depth === 0 ? sortRootFileNames(a.name, b.name) : a.name.localeCompare(b.name)))
    .map(item => ({
      kind: 'file',
      name: item.name,
      path: item.file.path,
      file: item.file,
    }));

  return [...dirNodes, ...fileNodes];
}

export function buildChangedFilesTree(files: SuperAgentFileOperation[]): ChangedTreeNode[] {
  const root = createMutableDir();
  for (const file of files) {
    const clean = normalizeChangedFilePath(file.path);
    const segments = clean.split('/').filter(Boolean);
    if (!segments.length) continue;
    let cur = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = cur.dirs.get(seg);
      if (!child) {
        child = createMutableDir();
        cur.dirs.set(seg, child);
      }
      cur = child;
    }
    cur.files.push({
      name: segments[segments.length - 1],
      file: { ...file, path: clean },
    });
  }
  return finalizeTreeNodes(root, '', 0);
}

function collectAllDirPaths(nodes: ChangedTreeNode[]): string[] {
  const dirs: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'directory') {
      dirs.push(node.dirPath);
      dirs.push(...collectAllDirPaths(node.children));
    }
  }
  return dirs;
}

export function UnifiedDiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split('\n').slice(0, 120), [diff]);
  return (
    <pre className="om-sa-diff-pre">
      <code className="om-sa-diff-code">
        {lines.map((line, i) => {
          const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
            ? 'meta'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx';
          return (
            <span key={i} className="om-sa-diff-line" data-kind={kind}>
              {line}
              {'\n'}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function ChangedTreeNodeList({
  nodes,
  depth,
  collapsedDirs,
  openDiffs,
  onToggleDir,
  onToggleFile,
  onCopyText,
  onOpenFile,
}: {
  nodes: ChangedTreeNode[];
  depth: number;
  collapsedDirs: Record<string, boolean>;
  openDiffs: Record<string, boolean>;
  onToggleDir: (dirPath: string) => void;
  onToggleFile: (file: SuperAgentFileOperation) => void;
  onCopyText: (text: string) => void;
  onOpenFile?: (file: SuperAgentFileOperation) => void;
}) {
  const { t } = useI18n();
  const indentStyle = { '--tree-depth': depth } as CSSProperties;

  return (
    <>
      {nodes.map(node => {
        if (node.kind === 'directory') {
          const isCollapsed = Boolean(collapsedDirs[node.dirPath]);
          return (
            <div key={`dir:${node.dirPath}`} className="om-sa-file-folder-item">
              <div className="om-sa-file-folder-row" style={indentStyle}>
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-file-folder-trigger"
                  aria-expanded={!isCollapsed}
                  title={node.dirPath}
                  onClick={() => onToggleDir(node.dirPath)}
                >
                  <span className="om-sa-file-folder-chevron" data-open={!isCollapsed || undefined} aria-hidden="true">
                    <RemixIcon name="arrow-right-s-line" size={13} />
                  </span>
                  <RemixIcon
                    name={isCollapsed ? 'folder-line' : 'folder-open-line'}
                    size={14}
                    className="om-sa-file-folder-icon"
                  />
                  <span className="om-sa-file-folder-name">{node.name}</span>
                  <span className="om-sa-file-folder-count">{node.fileCount}</span>
                </Button>
              </div>
              {!isCollapsed && (
                <div className="om-sa-file-folder-children">
                  <ChangedTreeNodeList
                    nodes={node.children}
                    depth={depth + 1}
                    collapsedDirs={collapsedDirs}
                    openDiffs={openDiffs}
                    onToggleDir={onToggleDir}
                    onToggleFile={onToggleFile}
                    onCopyText={onCopyText}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
            </div>
          );
        }

        const file = node.file;
        const canExpandInline = Boolean(file.diffPreview || file.previewUrl);
        const diffOpen = Boolean(openDiffs[file.path]);
        const meta = changedFileMeta(file.path, file.binary);
        const canOpenViewer = Boolean(onOpenFile && file.artifactId && isInspectableChangedFile(file.path));
        const hasLineStats =
          (file.addedLines !== undefined && file.addedLines > 0)
          || (file.removedLines !== undefined && file.removedLines > 0);
        const sizeLabel = !hasLineStats && file.sizeBytes !== undefined ? formatCompactBytes(file.sizeBytes) : '';

        return (
          <div key={`file:${file.path}`} className="om-sa-file-change-item">
            <div className="om-sa-file-change-row" style={indentStyle}>
              <Button
                variant="plain"
                type="button"
                className="om-sa-file-row-trigger"
                aria-expanded={canExpandInline ? diffOpen : undefined}
                title={file.path}
                onClick={() => onToggleFile(file)}
              >
                <span
                  className="om-sa-file-row-chevron"
                  data-open={diffOpen || undefined}
                  data-hidden={!canExpandInline || undefined}
                  aria-hidden="true"
                >
                  <RemixIcon name="arrow-down-s-line" size={13} />
                </span>
                <span className="om-sa-file-action-badge" data-action={file.action}>
                  {file.action === 'create' ? 'A' : file.action === 'delete' ? 'D' : 'M'}
                </span>
                <RemixIcon
                  name={meta.icon}
                  size={13}
                  className="om-sa-file-type-icon"
                  data-tone={meta.tone}
                />
                <span className="om-sa-file-path-text">{node.name}</span>
                <span className="om-sa-file-row-trail">
                  {hasLineStats ? (
                    <span className="om-sa-diff-badges">
                      {file.addedLines !== undefined && file.addedLines > 0 && (
                        <span className="om-sa-diff-add">+{file.addedLines}</span>
                      )}
                      {file.removedLines !== undefined && file.removedLines > 0 && (
                        <span className="om-sa-diff-del">-{file.removedLines}</span>
                      )}
                    </span>
                  ) : sizeLabel ? (
                    <span className="om-sa-file-size-badge">{sizeLabel}</span>
                  ) : null}
                </span>
              </Button>
              {canOpenViewer && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="om-sa-file-copy-btn"
                  aria-label={t('Open in Code Viewer')}
                  title={t('Open in Code Viewer')}
                  onClick={() => onOpenFile?.(file)}
                  icon={<RemixIcon name="external-link-line" size={12} />}
                />
              )}
              <IconButton
                variant="ghost"
                size="sm"
                className="om-sa-file-copy-btn"
                aria-label={t('Copy path')}
                title={t('Copy path')}
                onClick={() => onCopyText(file.path)}
                icon={<RemixIcon name="file-copy-line" size={12} />}
              />
            </div>
            {canExpandInline && diffOpen && (
              <div className="om-sa-file-diff-drawer">
                {file.diffPreview ? (
                  <UnifiedDiffView diff={file.diffPreview} />
                ) : file.previewUrl ? (
                  <div className="om-sa-file-image-drawer">
                    <img
                      className="om-sa-file-preview-img"
                      src={file.previewUrl}
                      alt={file.path}
                      loading="lazy"
                    />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function isInternalManagedStorageDir(rawDir?: string): boolean {
  if (!rawDir) return false;
  return /(?:Application Support[\\/]Open(?:Design|Motion)|AppData[\\/](?:Roaming|Local)[\\/]Open(?:Design|Motion)|\.config[\\/]open(?:design|motion)|[\\/]super-agent[\\/]work[\\/])/i.test(rawDir);
}

export function FilesChangedCard({
  files,
  projectDir,
  defaultExpanded = true,
  onCopyText,
  onOpenFile,
}: {
  files: SuperAgentFileOperation[];
  projectDir?: string;
  defaultExpanded?: boolean;
  onCopyText: (text: string) => void;
  onOpenFile?: (file: SuperAgentFileOperation) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({});

  const tree = useMemo(() => buildChangedFilesTree(files), [files]);
  const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);

  if (!files.length) return null;

  const totalAdd = files.reduce((sum, f) => sum + (f.addedLines ?? 0), 0);
  const totalDel = files.reduce((sum, f) => sum + (f.removedLines ?? 0), 0);
  const anyDirExpanded = allDirPaths.some(dirPath => !collapsedDirs[dirPath]);

  const handleToggleAllDirs = () => {
    if (anyDirExpanded) {
      const next: Record<string, boolean> = {};
      for (const dirPath of allDirPaths) next[dirPath] = true;
      setCollapsedDirs(next);
    } else {
      setCollapsedDirs({});
    }
  };

  const handleToggleFile = (file: SuperAgentFileOperation) => {
    if (file.diffPreview || file.previewUrl) {
      setOpenDiffs(prev => ({ ...prev, [file.path]: !prev[file.path] }));
    } else if (onOpenFile && file.artifactId && isInspectableChangedFile(file.path)) {
      onOpenFile(file);
    } else {
      onCopyText(file.path);
    }
  };

  return (
    <div className="om-sa-files-changed">
      <div className="om-sa-files-changed-head">
        <Button
          variant="plain"
          type="button"
          className="om-sa-files-changed-head-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          <span className="om-sa-files-changed-chevron" data-open={expanded || undefined}>
            <RemixIcon name="arrow-down-s-line" size={14} />
          </span>
          <RemixIcon name="file-code-line" size={14} />
          <span className="om-sa-files-changed-title">
            {t('Files changed ({count})', { count: files.length })}
          </span>
          {(totalAdd > 0 || totalDel > 0) && (
            <span className="om-sa-diff-badges">
              {totalAdd > 0 && <span className="om-sa-diff-add">+{totalAdd}</span>}
              {totalDel > 0 && <span className="om-sa-diff-del">-{totalDel}</span>}
            </span>
          )}
        </Button>

        {expanded && allDirPaths.length > 0 && (
          <div className="om-sa-files-changed-head-actions">
            <Button
              variant="plain"
              type="button"
              className="om-sa-files-head-action-btn"
              onClick={handleToggleAllDirs}
            >
              <RemixIcon name={anyDirExpanded ? 'folder-line' : 'folder-open-line'} size={13} />
              <span>{t(anyDirExpanded ? 'Collapse all' : 'Expand all')}</span>
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="om-sa-files-changed-list">
          <ChangedTreeNodeList
            nodes={tree}
            depth={0}
            collapsedDirs={collapsedDirs}
            openDiffs={openDiffs}
            onToggleDir={dirPath =>
              setCollapsedDirs(prev => ({ ...prev, [dirPath]: !prev[dirPath] }))
            }
            onToggleFile={handleToggleFile}
            onCopyText={onCopyText}
            onOpenFile={onOpenFile}
          />
          {projectDir && !isInternalManagedStorageDir(projectDir) && (
            <div className="om-sa-files-changed-foot">
              <Tooltip label={t('Copy project directory')}>
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-files-dir-btn"
                  onClick={() => onCopyText(projectDir)}
                >
                  <RemixIcon name="folder-line" size={12} />
                  <code>{projectDir}</code>
                  <RemixIcon name="file-copy-line" size={12} />
                </Button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
