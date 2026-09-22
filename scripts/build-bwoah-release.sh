#!/bin/sh
set -eu

# Bwoah release build wrapper.
#
# Usage: scripts/build-bwoah-release.sh OUTPUT_DIR
#
# Packages the single supported fork target (macOS arm64) into
# OUTPUT_DIR/omp-darwin-arm64.tar.gz plus its .sha256 checksum file. Reuses
# the upstream release builder (ci-release-build-binaries.ts) for compilation,
# native embedding, and ad-hoc signing; reuses ci-release-checksums.ts for the
# checksum file. Requires macOS arm64 and workspace dependencies already
# installed with `bun install --frozen-lockfile`.

die() {
	echo "build-bwoah-release: $*" >&2
	exit 1
}

[ "$#" -eq 1 ] || die "usage: scripts/build-bwoah-release.sh OUTPUT_DIR"
OUTPUT_DIR="$1"

# Resolve the repository root relative to this script, not the caller's cwd.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || die "cannot resolve script directory"
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd) || die "cannot resolve repository root"
cleanup() {
	if [ -n "${native_tmp:-}" ]; then rm -rf -- "$native_tmp"; fi
	if [ -n "${smoke_root:-}" ]; then rm -rf -- "$smoke_root"; fi
	if [ -n "${stage_dir:-}" ]; then rm -rf -- "$stage_dir"; fi
}
trap cleanup EXIT

# ---- Host and toolchain prerequisites -------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "this build requires macOS; unsupported host: $(uname -s 2>/dev/null || echo unknown)"
# `hw.optional.arm64` stays correct inside a Rosetta shell, where uname -m
# reports the translated x86_64.
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ]; then
	die "this build requires macOS arm64; refusing to cross-compile"
fi

for cmd in bun curl tar; do
	command -v "$cmd" >/dev/null 2>&1 || die "required command not on PATH: $cmd"
done

[ -d "$repo_root/node_modules" ] || die "workspace dependencies missing; run 'bun install --frozen-lockfile' first"

# ---- Workspace versions ---------------------------------------------------

# The release binary must embed an addon whose version sentinel exactly
# matches the workspace, so all three manifests must agree. Never hard-code a
# version here.
pkg_version() {
	bun -e 'process.stdout.write(String(require("'"$1"'").version))' || die "cannot read version from $1"
}
version=$(pkg_version "$repo_root/packages/coding-agent/package.json")
for manifest in packages/natives/package.json packages/utils/package.json; do
	[ "$(pkg_version "$repo_root/$manifest")" = "$version" ] || die "version mismatch: $manifest does not match packages/coding-agent/package.json ($version)"
done
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
	die "workspace version is not plain SemVer: $version"

# ---- Fetch the exact published native addon -------------------------------

# Mirrors the fork CI native-leaf pattern (npm registry leaf for the exact
# workspace version); resolved through the registry JSON API because a local
# corepack/pnpm npm shim may abort on this repo's packageManager field.
# `latest`, a cached older addon, or an implicit Rust build are never accepted.
native_tmp=$(mktemp -d "${TMPDIR:-/tmp}/bwoah-native.XXXXXX")
tarball=$(bun -e "const r = await fetch('https://registry.npmjs.org/@oh-my-pi%2Fpi-natives-darwin-arm64/' + process.argv[1]); if (!r.ok) throw new Error('registry ' + r.status); console.log((await r.json()).dist.tarball)" "$version") ||
	die "@oh-my-pi/pi-natives-darwin-arm64@$version not found on npm"
echo "Fetching @oh-my-pi/pi-natives-darwin-arm64@$version from $tarball"
curl -fsSL --retry 3 --connect-timeout 15 -o "$native_tmp/addon.tgz" "$tarball" ||
	die "native addon download failed"
tar -xzf "$native_tmp/addon.tgz" -C "$native_tmp" || die "native addon extraction failed"

addon="$native_tmp/package/pi_natives.darwin-arm64.node"
[ -f "$addon" ] || die "extracted addon package is missing package/pi_natives.darwin-arm64.node"
[ -s "$addon" ] || die "extracted addon package/pi_natives.darwin-arm64.node is empty"
extracted_version=$(cd "$native_tmp/package" && bun -e 'process.stdout.write(String(require("./package.json").version))') ||
	die "extracted addon package has no readable version"
[ "$extracted_version" = "$version" ] ||
	die "extracted addon version $extracted_version does not match workspace version $version"

