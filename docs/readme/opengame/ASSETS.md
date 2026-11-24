# OpenGame README imagery

All game and product captures come from `OpenDesignHQ/opengame` at source revision `45694bb06becd0de1565fe1c0d4296f009997c96`, captured on November 24, 2026 (Asia/Shanghai). The hero background is separately generated editorial artwork.

## OpenGame logo

The [OpenGame lockup](../../../packages/design-system/brand/opengame-logo.svg) reuses the original OpenDesign symbol without changing its path geometry. The name is **OpenGame**, set in outlined Albert Sans at weight 500, following the shared brand lockup. The symbol and existing “Open” letter outlines come from the [maintained shared logo](../../../packages/design-system/brand/openmotion-logo.svg); original OpenDesign artwork is credited in [its source notice](../../../packages/design-system/opendesign-logo-SOURCE.md). The font retains its [license and notices](../../../packages/design-system/fonts/NOTICES.txt).

The package SVG is the single maintained source, referenced directly by all README languages and the hero composition. It adapts to light and dark README themes; the hero renders the same paths in white. No generated logo or replacement symbol is used.

## README layout and identity assets

The README follows the original OpenMotion layout: centered brand mark and positioning, hero, two rows of compact badges, section navigation and language links. The first badge row covers Stars, Node, license and the maker; the second links the project and community. Reused badges remain in [the existing badge directory](../badges). The OpenGame [project badge](badges/project.svg) and [Stars badge](badges/stars.svg) preserve that geometry. The Stars value is a **3-star snapshot verified on November 24, 2026**, not OpenMotion's count.

[29 Agent identities](agents.webp) appear **after quick start**, with a left-aligned count and link to the agent setup section. The editable compositions are [agents.html](agents.html) and [agents.mobile.html](agents.mobile.html). Names and icons reuse the maintained [client registry](../../../shared/local-agents.ts), [provider icon mapping](../../../packages/design-system/provider-icons.js) and [icon sprite](../../../packages/design-system/icons.svg). Labels follow the current 29-entry registry. Aider, AtomCode and IBM Bob retain the application's generic glyphs instead of invented logos.

The Agent gallery is 1309 × 350, with a 650 × 1000 narrow-screen variant selected below 600 px. Both are HTML captures encoded as WebP at quality 90. Individual agent buttons in the BYOA section reuse [the original badge assets](../agents).

The **11+ media models** figure starts with the 11 built-in entries in [the model catalog](../../../gateway/catalog.ts); connected provider catalogs can add models. Compact model badges appear **inside the multimodal feature section**, at the same 133 px display width as OpenMotion. The row represents GPT Image, Seedream, Nano Banana, FLUX, Seedance, Wan, Suno, ElevenLabs, Kokoro and BytePlus. [GPT Image](models/gpt-image.svg), [Seedream](models/seedream.svg) and [BytePlus](models/byteplus.svg) adapt the existing chip artwork; the other marks reference [the maintained model badges](../models) directly.

Where no distinct model mark is bundled, its developer/provider mark is used (ByteDance for Seedream, Seedance and BytePlus; Alibaba for Wan; fal.ai for Kokoro). This does not assert account entitlement or a successful generation for every model. [Provider artwork provenance](../../../packages/design-system/providers/NOTICE.md) and the [Remix Icon license](../../../packages/design-system/remix-icon-LICENSE.txt) remain with the shared assets. The previous large model galleries ([desktop](models.html), [mobile](models.mobile.html)) remain as editable source assets and are no longer embedded in the README.

The **1309 × 964** hero preserves the real screenshot and game-world composition above four prominent numbers: **100+ games, 29 agents, 11+ media models and 3+ publishing platforms**. Collection and platform claims were confirmed by the project owner; agent and built-in model counts were verified from this checkout.

## Product and technical diagrams

Three diagrams, each in English, Simplified Chinese and Japanese, complement the corresponding README sections:

- [Creation stack](diagrams/creation-stack.svg): idea/resources/agent → understand, remix, assets, play, publish. Appears in the first product pillar.
- [Project context](diagrams/project-context.svg): plan, asset inventory, verification and source. Appears in the remix and reusable-project pillar.
- [Runtime architecture](diagrams/runtime-architecture.svg): Studio and agents → shared local application → media, owned game files and verification → local play, web sharing and trailer. Appears in the technical guide.

[generate.py](diagrams/generate.py) is the maintained SVG source generator. Run `python3 docs/readme/opengame/diagrams/generate.py` to rebuild all nine files. It follows the original README's editable SVG diagram approach and visual hierarchy. Diagrams are documentation artwork, not product UI or screenshots. Technical meaning and source references are maintained in [OpenGame architecture](../../opengame-architecture.md). Platform integrations in the product flow are separate from the local MCP publication action.

