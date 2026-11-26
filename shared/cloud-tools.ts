/**
 * Pure, browser-safe MCP tool schemas for OpenDesign Cloud deployment and
 * element-anchored 1-level comment/reply collaboration.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const relPath = { type: 'string', minLength: 1, maxLength: 240 };
const idStr = { type: 'string', minLength: 1, maxLength: 128 };
const noteSchema = { type: 'string', minLength: 0, maxLength: 4000 };

const cloudWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const cloudTools = [
  {
    name: 'openmotion_cloud_deploy',
    title: 'OpenMotion · Cloud Deploy',
    description:
      'Deploy HTML files, directories, Design Studio projects, playable Games (with optional public/unlisted visibility and allowRemix controls), or Motion HTML bundles to OpenDesign Cloud and manage live share links. Pass action="publish" with sourcePath (HTML file or folder) and optional title for standalone HTML materials, or targetKind + targetId for workspace projects (or action="visibility" to update game visibility). Returns shareUrl and share { projectId, slug } that can be inspected and commented via openmotion_cloud_comments. Requires OpenDesign sign-in.',
    inputSchema: obj(
      {
        action: {
          enum: ['publish', 'status', 'visibility', 'unpublish', 'list'],
          description:
            'publish deploys or updates a share URL; status checks freshness and share metadata; visibility updates public/unlisted state or allowRemix for games; unpublish pauses live access; list shows deployed cloud artifacts.',
        },
        targetKind: {
          enum: ['html', 'design', 'game', 'motion'],
          description: 'Defaults to "html" when sourcePath is provided.',
        },
        sourcePath: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'Absolute or workspace-relative path to an HTML file or folder (targetKind="html").',
        },
        targetId: idStr,
        filePath: relPath,
        title: { type: 'string', minLength: 1, maxLength: 160 },
        embedUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        workspaceId: idStr,
        deployMode: { enum: ['publish', 'resume', 'new_link'] },
        visibility: {
          enum: ['public', 'unlisted'],
          description: 'For targetKind="game": "public" publishes to the playable community feed; "unlisted" creates a private link-only share (requires a paid Go+ plan).',
        },
        allowRemix: {
          type: 'boolean',
          description: 'For targetKind="game": allow visitors to copy the remix prompt.',
        },
        refresh: { type: 'boolean' },
      },
      ['action'],
    ),
    annotations: cloudWrite,
  },
  {
    name: 'openmotion_cloud_comments',
    title: 'OpenMotion · Cloud Comments',
    description:
      'Inspect HTML elements, list comments and strictly 1-level Feishu-style replies, post whole-page, element-anchored, or Game-stage comments and 1-level replies (optionally attaching up to 4 PNG/JPEG/WebP/GIF images <= 5 MiB via images/imagePaths, including image-only posts), and update/resolve/delete comments on ANY deployed OpenDesign Cloud artifact including standard web pages, ?kind=game shares, and /games/<slug> community links (your own or another user\'s shareUrl).',
    inputSchema: obj(
      {
        action: {
          enum: ['inspect_elements', 'list', 'comment', 'reply', 'update', 'delete'],
          description: 'Operation to perform on a deployed Cloud artifact share.',
        },
        shareUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'Share URL (/artifact/<projectId>/<slug> optionally with ?kind=game, or /games/<slug>) of your own or another user\'s deployed Cloud artifact.',
        },
        projectId: idStr,
        slug: idStr,
        targetKind: { enum: ['html', 'design', 'game', 'motion'] },
        targetId: idStr,
        sourcePath: { type: 'string', minLength: 1, maxLength: 2048 },
        filePath: relPath,
        parentCommentId: {
          ...idStr,
          description: 'Top-level root comment ID to reply to (strictly 1-level; required for action="reply").',
        },
        replyToCommentId: {
          ...idStr,
          description: 'Optional level-1 reply ID within parentCommentId to address directly (renders as "Author ▸ Target" while keeping strictly 1-level storage).',
        },
        commentId: {
          ...idStr,
          description: 'Comment or reply ID (required for action="update" and action="delete").',
        },
        note: noteSchema,
        targetType: {
          enum: ['element', 'page', 'game'],
          description: 'Optional anchor mode for action="comment"; defaults to whole-page anchoring ("page-comment" on standard shares, "game-stage" on ?kind=game shares) when selector/elementId are omitted.',
        },
        images: {
          type: 'array',
          maxItems: 4,
          description: 'Optional local image attachments (up to 4 PNG, JPEG, WebP, or GIF files, <= 5 MiB each) for action="comment" or action="reply".',
          items: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 2048 },
              {
                type: 'object',
                properties: {
                  path: { type: 'string', minLength: 1, maxLength: 2048 },
                  filePath: { type: 'string', minLength: 1, maxLength: 2048 },
                  alt: { type: 'string', minLength: 1, maxLength: 240 },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        imagePaths: {
          type: 'array',
          maxItems: 4,
          description: 'Alias for images: array of local PNG/JPEG/WebP/GIF file paths (<= 5 MiB each).',
          items: { type: 'string', minLength: 1, maxLength: 2048 },
        },
        elementId: { type: 'string', minLength: 1, maxLength: 240 },
        selector: { type: 'string', minLength: 1, maxLength: 500 },
        htmlHint: { type: 'string', minLength: 1, maxLength: 500 },
        label: { type: 'string', minLength: 1, maxLength: 200 },
        position: obj(
          {
            left: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 },
            top: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 },
            width: { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 },
            height: { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000 },
            viewportWidth: { type: 'number', exclusiveMinimum: 0, maximum: 32768 },
            viewportHeight: { type: 'number', exclusiveMinimum: 0, maximum: 32768 },
          },
          ['left', 'top', 'width', 'height', 'viewportWidth', 'viewportHeight'],
        ),
        status: {
          enum: ['open', 'resolved'],
          description: 'For root comments in action="update" (replies cannot be resolved independently).',
        },
        includeResolved: {
          type: 'boolean',
          description: 'For artifact owner on action="list": include resolved threads alongside open threads.',
        },
        sinceSeq: { type: 'integer', minimum: 0 },
        query: { type: 'string', maxLength: 200, description: 'Optional text/selector filter for action="inspect_elements".' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max elements returned by action="inspect_elements".' },
        expectedVersion: { type: 'integer', minimum: 1 },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 64 },
      },
      ['action'],
    ),
    annotations: cloudWrite,
  },
] as const;
