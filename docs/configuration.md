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
| `DEMO_TOKEN_MINT` | required | Pinned devnet USDC mint (6 decimals, original SPL Token program). |
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
| `CONTROL_PROVISION_RUNNER_CREDENTIALS` | empty | Single-host local deployments only. With `1` and `RUNNER_WORKER_CREDENTIAL_PATH` set, control issues a worker credential for every active research, content or custom agent that has no live entry in that file (at startup, on policy activation and on resume) and removes the entry when the agent is revoked or archived. The file is replaced atomically (temporary file and rename, mode 0600) and keeps other entries; tokens are never logged. Leave unset when the runner runs on another host or its credentials are managed by hand. |

#### Marketplace controller (control)

| Variable | Default | Description |
|---|---|---|
| `MARKETPLACE_URL` | empty | Marketplace base URL (https, or loopback http for tests). Unset: marketplace hires are disabled. Control only connects outbound; every controller request is signed. |
| `MARKETPLACE_MAX_PAYMENT_UNITS` | `1000000` | Ceiling on any one marketplace payment, in USDC base units. Larger quotes are rejected locally. |
| `MARKETPLACE_LOCAL_SELLER_ORIGINS` | empty | Comma-separated exact origins of local test sellers. Only these may use http or resolve to loopback/private addresses; every other seller origin must be a public https DNS name, re-resolved on every connection. |
| `MARKETPLACE_POLL_MS` | `10000` | Payment-request polling interval. |
| `MARKETPLACE_MIN_QUOTE_REMAINING_SECONDS` | `120` | Minimum time the marketplace quote must still have when the private proof is about to be released. With less left, control cancels the unreleased funding and rejects the hire with `QUOTE_EXPIRED`, because the seller host refuses an expired quote and a withdrawal that finishes later would strand the funds in the one-time wallet. Recommended: set the marketplace's `MARKETPLACE_QUOTE_TTL_SECONDS` to `900` (the marketplace database caps it at 15 minutes) so a private withdrawal fits inside the quote. |
| `CONTROL_CONTROLLER_KEY_PATH` | `<VEILO_SECRETS_DIR>/control/marketplace-controller.pem` | Ed25519 controller key (0600), generated on first start. Withheld from the runner. |
| `CONTROL_SELLER_ACCOUNTS_DIR` | `<VEILO_SECRETS_DIR>/control/seller-accounts` | Per-seller-host account tokens (0600 files), created on first use through `POST /v1/accounts`. Withheld from the runner. |
| `EXTERNAL_X402_MAX_BATCH_UNITS` | `100000` | Ceiling for one external x402 binding's batch (unit price × max calls), in USDC base units. |
| `EXTERNAL_X402_LOCAL_ORIGINS` | empty | Comma-separated exact origins of local test x402 resources (tests only). Every other external origin must be a public https DNS name, re-resolved on every request; redirects are refused. |
| `WORKFLOW_MAX_RUN_UNITS` | `1000000` | Ceiling for one workflow run's approved total, in USDC base units. |
| `CONNECTOR_CALLS_PER_TASK` | `5` | Most agent-connector calls one task may make (0–100), counted when the call is reserved, whatever its outcome. Each call also counts against the task's tool-call bound. |
| `CONNECTOR_CALLS_PER_AGENT_DAY` | `50` | Most agent-connector calls one agent may make in any rolling 24 hours (0–10000). |
| `CONNECTOR_MAX_TEXT_CHARS` | `16000` | Text kept from one connector reply (at most 64000); images, resources and links in the reply are dropped. |
| `CONNECTOR_CALL_TIMEOUT_MS` | `20000` | Timeout for each MCP request a connector call makes (initialize, tools/list, tools/call). |

**External x402 resources.** The owner approves a binding (`POST /external-bindings`): exact origin and path (or `/*` prefix), devnet network and pinned mint, `payTo` and its derived ATA, unit price, maximum calls, allowed facilitator fee payers and, for JSON-RPC, allowed methods. Terms are immutable; a change is a new binding. An agent buys a batch with a purchase intent (SKU `external-x402-batch`): control reserves unit × max calls under every cap, funds one fresh payer from the pool, then pays each call after verifying its 402 challenge against the binding (a challenge with several prices for one recipient, such as a per-request price and a prepaid top-up, is accepted only at the pinned unit price). Calls in one batch share that payer and are linkable to each other on chain. A lost reply is reconciled from the payer's chain history and never paid again; a mismatch, refusal, unpaid call or emergency stop ends the batch, the merchant leg settles what was spent and the remainder becomes owner-recoverable. Bindings that a workflow approval installs are workflow-scoped and refused to purchase intents.

