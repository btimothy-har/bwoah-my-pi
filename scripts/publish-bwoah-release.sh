#!/bin/sh
set -eu

# Bwoah release publisher.
#
# Usage: scripts/publish-bwoah-release.sh VERSION FULL_COMMIT_SHA ASSET_DIR
#
# Publishes the two build-bwoah-release.sh assets to the fork's GitHub
# Releases under an immutable UTC-minute tag:
#
#   bwoah-v<VERSION>-<yyyymmdd>-<hhmm>   (UTC)
#
# Safety-sensitive transitions are kept in this independently exercisable
# script (testable against fake gh/curl/date/sleep), not inline workflow text:
# absence probe, atomic tag reservation, draft creation, asset upload and
# verification by release id, tag-SHA recheck, and explicit latest selection.
# Never executes package publishing or scripts/release.ts.

REPO="btimothy-har/bwoah-my-pi"
ASSET_TARBALL="omp-darwin-arm64.tar.gz"
ASSET_CHECKSUMS="omp-darwin-arm64.tar.gz.sha256"
# Upper bound on occupied-minute waits; the workflow timeout bounds it in CI.
MAX_WAIT_MINUTES=60

die() {
	echo "publish-bwoah-release: $*" >&2
	exit 1
}

[ "$#" -eq 3 ] || die "usage: scripts/publish-bwoah-release.sh VERSION FULL_COMMIT_SHA ASSET_DIR"
VERSION="$1"
SHA="$2"
ASSET_DIR="$3"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || die "cannot resolve script directory"
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd) || die "cannot resolve repository root"

# ---- Argument validation --------------------------------------------------

printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
	die "VERSION must be upstream SemVer without build metadata: $VERSION"
printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$' ||
	die "FULL_COMMIT_SHA must be a full 40-hex commit SHA"

[ -d "$ASSET_DIR" ] || die "ASSET_DIR is not a directory: $ASSET_DIR"
tarball="$ASSET_DIR/$ASSET_TARBALL"
sums="$ASSET_DIR/$ASSET_CHECKSUMS"
[ -f "$tarball" ] || die "missing asset: $tarball"
[ -s "$tarball" ] || die "asset is empty: $tarball"
[ -f "$sums" ] || die "missing asset: $sums"
[ "$(grep -Ec "^[0-9a-f]{64}  $ASSET_TARBALL\$" "$sums" || true)" = "1" ] ||
	die "checksum file must contain exactly one valid digest line for $ASSET_TARBALL"
[ "$(grep -Ec '^[0-9a-f]{64}  ' "$sums" || true)" = "1" ] ||
	die "checksum file contains extra lines"
(cd "$ASSET_DIR" && shasum -a 256 -c "$ASSET_CHECKSUMS" >/dev/null) ||
	die "local checksum validation failed for $ASSET_TARBALL"

native_manifest="$repo_root/packages/natives/package.json"
[ -f "$native_manifest" ] || die "missing $native_manifest"
native_version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$native_manifest" | sed -n '1p')
[ -n "$native_version" ] || die "cannot read native version from $native_manifest"

# ---- Environment validation (before any GitHub call) ----------------------

for cmd in gh curl jq shasum; do
	command -v "$cmd" >/dev/null 2>&1 || die "required command not on PATH: $cmd"
