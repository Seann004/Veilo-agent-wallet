# Dashboard design guide

Read this before changing anything visual in `apps/dashboard`. It records the theme, the component conventions and the rules the redesign was checked against. The asset brief (logos, avatars, marketing images) is in [`docs/design/asset-brief.md`](../../docs/design/asset-brief.md).

## Look and feel

- **References:** sokosumi.com/product/ai-coworkers for the public pages and x.ai/bot/marketplace for the marketplace. The owner app follows chat clients: an agent sidebar, a thread in the middle and a details panel on the right.
- **Mood:** calm, minimal, trustworthy. Lots of whitespace, soft radii, light-weight headings, one indigo accent. Nothing loud.
- **Plain language first.** Short sentences, no jargon on the surface. Technical detail (reason codes, signatures, policy versions) goes behind a disclosure or into small muted text.
- **One primary action per view.** Everything else is a secondary or small button.

## Honesty rules (non-negotiable)

- Every number, state and result on screen comes from the backend. No sample data, no invented balances, no "example" payments. Marketing images must be real screenshots.
- Uncertain outcomes stay uncertain ("Waiting for confirmation", "Uncertain"); never show them as success or failure.
- Keep these labels verbatim; tests and `@veilo/contracts` pin them:
  - `GATEWAY_CREDIT_LABEL`, `LABEL_*` and `stateSummaries` in `lib/labels.ts`
  - `STOP_KEEPS_RECOVERY`
  - `NO_CHARGE_NOTE`
  - the recovery and exit acknowledgements
- When you reword one, update its test in the same commit and keep the meaning.
- Amounts are integer base units formatted with `lib/format.ts` (`usdc`, `credits`). They never pass through floats. `usdc` trims trailing zeros past two places, and the value stays exact.
- The devnet badge and the demo-credits label stay visible in the top bar of every owner page.

## Tokens

All colours are CSS variables in `app/globals.css`. Components never use raw hex, except white text on solid buttons.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` | `#f5f5f5` | `#0f0f12` | Page background |
| `--surface` / `--surface-2` | `#fff` / `#fafafa` | `#17171b` / `#1c1c21` | Cards, inputs |
| `--sidebar` | `#f7f7f8` | `#131317` | Sidebar |
| `--ink` | `#0f0e0d` | `#ececf1` | Primary text |
| `--ink-2` | 62% ink | 68% ink | Secondary text (≥ 5:1) |
| `--ink-3` | 58% ink | 58% ink | Hints, placeholders (≥ 4.5:1) |
| `--line` / `--line-2` / `--line-strong` | 12% / 7% / 24% ink | 10% / 6% / 20% white | Borders, dividers |
| `--fill` / `--fill-2` / `--hover` / `--selected` | ink tints | white tints | Chips, hover, selected rows |
| `--accent` / `--accent-ink` / `--accent-soft` | `#4b4ddb` / `#3537b8` / `#eeeffe` | `#8b8dff` / `#a9abff` / 14% accent | Focus, links, selected chips |
| `--grad` | `#0b0b12 → #1b1c45 → #3d3f93` | `#3d3f93 → #4b4ddb` | Primary buttons, CTA band |
| `--ok` / `--warn` / `--danger` (+ `-bg`, `-ink`) | green / amber / red | lighter tints | Status pills and notices |
| `--danger-solid` | `#b4232f` | `#c9303d` | Destructive solid buttons |
| `--shadow` / `--pop-shadow` | soft | deeper | Hover lift, popovers |
| `--content-max` | 1240px | | Main column width; the top bar aligns to it |

### Theme

The theme follows the system by default.

- The sun/moon button in the sidebar footer saves `veilo.theme` in localStorage.
- `app/layout.tsx` applies the saved choice before first paint through `data-theme` on `<html>`.
- Add new colours as a token in all three places: `:root`, the `prefers-color-scheme: dark` block and `[data-theme="dark"]`.
- Test both themes.

## Type and spacing

- **Fonts:** Inter (system stack), base 15px, line-height 1.5.
- **Headings:** h1 2rem at weight 300 with tight tracking; panel titles 1.08rem at weight 500.
- **Minimum size:** no text below 0.8rem (12.8px). Inputs are 16px on phones.
- **Numbers:** amounts use tabular figures.
- **Spacing:** multiples of 4px. Panels pad 1.25rem (1rem on phones) and grids gap 0.75–1rem.
- **Radius:** `--radius-sm` 6px for buttons, `--radius` 8px for inputs, `--radius-lg` 14px for cards. Pills and chips are fully rounded.

## Layout