**Workflow runs.** `POST /workflows/runs` prepares terms from the marketplace's published tool facts (each step's tool, recipient, maximum and a digest of its full tool terms, the total and the run inputs); `POST /workflows/runs/:id/approve` takes that digest. Each step is then its own purchase: listing steps hire under `wf:<run>:<index>` and are approved locally only when the quote matches the step; external steps bind their one-time payer to the run step before funding. A changed quote halts the run before that step is paid; a failed or uncertain step stops it with earlier steps paid. `POST /workflows/assignments` lets an agent propose runs of a version within a budget (`POST /worker/workflow-runs`); a proposal outside the budget or for different terms waits for the owner, and revoking the assignment halts its runs.

**Agent connectors.** An owner attaches an operator-approved, read-only MCP connector from the marketplace catalogue to an agent (`PUT /agents/:id/connectors/:connectorId` with `{ "tools": [...] }`; `GET /agents/:id/connectors`; `DELETE` to remove). Control fetches `GET /marketplace/connectors` itself, so attaching needs `MARKETPLACE_URL`; it recomputes each tool's digest and pins name, digest and input schema. Archived and revoked agents are refused. A running task calls an attached tool through `POST /worker/connector-calls`: control checks the task belongs to the calling agent and is running, the agent is active and the emergency stop is clear (again just before `tools/call`), and the arguments fit the pinned schema; it then applies the caps above. Every call re-reads `tools/list` over the public-address-only client and refuses on any digest change, marking the attachment `changed` until the owner attaches it again. Connector tools are free and keyless: there is no x402 payment, no credential is sent, and replies are returned as untrusted data. Only digests of arguments and replies are stored. A research brief may cite a successful call of its own task as `mcp:<connectorId>/<tool>#call=<callId>`.

A cloud approval never authorizes spending. A payment request is paid only after a local owner approval bound to its operation, quote digest, recipient and total (`POST /marketplace/hires/:operationId/approve`), or when an owner-installed listing grant (`PUT /agents/:id/marketplace-allowlist`) matches a hire that this control service proposed for that agent. Before the pool proof is released, the wallet signs `payerBindingMessage` with the operation's fresh payer key (`POST /fundings/:purchaseId/payer-binding`, control credential only, refused after release), and control waits until the marketplace acknowledges that payer. Only a definite refusal (HTTP 403, or 409 such as `INVALID_TRANSITION` or a payer conflict) cancels the unreleased funding. A 401, 408, 429, 5xx, other 4xx or network error re-sends the same payer and proof under a fresh signature, and the proof is never released without a 2xx.

After funding finalizes and before any merchant authority, an expired gateway quote is re-quoted and the funding reused. If the marketplace quote itself has expired by then, nothing is signed: the purchase becomes recoverable and the hire closes unpaid, shown to the owner as `recoverable` with code `QUOTE_EXPIRED`. Payment evidence is reported only after the merchant transfer finalized. A 202 keeps it queued. A 2xx, or a 409 that carries the existing receipt, completes it. Any other refusal keeps the report queued and retries it with backoff (30 s doubling to 1 h), and the hire shows as `evidence_rejected` with the marketplace's code. `GET /marketplace/hires` lists pending, `evidence_rejected` and `recoverable` hires by default.

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

#### Seller-host profile

`GATEWAY_ROLE=seller-host` runs the same gateway code as a second, separate process that sells marketplace specialist jobs. Start it with `pnpm --filter @veilo/gateway start:seller-host`. It uses the operator gateway's seller protocol, so control pays it unchanged: `POST /quotes`, `POST /v1/purchases/:quoteId/execute` (402 with an x402 V2 `exact` `PAYMENT-REQUIRED`, then `PAYMENT-SIGNATURE`) and `GET /v1/purchases/:quoteId/result`.

