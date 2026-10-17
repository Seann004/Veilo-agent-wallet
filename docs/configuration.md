# Configuration

Veilo reads configuration from environment variables. Each service loads the repository-root `.env` (or the file named by `VEILO_ENV_FILE`) at startup; variables already present in the process environment take precedence. `.env.example` is the secret-free template; `pnpm setup:local` copies it to `.env` only when `.env` does not exist and never modifies an existing `.env`.

Validation lives in `packages/contracts` (`loadConfig`). Invalid configuration stops the process before it listens. Validation errors name the variable but never echo its value.

## Network guard (devnet only)

| Check | When | Failure |
|---|---|---|
| `EXPECTED_DEVNET_GENESIS_HASH` equals `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; mainnet genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` is rejected explicitly | config load | `WRONG_NETWORK` |
| `SOLANA_CAIP2_NETWORK` equals `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mainnet CAIP-2 (short or full form) is rejected | config load | `WRONG_NETWORK` |
| `DEMO_TOKEN_MINT` equals `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | config load | `WRONG_MINT` |
| RPC `getGenesisHash` equals the expected devnet hash and is not mainnet; CAIP-2 matches its first 32 characters | service startup / `pnpm check:devnet` | `WRONG_NETWORK`, process exits |
| Mint account at `finalized` commitment exists, is owned by the original SPL Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (Token-2022 rejected), is 82 bytes, initialized and has 6 decimals | service startup / `pnpm check:devnet` | `WRONG_MINT`, process exits |
| RPC unreachable or erroring | service startup | `/health` returns 503 (`chain.state = "unavailable"`); the check is retried every 30 s; there is no fallback endpoint |

Control, wallet, gateway and relayer run the live check; their `/health` is 200 only after it passes. Under `pnpm dev`, a mismatch in any service stops the whole stack.

## Variables

### Chain and payment

| Variable | Default | Description |
|---|---|---|
| `DEVNET_RPC_URL` | required | Solana devnet JSON-RPC URL (http/https). Only the origin is ever printed, because provider URLs can embed API keys. |
| `EXPECTED_DEVNET_GENESIS_HASH` | required | Must be the devnet genesis hash shown above. |
| `SOLANA_CAIP2_NETWORK` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | x402 CAIP-2 network id. Only devnet is accepted. |
| `DEMO_TOKEN_MINT` | required | Pinned devnet test-USDC mint (6 decimals, original SPL Token program). |
| `FACILITATOR_URL` | required | x402 facilitator for the merchant leg (https). Default in the template: `https://facilitator.payai.network`. |

### Pool deployment

| Variable | Default | Description |
|---|---|---|
| `POOL_PROGRAM_ID` | empty | Deployed pool program address; filled after `pnpm deploy:devnet`. Validated as a base58 address when set. |
| `POOL_ID` | empty | Logical pool instance id from the deployment manifest. |
| `DEPLOYMENT_MANIFEST_PATH` | `artifacts/deployment/devnet.json` | Deployment manifest location. |
| `FUNDING_KEY_PATH` | empty | Funded devnet bootstrap keypair (local file, never printed). `deploy:devnet` uses it (or `--funding <path>`) only to fund roles and test participants. The runner never receives it. |

### Inference

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | empty | Operator-funded provider key. Secret. Delivered only to the gateway process; every other process deletes it from its environment at startup. Never printed (summaries show `set`/`unset`). |
| `PLANNER_MODEL_ID` | empty | Pinned model for bounded sponsored planning calls. |
| `INFERENCE_MODEL_ID` | empty | Pinned model for paid inference SKUs. |
| `OPERATOR_MAX_REAL_USD_MICRO` | `0` | Operator real-dollar ceiling in micro-USD (non-negative integer). `0` or missing disables real inference. Real inference is enabled only when this is positive **and** a provider key is set. |

### Secret file paths

These are paths to files whose contents are never printed or logged. `setup:local` reports whether each file exists but never reads, creates or replaces them.

| Variable | Description |
|---|---|
| `SPONSOR_KEY_PATH` | Fee/rent sponsor keypair used by the relayer. |
| `OWNER_SERVICE_SECRET_PATH` | Owner wallet-service secret (note encryption / backup root). |
| `CONTROL_SERVICE_CREDENTIAL_PATH` | Credential the control service uses to authenticate itself to other services. |
| `RUNNER_WORKER_CREDENTIAL_PATH` | Scoped worker credential for the runner. |
| `WALLET_SERVICE_CREDENTIAL_PATH` | Wallet service credential. |
| `GATEWAY_ADMIN_CREDENTIAL_PATH` | Gateway administration credential (separate from owner and worker credentials). |
| `RELAYER_SERVICE_CREDENTIAL_PATH` | Relayer service credential. |

