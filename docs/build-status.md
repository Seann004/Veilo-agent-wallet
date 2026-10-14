# Build status

States: not-started · in-progress · blocked · done. A task is done only when its completion gate passed with recorded evidence.

| Task | State | Dependencies | Commands / checks | Evidence / blockers |
|---|---|---|---|---|
| T00 Repository and contribution policy | done | — | `git config user.name` → Ng Sean Sean; CLAUDE.md extracted verbatim from PRD Part II | Branch `feat/veilo-foundation`; `.gitignore` excludes keys, `work/`, env, databases, ptau/zkey |
| T01 Toolchain and monorepo | not-started | T00 | | |
| T02 Schemas and durable ledger | not-started | T01 | | |
| T03 Owner session and worker boundaries | not-started | T01–T02 | | |
| T04 Ordinary devnet x402 | not-started | T01–T03 | | |
| T05 Protocol specification and vectors | not-started | T01 | | |
| T06 Circuits and verifier | not-started | T05 | | |
| T07 Pool program and local adversarial tests | not-started | T02, T05–T06 | | |
| T08 Private SDK/indexer/relayer | not-started | T03, T05–T07 | | |
| T09 Devnet private integration | blocked | T04, T07–T08 | | Funded keypair for 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd not present on this machine; operator must supply its path via local config |
| T10 Gateway credits and inference | not-started | T02–T04 | | Live inference needs operator OPENROUTER_API_KEY and OPERATOR_MAX_REAL_USD_MICRO |
| T11 Shawn scheduler | not-started | T02–T03, T09–T10 | | |
| T12 Prince research | not-started | T03, T09–T10 | | |
| T13 Mira content | not-started | T03, T09–T10, T12 | | |
| T14 Dashboard and owner recovery | not-started | T03, T08, T10–T13 | | |
| T15 Integrated fault injection and restoration | not-started | T09–T14 | | |
| T16 Handoff and submission materials | not-started | T15 | | |

## Environment notes

- Host: Windows 11, Node 22.14.0, npm 11.4.0, Python 3.13. Rust/Solana/Anchor/circom are not installed on the host; they run inside a pinned Docker toolchain image (see T01).
- Funded setup wallet key is not in this checkout. Scripts take explicit key paths and never print key material.