The two roles stay apart:
- A seller host quotes only `specialist-job`. It refuses credit packs, datasets, the fixed inference SKUs, prepaid usage (`/credits`, `/usage`) and sponsored planning.
- The operator gateway refuses `specialist-job`, because that SKU has no fixed price.

The facilitator support check, the fee-payer pin and finality gating are identical in both roles.

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_ROLE` | `operator` | `operator` or `seller-host`. Set it per process rather than in a shared `.env`. |
| `SELLER_HOST_IDENTITY` | `veilo-seller-host-devnet` | Identity named in challenges. It must equal the marketplace quote's `sellerIdentity` and must differ from `GATEWAY_IDENTITY`. |
| `SELLER_HOST_PUBLIC_ORIGIN` | `http://<bind>:<SELLER_HOST_PORT>` | Origin used in execute and resource URLs. It must equal the quote's `sellerOrigin` and must differ from the operator origin. |
| `SELLER_HOST_PORT` | `4106` | Listen port. It must differ from `GATEWAY_PORT`. |
| `SELLER_HOST_DATABASE_PATH` | `data/seller-host.sqlite` | The host's own ledger. It must differ from `GATEWAY_DATABASE_PATH`. |
| `MARKETPLACE_URL` | required | Marketplace base URL: https, or a loopback URL for local testing. |
| `MARKETPLACE_SELLER_HOST_TOKEN_PATH` | empty | File holding the seller-host bearer credential (preferred). |
| `MARKETPLACE_SELLER_HOST_TOKEN` | empty | The same credential as an environment value. If both are set, they must agree. The credential is never printed. |
| `SELLER_HOST_RECIPIENTS` | empty | Optional comma-separated payout owners. When set, a quote naming any other recipient is refused. A seller running their own host should set it to their payout wallet. |
| `SELLER_HOST_ACCOUNTS_PER_IP_HOUR` | `5` | Self-service account creations allowed per client address per hour. There is also a global cap of 200 per hour. |
| `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET` | empty | Seller host only: the seller's own Higgsfield key. Without both, its Higgsfield tools report "Provider not configured" and are never quoted. Higgsfield tools are sold only as workflow steps (its terms forbid a bare pass-through). |
| `HIGGSFIELD_MAX_IMAGES` | `8` | Seller host only: images generated per carousel, clamped to 2–8. A spend cap on the seller's own Higgsfield credits; slides past the cap are not generated. |
| `CAROUSEL_SELLER_IDENTITY`, `CAROUSEL_SELLER_RECIPIENTS`, `CAROUSEL_SELLER_TOKEN_PATH`, `CAROUSEL_SELLER_DATABASE_PATH` | empty | With `CAROUSEL_SELLER_ORIGIN`, `pnpm dev` also starts the carousel creator's seller host on that origin's port: its seller identity, payout recipient(s), host credential file (from the repository root) and database (default `data/seller-host-carousel.sqlite`). |
| `HIGGSFIELD_STYLE` | empty | Seller host only: a visual style (up to 600 characters) appended to every Higgsfield Soul prompt, so all carousel images share one look. |
| `ZERNIO_API_KEY`, `ZERNIO_TIKTOK_ACCOUNT_ID` | empty | Seller host only: the seller's Zernio key and connected TikTok account. Without both, the TikTok draft tool reports "Provider not configured". Drafts are private (`SELF_ONLY`, `tiktokSettings.draft`) and are never published by Veilo. |
| `ZERNIO_PUBLISH_MODE` | `draft` | Seller host only: `draft` or `publish` (anything else stops the host at startup). `publish` turns on the separate `publish_tiktok_carousel` tool (provider `zernio_publish`, effect `publish_external`), which posts publicly (`PUBLIC_TO_EVERYONE`, `publishNow`, no draft flag) and only images this host rendered in the last 24 hours of its current process. The draft tool always drafts, whatever this is set to. Under `draft` the publish tool reports "Provider not configured". |
| `SLIDES_RENDERER` | on | Seller host only: `off` disables the slide designer (`render_carousel_slides`). It is otherwise configured whenever `ZERNIO_API_KEY` and `ZERNIO_TIKTOK_ACCOUNT_ID` are set, since it uploads through Zernio's presigned media upload. |
| `SLIDES_BROWSER_EXECUTABLE` | installed Chrome | Seller host only: Chrome or Chromium binary for slide rendering (playwright-core). Unset uses the installed Google Chrome channel. Rendering runs with scripts off and every request refused except allowlisted images. |
| `SLIDES_IMAGE_HOSTS` | empty | Seller host only: comma-separated exact https hostnames a slide's optional `imageUrl` may load from (for example the Higgsfield CDN host). Empty means no slide loads any image. |
| `CAROUSEL_SELLER_ORIGIN` | empty | Seed only: the seller host origin the carousel tools are listed on. Unset lists them on a placeholder host that cannot be paid. |
| `MAKEUGC_API_KEY`, `MAKEUGC_AVATAR_ID` | empty | Seller host only: the seller's own MakeUGC key (paid plan) and the avatar its videos use. |