The runner process deletes `SPONSOR_KEY_PATH`, `OWNER_SERVICE_SECRET_PATH` and the other services' credential paths from its environment at startup, so a worker never learns where those files are.

### Storage and directories

| Variable | Default | Description |
|---|---|---|
| `CONTROL_DATABASE_PATH` | `data/control.sqlite` | Authoritative owner ledger (SQLite, WAL). |
| `GATEWAY_DATABASE_PATH` | `data/gateway.sqlite` | Gateway credit and purchase ledger. |
| `VEILO_DATA_DIR` | `data` | Created by `setup:local` with owner-only permissions. |
| `VEILO_SECRETS_DIR` | `secrets` | Created by `setup:local` with owner-only permissions; gitignored. |

Relative paths resolve against the repository root.

### Service listeners

| Variable | Default |
|---|---|
| `VEILO_BIND_HOST` | `127.0.0.1` |
| `DASHBOARD_PORT` | `3000` |
| `CONTROL_PORT` | `4101` |
| `RUNNER_PORT` | `4102` |
| `WALLET_PORT` | `4103` |
| `GATEWAY_PORT` | `4104` |
| `RELAYER_PORT` | `4105` |

Every process serves `GET /health`.

### Control service

| Variable | Default | Description |
|---|---|---|
| `VEILO_OWNER_PUBKEY` | empty | Owner wallet address. When set, control seeds the workspace once with **draft** default policies (activation is an owner action). Owner login is unavailable until the workspace exists. |
| `VEILO_GUEST_PUBKEYS` | empty | Comma-separated base58 wallet addresses that may sign in as **guests**. A guest reads the full (unredacted) workspace and may run agents (`POST /agents/:id/run`) without a task spending limit; every other mutation, the wallet (deposit, exit, recovery, note status) and policy stay owner-only. Startup fails on an invalid address or if the list contains `VEILO_OWNER_PUBKEY`. The role is recomputed on every request, so removing a wallet and restarting control ends its sessions. Guest actions are audited with actor type `system`, the guest address as actor id and `{"actor":"guest"}` in details. |
| `VEILO_GUEST_RUNS_PER_HOUR` | `20` | Agent runs one guest wallet may start per rolling hour (1 to 10000), counted from the audit log. The owner is not limited. |
| `VEILO_PUBLIC_VIEW` | `0` | `1` enables an anonymous read-only viewer when the request carries no Authorization header and no valid session. Viewers get the read endpoints only, with session and worker-credential events removed, activity details reduced to an allowlist, purchase operation ids, request digests, chain attempts, state reasons and execution removed, and the gateway account id removed from balances. Any other value except empty or `0` is rejected at startup. |
| `VEILO_DASHBOARD_ORIGIN` | `http://localhost:<DASHBOARD_PORT>` | Exact browser origin. Its host is bound into the sign-in challenge, and mutating owner requests from any other Origin are rejected. An `https:` origin enables the Secure cookie attribute. |
| `CONTROL_USAGE_PERMIT_KEY_PATH` | `<VEILO_SECRETS_DIR>/control/usage-permit-signing.pem` | Control-only Ed25519 private key that signs usage permits. Created by `pnpm demo:seed`, never printed. Missing: prepaid usage is unavailable. |
| `CONTROL_GATEWAY_ACCOUNT_TOKEN_PATH` | `<VEILO_SECRETS_DIR>/control/gateway-account.token` | Bearer token of the workspace's single gateway credit account. Agents never receive it. Missing: purchases stay authorization-only (NOT_READY). |
| `CONTROL_SERVICE_CREDENTIAL_PATH` | empty | Control's bearer credential towards the wallet service funding API. Unset: the funding provider is `unavailable` and returns NOT_READY; it never reports a funded purchase. |
| `GATEWAY_PLANNING_CREDENTIAL_PATH` | `<VEILO_SECRETS_DIR>/gateway/planning.token` | Read by control to proxy operator-sponsored planning (`POST /worker/planning`); withheld from the runner. |
| `CONTROL_PURCHASE_WAIT_MS` | `120000` | How long a purchase request (worker intent, owner reconcile, Shawn check) keeps reconciling a pending chain outcome of the same operation before it replies. Waiting never authorizes, proves or signs anything new. |
| `CONTROL_PURCHASE_SWEEP_MS` | `15000` | The scheduler reconciles every purchase with unresolved execution at most this often, so a withdrawal or payment that finalizes after its request returned still completes. |

