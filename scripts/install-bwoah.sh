#!/bin/sh
# Bwoah My Pi installer (fork of Oh My Pi).
#
# Usage: curl -fsSL https://raw.githubusercontent.com/btimothy-har/bwoah-my-pi/main/scripts/install-bwoah.sh | sh
#
# Installs a tagged macOS arm64 binary from the fork's GitHub Releases.
#
# Options:
#   --binary       Install the prebuilt release binary (default)
#   --ref <tag>    Install a specific release tag (e.g. bwoah-v18.2.5-20260922-1430)
#   -r <tag>       Shorthand for --ref
#   --source       Install from a durable source checkout via `bun setup`
#   --help         Show this help
set -e

FORK_REPO="btimothy-har/bwoah-my-pi"
FORK_URL="https://github.com/btimothy-har/bwoah-my-pi"
FORK_CLONE_URL="https://github.com/btimothy-har/bwoah-my-pi.git"
ASSET_ARCHIVE="omp-darwin-arm64.tar.gz"
ASSET_CHECKSUM="omp-darwin-arm64.tar.gz.sha256"
SOURCE_DIR="$HOME/.local/share/bwoah-my-pi"
SOURCE_DEFAULT_REF="main"
MIN_BUN_VERSION="1.3.14"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"

SCRATCH=""
STAGE=""

usage() {
	cat <<'EOF'
Bwoah My Pi installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/btimothy-har/bwoah-my-pi/main/scripts/install-bwoah.sh | sh

Options:
  --binary        Install the prebuilt macOS arm64 binary from the fork's
                  GitHub Releases (default)
  --ref TAG, -r TAG
                  Install a specific release tag, e.g. bwoah-v18.2.5-20260922-1430
  --source        Install from a durable source checkout at
                  ~/.local/share/bwoah-my-pi using `bun setup`
                  (requires git, bun, and a Rust toolchain)
  --help          Show this help

Destination: $PI_INSTALL_DIR if set, otherwise ~/.local/bin
EOF
}

warn() {
	printf 'install-bwoah: %s\n' "$1" >&2
}

die() {
	warn "$1"
	exit 1
}

cleanup() {
	[ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
	[ -n "$STAGE" ] && rm -rf "$STAGE"
	return 0
}

source_hint() {
	warn "As a fallback, install from source with:"
	warn "  curl -fsSL $FORK_URL/raw/main/scripts/install-bwoah.sh | sh -s -- --source"
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
	if [ "$(uname -s)" = "Darwin" ]; then
		if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
			echo "arm64"
		else
			echo "x64"
		fi
		return
	fi
	case "$(uname -m)" in
		x86_64|amd64)  echo "x64" ;;
		arm64|aarch64) echo "arm64" ;;
		*)             uname -m ;;
	esac
}

version_ge() {
	current="$1"
	minimum="$2"

	current_major="${current%%.*}"
	current_rest="${current#*.}"
	current_minor="${current_rest%%.*}"
	current_patch="${current_rest#*.}"
	current_patch="${current_patch%%.*}"

	minimum_major="${minimum%%.*}"
	minimum_rest="${minimum#*.}"
	minimum_minor="${minimum_rest%%.*}"
	minimum_patch="${minimum_rest#*.}"
	minimum_patch="${minimum_patch%%.*}"

	if [ "$current_major" -ne "$minimum_major" ]; then
		[ "$current_major" -gt "$minimum_major" ]
		return $?
	fi

	if [ "$current_minor" -ne "$minimum_minor" ]; then
		[ "$current_minor" -gt "$minimum_minor" ]
		return $?
	fi

	[ "$current_patch" -ge "$minimum_patch" ]
}

# Release tags look like bwoah-v<semver>-<yyyymmdd>-<hhmm> (UTC).
validate_release_tag() {
	printf '%s' "$1" | grep -Eq '^bwoah-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\.[0-9]+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-[0-9]{8}-[0-9]{4}$' ||
		die "invalid release tag '$1': expected bwoah-v<version>-<yyyymmdd>-<hhmm>"
}