`GATEWAY_FACILITATOR_FEE_PAYER`, `GATEWAY_QUOTE_TTL_SECONDS`, `GATEWAY_SETTLEMENT_WAIT_MS`, `GATEWAY_PROVIDER_TIMEOUT_MS`, `GATEWAY_PRICING_MAX_AGE_SECONDS`, the inference model and `OPERATOR_MAX_REAL_USD_MICRO` apply as in the operator role. `GATEWAY_MERCHANT_ADDRESS`/`_ATA`, the usage-permit key and the planning credential are ignored: a seller host has no fixed merchant.

**Quote.** The `specialist-job` input is `{jobId, listingVersionId, quoteDigest, brief}`. The host fetches `GET {MARKETPLACE_URL}/internal/seller-host/jobs/:jobId` (`sellerHostJobViewSchema`) and quotes only when all of these hold:
- the job is `awaiting_payment`;
- `verifyQuote` passes;
- the digest, job, listing version, runtime version and brief digest match the input;
- network, genesis hash, mint and decimals match the host's chain configuration;
- `recipientAta` is the recipient's derived ATA;
- origin and identity match this host;
- the quote has not expired;
- the listing is a Markdown managed template on the pinned model;
- the amount is nonzero.

The gateway quote takes `amount = totalUnits`, `payTo = recipient` and `merchantAta = recipientAta` from that marketplace quote, and expires no later than it. Payment verification compares against those per-quote values.

Any failed check, or an unreachable marketplace, refuses the quote. The error codes are:

| Code | Cause |
|---|---|
| `PRICE_CHANGED` | the digest, IDs or brief differ from the quote |
| `WRONG_NETWORK` | network or genesis hash mismatch |
| `WRONG_MINT` | mint or decimals mismatch |
| `SERVICE_NOT_ALLOWED` | wrong recipient, origin, identity or runtime |
| `QUOTE_EXPIRED` | the marketplace quote has expired |
| `NOT_READY` | the job is not awaiting payment, or the marketplace is unreachable |

A job binds to one buyer operation. Before each challenge and each payment, the host re-checks that the job still awaits payment under the same digest.

**Fulfilment** starts only after finalized settlement. Each step is persisted before the next one starts:
1. `POST …/jobs/:jobId/payment-evidence {operationId, signature}`, so the marketplace verifies the receipt itself. A 409 means already recorded. 202, 401, 408, 429, 5xx and network errors are retried. Any other refusal, such as a 403 `SERVICE_NOT_ALLOWED` for a payer mismatch, closes the purchase as `paid_no_result` with that code in its result.
2. `POST …/claim`, retried with backoff while the job is not queued. The returned lease is stored in the host DB.
3. One bounded provider call for the template, with seller instructions and the brief passed as fenced untrusted data. A heartbeat confirms the lease before dispatch, and another is sent every 15 s while the call runs.
4. `POST …/complete` with a `veilo.result.v1` envelope and one Markdown artifact (SHA-256 and byte count computed locally).
5. If the provider call failed, `POST …/fail` instead, with `uncertain` true when the outcome is ambiguous.

The gateway purchase becomes `delivered`, `incomplete` or `paid_no_result` only after the marketplace acknowledges the outcome. Until then, the result shows the payment as paid and pending.

Inference runs at most once per purchase. A crash or a lost lease resumes from the stored step: a new lease reports the stored output, and an interrupted provider call is reported as uncertain, never re-run. The host repeats pending passes every 30 s.