`pnpm demo:seed` (requires `VEILO_OWNER_PUBKEY`) is idempotent. It seeds the workspace, the three agents with **draft** policies and the fixed catalog. It creates one shared gateway account and the integration secret files above, plus the runner's worker-credential file. If the gateway merchant and fee payer are configured, it binds the unbound services to that recipient. A rerun changes nothing and never issues credits. If the account exists but its token file is lost, it stops instead of creating a second account.

Wallet note secrets and fresh-wallet keys use a separate SQLite file, `<VEILO_SECRETS_DIR>/wallet-secrets.sqlite`, which only the wallet service opens. The control ledger refuses to open it (role check) and refuses to live inside the secrets directory. The runner receives only `toRunnerConfig`: network, control URL, its own worker-credential path and planner model. Every path in `RUNNER_WITHHELD_ENV` is deleted from its environment: provider key, sponsor/funding/owner-secret key paths, other services' credentials, both database paths and the secrets directory.

### Gateway service

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_IDENTITY` | `veilo-gateway-devnet` | Gateway identity: `resource.serviceName` in challenges and the required `aud` of usage permits. |
| `GATEWAY_PUBLIC_ORIGIN` | `http://<bind>:<GATEWAY_PORT>` | Origin used in quote execute URLs and x402 resource URLs. |
| `GATEWAY_MERCHANT_ADDRESS` | empty | Merchant wallet (`payTo`). The recipient ATA is derived from it and the pinned mint. Unset: x402 acceptance disabled. |
| `GATEWAY_MERCHANT_ATA` | empty | Optional pin; must equal the derived ATA or acceptance stays disabled. |
| `GATEWAY_FACILITATOR_FEE_PAYER` | empty | The only facilitator fee payer named in requirements; must be advertised for x402 v2 `exact` on the devnet CAIP-2 by `FACILITATOR_URL/supported`. |
| `GATEWAY_QUOTE_TTL_SECONDS` | `600` | Quote lifetime (60-3600). |
| `GATEWAY_PROVIDER_TIMEOUT_MS` | `60000` | Timeout of the single provider attempt; a timeout is recorded as uncertain and never retried. |
| `GATEWAY_PRICING_MAX_AGE_SECONDS` | `21600` | Live pricing older than this disables dispatch. |
| `GATEWAY_SETTLEMENT_WAIT_MS` | `40000` | How long one execute request waits for finality before returning 202. |
| `USAGE_PERMIT_PUBLIC_KEY_PATH` | empty | PEM Ed25519 public key of the control service's usage-permit signer. Unset: prepaid usage disabled. |
| `GATEWAY_PLANNING_CREDENTIAL_PATH` | empty | File holding the sponsored-planning bearer token (only its SHA-256 is kept in memory). Control presents it on behalf of running tasks; the runner never holds it. |
| `GATEWAY_TEST_PROVIDER_URL` | empty | Local test validator profile only (loopback URL): an OpenRouter-compatible mock replaces OpenRouter. The provider is labeled `fixture` and never counts as real inference. Rejected under the devnet profile. |
| `VEILO_TEST_CRASH_POINTS` | empty | Local test validator profile only. Comma-separated `gateway.afterClaim`, `gateway.afterPaymentFinalized` or `gateway.beforeProviderCall`: the gateway exits with code 86 at that hook, so tests can restart it at that boundary. Rejected under the devnet profile. |

The deployment manifest may carry `{"gateway": {"merchantAddress", "merchantAta", "facilitatorFeePayer"}}`; when the manifest and the environment both set a value they must agree. The gateway keeps its own SQLite ledger at `GATEWAY_DATABASE_PATH`. Accounts are created with `pnpm --filter @veilo/gateway account:create -- --workspace <id> --out <token-file>`; the token is written to a new owner-only file and never printed.

### Runner service

