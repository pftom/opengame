export type CloudShareRef = {
  projectId: string;
  slug: string;
  shareUrl?: string;
  filePath?: string;
  version?: number;
};

export type CloudCommentAuthor = {
  kind: 'member' | 'user';
  authorKey: string;
  displayName?: string;
  memberId?: string;
};

export type CloudCommentPosition = {
  left: number;
  top: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type CloudCommentAttachmentMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export type CloudCommentAttachment = {
  id: string;
  mimeType: CloudCommentAttachmentMime;
  sizeBytes: number;
  width: number;
  height: number;
  alt?: string;
  url: string;
};

export type CloudCommentAttachmentInput = {
  uploadToken: string;
  alt?: string;
};

export type CloudCommentImageInput = {
  path?: string;
  filePath?: string;
  alt?: string;
};

export type CloudComment = {
  id: string;
  seq: number;
  parentCommentId?: string;
  replyToCommentId?: string;
  replyToAuthorName?: string;
  author: CloudCommentAuthor;
  isMine: boolean;
  note: string;
  attachments?: CloudCommentAttachment[];
  filePath: string;
  elementId: string;
  selector: string;
  htmlHint: string;
  anchoredVersion?: number;
  position?: CloudCommentPosition;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type CloudCommentThread = CloudComment & {
  replies: CloudComment[];
};

export type CloudCommentElement = {
  index: number;
  elementId: string;
  selector: string;
  htmlHint: string;
  tag: string;
  text: string;
  id?: string;
  className?: string;
  role?: string;
  ariaLabel?: string;
};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

function stripMountPrefix(parts: readonly string[]): { prefix: string; rest: string[] } {
  if (parts.length >= 2 && (parts[0] === 'cloud' || parts[0] === 'amr')) {
    return { prefix: `/${parts[0]}`, rest: parts.slice(1) };
  }
  return { prefix: '', rest: [...parts] };
}

function isValidShareSegment(value: string): boolean {
  return Boolean(
    value &&
      value !== '.' &&
      value !== '..' &&
      !/[/\\]/.test(value),
  );
}

export function isGameShareUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.searchParams.get('kind') === 'game') return true;
    const { rest } = stripMountPrefix(parsed.pathname.split('/').filter(Boolean));
    return rest.length === 2 && rest[0] === 'games' && isValidShareSegment(decodeURIComponent(rest[1]!).trim());
  } catch {
    return false;
  }
}

export function parseCloudShareUrl(rawUrl: string): {
  projectId: string;
  slug: string;
  origin: string;
  shareUrl: string;
  isGame?: boolean;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('INVALID_ARGUMENT: shareUrl must be a valid URL');
  }
  const allowedProtocol =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  if (!allowedProtocol) {
    throw new Error('INVALID_ARGUMENT: shareUrl must use https:// (or loopback http:// for local development)');
  }
  const { prefix, rest } = stripMountPrefix(parsed.pathname.split('/').filter(Boolean));
  if (rest.length === 2 && rest[0] === 'games') {
    const slug = decodeURIComponent(rest[1]!).trim();
    if (!isValidShareSegment(slug)) {
      throw new Error('INVALID_ARGUMENT: shareUrl contains an invalid slug');
    }
    return {
      projectId: '',
      slug,
      origin: parsed.origin,
      shareUrl: `${parsed.origin}${prefix}/games/${encodeURIComponent(slug)}`,
      isGame: true,
    };
  }
  if (rest.length < 3 || rest[0] !== 'artifact') {
    throw new Error('INVALID_ARGUMENT: shareUrl path must match /artifact/<projectId>/<slug> or /games/<slug>');
  }
  const projectId = decodeURIComponent(rest[1]!).trim();
  const slug = decodeURIComponent(rest[2]!).trim();
  if (!isValidShareSegment(projectId) || !isValidShareSegment(slug)) {
    throw new Error('INVALID_ARGUMENT: shareUrl contains an invalid projectId or slug');
  }
  const isGame = parsed.searchParams.get('kind') === 'game';
  return {
    projectId,
    slug,
    origin: parsed.origin,
    shareUrl: `${parsed.origin}${prefix}/artifact/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}${isGame ? '?kind=game' : ''}`,
    ...(isGame ? { isGame: true } : {}),
  };
}