**Buyer accounts.** `POST /v1/accounts` (seller host only, rate-limited per client address) returns `{accountId, token}`. The token is shown once; only its SHA-256 is stored. An account sees only its own quotes and results, and every execution still needs a valid x402 payment. A remote seller can run this profile on their own infrastructure with their own marketplace seller-host credential, origin and `SELLER_HOST_RECIPIENTS`. The marketplace must list exactly that origin and identity in its quotes.

### Marketplace service and dashboard

`services/marketplace` holds marketplace identity and product records in Supabase. It is optional: `pnpm dev` starts it only when `SUPABASE_URL` is set, and the seller host only when `MARKETPLACE_SELLER_HOST_TOKEN_PATH` is also set. It also requires `EXPECTED_DEVNET_GENESIS_HASH`, `DEVNET_RPC_URL` and `DEMO_TOKEN_MINT`. It never holds wallet keys or local spending authority.

| Variable | Default | Description |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | required | Supabase project URL and publishable key. |
| `SUPABASE_SECRET_KEY` | required | Server-side key; it reaches only the marketplace process. Never give it to the dashboard or agents. |
| `MARKETPLACE_PORT` | `4106` | Listen port. The seller host's own default is also 4106, so set `SELLER_HOST_PORT` (`.env.example` uses 4107) when both run. |
| `MARKETPLACE_BROWSER_ORIGINS` | `http://localhost:3000` | Comma-separated browser origins the API accepts. |
| `MARKETPLACE_QUOTE_TTL_SECONDS` | `300` | Quote lifetime. The database caps it at 15 minutes; `.env.example` uses 840 so a private withdrawal fits inside the quote. |
| `MARKETPLACE_SELLER_HOST_TOKEN_PATH`, `MARKETPLACE_OPERATOR_TOKEN_PATH` | empty | Owner-only bearer token files for the seller host and the operator CLI (`pnpm marketplace:operator`); created by `pnpm setup:local`. Only their SHA-256 is kept in memory. A `*_SHA256` variable may be given instead of the path. |
| `MARKETPLACE_MANAGED_SELLER_ORIGIN`, `MARKETPLACE_MANAGED_SELLER_IDENTITY` | empty, `veilo-seller-host-devnet` | Seller host that runs managed listings. The identity must equal the seller host's `SELLER_HOST_IDENTITY`. |
| `MARKETPLACE_DEV_SELLER_ORIGINS` | empty | Exact loopback/private origins admitted for local remote-seller tests only. |
| `MARKETPLACE_MAX_NETWORK_FEE_LAMPORTS` | `10000000` | Ceiling on the network fee a quote may carry. |
| `MARKETPLACE_TERMS_VERSION`, `MARKETPLACE_MANAGED_RUNTIME_REVISION` | `2026-10-17`, `v2` | Terms version stamped on quotes; runtime revision for new managed listings. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_MARKETPLACE_URL` | empty, empty, `http://127.0.0.1:4106` in `.env.example` | Dashboard values, baked in at build time. Only the publishable key belongs here. |

### Dashboard access roles

The dashboard at `http://localhost:3000` serves a public landing page at `/` and the workspace at `/workspace`. Access follows the control service's roles (`VEILO_GUEST_PUBKEYS`, `VEILO_GUEST_RUNS_PER_HOUR`, `VEILO_PUBLIC_VIEW` above):

| Role | Can | Cannot |
|---|---|---|
| Owner | Everything: configure and create agents, policies, funding, exit, recovery, approvals, content review, connectors | — |
| Guest | Sign in with a listed wallet, read the workspace and run agents within their existing policies, rate-limited per hour | Configure, create, stop, fund, recover, decide handoffs, review content or manage connectors |
| Public viewer | Read the redacted workspace without signing in, only when `VEILO_PUBLIC_VIEW=1` | Any action |

The dashboard only enables or disables controls; control and wallet enforce the same split on every request. The light/dark theme follows the system setting until the viewer picks one, which is kept in browser storage.

### Runner service

