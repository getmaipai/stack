#!/usr/bin/env bash
set -euo pipefail
if command -v cargo >/dev/null 2>&1; then echo "Rust toolchain already installed: $(rustc --version)"; exit 0; fi
if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup and the stable Rust toolchain..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
else
  echo "Installing the stable Rust toolchain..."
fi
rustup toolchain install stable
rustup default stable
echo "Rust is ready: $(rustc --version)"
