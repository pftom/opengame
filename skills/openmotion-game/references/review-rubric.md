> See [source and execution notes](../PROVENANCE.md).

# Game Review Rubric

Run this before setting `status: "ready"` or publishing. Automated checks raise the floor; headless captures do not replace human play, physical GPU/touch performance, or audible review.

## 1. Mechanical & Functional Gate (Fix Every Failure Before `ready`)

1. **Zero starter residue:** No leftover starter copy/titles (`TODO`, `lorem`, empty `src=""`, or default placeholder theme).
2. **Entry & viewport fit (`100dvh`):** Full-viewport playfield with no landing-page layout beside a boxed canvas. Lightweight 2D/arcade games play from frame one; heavy-asset/atmospheric 3D builds using a loading cover must show real progress, block gameplay inputs while loading, enter cleanly via `#start`, and completely remove/hide the cover overlay on entry.
3. **Readability & style cohesion:** Clear figure-ground separation (environment < obstacles < hero & hazards/objectives), consistent rendering medium (no live-action DSLR photos pasted onto 2D/anime canvases), and no glaring visual fidelity cliff between hero anchors and primary-sightline neighbors.
4. **Assets complete & clean:** Every used asset in `design/assets.csv` loads with zero 404/network errors in playtest; generated/imported library assets use complete literal `/motion-api/assets/<assetId>/versions/<versionId>/media` URLs (never dynamic concatenation); 3D `.glb` assets checked with `scripts/game-glb-inspect.mjs` (scale, grounding, `alphaMode: BLEND`, payload share).
5. **Multimodal-first honoured:** When fitting models are available and approved, real generated/imported assets appear inside active gameplay/character scenes (not title-only); any fallback records the concrete blocker in `design/plan.md`.
6. **Verification matched to architecture:**
   - `openmotion_game_validate` passes with zero blocking diagnostics.
   - Rule/score/puzzle/card games using `logic.js`: 3-tier `openmotion_game_simulate` passes (`reference` wins, degraded struggles, `idle` loses cleanly).
   - All games (and primary for `realtime-3d` / `sandbox-explore`): `openmotion_game_playtest` passes all assertions including **`window.__omGame.runSelfTests()`** invariants, multi-point `{ type: "screenshot", label }` visual inspection, and zero horizontal overflow at `390×844` under peak HUD density.
7. **Audio, fallbacks & accessibility:** User-gesture AudioContext unlock, responsive SFX **and** a looping BGM bed (generated via OpenMotion media when usable, or synthesized WebAudio fallback — unless silence was explicitly requested), mute toggle controlling both SFX and BGM, playable muted, graceful asset-load fallbacks (never blanking gameplay), `prefers-reduced-motion` respect (no > 3 Hz full-screen flashes), and touch controls (≥ 48–56 px targets).
8. **Metadata, cover & licenses:** Game-only 1280×720 cover captured via `openmotion_game_capture_cover` (never user's visible browser/desktop; never stuck on a loading frame), concise English + `zh-CN` metadata via `openmotion_game_update_meta`, and preserved `vendor/` / `characters/` licenses.

## 2. Playable-Ad Addendum

For **Format: playable ad**, score each criterion 0 (missing), 1 (partial), or 2 (meets [game-playable-ad.md](game-playable-ad.md)) in `design/verification.md`. Ship only with zero `0`s and total ≥ 10/12:

| Criterion | 2 means |
|---|---|
| First-frame play | Playable scene on frame one, no title card; first touch plays and scores within 1 s |
| Tutorial | Animated hand on exact first target + short cue; hides on input, returns after idle hint delay |
| Level arc | 3–8 levels (easy L1 win, high-tension level, twist); `reference` wins and `idle` loses in `simulate` |
| End card & CTA | Both win/fail cards verified in playtest; CTA logs `cta_click` via `openStore()`, Play again does not |
| Audio & runtime | First-touch SFX + looping BGM (generated or WebAudio), mute toggles both, Replay never stacks BGM; zero third-party CDNs, storage, dialogs, or SDK stubs |
| Polish | Clean `390×844` layout, free corners, immediate feedback on every tap, localized copy fits |

## 3. Optional Post-Publish Checks

- **Trailer (`openmotion_game_trailer`):** Only on user request; inspect actual clips and final silent MP4 before claiming ready.
- **Existing multiplayer projects:** Apply [Mandatory Multiplayer Entry Acceptance](../SKILL.md#mandatory-multiplayer-entry-acceptance).