# Smoke-load the addon through a script file: `bun -e` swallows dlopen
# failures, a script file enforces them.
cat > "$native_tmp/smoke-addon.js" <<'EOF'
for (const f of process.argv.slice(2)) {
	const m = require(f);
	if (!m || Object.keys(m).length === 0) {
		console.error(`addon failed to load: ${f}`);
		process.exit(1);
	}
}
EOF
bun "$native_tmp/smoke-addon.js" "$addon" || die "native addon failed to dlopen"

mkdir -p "$repo_root/packages/natives/native"
cp "$addon" "$repo_root/packages/natives/native/pi_natives.darwin-arm64.node"

# ---- Build the binary ------------------------------------------------------

# ci-release-build-binaries.ts generates stats/tool-view assets, embeds the
# native archive, compiles, ad-hoc signs, and resets generated placeholders in
# a finally block.
binary="$repo_root/packages/coding-agent/binaries/omp-darwin-arm64"
(cd "$repo_root" && RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries) ||
	die "release binary build failed"
[ -f "$binary" ] || die "built binary missing: $binary"
[ -x "$binary" ] || die "built binary is not executable: $binary"

# ---- Smoke the binary in an isolated runtime ------------------------------

# Private short runtime root: short paths keep the Unix sockets created by the
# smoke workers under sun_path's 104-byte limit. `env -i` with an explicit
# allowlist prevents inheriting provider credentials, profiles, or config
# overrides; packages/utils/src/env.ts loads the cwd's .env even for a
# compiled binary, so the cwd must be the empty smoke directory.
smoke_root=$(mktemp -d /tmp/bwoah.XXXXXX)
mkdir "$smoke_root/h" "$smoke_root/a" "$smoke_root/d" "$smoke_root/c" "$smoke_root/s" "$smoke_root/t" "$smoke_root/w" "$smoke_root/bin"
cp "$binary" "$smoke_root/bin/omp"
chmod 0755 "$smoke_root/bin/omp"

run_isolated() {
	(cd "$smoke_root/w" && exec env -i \
		HOME="$smoke_root/h" \
		PI_CODING_AGENT_DIR="$smoke_root/a" \
		XDG_DATA_HOME="$smoke_root/d" \
		XDG_CACHE_HOME="$smoke_root/c" \
		XDG_STATE_HOME="$smoke_root/s" \
		TMPDIR="$smoke_root/t" \
		PATH=/usr/bin:/bin:/usr/sbin:/sbin \
		TERM=xterm-256color \
		"$smoke_root/bin/omp" "$@")
}

smoke_version=$(run_isolated --version) || die "built binary --version failed"
[ "$smoke_version" = "omp/$version+bwoah" ] ||
	die "built binary reported '$smoke_version', expected 'omp/$version+bwoah'"
run_isolated --smoke-test >/dev/null || die "built binary --smoke-test failed"

# ---- Package the release assets -------------------------------------------

if [ -e "$OUTPUT_DIR" ]; then
	[ -d "$OUTPUT_DIR" ] || die "OUTPUT_DIR exists and is not a directory: $OUTPUT_DIR"
	if [ -n "$(ls -A "$OUTPUT_DIR" 2>/dev/null)" ]; then
		die "OUTPUT_DIR is not empty: $OUTPUT_DIR"
	fi
else
	mkdir -p "$OUTPUT_DIR" || die "cannot create OUTPUT_DIR: $OUTPUT_DIR"
fi
OUTPUT_DIR=$(CDPATH= cd -- "$OUTPUT_DIR" && pwd) || die "cannot resolve OUTPUT_DIR"

# The tarball root contains exactly three regular files, named explicitly so
# no root-directory entry or AppleDouble metadata sneaks in.
stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/bwoah-stage.XXXXXX")
cp "$binary" "$stage_dir/omp"
chmod 0755 "$stage_dir/omp"
cp "$repo_root/LICENSE" "$repo_root/THIRD-PARTY-NOTICES.txt" "$stage_dir/"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT_DIR/omp-darwin-arm64.tar.gz" -C "$stage_dir" omp LICENSE THIRD-PARTY-NOTICES.txt ||
	die "tarball creation failed"

# Reuse the existing checksum generator; do not reimplement hashing.
(cd "$repo_root" && bun scripts/ci-release-checksums.ts \
	"$OUTPUT_DIR/omp-darwin-arm64.tar.gz.sha256" "$OUTPUT_DIR/omp-darwin-arm64.tar.gz") ||
	die "checksum generation failed"

echo "Bwoah release assets ready in $OUTPUT_DIR:"
ls -l "$OUTPUT_DIR/omp-darwin-arm64.tar.gz" "$OUTPUT_DIR/omp-darwin-arm64.tar.gz.sha256"
echo "Binary: omp/$version+bwoah (tag prefix: bwoah-v$version-<yyyymmdd>-<hhmm>)"
