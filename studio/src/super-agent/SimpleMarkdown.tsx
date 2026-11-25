import { Fragment, useMemo, type ReactNode } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

type TableAlign = 'left' | 'center' | 'right';

type ListItem = {
  text: string;
  checked?: boolean;
};

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; alignments: TableAlign[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'paragraph'; text: string };

const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(line: string, count: number): TableAlign[] {
  const parts = splitTableRow(line);
  return Array.from({ length: count }, (_, idx) => {
    const token = (parts[idx] ?? '').trim();
    const left = token.startsWith(':');
    const right = token.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  return lines[index].includes('|') && TABLE_SEPARATOR_RE.test(lines[index + 1]);
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^(\s*)```([\w-]*)\s*$/);
    if (fence) {
      const indent = fence[1] || '';
      const lang = fence[2] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        const raw = lines[i];
        codeLines.push(indent && raw.startsWith(indent) ? raw.slice(indent.length) : raw);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) && !/^\s*[-*]\s+\S/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const alignments = parseTableAlignments(lines[i + 1], headers.length);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = splitTableRow(lines[i]);
        while (row.length < headers.length) row.push('');
        rows.push(row.slice(0, headers.length));
        i++;
      }
      blocks.push({ type: 'table', headers, alignments, rows });
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const match = ordered ? lines[i].match(/^\s*\d+\.\s+(.+)$/) : lines[i].match(/^\s*[-*]\s+(.+)$/);
        if (!match) break;
        const body = match[1];
        const taskMatch = !ordered ? body.match(/^\[( |x|X)\]\s+(.+)$/) : null;
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === 'x' });
        } else {
          items.push({ text: body });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^\s*```/.test(lines[i])
      && !/^#{1,4}\s+/.test(lines[i])
      && !lines[i].startsWith('>')
      && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])
      && !(/^\s*(?:[-*_]\s*){3,}$/.test(lines[i]) && !/^\s*[-*]\s+\S/.test(lines[i]))
      && !isTableStart(lines, i)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }
  }
  return blocks;
}

