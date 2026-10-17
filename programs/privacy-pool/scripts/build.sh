#!/bin/sh
# Builds the program twice inside the toolchain image: the `localnet` variant loaded by the
# LiteSVM tests and the deployable `devnet` variant used for size/rent measurements, both for
# SBPF v3 like `anchor build` with platform-tools v1.57.
# Build output stays on the cargo-registry Docker volume (bind-mount builds are slow on Windows).
set -eu
T=/root/.cargo/registry/veilo-pool-target
cd /workspace
cargo build-sbf --arch v3 --manifest-path programs/privacy-pool/Cargo.toml --no-default-features --features localnet \
  --sbf-out-dir "$T/sbf-localnet" -- --target-dir "$T/sbf-build"
cargo build-sbf --arch v3 --manifest-path programs/privacy-pool/Cargo.toml \
  --sbf-out-dir "$T/sbf-devnet" -- --target-dir "$T/sbf-build"
# Build by-products only; the deployment identity is created by the deploy task.
rm -f "$T"/sbf-localnet/*-keypair.json "$T"/sbf-devnet/*-keypair.json
ls -l "$T/sbf-localnet/privacy_pool.so" "$T/sbf-devnet/privacy_pool.so"