- **Owner shell** (`components/Shell.tsx`):
  - The sidebar holds the brand, a "+" (create agent), a collapse toggle, agent search, the agent list (avatar, name, state, status dot) and five nav items: Workspace, Marketplace, Activity, Content, Wallet. Then the owner chip, the theme toggle and Sign out.
  - **Collapse:** the sidebar collapses to a 72px icon rail (`veilo.sidebar`) and animates `grid-template-columns`. Below 900px it becomes an off-canvas drawer with a scrim.
  - **Top bar:** devnet badge and demo-credits label, padded to line up with `--content-max`.
- **Page header:** `.page-head` holds the h1 on the left and at most one action on the right.
- **Wallet:** Funds, Recovery and Privacy are tabs (`components/WalletTabs.tsx`) on `/wallet`, `/recovery` and `/privacy`; keep the URLs.
- **Agent page:** a two-column `.agent-view` (thread plus 340px details panel) filling the viewport. Each column scrolls on its own, and the layout stacks below 1100px.
- **Public pages:** use `SitePage` (`components/Site.tsx`): sticky nav, `.site-main` max 1200px, footer.
  - `/` is the landing page.
  - `/marketplace` is the marketplace landing page.
  - The in-app marketplace is `/market`.
- **Breakpoints:** 1100 (agent view stacks), 900 (sidebar becomes a drawer, grids drop to one or two columns), 640 (phone).

## Components

Reuse these; don't add one-off styles for the same job.

| Need | Use |
| --- | --- |
| Dropdown | `Select` (`components/Select.tsx`); never a native `<select>`. Options take `label` plus an optional `hint`. |
| Card with title | `Section` (`.panel` + `.panel-head`) |
| Collapsible detail | `<details className="panel disclosure">` with a chevron, or `.advanced` / `.composer-more` with a "+" marker |
| Key/value list | `KV` |
| Headline number | `.stats` > `.stat` (`.stat-label`, `.stat-value`, `.stat-sub`); `.stats-3` for three tiles |
| List row with avatar | `.agent-row` (overview) or `.market-row` (marketplace) |
| Toggle set | `.chips` with `.chip-toggle[aria-pressed]` |
| Amount input | `.input-unit` wrapper with the unit (`USDC`, `sec`) inside the field |
| Destructive action | `ConfirmButton` (two steps, Escape cancels). Use `display` for short visible text and keep `label` as the full accessible name. |
| Agent stop controls | `AgentControls`; `compact` gives a three-column row of short buttons |
| Loading | `Loading` (spinner plus text) for sections, `Spinner` inside busy buttons |
| Errors | `ErrorNotice`: title, plain guidance, then the backend message and code in small muted text, plus Retry |
| Status | `.pill pill-ok|warn|danger|muted`; always text, never colour alone |
| Avatars | `AgentAvatar` / `AvatarImage` / `AvatarPicker`. Choices are per browser (`lib/avatars.ts`); images and labels come from `lib/avatar-options.ts`. |
| Icons | `Icon` (`components/Icon.tsx`): inline 24px stroke icons at 1.7 width. Add paths there; no emoji, no icon fonts. |

## Motion

- 150–220ms ease-out. Page content fades up 4px on mount; thread items do the same; popovers use `pop-in`; the sidebar slides.
- Only `opacity` and `transform` animate, apart from the sidebar grid column.
- `prefers-reduced-motion` turns all of it off globally. Keep it that way.

## Accessibility and touch

- Contrast ≥ 4.5:1 for text in both themes; check new token pairs with a contrast calculator.
- Visible focus: the global `:focus-visible` outline, plus an accent ring on inputs and the select trigger.
- Every icon-only button has an `aria-label`. Decorative images use `alt=""`.
- On phones: buttons and select triggers ≥ 44px, small buttons ≥ 40px, icon buttons 44×44, and no horizontal scroll at 375px.
- When text truncates with an ellipsis, put the full text in `title`.

## Copy

- Say what something is or does in a few words: "Ready to spend", "Add funds", "Stuck payments", "How it spends".
- Role names: Researcher, Content writer, Credit manager.
- Explanations go in `.hint` under the field, not in a paragraph above the form.
- Empty states say what is missing and how to get it: "No drafts yet. Send Mira a campaign brief to get some."

## Before you finish a UI change

1. `pnpm check` and `pnpm test`. In a worktree with pnpm 11 on PATH, put a shim first that runs `corepack pnpm@10.34.6`.
2. Look at it in a browser with Claude in Chrome:
   - 1440px and 375px wide
   - light and dark
   - sidebar collapsed and expanded
3. Check there's no horizontal scroll: `document.documentElement.scrollWidth` should be at most the viewport width.
