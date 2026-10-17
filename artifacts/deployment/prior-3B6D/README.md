# Prior devnet deployment (program 3B6Db74g…rUrq)

This directory holds the earlier devnet deployment of the privacy pool. It is retired. No script reads these files.

| Item | Value |
|---|---|
| Program | `3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq` |
| Pool id | `c012ae927dfd556e75e9d2f1893a1ffcb1834eee6f1df4f4c5ff7fc3d9b2d589` |
| PoolState | `65FNWNc1akaXFsPFCoLGMwjnefGbpts3sw4KEVYQ8Tab` |
| Vault | `GQ7u2E8t1mEkUwo4NanbPFy5NhzGJHdhD8FY32ZWorgt` |
| Deployed | 2026-10-15/16 from a Windows machine through the Docker toolchain |

Files, moved here unchanged:

- `roles.devnet.json`, `devnet.json`, `devnet.progress.json`, `approved-labels.json`: the role public keys, deployment manifest, deploy progress and approved labels of that pool.
- `evidence/m2-*.json`: the M2 private-smoke evidence (deposits, inserts, approve-root, private spend, change insert, x402 merchant leg, exits). Its transactions belong to this deployment.

Why it was retired:

- The role keypairs (deployer/upgrade authority, program id, sponsor, approval authority, config authority, merchant, test participants) stayed on the original machine. Without the approval authority, no new label can be approved, so the pool cannot serve new private spends from this checkout.
- The encrypted note stores of the smoke and of the 2026-10-17 demo run also stayed on that machine.
- The proving keys were not lost. The setup is deterministic from public beacons, and the rebuild on 2026-10-17 reproduced the hashes in `artifacts/circuits/manifest.json`.

Funds left in the pool: the vault held 700,000 base units (0.7 test USDC) at finalized slot 511,995,985 on 2026-10-17. These are the remaining notes of the 2026-10-17 demo run: 3.0 deposited, 1.5 paid to merchants and 0.8 exited. Owner exit needs each note's secrets and salt, so this balance cannot be recovered without the note stores from the original machine. The refund signer of those deposits is the funding wallet, which is still available. If the note stores come back, `exit_public` still works on this program, because exit does not need the approval authority.

The program stays deployed and upgradeable by the old deployer key. Nothing in this repository deploys over it or reuses its keys.
