#!/bin/sh
# Measures Groth16 verifier compute units in LiteSVM using artifacts/vectors/groth16-v1.json.
# Run inside the toolchain image:  pnpm tc -- sh circuits/scripts/measure-cu.sh
# Build output lives on the cargo-registry Docker volume because the LiteSVM dependency tree
# is very slow to build on a Windows bind mount.
set -eu
TARGET="${VEILO_CACHE_DIR:-/root/.cargo/registry}/veilo-cu-bench-target"
cd "${VEILO_WORKSPACE:-/workspace}/programs/veilo-crypto/cu-bench"
cargo build-sbf --sbf-out-dir "$TARGET/sbf" -- --target-dir "$TARGET/sbf-build"
rm -f "$TARGET"/sbf/*-keypair.json
CARGO_TARGET_DIR="$TARGET/host" VEILO_BENCH_SO="$TARGET/sbf/veilo_verify_bench.so" \
  cargo test --test cu -j 6 -- --nocapture
