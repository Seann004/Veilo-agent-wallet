# Veilo asset delivery

Selected direction: **Pebble companions**, approved on 17 October 2026.

## Delivered files

All paths are relative to the repository root.

| Files | Dimensions | Size |
| --- | --- | --- |
| `apps/dashboard/public/brand/logo-mark.svg` | 32×32; scalable | <1 KB |
| `apps/dashboard/public/brand/logo-wordmark-light.svg` | 120×28 | <2 KB |
| `apps/dashboard/public/brand/logo-wordmark-dark.svg` | 120×28 | <2 KB |
| `apps/dashboard/app/icon.svg` | 64×64; scalable | <1 KB |
| `apps/dashboard/app/apple-icon.png` | 180×180, opaque | <3 KB |
| `apps/dashboard/public/avatars/avatar-01.svg` … `avatar-10.svg` | 512×512, transparent; 100×100 viewBox | <0.4 KB each |
| `apps/dashboard/app/opengraph-image.png` | 1200×630 | <75 KB |
| `docs/design/asset-preview.png` | Light/dark asset contact sheet | Review only |

The mark is two asymmetric pebbles separated by a narrow veil-like gap. The wordmarks use outlined lettering, with no font dependency. SVGs contain paths and simple shapes, no embedded rasters, metadata or external resources; coordinates are compact and wordmark precision is reduced to three decimal places. The mark uses `currentColor`; the app applies it as a CSS mask so it follows the accent token in either theme.

Avatars preserve the ten IDs, labels, suggested colours and role defaults. Each has one flat fill, two white rounded-rectangle eyes, no mouth, outline, text or human likeness. Their irregular contours and low-set eyes establish the pebble family. The contact sheet checks 32, 40 and 104 px, plus the mark at 16, 32 and 80 px, on both specified canvases.

## Customization

The owner approved expanding the initial asset-only code scope. The shared picker in agent creation and agent detail now provides ten independent shapes, ten colours, four visual presentations (smooth, tuft, side sweep, crest), and optional gender (not specified, woman, man, non-binary). Selecting Woman adds a fixed pale pink ribbon with a darker pink knot. Man, Non-binary and Not specified add no accessory. The ribbon attaches to each silhouette’s upper edge and keeps the selected body colour and presentation. It is a local display preference and does not change the agent's role, model, instructions, behaviour or spending policy.

The large preview updates while editing. Reset restores the selected shape's original appearance. Existing saved avatar IDs remain compatible. Custom choices use the existing per-agent, per-browser localStorage key and change notification; they are not synced to the service or other devices. Preference values are allowlisted before creating an SVG data URL. `lib/avatar-art.ts` holds the same geometry and palette as the shipped avatar files. File extensions remain SVG, so `lib/avatar-options.ts` did not need changes.

## Still needed / skipped

- **The landing product screenshot is still needed.** Leave `hero-placeholder.svg` and `Landing.tsx` in place until a real devnet run can provide `hero-light.webp` and `hero-dark.webp` at 1600×900, ≤250 KB, and a 1200×675 mobile crop if necessary. No generated product screenshot or invented product data was used.
- Optional marketplace role art, empty-state illustrations and Twitter card were skipped to keep this delivery focused on the required assets and approved customization. Their consuming components were not changed.

## Validation

- `pnpm check`: passed using Node 22 and the pinned pnpm 10.34.6.
- `pnpm test`: final PR review passed 45 test files, 1 skipped; 302 tests passed, 8 skipped. The first sandboxed attempt could not bind local test servers; the complete suite passed with local networking enabled.
- New tests cover legacy selection compatibility, role defaults, invalid stored data/SVG injection, independent choices, keyboard selection, persistence after remount and reset.
- Browser: all eleven page routes at 1440×960 and 375×960 in light and dark mode (44 route/viewport/theme combinations). No horizontal overflow and no uncaught page errors.
- Routes: `/`, `/marketplace`, `/workspace`, `/agents/new`, `/agents/asset-review` (dynamic detail route), `/market`, `/activity`, `/content`, `/wallet`, `/recovery`, `/privacy`.
- **Initial coverage limit:** the control service was unreachable during the asset-only pass. This was later superseded by the [final PR review](./pr-review.md): 96 page/navigation states against an actual disposable control backend, including authenticated default-agent detail pages and desktop/mobile navigation. Wallet/relayer unavailable states were checked; no paid-work or funded recovery run is claimed. No backend state, balances or results were fabricated for screenshots.
- The actual avatar picker was separately rendered in an isolated review harness using the repository component and stylesheet, at both requested widths and themes. Keyboard selection, independent customization, local saving, reset and no overflow were confirmed in all four combinations. This does not substitute for a live authenticated owner flow.
- Both light/dark asset contact sheets were inspected, including small-size eyes, silhouettes, wordmarks and favicon. The social card was inspected at its native size and at 300 px wide. All constrained file sizes and dimensions pass.

## Image generation provenance

The built-in imagegen tool was used for the preview-only three-direction concept sheet. It remains at `/Users/shawnchee/.codex/generated_images/01a148e9-b7f8-7ae0-ae8e-cb80806bbbda/exec-499485dc-455a-4c73-ab10-8d090930d262.png`. No CLI/API fallback was used. Production graphics were implemented as native vector geometry and rendered to the required PNG dimensions, following the imagegen skill's guidance for code-native icons and logos. The generated comparison is inspiration, not a shipped asset.

Concept prompt:

```text
Use case: logo-brand
Asset type: preview-only Veilo brand and avatar concept comparison sheet, not final production assets
Primary request: compare THREE genuinely distinct visual directions in three equal columns on a calm #f5f5f5 canvas. Each column contains one simple indigo logo mark near top and three small flat avatar characters beneath, plus a narrow #0f0f12 strip repeating the three characters. No labels or text anywhere. Direction 1 left: folded companions, soft asymmetrical blob shapes with a single folded-corner notch integrated into silhouette, paired with a very simple folded V / veil mark. Direction 2 middle: pebble companions, rounded organic off-centre stones, paired with a two-pebble veil mark. Direction 3 right: ribbon companions, softly curved geometric ribbon silhouettes, paired with a looped V veil mark. All avatars: one solid flat fill per character in violet #8b5cf6, teal #14a38b, pink #e8457f; precisely two small white rounded-rectangle eyes, no mouth, no outline. Distinct silhouettes, enough eye spacing to read at 32px. Restrained vector-like geometry, lots of whitespace, original character design. Logo marks single indigo colour, simple enough at 16px. Avoid any existing brand likeness, standard robot heads, antennas, glossy 3D, gradients inside characters, coins, rockets, lightning, human people, text or watermark. This is one coherent design exploration board showing options before implementation.
```
