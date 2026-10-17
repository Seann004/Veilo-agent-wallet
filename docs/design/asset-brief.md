# Veilo asset brief

Handoff for an image-generation agent or designer. For the full theme and component rules, see [`apps/dashboard/DESIGN.md`](../../apps/dashboard/DESIGN.md). Everything listed here is currently a placeholder in `apps/dashboard`. Deliver the files at the paths given, and the dashboard picks them up with no code changes, unless a step says otherwise.

## Brand at a glance

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Accent | `#4b4ddb` | `#8b8dff` | Links, focus, selected states |
| Accent ink | `#3537b8` | `#a9abff` | Accent text |
| Gradient | `#0b0b12 → #1b1c45 → #3d3f93` | `#3d3f93 → #4b4ddb` | Primary buttons, CTA band |
| Canvas | `#f5f5f5` | `#0f0f12` | Page background |
| Surface | `#ffffff` | `#17171b` | Cards |
| Ink | `#0f0e0d` | `#ececf1` | Text |

- **Type:** Inter (system fallback); light 300-weight headings and 400–500 body.
- **Feel:** calm, minimal and trustworthy, close to sokosumi.com and x.ai's bot marketplace. Use plenty of whitespace and soft rounded shapes.
- **Avoid:** neon, glossy 3D, crypto clichés (coins, rockets, lightning) and stock-photo people.
- **Don't:** use other brands' marks or likenesses of real people, or put text inside illustrations other than the wordmark.

## 1. Logo (needed)

The app currently uses a `◆` text glyph.

| File | Size | Notes |
| --- | --- | --- |
| `apps/dashboard/public/brand/logo-mark.svg` | square, 24–512 px | Mark only. Must read at 16 px. Single colour `currentColor` preferred. |
| `apps/dashboard/public/brand/logo-wordmark-light.svg` | ~120×28 | Mark plus "Veilo" for light backgrounds |
| `apps/dashboard/public/brand/logo-wordmark-dark.svg` | ~120×28 | Same, for dark backgrounds |
| `apps/dashboard/app/icon.svg` | square | Favicon (Next.js picks it up automatically) |
| `apps/dashboard/app/apple-icon.png` | 180×180 | Opaque background, mark centred with ~20% padding |

- **Concept hint:** a veil or soft fold over a diamond or rounded square, suggesting privacy and a guarded budget. It must stay simple enough to work as a 16 px favicon.
- **Code change after delivery:** replace the `◆` spans in `components/Shell.tsx` and `components/Site.tsx` with the mark.

## 2. Agent avatars (needed, 10)

These are user-selectable avatars. They currently live at `apps/dashboard/public/avatars/avatar-01.svg` … `avatar-10.svg`.

- **Style:** one character family. Each is a soft blob shape in one flat colour with two small white rounded-rectangle eyes, no mouth and no outline, like x.ai's Grok bot avatars. Every avatar needs a distinct silhouette: round, drop, cloud, rounded square, pill, triangle, hexagon and so on.
- **Format:** SVG preferred (or 512×512 transparent PNG/WebP), square canvas with the shape filling about 80%, ≤ 40 KB each.
- **Must read at** 32 px (sidebar), 40 px (lists), 88–104 px (detail views), on both `#f5f5f5` and `#0f0f12`.
- **Keep the ids and labels below.** If you change a file's extension, update `src` in `apps/dashboard/lib/avatar-options.ts`.

| id | Label | Suggested colour | Default for |
| --- | --- | --- | --- |
| avatar-01 | Violet round | `#8b5cf6` | |
| avatar-02 | Blue drop | `#3b82f6` | |
| avatar-03 | Green cloud | `#22a565` | |
| avatar-04 | Teal square | `#14a38b` | Credit manager |
| avatar-05 | Brown blob | `#8a5a3c` | |
| avatar-06 | Orange round | `#f97316` | |
| avatar-07 | Red pill | `#e5484d` | |
| avatar-08 | Pink triangle | `#e8457f` | Content writer |
| avatar-09 | Indigo square | `#5b5bd6` | Researcher |
| avatar-10 | Amber hexagon | `#f5a524` | |

Optional: a further 10–20 in the same family for more choice. Add them to `AVATARS` in `lib/avatar-options.ts`.

## 3. Landing product image (needed)

Placeholder: `apps/dashboard/public/marketing/hero-placeholder.svg`, 1600×900. It appears under the hero on `/`.

- **Must be a real screenshot** of the running app (sidebar, an agent thread, the details panel). Every number shown must come from a real devnet run. Do not fabricate balances, payments or results.
- **Deliver:** `hero-light.webp` and `hero-dark.webp` (1600×900, ≤ 250 KB), plus a 1200×675 crop for mobile if detail gets too small.
- **Hide** wallet addresses beyond the shortened form already shown, keys, tokens and anything personal.
- **Code change after delivery:** swap the `<img>` in `components/Landing.tsx` for a `<picture>` with a `prefers-color-scheme: dark` source.

## 4. Social card (needed)

- `apps/dashboard/app/opengraph-image.png`: 1200×630, logo plus "Agents with budgets, not blank cheques" on the brand gradient. Text must stay readable at 300 px wide.
- Optionally a matching `twitter-image.png` at the same size.

## 5. Marketplace role art (optional)

Larger hero art for the three featured roles on `/marketplace` and `/market`. Use the same blob character as the role's avatar, holding a simple prop: a magnifier (Researcher), a pen (Content writer) or a battery/gauge (Credit manager). 320×320 transparent WebP, ≤ 60 KB each, at `apps/dashboard/public/marketing/role-<role>.webp`. Wiring them in needs a small change to `components/MarketBrowser.tsx` and `components/MarketLanding.tsx`.

## 6. Empty-state illustrations (optional)

Small, monochrome line illustrations (accent colour on transparent, 160×120 SVG):

- `empty-agents.svg`: no agents yet
- `empty-payments.svg`: no payments yet
- `empty-content.svg`: no drafts yet

Put them in `apps/dashboard/public/illustrations/`. They need small component changes in `Overview.tsx`, `Activity.tsx` and `ContentView.tsx`.

## Checks before handing back

- Every asset looks right on light (`#f5f5f5`) and dark (`#0f0f12`) backgrounds.
- No text baked into avatars or illustrations; the dashboard supplies labels and alt text.
- File sizes are within the limits above, and SVGs are optimised (e.g. SVGO) with no embedded rasters.
- No real people, other brands' marks or invented product data.