function isInternalAppHref(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith('/api/') || trimmed.startsWith('/motion-api/');
}

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (isInternalAppHref(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeImageSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (isInternalAppHref(trimmed)) {
    return trimmed;
  }
  return safeHref(trimmed);
}

const LOCAL_FILE_EXT_RE = /\.(?:md|markdown|mdx|txt|json|jsonl|csv|tsx?|jsx?|mjs|cjs|css|scss|less|html?|py|sh|ya?ml|svg|png|jpe?g|webp|gif|pdf|glsl|wgsl|xml)$/i;
const INLINE_MARKDOWN_FILE_RE = /^(?:\.{0,2}\/|[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:md|markdown|mdx)(?:#[^\s`]+)?$/i;

function stripFileTargetMeta(raw: string): string {
  const withoutScheme = raw.trim().replace(/^file:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  return hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
}

function isLocalFileLinkTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  if (isInternalAppHref(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  const clean = stripFileTargetMeta(trimmed);
  if (!clean || isInternalAppHref(clean)) return false;
  return clean.startsWith('./') || clean.startsWith('../') || clean.startsWith('/') || LOCAL_FILE_EXT_RE.test(clean);
}

function formatFileChipLabel(fileRef: string): { fullPath: string; display: string; isMarkdown: boolean } {
  const clean = stripFileTargetMeta(fileRef);
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const display = parts.length <= 2 ? (clean || fileRef) : parts.slice(-2).join('/');
  return {
    fullPath: clean,
    display,
    isMarkdown: /\.(?:md|markdown|mdx)$/i.test(clean),
  };
}

type InlineRenderOptions = {
  onCopyCode?: (code: string) => void;
  onOpenWebUrl?: (url: string) => void;
  onOpenFilePath?: (filePath: string, label?: string) => void;
  openViewerLabel: string;
  copyPathLabel: string;
  /** Label shown instead of a published OpenDesign play link, which is never spelled out. */
  openLabel: string;
};

/** Published OpenDesign play links (games shared with OpenDesign): shown as "Open", never as the URL itself. */
export function isPublishedPlayLink(href: string) {
  return /^https?:\/\/(?:[\w-]+\.)*(?:open-design\.app\/artifact\/|opendesign\.app\/g\/)/i.test(href);
}

function renderLink(
  key: number,
  label: string,
  href: string,
  opts: InlineRenderOptions,
): ReactNode {
  if (isInternalAppHref(href)) {
    const isGameHref = /^\/(?:motion-api|api)\/games\//i.test(href);
    return (
      <Button
        key={key}
        variant="plain"
        type="button"
        className="om-sa-file-chip om-sa-artifact-inline-chip"
        onClick={() => {
          if (opts.onOpenWebUrl) {
            opts.onOpenWebUrl(href);
          } else {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        }}
      >
        <RemixIcon name={isGameHref ? 'play-fill' : 'eye-line'} size={12} />
        <span>{label}</span>
      </Button>
    );
  }
  return (
    <span key={key} className="om-sa-link-group">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="om-sa-link"
        onClick={event => {
          if (!opts.onOpenWebUrl) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          opts.onOpenWebUrl(href);
        }}
      >
        {label}
      </a>
      {opts.onOpenWebUrl && (
        <IconButton
          variant="plain"
          className="om-sa-link-viewer-btn"
          aria-label={opts.openViewerLabel}
          title={opts.openViewerLabel}
          onClick={() => opts.onOpenWebUrl?.(href)}
          icon={<RemixIcon name="arrow-right-up-line" size={12} />}
        />
      )}
    </span>
  );
}

function renderFileChip(
  key: number,
  rawTarget: string,
  label: string | undefined,
  opts: InlineRenderOptions,
): ReactNode {
  const { fullPath, display, isMarkdown } = formatFileChipLabel(rawTarget);
  const displayLabel = label || display;
  return (
    <Button
      key={key}
      variant="plain"
      type="button"
      className="om-sa-file-chip"
      title={opts.onOpenFilePath ? `${opts.openViewerLabel}: ${fullPath}` : `${opts.copyPathLabel}: ${fullPath}`}
      onClick={() => {
        if (opts.onOpenFilePath) {
          opts.onOpenFilePath(fullPath, displayLabel);
        } else {
          opts.onCopyCode?.(fullPath);
        }
      }}
    >
      <RemixIcon name={isMarkdown ? 'markdown-line' : 'file-text-line'} size={12} />
      <span>{displayLabel}</span>
    </Button>
  );
}

function renderInline(text: string, opts: InlineRenderOptions): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(!\[[^\]]*\]\((?:<[^>\n]+>|[^\s)]+)\)|`[^`\n]+`|\[[^\]]+\]\((?:<[^>\n]+>|file:\/\/\/[^)\n]+|\/[^)\n]+|\.{1,2}\/[^)\n]+|[^)\s]+)\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|https?:\/\/[^\s<>()]+|file:\/\/\/[^\s<>()]+|(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:md|markdown|mdx)(?:#[A-Za-z0-9_./:-]+)?(?![A-Za-z0-9_./:-]))/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push(text.slice(last, match.index));
    const full = match[0];

    if (full.startsWith('![')) {
      const altEnd = full.indexOf('](');
      const alt = full.slice(2, altEnd);
      const rawUrl = full.slice(altEnd + 2, -1).trim().replace(/^<([\s\S]*)>$/, '$1');
      const src = safeImageSrc(rawUrl);
      if (src) {
        tokens.push(
          <span key={key++} className="om-sa-md-image-wrap">
            <img src={src} alt={alt} loading="lazy" className="om-sa-md-image" />
          </span>,
        );
      } else {
        tokens.push(full);
      }
    } else if (full.startsWith('`')) {
      const inner = full.slice(1, -1);
      if (inner.startsWith('file://') && (opts.onOpenFilePath || opts.onCopyCode)) {
        tokens.push(renderFileChip(key++, inner, undefined, opts));
      } else if (opts.onOpenFilePath && INLINE_MARKDOWN_FILE_RE.test(inner)) {
        tokens.push(renderFileChip(key++, inner, undefined, opts));
      } else {
        tokens.push(<code key={key++} className="om-sa-inline-code">{inner}</code>);
      }
    } else if (full.startsWith('**')) {
      tokens.push(<strong key={key++}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('~~')) {
      tokens.push(<del key={key++} className="om-sa-md-del">{full.slice(2, -2)}</del>);
    } else if (full.startsWith('*')) {
      tokens.push(<em key={key++}>{full.slice(1, -1)}</em>);
    } else if (full.startsWith('[')) {
      const labelEnd = full.indexOf('](');
      const label = full.slice(1, labelEnd);
      const rawTarget = full.slice(labelEnd + 2, -1).trim().replace(/^<([\s\S]*)>$/, '$1');
      if (rawTarget.startsWith('file://') || isLocalFileLinkTarget(rawTarget)) {
        tokens.push(renderFileChip(key++, rawTarget, label, opts));
      } else {
        const href = safeHref(rawTarget);
        if (href) {
          tokens.push(renderLink(key++, isPublishedPlayLink(href) && /^https?:\/\//i.test(label) ? opts.openLabel : label, href, opts));
        } else {
          tokens.push(full);
        }
      }
    } else if (full.startsWith('file://')) {
      const trimmed = full.replace(/[.,;:!?)]+$/, '');
      const suffix = full.slice(trimmed.length);
      tokens.push(renderFileChip(key++, trimmed, undefined, opts));
      if (suffix) tokens.push(suffix);
    } else if (full.startsWith('http://') || full.startsWith('https://')) {
      const trimmed = full.replace(/[.,;:!?)]+$/, '');
      const suffix = full.slice(trimmed.length);
      const href = safeHref(trimmed);
      if (href) {
        tokens.push(renderLink(key++, isPublishedPlayLink(href) ? opts.openLabel : trimmed, href, opts));
      } else {
        tokens.push(trimmed);
      }
      if (suffix) tokens.push(suffix);
    } else {
      const prevChar = match.index > 0 ? text[match.index - 1] : '';
      const afterScheme = match.index >= 3 && text.slice(match.index - 3, match.index) === '://';
      const cleanStart = prevChar === '' || /[\s(>\[（【「"'`:：]/.test(prevChar);
      if (opts.onOpenFilePath && cleanStart && !afterScheme) {
        tokens.push(renderFileChip(key++, full, undefined, opts));
      } else {
        tokens.push(full);
      }
    }
    last = match.index + full.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

export function SimpleMarkdown({
  content,
  compact = false,
  onCopyCode,
  onOpenWebUrl,
  onOpenFilePath,
}: {
  content: string;
  compact?: boolean;
  onCopyCode?: (code: string) => void;
  onOpenWebUrl?: (url: string) => void;
  onOpenFilePath?: (filePath: string, label?: string) => void;
}) {
  const { t } = useI18n();
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const inlineOpts: InlineRenderOptions = {
    onCopyCode,
    onOpenWebUrl,
    onOpenFilePath,
    openViewerLabel: t('Open in Viewer'),
    copyPathLabel: t('Copy path'),
    openLabel: t('Open'),
  };

  return (
    <div className="om-sa-markdown" data-compact={compact || undefined}>
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="om-sa-code-card">
              <div className="om-sa-code-head">
                <span>{block.lang || 'text'}</span>
                {onCopyCode && (
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Copy code')}
                    onClick={() => onCopyCode(block.code)}
                    icon={<RemixIcon name="file-copy-line" size={14} />}
                  />
                )}
              </div>
              <pre className="om-sa-code-pre">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }
        if (block.type === 'hr') {
          return <hr key={index} className="om-sa-md-hr" />;
        }
        if (block.type === 'heading') {
          const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : block.level === 3 ? 'h5' : 'h6';
          return (
            <Tag key={index} className="om-sa-md-heading" data-level={block.level}>
              {renderInline(block.text, inlineOpts)}
            </Tag>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={index} className="om-sa-md-table-wrap">
              <table className="om-sa-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, ci) => (
                      <th key={ci} data-align={block.alignments[ci]}>
                        {renderInline(header, inlineOpts)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} data-align={block.alignments[ci]}>
                          {renderInline(cell, inlineOpts)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="om-sa-md-quote">
              {block.lines.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {renderInline(line, inlineOpts)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="om-sa-md-list">
              {block.items.map((item, i) => (
                <li key={i} className={item.checked !== undefined ? 'om-sa-md-task' : undefined}>
                  {item.checked !== undefined && (
                    <span className="om-sa-md-task-box" data-checked={item.checked || undefined} aria-hidden="true">
                      <RemixIcon name={item.checked ? 'checkbox-circle-line' : 'checkbox-blank-line'} size={14} />
                    </span>
                  )}
                  <span>{renderInline(item.text, inlineOpts)}</span>
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={index} className="om-sa-md-para">
            {block.text.split('\n').map((line, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {renderInline(line, inlineOpts)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
