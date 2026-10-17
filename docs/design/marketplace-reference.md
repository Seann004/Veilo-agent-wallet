# Marketplace reference UX

A public bot marketplace was walked in a browser on 2026-10-17 to borrow interaction patterns for Veilo's workflow marketplace. Only the patterns are reused. Veilo uses its own names, copy, layout and design system (`apps/dashboard/components/ui.tsx`, `apps/dashboard/app/globals.css`). No reference branding, text, imagery or styling is copied, and the reference screenshots are kept out of the repository.

## Route map (reference)

| Route | What it shows |
|---|---|
| `/bot/marketplace` | Title, category pill tabs, a search box, a "Featured" row, then one section per category with up to four cards and a "View all" link |
| `/bot/marketplace/<category-slug>` | The same header, tabs and search; a single section with every bot in that category. No Featured row. "View all" links here |
| `/bot/marketplace/bots/<slug>` | Detail: back link, avatar, name, "By creator", the full description, a primary action, then a side menu (memories, skills, routines, integrations) with the selected panel's contents |
| `/bot/<id>` | The "Add" target: a card with the name and description, a third-party disclaimer and terms link, and a deep link into a desktop app or an installer download |

Category tabs are links, so every category has its own URL. Ten categories were present, including a first-party "team" category. One category (two bots) had no "View all" link because the section already showed everything.

## Differences from the brief

- **Search exists.** A "Search by creator or bot name" box sits under the tabs. It filters as you type, also matches description text, and hides the Featured row while active.
- **Featured is a row of bots, not creators.** Each tile shows the bot avatar with the creator's photo overlaid, the bot name and "by creator". There is no separate creators row.
- **Cards are one line in sections.** Within sections the description is truncated to one line; the full text appears on the detail page.
- **"Add" never reaches a web sign-in.** It leads to an install page that opens a desktop app or offers an installer from a third-party domain. No account step was reached, nothing was downloaded and nothing was signed in.
- **Detail pages expose the configuration.** The instructions, skills, routines and integrations (with one line on what each integration is used for) are readable before adding.

Confirmed absent: prices, ratings, a builder or publish flow, payment or spending controls, and any run history.

## Patterns Veilo adopts

1. **Category tabs as routes**: `/marketplace` and `/marketplace/c/<category>`, with Veilo's categories (Research, Content, Media, Social, Data, Developer, Operations).
2. **Search under the tabs**, matching name, creator and summary, with the Featured row hidden while a query is active.
3. **Featured creators row** above the sections. Veilo shows creators (demo accounts are labelled "demo").
4. **Sections with "View all"**, shown only when a category has more workflows than the section shows.
5. **Compact cards**: name, "by creator", one summary line, and the safety promise as its own line.
6. **A safety promise on every workflow** that can act externally, for example "Drafts only; nothing posts without your approval". Veilo enforces this in the publish checks instead of leaving it as copy.
7. **A detail page that discloses what the workflow will do** before you commit: each step's tool, what it reads and writes, and what it will not do.
8. **A back link to the catalogue** on detail pages.

## Gaps Veilo fills

| Gap | Veilo |
|---|---|
| No prices | Each card shows the price per run in test tokens. Detail pages show the price per step and the total, all labelled "Devnet test tokens — no monetary value" |
| No chain view | Detail shows the ordered tool chain: each step's tool, recipient, maximum price and which earlier artifact feeds it |
| No payment controls | "Run once" and "Add to agent" both end in the owner's local approval, bound to the version, steps, recipients and maxima. Agents can propose runs but cannot widen budgets |
| No builder | A five-step create wizard: basics, chain builder, price and payout wallet, a real devnet test run, publish |
| No run history | A run view with a per-step timeline: funding and merchant signatures (devnet explorer links), deliverables, stop reasons, with payment and execution shown separately |
| Opaque add flow | Nothing installs or runs until the owner approves locally; there is no app download |
| No publish states | Draft, In review, Live and Suspended badges. Workflows built only from approved tools go Live after automated checks; new tools go through operator review |