export function groupCloudCommentThreads(comments: readonly CloudComment[]): CloudCommentThread[] {
  const roots: CloudComment[] = [];
  const repliesByParent = new Map<string, CloudComment[]>();
  for (const comment of comments) {
    if (comment.status === 'deleted') continue;
    if (comment.parentCommentId) {
      const bucket = repliesByParent.get(comment.parentCommentId);
      if (bucket) bucket.push(comment);
      else repliesByParent.set(comment.parentCommentId, [comment]);
    } else {
      roots.push(comment);
    }
  }
  roots.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
  return roots.map((root) => ({
    ...root,
    replies: [...(repliesByParent.get(root.id) ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || a.seq - b.seq,
    ),
  }));
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const SKIP_BODY_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const IGNORED_OUTPUT_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'base', 'script', 'style', 'noscript', 'template']);

type ParsedNode = {
  tag: string;
  attrs: Record<string, string>;
  htmlHint: string;
  selectorSegment: string;
  parent: ParsedNode | null;
  childTagCounts: Map<string, number>;
  textParts: string[];
  order: number;
};

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function parseAttributes(rawAttrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of rawAttrText.matchAll(attrPattern)) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    const rawVal = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(rawVal);
  }
  return attrs;
}

function escapeCssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function escapeCssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatHtmlHint(tag: string, attrs: Record<string, string>): string {
  const picked: string[] = [];
  for (const key of ['id', 'class', 'data-testid', 'role', 'aria-label', 'href', 'type']) {
    const val = attrs[key]?.trim();
    if (val) picked.push(`${key}="${val.slice(0, 48)}"`);
  }
  const joined = picked.length ? `<${tag} ${picked.join(' ')}>` : `<${tag}>`;
  return joined.length > 160 ? `${joined.slice(0, 157)}...>` : joined;
}

/**
 * Extracts commentable visible DOM elements with deterministic unique CSS
 * selectors (`#id`, `[data-testid="..."]`, or `:nth-of-type(...)` path) from
 * deployed static HTML without booting a browser.
 */
