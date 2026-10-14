# Pinned build toolchain for the Solana program and circuits.
# Every version below is pinned; bump them together and record the change in docs/deployment.md.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ARG DEBIAN_FRONTEND=noninteractive
ARG RUST_VERSION=1.97.1
ARG AGAVE_VERSION=v4.1.2
ARG ANCHOR_VERSION=1.2.1
ARG CIRCOM_TAG=v2.2.3
ARG NODE_VERSION=v22.22.3
ARG NODE_SHA256=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f
ARG PNPM_VERSION=10.34.6
ARG SNARKJS_VERSION=0.7.6

ENV HOME=/root \
    CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup
ENV PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/opt/node/bin:${PATH}

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      build-essential pkg-config libssl-dev libudev-dev ca-certificates curl git xz-utils bzip2 python3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
 && sh /tmp/rustup.sh -y --profile minimal --default-toolchain ${RUST_VERSION} \
 && rustup component add rustfmt clippy \
 && rm /tmp/rustup.sh

RUN curl -sSfL https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION} snarkjs@${SNARKJS_VERSION}

RUN sh -c "$(curl -sSfL https://release.anza.xyz/${AGAVE_VERSION}/install)" \
 && solana --version

RUN cargo install --locked anchor-cli --version ${ANCHOR_VERSION} \
 && rm -rf /root/.cargo/registry /root/.cargo/git

RUN cargo install --locked --git https://github.com/iden3/circom --tag ${CIRCOM_TAG} circom \
 && rm -rf /root/.cargo/registry /root/.cargo/git

# Pre-fetch the SBF platform-tools that anchor-cli selects by default, so program builds
# do not download them at run time. Declared late to keep earlier layers cacheable.
ARG PLATFORM_TOOLS_VERSION=v1.57
RUN cargo-build-sbf --install-only --tools-version ${PLATFORM_TOOLS_VERSION}

WORKDIR /workspace