done
[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set"
[ "${GITHUB_REPOSITORY:-}" = "$REPO" ] || die "GITHUB_REPOSITORY must be $REPO (got '${GITHUB_REPOSITORY:-<unset>}')"
[ "${GITHUB_REF:-}" = "refs/heads/main" ] || die "GITHUB_REF must be refs/heads/main (got '${GITHUB_REF:-<unset>}')"
[ "${GITHUB_SHA:-}" = "$SHA" ] || die "GITHUB_SHA does not match the supplied commit SHA"
GH_HOST=github.com
export GH_HOST

# ---- Tag selection: probe absence, wait out occupied minutes --------------

# $1 = candidate tag; returns 0 when occupied. API/auth/network failures are
# fatal, never treated as "tag absent".
tag_occupied() {
	refs_json=$(gh api "repos/$REPO/git/matching-refs/tags/$1") ||
		die "tag refs query failed for $1 (API/auth/network error, not 'tag absent')"
	if printf '%s\n' "$refs_json" | grep -Fq "\"ref\":\"refs/tags/$1\""; then
		return 0
	fi
	# Also check paginated release tag names, including drafts visible to the
	# token: a release can exist without a matching Git ref.
	releases_json=$(gh api --paginate "repos/$REPO/releases") ||
		die "release listing failed (API/auth/network error, not 'tag absent')"
	if printf '%s\n' "$releases_json" | grep -Fq "\"tag_name\":\"$1\""; then
		return 0
	fi
	return 1
}

tag=""
waits=0
while :; do
	candidate="bwoah-v${VERSION}-$(date -u +%Y%m%d-%H%M)"
	if ! tag_occupied "$candidate"; then
		tag="$candidate"
		break
	fi
	waits=$((waits + 1))
	[ "$waits" -le "$MAX_WAIT_MINUTES" ] ||
		die "tag candidate occupied for $MAX_WAIT_MINUTES UTC minutes; aborting instead of respinning"
	echo "Tag $candidate is already occupied; waiting for the next UTC minute"
	prev_minute=$(date -u +%Y%m%d-%H%M)
	while [ "$(date -u +%Y%m%d-%H%M)" = "$prev_minute" ]; do
		sleep 2
	done
done
echo "Publishing as $tag (source commit $SHA)"

# ---- Atomic tag reservation ----------------------------------------------

# The absence probe above does not establish ownership; this creation does.
reserve_out=$(gh api --method POST "repos/$REPO/git/refs" \
	-f "ref=refs/tags/$tag" -f "sha=$SHA") ||
	die "atomic tag reservation failed for $tag (post-probe collision or API error); no release created"
printf '%s\n' "$reserve_out" | grep -Fq "\"ref\":\"refs/tags/$tag\"" ||
	die "reservation response does not name $tag: $reserve_out"
reserved_sha=$(printf '%s\n' "$reserve_out" | jq -r '.object.sha')
[ "$reserved_sha" = "$SHA" ] ||
	die "reservation response points at $reserved_sha, expected $SHA"

# ---- Draft release --------------------------------------------------------

# Derive the display timestamp from the tag so title and tag always agree.
stamp=${tag#"bwoah-v${VERSION}-"}
day=${stamp%%-*}
clock=${stamp#*-}
title_date="$(printf '%s' "$day" | cut -c1-4)-$(printf '%s' "$day" | cut -c5-6)-$(printf '%s' "$day" | cut -c7-8) $(printf '%s' "$clock" | cut -c1-2):$(printf '%s' "$clock" | cut -c3-4)"
title="Bwoah My Pi $VERSION — $title_date UTC"
body=$(cat <<EOF
Bwoah My Pi binary release for upstream version $VERSION.

- Source commit: $SHA
- Upstream version: $VERSION
- Native addon: @oh-my-pi/pi-natives-darwin-arm64 $native_version
- Target: macOS arm64 (darwin-arm64)
- Signing: ad-hoc (\`codesign --force --sign -\`); not Apple Developer signed or notarized

Install:

    curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install-bwoah.sh | sh
EOF
)

# Boolean fields use -F, strings use -f.
draft_json=$(gh api --method POST "repos/$REPO/releases" \
	-f "tag_name=$tag" \
	-f "target_commitish=$SHA" \
	-F draft=true \
	-F prerelease=false \
	-f "name=$title" \
	-f "body=$body") || die "draft release creation failed for $tag"
release_id=$(printf '%s\n' "$draft_json" | jq -r '.id') || die "draft response has no readable id"
case "$release_id" in
	'' | *[!0-9]*) die "draft response returned a non-numeric id: $release_id" ;;
esac
echo "Created draft release $release_id for $tag"

# All subsequent operations address this release id; never re-resolve a
# possibly replaced draft by tag.
release_json=$(gh api "repos/$REPO/releases/$release_id") ||
	die "cannot read draft release $release_id"
[ "$(printf '%s\n' "$release_json" | jq -r '.tag_name')" = "$tag" ] ||
	die "release $release_id does not carry tag $tag"
upload_url=$(printf '%s\n' "$release_json" | jq -r '.upload_url')
# Strip the URI template suffix GitHub appends ({?name,label}).
upload_url=${upload_url%%\{*}
[ "$upload_url" = "https://uploads.github.com/repos/$REPO/releases/$release_id/assets" ] ||
	die "unexpected upload URL for release $release_id: $upload_url"

# ---- Asset upload and verification ---------------------------------------

assets_json=$(gh api "repos/$REPO/releases/$release_id/assets") ||
	die "cannot list assets of release $release_id"
existing_names=$(printf '%s\n' "$assets_json" | jq -r '.[].name')
for name in "$ASSET_TARBALL" "$ASSET_CHECKSUMS"; do
	if printf '%s\n' "$existing_names" | grep -Fxq "$name"; then
		die "asset $name already exists on draft release $release_id; refusing to replace it"
	fi
done

upload_asset() {
	# $1 local path, $2 asset name, $3 content type
	curl --fail --silent --show-error --connect-timeout 15 --max-time 600 \
		-H "Authorization: Bearer $GH_TOKEN" \
		-H "Content-Type: $3" \
		--data-binary @"$1" \
		"$upload_url?name=$2" >/dev/null ||
		die "asset upload failed: $2"
}
upload_asset "$tarball" "$ASSET_TARBALL" "application/gzip"
upload_asset "$sums" "$ASSET_CHECKSUMS" "text/plain"

# Re-fetch after upload: the pre-upload listing above only serves the
# duplicate-name guard and cannot prove the new assets landed.
assets_json=$(gh api "repos/$REPO/releases/$release_id/assets") ||
	die "cannot verify assets of release $release_id"

verify_asset() {
	# $1 name, $2 expected local size
	asset_name="$1"
	expected_size="$2"
	state=$(printf '%s\n' "$assets_json" | jq -r --arg n "$asset_name" '.[] | select(.name == $n) | .state') ||
		die "cannot inspect asset $asset_name"
	[ "$state" = "uploaded" ] ||
		die "asset $asset_name is not uploaded (state: ${state:-missing})"
	size=$(printf '%s\n' "$assets_json" | jq -r --arg n "$asset_name" '.[] | select(.name == $n) | .size') ||
		die "cannot read size of asset $asset_name"
	[ "$size" != "0" ] && [ "$size" = "$expected_size" ] ||
		die "asset $asset_name size mismatch: remote $size, local $expected_size"
}
verify_asset "$ASSET_TARBALL" "$(wc -c < "$tarball" | tr -d ' ')"
verify_asset "$ASSET_CHECKSUMS" "$(wc -c < "$sums" | tr -d ' ')"

# ---- Final recheck and publish -------------------------------------------

# The reserved tag must still point at the source SHA and this run's release
# must still be the expected draft before publishing.
final_refs=$(gh api "repos/$REPO/git/matching-refs/tags/$tag") ||
	die "final tag recheck failed for $tag"
final_sha=$(printf '%s\n' "$final_refs" | jq -r --arg ref "refs/tags/$tag" 'map(select(.ref == $ref)) | if length == 1 then .[0].object.sha else "" end')
[ "$final_sha" = "$SHA" ] ||
	die "tag $tag no longer points at $SHA (found '$final_sha'); leaving draft in place"
release_json=$(gh api "repos/$REPO/releases/$release_id") ||
	die "cannot re-read draft release $release_id"
[ "$(printf '%s\n' "$release_json" | jq -r '.draft')" = "true" ] ||
	die "release $release_id is no longer a draft; leaving it untouched"
[ "$(printf '%s\n' "$release_json" | jq -r '.tag_name')" = "$tag" ] ||
	die "release $release_id tag changed unexpectedly; leaving it untouched"

gh api --method PATCH "repos/$REPO/releases/$release_id" \
	-F draft=false -F prerelease=false -f make_latest=true >/dev/null ||
	die "publishing release $release_id failed; draft and tag $tag left in place for inspection"

echo "Published $tag (release $release_id): https://github.com/$REPO/releases/tag/$tag"
