#!/bin/sh
# Program tests inside the toolchain image: host unit tests, then the LiteSVM suite with real
# proofs from target/program-fixtures/fixtures.json (generated on the host by
# scripts/program-fixtures.ts). Run via `pnpm test:program`.
set -eu
W="${VEILO_WORKSPACE:-/workspace}"
C="${VEILO_CACHE_DIR:-/root/.cargo/registry}"
T="$C/veilo-pool-target"
sh "$W/programs/privacy-pool/scripts/build.sh"
cd "$W"
CARGO_TARGET_DIR="$T/host-main" cargo test -p privacy-pool --lib -j 6
cd "$W/programs/privacy-pool/litesvm"
CARGO_TARGET_DIR="$C/veilo-pool-target-host" \
VEILO_POOL_SO="$T/sbf-localnet/privacy_pool.so" \
VEILO_POOL_DEVNET_SO="$T/sbf-devnet/privacy_pool.so" \
  cargo test -j 6 -- "$@"