# The upstream version is the tag minus its known prefix and trailing date/time.
version_from_tag() {
	printf '%s' "$1" | sed -E 's/^bwoah-v//; s/-[0-9]{8}-[0-9]{4}$//'
}

require_commands() {
	for cmd in "$@"; do
		command -v "$cmd" >/dev/null 2>&1 ||
			die "'$cmd' is required but was not found in PATH"
	done
}

curl_download() {
	# $1 = destination file, $2 = URL
	curl -fSL --proto '=https' --connect-timeout 15 --max-time 300 -o "$1" "$2" ||
		die "download failed: $2"
}

# Resolve the latest published release tag by following the fork's
# /releases/latest redirect and requiring the effective URL to be this
# fork's /releases/tag/<tag>. Avoids parsing GitHub JSON.
resolve_latest_tag() {
	final_url=$(curl -fsSL --proto '=https' --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "$FORK_URL/releases/latest") ||
		die "could not resolve the latest release of $FORK_REPO"
	case "$final_url" in
		"$FORK_URL/releases/tag/"*) tag="${final_url#"$FORK_URL/releases/tag/"}" ;;
		*) die "unexpected latest-release URL '$final_url': refusing to install from anything but $FORK_REPO releases" ;;
	esac
	validate_release_tag "$tag"
}

binary_install() {
	os=$(uname -s)
	if [ "$os" != "Darwin" ]; then
		warn "binary releases are only published for macOS (Darwin); this host reports '$os'"
		source_hint
		exit 1
	fi
	if [ "$(host_arch)" != "arm64" ]; then
		warn "binary releases are only published for darwin-arm64; this host reports '$(host_arch)'"
		source_hint
		exit 1
	fi
	require_commands curl shasum tar sed grep uname sysctl mktemp

	if [ -n "$REF" ]; then
		tag="$REF"
		validate_release_tag "$tag"
	else
		resolve_latest_tag
	fi
	upstream_version=$(version_from_tag "$tag")

	if [ -d "$INSTALL_DIR/omp" ]; then
		die "destination $INSTALL_DIR/omp is a directory; remove it and re-run the installer"
	fi
	mkdir -p "$INSTALL_DIR"

	echo "Installing $FORK_REPO $tag..."

	SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/bwoah-install.XXXXXX")
	trap cleanup EXIT

	base="$FORK_URL/releases/download/$tag"
	# Both assets are pinned to the same resolved tag so a latest-release
	# change mid-install cannot mix releases.
	curl_download "$SCRATCH/$ASSET_ARCHIVE" "$base/$ASSET_ARCHIVE"
	curl_download "$SCRATCH/$ASSET_CHECKSUM" "$base/$ASSET_CHECKSUM"

	# The checksum file must name exactly the expected archive and contain
	# exactly one digest line.
	[ "$(grep -c . "$SCRATCH/$ASSET_CHECKSUM" || true)" = "1" ] ||
		die "malformed checksum file: expected exactly one digest line"
	grep -Eq '^[0-9a-fA-F]{64}[[:space:]]+omp-darwin-arm64\.tar\.gz$' "$SCRATCH/$ASSET_CHECKSUM" ||
		die "checksum file does not name $ASSET_ARCHIVE"
	(cd "$SCRATCH" && shasum -a 256 -c "$ASSET_CHECKSUM") >/dev/null ||
		die "checksum verification failed for $ASSET_ARCHIVE"

	# Validate the archive layout before extracting anything executable.
	members=$(tar -tzf "$SCRATCH/$ASSET_ARCHIVE") || die "$ASSET_ARCHIVE is not a valid gzip archive"
	[ "$(printf '%s\n' "$members" | grep -c . || true)" = "3" ] ||
		die "unexpected archive layout: expected exactly omp, LICENSE, THIRD-PARTY-NOTICES.txt"
	for member in omp LICENSE THIRD-PARTY-NOTICES.txt; do
		[ "$(printf '%s\n' "$members" | grep -cx "$member" || true)" = "1" ] ||
			die "unexpected archive layout: expected exactly omp, LICENSE, THIRD-PARTY-NOTICES.txt"
	done

	# Stage on the destination filesystem so the final commit is an atomic rename.
	STAGE="$INSTALL_DIR/.bwoah-stage.$$"
	mkdir -p "$STAGE"
	tar -xzf "$SCRATCH/$ASSET_ARCHIVE" -C "$STAGE" || die "extraction failed"
	# Plain `tar -t` lists a link by name only; verify types post-extraction.
	for member in omp LICENSE THIRD-PARTY-NOTICES.txt; do
		{ [ -f "$STAGE/$member" ] && [ ! -L "$STAGE/$member" ]; } ||
			die "archive member $member is not a regular file"
	done
	[ -x "$STAGE/omp" ] || die "staged omp is not executable"

	# Verify the staged binary under an isolated environment before committing it.
	probe_home="$SCRATCH/probe-home"
	probe_tmp="$SCRATCH/probe-tmp"
	mkdir -p "$probe_home" "$probe_tmp"
	probed=$(cd "$probe_tmp" && env -i \
		HOME="$probe_home" \
		TMPDIR="$probe_tmp" \
		XDG_CONFIG_HOME="$probe_home/.config" \
		XDG_CACHE_HOME="$probe_home/.cache" \
		XDG_DATA_HOME="$probe_home/.data" \
		PATH=/usr/bin:/bin:/usr/sbin:/sbin \
		TERM=xterm-256color \
		"$STAGE/omp" --version) || die "staged binary failed its --version probe"
	[ "$probed" = "omp/$upstream_version+bwoah" ] ||
		die "staged binary reported '$probed'; expected omp/$upstream_version+bwoah"

	# Retain license notices, then commit the executable by rename. The stage
	# sits on the destination filesystem, so mv is an atomic rename that
	# replaces an existing symlink entry without touching its target.
	notices_dir="$INSTALL_DIR/../share/bwoah-my-pi-releases/$tag"
	mkdir -p "$notices_dir"
	mv -f "$STAGE/LICENSE" "$STAGE/THIRD-PARTY-NOTICES.txt" "$notices_dir/"
	mv -f "$STAGE/omp" "$INSTALL_DIR/omp"

	echo "Installed $tag to $INSTALL_DIR/omp"
	echo "$probed"

	# Report PATH reality; never edit shell profiles or other launchers.
	if command -v omp >/dev/null 2>&1; then
		omp_path=$(command -v omp)
		if [ "$omp_path" != "$INSTALL_DIR/omp" ]; then
			warn "'omp' currently resolves to $omp_path, which takes precedence over the new install"
			echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
			warn "~/.bun/bin/omp may still reference a source checkout"
		fi
	else
		warn "$INSTALL_DIR is not on your PATH"
		echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
	fi
}

