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

### Diagnostics

| Variable | Description |
|---|---|
| `VEILO_ENV_FILE` | Alternate env file path. |
| `VEILO_LOG_CONFIG=1` | Services print a redacted configuration summary at startup (`describeConfig`). |
| `VEILO_TOOLCHAIN_IMAGE` | Override the toolchain image tag used by `pnpm tc`. |

## Owner-only permissions

On POSIX, `setup:local` sets `data/` and `secrets/` to mode 0700, and a `.env` it creates to 0600. On Windows, it removes inherited ACEs and grants full control only to the current user via `icacls`.
