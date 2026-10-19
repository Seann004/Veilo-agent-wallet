# Submission review, 19 October 2026

Scope: tested source `b155f17` (based on merged source `55e6404c2b8304c5b0b557742a3b2e96bbae1627`) plus the accompanying submission documentation. This is a focused adversarial review of submission claims, connector approval, runner transport/leases and supporting controls, not an external audit, exhaustive program audit or production clearance. Historical transactions keep their original environments and dates.

## Organizer checklist supplied by the owner

The six requirements below come from the owner's screenshot. Deadline, registration, devnet eligibility and reuse acceptance have not been independently confirmed in this review.

| Requirement | Available now | Remaining gate |
|---|---|---|
| Technical documentation: architecture, algorithms, security | [Architecture](./guide/architecture.md), [protocol](./protocol.md), [policy](./guide/policy.md), [privacy](./guide/privacy.md), [security model](./security/assessment.md) | Freeze the final source and deployed artifact identities with the submitted evidence |
| Presentation, at most 10 minutes | Canonical `slide_deck.md` proposes 12 slides with notes and a 5:40 speaking target; no demo slide or embedded demonstration | Approve content, rebuild the earlier PowerPoint draft and rehearse under 10 minutes; any website demonstration is separate and must fit the slot if included |
| Optional demo video, at most 5 minutes | Demo flow and historical execution records exist | No final recording verified in this review; record only after the website rehearsal |
| Source, README, GitHub link, setup, tests | README, pinned lockfiles, deployment/running guides, source and test suites | **GitHub API reports the repository is private**. Grant judges access or choose a reviewed publication path, then freeze a clean reviewed commit; a fresh clone has no keys, provider credits or proof build artifacts |
| Security self-assessment: permission tiers and known risks | [Assessment](./security/assessment.md), [risks](./security/risks.md), [evidence matrix](./security/evidence.md) | Retain known gaps and attach final review identity and exact tested snapshot; not an independent audit |
| On-chain execution evidence: real transaction hashes | M2 and pre-merge agent receipts, including pool withdrawal, merchant payment and public exit | A fresh current-path swap and private-pool-funded marketplace workflow are still needed for those current-feature claims; local-validator signatures cannot count as devnet evidence |

## Findings and corrections

1. **High, evidence integrity:** `scripts/evidence-export.ts` assigned devnet Explorer links to local integration signatures. Fixed through `scripts/evidence/signatures.ts`: explicit local labels take precedence, unknown environments stay unknown, only explicit devnet receipts receive public-devnet links, and deduplication includes network. Five regression cases cover misleading profiles, local labels, the local-rehearsal profile, unknown records and real devnet labels. This correction does not recheck chain finality.
2. **Medium, provenance:** the exporter lacked the source checkout identity and lockfile digest. It now includes checkout commit/dirty flag and `pnpm-lock.yaml` hash. This identifies the exporter, never retroactively attributes historical runs to a new source commit. The submitted run must still record its own tested source.
3. **Medium, documentation drift:** public setup/handoff text instructed operators to run the full marketplace seed and retained older browser DNS and swap claims. Updated to the custom-connector proposal followed by targeted operator approval, connection-time DNS checks and the distinction between older finalized swaps and the current unverified path.
4. **Low, product clarity:** the existing `coingecko-docs` catalogue entry could be mistaken for price access. Dashboard display and future seed title now say **CoinGecko docs search only**. Market-data registration stays separate and requires explicit operator review. No live catalogue activation was performed.

## Adversarial boundaries checked

- Connector discovery contacts the registered canonical endpoint. Approval checks the full tools against live definitions again before approval. Fixed templates pin both code and upstream `execute`; raw code execution is refused. Existing approval, drift, endpoint and forged-pin tests remain in the suite.
- Runner heartbeat 403/404/409 latches lease loss. Temporary failures leave completion validation to control. Existing lease and stale-completion regression tests remain in the suite.
- Runner browser and research fetches use the shared bounded transport with address validation at connection time. Redirect and local-origin rules remain separate from arbitrary public access.
- Reviewed program entry points include signer/account/PDA validation, checked financial arithmetic, proof verification and nullifier checks. No Rust/program changes were made and the program/LiteSVM suite was not rerun in this pass.
- Budgets are enforced by the owner-controlled services. They are not proof-enforced caps. Owner-host compromise, small anonymity sets, development trusted setup and administrator powers remain explicit limitations.

## Validation record

Baseline before the exporter fix: full Vitest **989 passed, 1 skipped, 126 files**. Final full Vitest on source `b155f17`: **994 passed, 1 skipped, 127 files** (Node 24.22.0, `pnpm test --maxWorkers=4`). Root typecheck and lint passed after the fix. The five added tests concern evidence-network classification. Documentation production build and dashboard production build passed. VitePress emitted a bundle-size warning but no dead-link or rendering failure. A read-only classification of 14 existing evidence JSON files found four local-validator and forty devnet signature occurrences, with zero local/unknown signatures receiving a devnet link. This does not independently reverify transaction finality. Real development proof artifacts are present in this checkout. An initial run under a different bundled Node and restricted local-server environment failed; the repository Node and permitted local-server run passed the baseline. This is not evidence of a deployed behavior change.

## Remaining operational gates

- Current hardened swap: tiny amount, new finalized funding and swap receipts, pinned destination and pool, no blind retry on uncertainty.
- CoinGecko: show docs-only first, submit market data in the UI, show In review, operator approves only that connector, attach to a custom agent and verify a cited price result.
- Carousel: verify the displayed quote, one Studio North seller, provider credits, five images, three paid steps and the intended TikTok inbox destination. No paid image call or draft was initiated by this review. `draft` prevents auto-publication, not a guarantee of private audience.
- Browser-wallet signing and owner exit on an eligible note; reserved/pending funds are not immediately withdrawable. A public exit is not a funded-wallet recovery drill.
- Sponsor capacity is not reserved for the later swap, failed-swap sponsor fees do not reach control, and missing transaction reads can leave fee-accounting gaps. These remain open and block claims of complete financial hardening.
- GitHub repository visibility was checked through the authenticated GitHub API on 19 October: `private: true`. Anonymous judge access is unavailable; reviewer invitations or a separately approved publication decision are required. No repository visibility was changed.
- Licensing and organizer acceptance remain owner decisions. No code was merged, deployed or submitted by this review.

## Website review order

1. Workspace and Wallet: owner/devnet identity, ready/held/pending totals, public pool total, weak-pool warning, mobile and both themes.
2. Custom agent on the owner's model key and a read-only documentation/browser task.
3. Custom CoinGecko connector flow as described above; no USDC purchase, while model calls can consume provider credits.
4. Wrong-direction and over-budget refusals before one tiny authorized swap.
5. Carousel quote and output review, then one explicitly approved paid rehearsal.
6. Pause/revoke and a separate eligible-note public exit last. Capture IDs, source revision, UTC times and finalized receipts.