source_install() {
	require_commands git
	command -v bun >/dev/null 2>&1 || die "bun is required for source installs; install it at https://bun.sh/docs/installation"
	bun_version_raw=$(bun --version 2>/dev/null || true)
	[ -n "$bun_version_raw" ] || die "failed to read the bun version"
	bun_version_clean=${bun_version_raw%%-*}
	if ! version_ge "$bun_version_clean" "$MIN_BUN_VERSION"; then
		die "bun $MIN_BUN_VERSION or newer is required for source installs; current version: $bun_version_clean"
	fi
	command -v rustup >/dev/null 2>&1 || command -v cargo >/dev/null 2>&1 ||
		die "a Rust toolchain (rustup) is required for source installs; install it at https://rustup.rs"

	git check-ref-format --branch "$REF" 2>/dev/null ||
		die "invalid ref '$REF': source installs accept a branch or tag name only"

	if [ -e "$SOURCE_DIR" ]; then
		if [ ! -d "$SOURCE_DIR/.git" ] && [ ! -f "$SOURCE_DIR/.git" ]; then
			die "$SOURCE_DIR exists but is not a git repository; move it aside and retry"
		fi
		# `remote get-url` applies url.insteadOf rewriting; the identity check
		# must read the literal configured URL instead.
		remote=$(git -C "$SOURCE_DIR" config --get remote.origin.url 2>/dev/null) ||
			die "$SOURCE_DIR has no 'origin' remote; add one pointing at $FORK_CLONE_URL"
		case "$remote" in
			https://github.com/btimothy-har/bwoah-my-pi.git | git@github.com:btimothy-har/bwoah-my-pi.git) ;;
			*) die "$SOURCE_DIR origin is '$remote'; expected $FORK_CLONE_URL — fix it manually (the installer will not touch your checkout)" ;;
		esac
		[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ] ||
			die "$SOURCE_DIR has uncommitted changes; commit or stash them and retry"
		current_branch=$(git -C "$SOURCE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) ||
			die "could not read the current branch of $SOURCE_DIR"
		if [ "$current_branch" = "$REF" ]; then
			echo "Updating $REF in $SOURCE_DIR..."
			git -C "$SOURCE_DIR" fetch origin "$REF" ||
				die "could not fetch $REF from origin"
			git -C "$SOURCE_DIR" merge --ff-only FETCH_HEAD ||
				die "$SOURCE_DIR cannot fast-forward to origin/$REF; update it manually (the installer will not reset your checkout)"
		elif tag_commit=$(git -C "$SOURCE_DIR" rev-parse -q --verify "refs/tags/$REF^{commit}" 2>/dev/null) &&
			[ "$tag_commit" = "$(git -C "$SOURCE_DIR" rev-parse HEAD)" ]; then
			echo "Already at $REF; leaving $SOURCE_DIR unchanged."
		else
			die "ref mismatch: $SOURCE_DIR is on '$current_branch' but '$REF' was requested; check it out manually"
		fi
	else
		echo "Cloning $FORK_CLONE_URL into $SOURCE_DIR..."
		git clone "$FORK_CLONE_URL" "$SOURCE_DIR" ||
			die "cloning $FORK_CLONE_URL failed"
		git -C "$SOURCE_DIR" checkout "$REF" ||
			die "could not check out $REF: no such branch or tag on $FORK_REPO"
	fi

	echo "Running bun setup in $SOURCE_DIR..."
	(cd "$SOURCE_DIR" && bun setup) || die "bun setup failed in $SOURCE_DIR"

	global_bin=$(bun pm -g bin 2>/dev/null || true)
	[ -n "$global_bin" ] || global_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
	if [ -x "$global_bin/omp" ]; then
		wrapper_version=$("$global_bin/omp" --version 2>/dev/null || true)
		echo "Source install ready: $global_bin/omp ${wrapper_version:-(could not read version)}"
	else
		echo "Source checkout ready at $SOURCE_DIR (no global omp launcher found; run scripts/link-omp.sh)"
	fi

	# Binary installs elsewhere on PATH shadow the source launcher.
	if command -v omp >/dev/null 2>&1; then
		omp_path=$(command -v omp)
		if [ "$omp_path" != "$global_bin/omp" ]; then
			warn "'omp' currently resolves to $omp_path, which takes precedence over $global_bin/omp"
			echo "  export PATH=\"$global_bin:\$PATH\""
		fi
	else
		warn "$global_bin is not on your PATH"
		echo "  export PATH=\"$global_bin:\$PATH\""
	fi
}

MODE="binary"
REF=""
requested_binary=0
requested_source=0

while [ $# -gt 0 ]; do
	case "$1" in
		--binary)
			requested_binary=1
			shift
			;;
		--source)
			requested_source=1
			shift
			;;
		--ref | -r)
			[ $# -ge 2 ] || die "--ref requires a tag argument"
			REF="$2"
			shift 2
			;;
		--help | -h)
			usage
			exit 0
			;;
		*)
			die "unknown argument '$1' (see --help)"
			;;
	esac
done

if [ "$requested_binary" = "1" ] && [ "$requested_source" = "1" ]; then
	die "choose either --binary or --source, not both"
fi

if [ "$requested_source" = "1" ]; then
	[ -n "$REF" ] || REF="$SOURCE_DEFAULT_REF"
	source_install
else
	binary_install
fi