export function extractCommentableElements(
  html: string,
  options: { query?: string; limit?: number } = {},
): { elements: CloudCommentElement[]; totalElements: number } {
  const nodes: ParsedNode[] = [];
  const rootCounts = new Map<string, number>();
  const stack: ParsedNode[] = [];
  const idCounts = new Map<string, number>();
  const testIdCounts = new Map<string, number>();

  let pos = 0;
  const len = html.length;
  let order = 0;

  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      const tail = decodeHtmlEntities(html.slice(pos)).replace(/\s+/g, ' ').trim();
      if (tail && stack.length > 0) stack[stack.length - 1]!.textParts.push(tail);
      break;
    }
    if (lt > pos) {
      const text = decodeHtmlEntities(html.slice(pos, lt)).replace(/\s+/g, ' ').trim();
      if (text && stack.length > 0) stack[stack.length - 1]!.textParts.push(text);
    }
    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      pos = endComment === -1 ? len : endComment + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const endDecl = html.indexOf('>', lt + 2);
      pos = endDecl === -1 ? len : endDecl + 1;
      continue;
    }

    // Find closing `>` respecting quoted attribute values
    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < len) {
      const ch = html[gt]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt += 1;
    }
    if (gt >= len) break;

    const rawTag = html.slice(lt + 1, gt).trim();
    pos = gt + 1;
    if (!rawTag) continue;

    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1).trim().toLowerCase().split(/[\s/>]/)[0];
      if (!closingName) continue;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.tag === closingName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const stripped = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceIdx = stripped.search(/\s/);
    const tag = (spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx)).toLowerCase();
    if (!tag || !/^[a-z][a-z0-9-]*$/i.test(tag)) continue;

    const attrText = spaceIdx === -1 ? '' : stripped.slice(spaceIdx + 1);
    const attrs = parseAttributes(attrText);
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    const siblingMap = parent ? parent.childTagCounts : rootCounts;
    const nth = (siblingMap.get(tag) ?? 0) + 1;
    siblingMap.set(tag, nth);

    const elId = attrs.id?.trim();
    if (elId) idCounts.set(elId, (idCounts.get(elId) ?? 0) + 1);
    const testId = attrs['data-testid']?.trim();
    if (testId) testIdCounts.set(testId, (testIdCounts.get(testId) ?? 0) + 1);

    const node: ParsedNode = {
      tag,
      attrs,
      htmlHint: formatHtmlHint(tag, attrs),
      selectorSegment: nth === 1 && tag === 'body' ? 'body' : `${tag}:nth-of-type(${nth})`,
      parent,
      childTagCounts: new Map(),
      textParts: [],
      order: ++order,
    };
    nodes.push(node);

    const isVoid = selfClosing || VOID_TAGS.has(tag);
    if (!isVoid) {
      if (SKIP_BODY_TAGS.has(tag)) {
        const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
        const rest = html.slice(pos);
        const match = closeRe.exec(rest);
        pos = match ? pos + match.index + match[0].length : len;
      } else {
        stack.push(node);
      }
    }
  }

  const buildSelector = (node: ParsedNode): string => {
    const ownId = node.attrs.id?.trim();
    if (ownId && (idCounts.get(ownId) ?? 0) === 1 && /^[a-zA-Z_][\w:-]*$/.test(ownId)) {
      return `#${escapeCssIdentifier(ownId)}`;
    }
    const ownTestId = node.attrs['data-testid']?.trim();
    if (ownTestId && (testIdCounts.get(ownTestId) ?? 0) === 1) {
      return `[data-testid="${escapeCssAttrValue(ownTestId)}"]`;
    }
    const segments: string[] = [];
    let cur: ParsedNode | null = node;
    while (cur && segments.length < 256) {
      const curId = cur.attrs.id?.trim();
      if (cur !== node && curId && (idCounts.get(curId) ?? 0) === 1 && /^[a-zA-Z_][\w:-]*$/.test(curId)) {
        segments.push(`#${escapeCssIdentifier(curId)}`);
        break;
      }
      const curTestId = cur.attrs['data-testid']?.trim();
      if (cur !== node && curTestId && (testIdCounts.get(curTestId) ?? 0) === 1) {
        segments.push(`[data-testid="${escapeCssAttrValue(curTestId)}"]`);
        break;
      }
      if (cur.tag === 'html') break;
      segments.push(cur.selectorSegment);
      if (cur.tag === 'body') break;
      cur = cur.parent;
    }
    return segments.reverse().join(' > ');
  };

  const candidates: CloudCommentElement[] = [];
  for (const node of nodes) {
    if (IGNORED_OUTPUT_TAGS.has(node.tag)) continue;
    const text = node.textParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const id = node.attrs.id?.trim() || undefined;
    const testId = node.attrs['data-testid']?.trim() || undefined;
    const className = node.attrs.class?.trim() || undefined;
    const role = node.attrs.role?.trim() || undefined;
    const ariaLabel = node.attrs['aria-label']?.trim() || undefined;
    const selector = buildSelector(node);
    const elementId = id || testId || `om-el-${node.order}-${node.tag}`;
    if (!text && !id && !testId && !ariaLabel && !['img', 'button', 'input', 'textarea', 'select', 'section', 'article', 'canvas'].includes(node.tag)) {
      continue;
    }
    candidates.push({
      index: candidates.length,
      elementId,
      selector,
      htmlHint: node.htmlHint,
      tag: node.tag,
      text,
      ...(id ? { id } : {}),
      ...(className ? { className } : {}),
      ...(role ? { role } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
    });
  }

  const normalizedQuery = options.query?.trim().toLowerCase();
  const filtered = normalizedQuery
    ? candidates.filter((item) =>
        item.text.toLowerCase().includes(normalizedQuery) ||
        item.selector.toLowerCase().includes(normalizedQuery) ||
        item.elementId.toLowerCase().includes(normalizedQuery) ||
        item.htmlHint.toLowerCase().includes(normalizedQuery) ||
        item.tag.toLowerCase().includes(normalizedQuery) ||
        (item.ariaLabel?.toLowerCase().includes(normalizedQuery) ?? false),
      )
    : candidates;

  const limit = Math.max(1, Math.min(200, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 50));
  return {
    elements: filtered.slice(0, limit),
    totalElements: filtered.length,
  };
}
