# CLAUDE.md

## Project

Build Veilo as a Solana-devnet multi-agent workspace with a real ZK private pool, standard x402 payments, independent spending controls, durable recovery and useful agent outputs. Read the repository PRD_latest.md before implementation. Requirements describe intended behavior, not shipped features.

## Git identity

- Never use Claude, Anthropic, an AI bot or an invented identity as commit author or committer.
- Use the human Git identity already configured for the repository. Do not change user.name, user.email, author/committer environment variables or existing attribution.
- Do not add Co-authored-by: Claude, AI co-author trailers or generated-by-AI commit text.
- If human identity is missing, finish the reviewable changes and report the missing identity before committing. Never fabricate one.
- Do not rewrite history, amend another person's commit, force-push or publish without the applicable user authorization.

## Comments

- Write comments only when they clarify an invariant, non-obvious behavior or a necessary constraint.
- Keep comments short, accurate and specific to this codebase. Do not narrate obvious code.
- Do not mention external planning documents, reference projects, this conversation, implementation tasks or AI generation in explanatory source comments.
- Explain what the code guarantees or why an edge case matters. Do not claim safety, privacy or performance beyond what the implementation proves.
- Keep architectural context in documentation. Keep reference attribution in README, NOTICE and license files; preserve legally required notices in reused code.

## Commits and branches

- Use Conventional Commits: type(scope): concise imperative description.
- Allowed types: feat, fix, refactor, test, docs, chore, build, ci, perf, revert.
- Example: feat(wallet): reserve task budgets atomically.
- Add BREAKING CHANGE details only for an actual incompatible public behavior change.
- Keep each commit focused and include the verification relevant to that change.
- Use branch names type/short-kebab-description, matching the same type vocabulary.
- Examples: feat/private-pool, fix/payment-reconciliation, docs/setup-guide.
- Avoid spaces, agent names, version hype or unspecified random identifiers in branch names.
- Inspect current branch and worktree before creating a branch. Do not discard existing changes or move unrelated work.

## Build discipline

- Implement the mandatory backlog in dependency order. A runnable private payment comes before expanding the dashboard.
- Preserve real on-chain proof verification. Never replace it with a database permission, mocked verifier or address rotation and call it private.
- Keep devnet identity and mint checks fail-closed. Never fall back to mainnet.
- Keep model tools away from notes, signing keys, provider credentials and policy mutation.
- Use integer financial units, atomic reservations, durable operation IDs and reconciliation for uncertain outcomes.
- Keep shared service credits and direct USDC payments distinct. Do not implement separate task credit buckets.
- Never expose seeds, keypair bytes, encrypted-note decryption secrets or API keys in output, logs, Git or screenshots.
- Run meaningful tests for modified financial/security behavior. Do not weaken checks, vectors or assertions to make tests pass.
- Label fixtures, sponsored inference and unverified behavior accurately. Report a measured blocker instead of silently removing a core requirement.
- Preserve source-license notices and reference attribution in project documentation.

## Completion

A feature is complete only when its relevant acceptance tests pass and its end-to-end behavior is demonstrated. Report what changed, what was verified and what remains blocked. A successful requirements review is not an audit or a deployment.
