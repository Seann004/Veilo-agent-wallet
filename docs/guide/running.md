# Running Veilo

**Verification scope:** M2 is **verified on devnet**. Integrated payments/recovery are **verified on local test validator**, agent inference uses a **fixture / mock provider**, and complete devnet agent acceptance evidence is missing here. Marketplace acceptance is **not yet run** in this checkout. See [current status](./status.md).

## Marketplace setup is a separate, pending track

The commands below start the existing local wallet workspace, not the v3.2 marketplace. T18 will add Supabase Auth/Postgres/private Storage; T19–T23 add generic jobs, direct hiring, discovery, connectors and release checks. Supabase is required for that extension but remains unnecessary for the local T00–T16 stack.

No marketplace migration, environment-variable contract, setup script, cloud connection or deployed project is supplied here. Do not invent Supabase key names or use a cloud session as wallet authorization. Follow [marketplace triage](./marketplace-triage.md) and complete the T17 discovery/schema gate before making those changes.

## Application quickstart

Use Node **>=22.14.0 <23**, **pnpm 10.34.6**, and Docker with a running Linux daemon. Native Rust, Solana, Anchor and circom are provided by the pinned Docker toolchain. Allow time/disk/network for the first image and proof builds.

From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm toolchain:build
pnpm setup:local
pnpm check:devnet
```

`setup:local` creates `.env` from `.env.example` if missing and local directories. It creates the wallet encryption root only when `OWNER_SERVICE_SECRET_PATH` is configured; it reports service credential paths but does not generate those credentials. Existing secrets are never replaced. Back up the encryption root separately; never commit it.

Edit `.env` locally using [configuration](../configuration.md): set `VEILO_OWNER_PUBKEY`, deployment manifest/program/pool values and role credential/key **paths**. Configure gateway merchant/ATA and facilitator fee payer consistently with the manifest. Missing bindings remain unbound/NOT_READY. For live inference only, the gateway needs an operator-funded OpenRouter key, allowlisted models and a nonzero bounded `OPERATOR_MAX_REAL_USD_MICRO`; test USDC cannot buy provider dollars.

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

Seed policies start as drafts and seeding never issues credits. Open the dashboard at `http://127.0.0.1:3000`, connect the configured devnet owner wallet and review/activate workspace and agent policies. Control/runner/wallet/gateway/relayer use ports 4101–4105. Run [deployment instructions](../deployment.md) to provision/fund roles and deploy a pool before attempting private purchases. A clean clone has no funded keys, proving keys, databases or provider credentials.

## Proofs, rehearsal and devnet recording

```sh
pnpm test:circuits
pnpm test:program
pnpm test:integration
pnpm demo:run -- --local-rehearsal
```

The integration suite needs the built program (`target/deploy/privacy_pool.so`) and manifest-compatible proving files (`circuits/build/`). The local rehearsal uses throwaway keys, loopback validator/facilitator and **fixture / mock provider**. It writes under ignored `work/demo-rehearsal/evidence/`; its signatures cannot be checked on a devnet explorer.

The parallel deployment branch records an earlier devnet gateway run whose state and acceptance files are absent here. Recover that run’s original state/ledgers and use the corresponding acceptance-checking script version before deciding another paid run is needed; do not reset operation IDs to manufacture a fresh result. See [handoff](../handoff.md#parallel-branch-evidence).

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