| Variable | Default | Description |
|---|---|---|
| `RUNNER_WORKER_CREDENTIAL_PATH` | empty | Per-agent worker tokens. `demo:seed` writes `<VEILO_SECRETS_DIR>/runner/worker-credentials.json` when unset and prints the path to set here. Format (`{"agents":[{"agentId","role","token"}]}`). The runner polls and claims jobs for these agents only. |
| `RUNNER_APPROVED_FETCH_ORIGINS` | empty | Exact origins agent tools may fetch (owner-suggested sources). Others are listed as "not fetched". |
| `RUNNER_LOCAL_SERVICE_ORIGINS` | empty | Subset of approved origins that are configured local demo services and may resolve to loopback/private addresses. All other targets must resolve to public addresses; redirects are not followed. |

### Wallet and relayer services

| Variable | Default | Description |
|---|---|---|
| `OWNER_SERVICE_SECRET_PATH` | empty | Wallet-service root secret (32 random bytes). `setup:local` creates it once with owner-only permissions and never prints it. Note secrets, one-time keys and backups are encrypted under keys derived from it; keep a separate copy. Unset: the wallet serves only `/health`. |
| `WALLET_SERVICE_CREDENTIAL_PATH` | empty | Bearer token the wallet presents to control (`/internal/wallet/*`) and the relayer. |
| `CONTROL_SERVICE_CREDENTIAL_PATH` | empty | Bearer token control presents to the wallet funding API (`/fundings*`). |
| `OWNER_RECOVERY_ADDRESS` | empty | The only destination owner recovery may pay (its exact-mint ATA must exist). Unset: recovery is unavailable. |
| `RELAYER_DATABASE_PATH` | `<VEILO_DATA_DIR>/relayer.sqlite` | Relayer withdrawals, attempts, sponsor lamport ledger and indexed transaction cache. |
| `RELAYER_SPONSOR_LAMPORT_CAP` | `100000000` | Total sponsor exposure (fees spent + outstanding rent) the relayer may incur. |
| `APPROVED_LABELS_PATH` | `artifacts/deployment/approved-labels.json` | Operator-published ordered approved-label list (written by `pnpm --filter @veilo/relayer approve-root`). |
| `APPROVED_PARTICIPANTS` | empty | Comma-separated synthetic/test participant addresses whose inserted deposits the prototype rule approves. |
| `VEILO_CIRCUIT_BUILD_DIR` | `circuits/build` | Proving files (hash-checked against `artifacts/circuits/manifest.json`). |
| `VEILO_CONTROL_URL`, `VEILO_RELAYER_URL` | loopback + service port | Overrides for the wallet's control and relayer clients. |
| `WALLET_NOTE_SYNC_MS` | `10000` | Interval of the wallet's background note sync against verified public state. Inserted deposits and change notes become spendable, and are reported to control, without an owner session. |

`pnpm backup` writes an AES-256-GCM encrypted snapshot (SQLite backup API) of the wallet secrets DB and control ledger to `backups/`. `pnpm restore -- --file <path> [--include-control]` must run with the wallet stopped; it validates every encrypted row, moves the old files aside, advances key counters by 1000 and blocks new proofs and signatures until the wallet's startup reconciliation passes.

### Diagnostics

| Variable | Description |
|---|---|
| `VEILO_ENV_FILE` | Alternate env file path. |
| `VEILO_LOG_CONFIG=1` | Services print a redacted configuration summary at startup (`describeConfig`). |
| `VEILO_TOOLCHAIN_IMAGE` | Override the toolchain image tag used by `pnpm tc`. |
| `VEILO_CHAIN_PROFILE` | `devnet` (default) or `local-test-validator`. The local profile is for `pnpm test:integration` and `pnpm demo:run -- --local-rehearsal`. Under it, `DEVNET_RPC_URL` and `FACILITATOR_URL` must be loopback (http is allowed). The chain guard also requires a genesis hash that is neither devnet nor mainnet, so this profile never acts on a public cluster. Mint checks are unchanged. Under `devnet` the facilitator must use https. |
| `VEILO_DEPLOY_PROFILE` | `local-rehearsal` points `keys:init`, `deploy:devnet` and `demo:private-smoke` at `work/rehearsal/` and a loopback test validator (non-loopback, devnet and mainnet RPC refused). Unset or anything else: devnet. See docs/deployment.md, "Local rehearsal". |

## Owner-only permissions

On POSIX, `setup:local` sets `data/` and `secrets/` to mode 0700, and a `.env` it creates to 0600. On Windows, it removes inherited ACEs and grants full control only to the current user via `icacls`.
