# Bwoah My Pi

This repository is a personal fork of [Oh My Pi](https://github.com/can1357/oh-my-pi), maintained for the owner's use and free to diverge from upstream. It keeps the `omp` command and existing `~/.omp` configuration, credentials, sessions, and history.

## Install

Requires Git, [Bun](https://bun.sh) 1.3.14 or newer, [rustup](https://rustup.rs), and native build tools (Xcode Command Line Tools on macOS or `build-essential` on Debian/Ubuntu).

```sh
# Remove the published package first if it is installed.
bun remove -g @oh-my-pi/pi-coding-agent

git clone --branch main https://github.com/btimothy-har/bwoah-my-pi.git ~/.local/share/bwoah-my-pi
cd ~/.local/share/bwoah-my-pi
bun setup

# This source install is updated through Git, not upstream npm releases.
omp config set startup.checkUpdate false
omp --version
```

`bun setup` installs dependencies, builds the native addon, and links this checkout as the global `omp` command. `omp --version` reports the compatible upstream version with a `+bwoah` suffix.

## Update

```sh
cd ~/.local/share/bwoah-my-pi
git pull --ff-only origin main
bun setup
```

Do not use `omp update` for this source installation; it targets official upstream packages and release assets. See [deployment issue #1](https://github.com/btimothy-har/bwoah-my-pi/issues/1) for verification, platform prerequisites, and upstream-sync details.

For general documentation and support, use the [upstream repository](https://github.com/can1357/oh-my-pi).