| Variable | Default | Description |
|---|---|---|
| `RUNNER_WORKER_CREDENTIAL_PATH` | empty | Per-agent worker tokens. `demo:seed` writes `<VEILO_SECRETS_DIR>/runner/worker-credentials.json` when unset and prints the path to set here. Format (`{"agents":[{"agentId","role","token"}]}`). The runner polls and claims jobs for these agents only, and re-reads the file every 5 seconds (by modification time), so added or removed agents start or stop without a restart. A file that fails to parse keeps the current agents. |
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
| `RELAYER_AUTO_APPROVE_KEY_PATH` | empty | Relayer only, opt-in: path (from the repository root) to the approval authority keypair. With it and `APPROVED_PARTICIPANTS`, the relayer applies the same rule as `approve-root` on every tick, so a participant's inserted deposit becomes spendable without the manual tool. Without it, approval stays manual. |
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

## TikTok carousel workflow (run checklist)

Nothing here spends money until the last step.

1. Put `ZERNIO_API_KEY`, `ZERNIO_TIKTOK_ACCOUNT_ID`, `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET` and optionally `HIGGSFIELD_MAX_IMAGES=2` in `.env`.
2. Pick a local origin for Studio North's seller host, for example `http://127.0.0.1:4116`, and set it as `CAROUSEL_SELLER_ORIGIN` and in both `MARKETPLACE_DEV_SELLER_ORIGINS` and `MARKETPLACE_LOCAL_SELLER_ORIGINS`.
3. `pnpm marketplace:carousel-preflight` — free reads only (Zernio account list and TikTok privacy options). Every line must say `ok`. The draft uses `SELF_ONLY` when the account offers it, otherwise the first offered level; it is still an inbox draft that is never published.
4. Issue the seller host credential: `pnpm marketplace:operator host-credential <studio-north sellerId>` (printed once) and start a second seller host with `GATEWAY_ROLE=seller-host`, `SELLER_HOST_PORT=4116`, `SELLER_HOST_PUBLIC_ORIGIN` equal to the origin above, `SELLER_HOST_IDENTITY=veilo-remote-<studio-north sellerId>` (quotes for a remote seller name that identity), its own `SELLER_HOST_DATABASE_PATH`, that credential (`MARKETPLACE_SELLER_HOST_TOKEN_PATH` pointing at a 0600 file under `secrets/`), and `SELLER_HOST_RECIPIENTS` set to Studio North's payout wallet.
5. `pnpm marketplace:seed --confirm` lists the planner, the two provider tools and the workflow "TikTok carousel from a topic".
6. Run it once from `/marketplace/w/tiktok-carousel-from-topic`. This is the only step that spends: at most 0.23 devnet USDC from the private pool, `HIGGSFIELD_MAX_IMAGES` Higgsfield images, and one private TikTok draft.

### Designed slides and public posting

Requires migration `supabase/migrations/20261018000020_slides_and_publish.sql` (new providers `slides` and `zernio_publish`, effect `publish_external`, and both providers workflow-only), applied before the seed.

- "TikTok carousel from a topic" gets a later version with run inputs `topic`, `style` (free text, or `default`) and `slides` (3 to 8; a missing or out-of-range count gives 6). Its planner writes one image prompt per slide in that style; Higgsfield still stops at `HIGGSFIELD_MAX_IMAGES`.
- The range is `CAROUSEL_SLIDES` in `packages/contracts/src/marketplace/limits.ts`. The slide designer refuses a plan with fewer than 3 or more than 8 slides before rendering anything. Raising it from 5–7 added new versions of the two planners, the slide designer, the Higgsfield carousel tool and the three carousel workflows (seed state keys `listing.<slug>.v2`, `workflow.tiktok-carousel-from-topic.v3`, `workflow.tiktok-carousel-designed.v2`, `workflow.tiktok-carousel-designed-publish.v2`); provider manifests and their digests did not change.
- "TikTok carousel (designed slides)": a planner writes a JSON slide plan, the slide designer renders 1080x1920 PNGs from a fixed template on the seller host and uploads them with Zernio's `POST /v1/media/presign` then `PUT uploadUrl`, and the Zernio draft tool sends them to the TikTok inbox. Text on the slides is exact because it is rendered, not generated.
- "TikTok carousel (designed, posts publicly)": the same, ending in `publish_tiktok_carousel`. It publishes publicly with no review step once the run is approved, so it runs only after the seller host owner sets `ZERNIO_PUBLISH_MODE=publish`. Any buyer who approves a run posts to the seller's account, with buyer-influenced text; turn it on only while you are the only buyer you expect.