## Real product interface

The source Studio was built with `npm run build:studio` using Node.js 26.11.1 and served on loopback with a separate `MOTION_DATA_DIR`. The screenshot session used the browser's normal 1309 × 955 viewport. The campaign banner was dismissed and the conversation sidebar collapsed through the existing UI. No product controls, labels or results were redrawn for the images.

| Image | Actual state |
| --- | --- |
| [Creation entry](studio-create.webp) | Game Studio genre selector, template discovery and prompt composer |
| [Playable preview](studio-play.webp) | Game Studio alongside Harbor Skirmish in the Artifact Viewer |
| [Source view](studio-code.webp) | The same game's HTML in the viewer's Code mode |

These are captures of the repository's current interface, which retains OpenDesign branding and existing navigation labels. The source application detects locally installed agents; the screenshot session did not install or reconnect an MCP integration, submit a prompt, run an Agent creation task, generate game assets or publish a game. The user's desktop client was not started.

The template carousel and discovery cards include community references. Their presence in a product screenshot is not a claim that OpenGame generated them. Original authors and reference URLs are maintained in [the catalog source](../../../studio/src/motion/game/gameCatalog.ts), including the Little Prince reference by @Saccc_c and MAAD MAXXING by @Andrew_Blumson visible in the hero capture. The source game's own rendered title and imagery remain unchanged.

## Standalone game captures

The six standalone captures were made from the source games in fresh headless Chrome pages. Non-loopback requests were blocked; data and blob URLs were allowed. English browser language settings were used. Landscape games were captured at 1280 × 720 after pressing their start control; portrait games at 450 × 800 in their initial playable/tutorial state. WebP quality was 65.

| Capture | Editable game source | Captured state |
| --- | --- | --- |
| [Harbor Skirmish](harbor-skirmish.webp) | [Source](../../../templates/games/harbor-skirmish) | First wave after `#playBtn` |
| [Rooftop Roast](rooftop-roast.webp) | [Source](../../../templates/games/rooftop-roast) | Active game after `#start` |
| [Drift Dash](drift-dash.webp) | [Source](../../../templates/games/drift-dash) | Initial race/tutorial |
| [Pin Rescue](pin-rescue.webp) | [Source](../../../templates/games/pin-rescue) | First puzzle/tutorial |
| [Sort Stack](sort-stack.webp) | [Source](../../../templates/games/sort-stack) | First puzzle/tutorial |
| [Tilt Temple](tilt-temple.webp) | [Source](../../../templates/games/tilt-temple) | First maze/tutorial |

## Hero artwork

[cover.html](cover.html) is the editable composition for [cover.webp](cover.webp). It combines the real [Studio preview screenshot](studio-play.webp), typography and [hero-world.webp](hero-world.webp), a generated background. The background is a game-themed illustration, not a game frame or a product feature. No generated UI is used.

Art direction: a midnight-blue and teal game world with warm amber lighting, a seaside miniature town, curved racing road, collectible coin, floating platform blocks and a glowing portal. Keep the headline area quiet and the real product interface dominant. No text, logos or interface panels were requested in the generated layer. The illustration was generated using the imagegen tool, then encoded as WebP at quality 80.

The November 24 positioning revision uses **The Open-source Super Game Agent** and **Make games. Make money.** as the category and mission-led headline. The 100+ viral-game collection and TikTok / WeChat / Douyin distribution are product claims confirmed by the project owner for this positioning draft. The source checkout and screenshots retain their original 26-game bundled catalog; the README technical section distinguishes that snapshot from the wider product offering. This copy update does not alter the product capture or background artwork.

The composition uses the shared Albert Sans font. Its gaming palette is editorial artwork requested for OpenGame, not a replacement application theme. Serve the repository root, open `cover.html`, wait for its local font and images, and capture the **1309 × 964** artwork bounds. This revision was captured through the browser screenshot API and encoded to WebP at quality 82. Studio captures were encoded at quality 78; the original capture bytes are retained in the local working archive, outside the repository.

[manifest.json](manifest.json) records image sizes, SHA-256 hashes, source-file hashes, viewports and capture types. All display images are below 1 MiB and GitHub's 5 MB image proxy limit. Screenshot review does not establish human fun, real-device performance, sound quality, public hosting or a completed Agent connection.

Original code uses the repository [license](../../../LICENSE). Third-party game assets keep their original terms. Agent badges reuse [the existing local badge assets](../agents), with provider provenance maintained in [the design system](../../../packages/design-system/providers). [Font notices](../../../packages/design-system/fonts/NOTICES.txt) remain with the shared fonts.
