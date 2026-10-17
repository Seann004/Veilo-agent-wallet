#!/bin/sh
# Program tests inside the toolchain image: host unit tests, then the LiteSVM suite with real
# proofs from target/program-fixtures/fixtures.json (generated on the host by
# scripts/program-fixtures.ts). Run via `pnpm test:program`.
set -eu
T=/root/.cargo/registry/veilo-pool-target
sh /workspace/programs/privacy-pool/scripts/build.sh
cd /workspace
CARGO_TARGET_DIR="$T/host-main" cargo test -p privacy-pool --lib -j 6
cd /workspace/programs/privacy-pool/litesvm
CARGO_TARGET_DIR=/root/.cargo/registry/veilo-pool-target-host \
VEILO_POOL_SO="$T/sbf-localnet/privacy_pool.so" \
VEILO_POOL_DEVNET_SO="$T/sbf-devnet/privacy_pool.so" \
  cargo test -j 6 -- "$@"
