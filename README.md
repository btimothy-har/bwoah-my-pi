# Bwoah My Pi

This repository is a personal fork of [Oh My Pi](https://github.com/can1357/oh-my-pi), maintained for the owner's use and free to diverge from upstream. It keeps the `omp` command and existing `~/.omp` configuration, credentials, sessions, and history.

## Install

macOS arm64 binary — no Bun, Rust, or build tools required:

```sh
curl -fsSL https://raw.githubusercontent.com/btimothy-har/bwoah-my-pi/main/scripts/install-bwoah.sh | sh
```

The installer resolves the latest `bwoah-v*` release from this repository only, verifies the SHA-256 checksum before executing anything, and installs `omp` to `~/.local/bin` (override with `PI_INSTALL_DIR`). `omp --version` reports the compatible upstream version with a `+bwoah` suffix.

Pin or roll back to a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/btimothy-har/bwoah-my-pi/main/scripts/install-bwoah.sh -o install-bwoah.sh
sh install-bwoah.sh --ref bwoah-v18.2.5-20260922-1430
```

### Source install

Requires Git, [Bun](https://bun.sh) 1.3.14 or newer, [rustup](https://rustup.rs), and native build tools (Xcode Command Line Tools):

```sh
sh install-bwoah.sh --source
```

This clones this fork to `~/.local/share/bwoah-my-pi` and runs `bun setup`, which builds the native addon and links the checkout as the global `omp` command through Bun's global bin.

## Update

- Binary install: re-run the installer command above.
- Source install: re-run `sh install-bwoah.sh --source`, or `git pull --ff-only origin main && bun setup` inside `~/.local/share/bwoah-my-pi`.

`omp update` refuses to update this fork: it targets upstream npm packages and release assets. Fork builds also skip the upstream release notification at startup.

## Releasing

Maintainers cut a binary release with the **Bwoah release** workflow (Actions tab, **Run workflow** on `main`). The run builds the macOS arm64 binary from the dispatched commit, attaches it to a GitHub Release on this repository tagged `bwoah-v<upstream-version>-<yyyymmdd>-<hhmm>` (UTC), and marks it latest. There are no version bumps: `VERSION` stays the upstream package version and the tag only labels the fork build.

For general documentation and support, use the [upstream repository](https://github.com/can1357/oh-my-pi).
