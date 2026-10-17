# Deployment and configuration

## Run the documentation now

From the repository root, use Node.js 22 or later:

```sh
cd docs
npm ci
npm run dev
```

Build and preview the static site:

```sh
npm run build
npm run preview
```

The default production base is `/Veilo-agent-wallet/`. Open the base URL printed by the preview server. For a site at a custom domain root, build with `DOCS_BASE=/ npm run build`.

## Deployment requirements

The application uses separately authenticated dashboard/control, runner, wallet, relayer and gateway services. Configure the toolchain and compatible SDK versions, initialize the durable database, load local credentials and verify the selected network before enabling financial operations.

Application startup commands and deployment addresses must come from the implementation's release instructions. This page does not provide an executable application installer.

| Area | Configuration requirement |
|---|---|
| Network | Exact devnet genesis, mint, decimals and token program; reject mainnet in demo mode |
| Credentials | Separate owner, worker, wallet, gateway admin and provider credentials |
| Database | Migrations, WAL mode, single control writer and consistent backup/restore |
| Proofs | Compatible source/vector versions and pinned proving/verifying artifacts |
| Services | Authenticated health checks and bounded provider/facilitator settings |
| Operations | Recovery destinations, sponsor budgets and reconciliation before new work |

## Public deployment manifest

Record commit, dependency lock hashes, full genesis hash/CAIP network, program/pool/vault addresses, mint/decimals/token program, circuit and key hashes, setup provenance, canonical encoding/public-input order, tree depths, root-history rules, fees, expiry bounds and administrator public keys.

Program/vault addresses are unknown until deployment. Do not substitute the setup wallet for a PDA-controlled pool or invent addresses to complete this page.

## Operator checks

Verify facilitator `/supported` for the exact selected devnet/mint path before enabling payments. Recheck the operator-funded inference balance/model/cost bounds. Record outages visibly and stop affected work rather than auto-charging a real card or switching to mainnet.

Separate deployer, sponsor, merchant and owner roles, while disclosing common operator bootstrap funding. Public dashboard access requires authentication; signer and administration remain private. Budget test-SOL rent and repeated deployment attempts from measured binary/account sizes.

Public operational records may include program addresses and transaction signatures. Never publish keys, private notes, witnesses, authentication headers or sensitive prompt content.

## Documentation dependency maintenance

The docs use VitePress 1.6.4 with a pinned Vite 6.4.4 override, because the default Vite 5 dependency has published development-server advisories. Mermaid is pinned to 12.2.0. The override is intentionally outside VitePress's default Vite range: keep it only while production builds and browser checks pass, and revisit it when upgrading VitePress. Use the committed lockfile and check advisories when changing dependencies.
