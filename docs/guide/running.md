# Running Veilo

Use your own wallet, deployment and provider accounts. A clean clone contains no author API keys, wallet keys or local state. [Current status](./status.md) records verification and remaining checks.

Provider-backed calls use the configured operator's real credits. Leave the real-inference budget at zero until you have configured your own account and spending limits. Do not copy an existing operator's `.env`, secret directory, databases or private keys, and do not point a new installation at their service credentials. Public program IDs, mint addresses and transaction receipts are not credentials.

## Marketplace setup (optional)

The local T00–T16 workspace runs without Supabase. To enable the marketplace, set the Supabase and marketplace variables from `.env.example` (see [configuration](../configuration.md#marketplace-service-and-dashboard)), apply `supabase/migrations/` to the project, enable the Supabase Web3 (Solana) sign-in provider, and run `pnpm setup:local` to create the seller-host and operator token files. `pnpm dev` then also starts the marketplace service and the seller host. A cloud session never authorizes a wallet spend.

```sh
pnpm test:marketplace-rls   # live identity/RLS/Storage checks; chain reads use a labeled fixture
pnpm marketplace:seed       # read-only plan; add --confirm to create the demo catalogue
```

The service key stays in the marketplace process only.

## Application quickstart

Use Node **24 LTS** (`>=22.14.0 <25`), **pnpm 10.34.6**, and Docker with a running Linux daemon. Native Rust, Solana, Anchor and circom are provided by the pinned Docker toolchain. Allow time/disk/network for the first image and proof builds.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm toolchain:build
pnpm setup:local
pnpm check:devnet
```

`setup:local` creates `.env` from `.env.example` if missing and local directories. It creates the wallet encryption root only when `OWNER_SERVICE_SECRET_PATH` is configured; it reports service credential paths but does not generate those credentials. Existing secrets are never replaced. Back up the encryption root separately; never commit it.

Edit `.env` locally using [configuration](../configuration.md): set `VEILO_OWNER_PUBKEY`, deployment manifest/program/pool values and role credential/key **paths**. Configure gateway merchant/ATA and facilitator fee payer consistently with the manifest. Missing bindings remain unbound/NOT_READY. For live inference only, the gateway needs an operator-funded OpenRouter key, allowlisted models and a nonzero bounded `OPERATOR_MAX_REAL_USD_MICRO`; devnet USDC cannot buy provider dollars.

For a new manual local stack, set `OWNER_SERVICE_SECRET_PATH=secrets/owner-service.secret`, `CONTROL_SERVICE_CREDENTIAL_PATH=secrets/control-service.credential`, `WALLET_SERVICE_CREDENTIAL_PATH=secrets/wallet-service.credential` and `RELAYER_SERVICE_CREDENTIAL_PATH=secrets/relayer-service.credential` in `.env`. Generate those three independent credentials without printing them (the directories already exist after setup):

```sh
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; for (const role of ["control", "wallet", "relayer"]) writeFileSync(`secrets/${role}-service.credential`, randomBytes(32).toString("hex")+"\n", {flag:"wx", mode:0o600});'
pnpm setup:local
```

This command is for a fresh stack only and refuses existing files. Restore missing credentials for an existing ledger instead of resetting identities. On Windows restrict these credential files with owner-only ACLs; POSIX `mode` does not enforce a Windows ACL. The isolated `demo:run` creates its own credentials and does not use these manual-stack files.

```sh
pnpm demo:seed
pnpm check
pnpm test
pnpm dev
```

Seed policies start as drafts and seeding never issues credits. Open the dashboard at `http://localhost:3000`; it must match `VEILO_DASHBOARD_ORIGIN`, which binds the sign-in challenge and rejects mutating requests from another origin. `pnpm dev` starts the dashboard (Next.js dev server on webpack, port 3000) and control/runner/wallet/gateway/relayer on ports 4101–4105; with Supabase configured it also starts the marketplace (4106) and the seller host (4107 in `.env.example`), plus the optional carousel seller host when its `CAROUSEL_SELLER_*` settings are present. The runner reads public pages through an installed Chrome; set `RUNNER_BROWSER=off` if none is installed.

| Path | Screen |
|---|---|
| `/` | Public landing page |
| `/workspace` | Owner workspace: agents, policies, shared treasury, emergency stop |
| `/agents/new`, `/agents/<id>` | Create or configure an agent; the agent's chat, live steps and results |
| `/connectors` | Read-only MCP connectors attached to agents, and result destinations (Telegram, Slack, Discord) |
| `/outputs` | Saved results, editable content drafts and calendar |
| `/wallet` | Pool balance, deposit and exit, activity, recovery and the Agent swaps approval |
| `/settings` | The owner's AI model key and privacy limits |
| `/marketplace/…` | Open marketplace: workflows, role templates, create, tools, runs, jobs, seller console, agents, Local approval |

Older addresses redirect: `/activity` and `/recovery` to `/wallet`, `/privacy` to `/settings`, `/content` to `/outputs`, `/market` to `/marketplace`.

Sign in with the configured owner wallet, then review/activate workspace and agent policies. Add a model provider key in **Settings** so agents can do model work; without one only the operator-sponsored planning trial is available. How to approve swaps, attach CoinGecko market data and attach a reference image is in [agent workflows](./agents.md#owner-how-to-swaps-market-data-and-reference-images). Wallets listed in `VEILO_GUEST_PUBKEYS` sign in as guests: they can run agents within their policies (rate-limited by `VEILO_GUEST_RUNS_PER_HOUR`) but cannot configure, fund, recover or approve. `VEILO_PUBLIC_VIEW=1` adds a redacted read-only view without sign-in. The header toggles light/dark mode; without a choice the system setting applies. Run [deployment instructions](../deployment.md) to provision/fund roles and deploy a pool before attempting private purchases. A clean clone has no funded keys, proving keys, databases or provider credentials.

## Proofs, rehearsal and devnet recording

```sh
pnpm test:circuits
pnpm test:program
pnpm test:integration
pnpm demo:run -- --local-rehearsal
```

The integration suite needs the built program (`target/deploy/privacy_pool.so`) and manifest-compatible proving files (`circuits/build/`). The local rehearsal uses throwaway keys, loopback validator/facilitator and **fixture / mock provider**. It writes under ignored `work/demo-rehearsal/evidence/`; its signatures cannot be checked on a devnet explorer.

Devnet run `2026-10-17-1eba868c` and its export are committed under `artifacts/evidence/`. A new run must use its own run ID; do not reset operation IDs or reuse another run's state to manufacture a fresh result. The macOS operator checklist is in [deployment](../deployment.md).

For a new deployment, follow the [devnet runbook](../deployment.md#devnet-deployment-runbook-t09-m2), including key initialization, program-ID alignment/build and circuit manifest checks. Do not regenerate role or proving keys for an existing deployment. The deterministic development setup is unsuitable for production funds.

```sh
pnpm demo:run
# After readiness passes and operator budgets/policies are reviewed:
pnpm demo:run -- --execute --confirm
pnpm evidence:export
```

The first command is read-only and makes no inference call. Execution signs deposits, withdrawals/merchant payments and exit, and incurs bounded operator provider costs. Rerun the same execute command to resume recorded operations. The eight-step [demo script](./demo.md) gives expected records and screenshot placeholders.

The script starts isolated backend services; funded dashboard screenshots require a separately configured dashboard connected to those same run databases/service ports. A screenshot of another workspace is not evidence of this run.

## Backup and recovery

Quiesce service writers before `pnpm backup` for an operator snapshot: wallet and control files are copied separately. Use the encrypted wallet/control snapshot and keep `OWNER_SERVICE_SECRET_PATH` separately. Stop the wallet and other writers before `pnpm restore -- --file <encrypted-backup> --include-control`; retain the matching gateway ledger and credentials rather than resetting issued credits. Startup reconciliation blocks new authority until pending operations are resolved. See [configuration](../configuration.md) for the exact scope. A public exit/recovery can reveal spending/linkage and cannot cancel already released authority.

## Documentation site

The documentation has its own npm lockfile:

```sh
cd docs
npm ci
npm run dev
# Or build and preview:
npm run build
npm run preview
```

The default base is `/Veilo-agent-wallet/`; open the printed base URL. Use `DOCS_BASE=/ npm run build` for a domain root. The build generates `llms.txt`, its intentional compatibility alias `llms.text`, and `llms-full.txt`.

VitePress 1.6.4 uses a pinned Vite 6.4.4 override and Mermaid 12.2.0. Revalidate the build and browser behavior when changing these dependencies. A successful documentation build does not run application/security tests.
