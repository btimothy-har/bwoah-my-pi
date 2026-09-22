import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const REPO = "btimothy-har/bwoah-my-pi";
const VERSION = "9.4.1";
const SHA = "deadbeef".repeat(5);
const OTHER_SHA = "f".repeat(40);

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/** UTC epoch minutes for a fixed wall-clock time the fake `date` shim serves. */
function epochMinute(year: number, month: number, day: number, hour: number, minute: number): number {
	return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 60_000);
}

interface Fixture {
	root: string;
	state: string;
	assetDir: string;
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

function ghShim(state: string): string {
	return `#!/bin/sh
set -eu
STATE="${state}"
BASE="repos/btimothy-har/bwoah-my-pi"

log() {
	printf '%s\\n' "$*" >> "$STATE/log"
}

fail_if() {
	if [ -f "$STATE/fail/$1" ]; then
		echo "gh: simulated API failure: $1" >&2
		exit 1
	fi
}

method=GET
path=""
req="$STATE/request.$$"
: > "$req"
while [ $# -gt 0 ]; do
	case "$1" in
		--method) method="$2"; shift 2 ;;
		--paginate) shift ;;
		-f|-F) printf '%s\\n' "$2" >> "$req"; shift 2 ;;
		api) shift ;;
		-*) shift ;;
		*) path="$1"; shift ;;
	esac
done

get_kv() {
	sed -n "s/^$1=//p" "$req" | sed -n '1p'
}

case "$path" in
	"$BASE"/git/matching-refs/tags/*)
		fail_if matching-refs
		tag=\${path#"$BASE"/git/matching-refs/tags/}
		out="["
		first=1
		for f in "$STATE/tags"/*; do
			[ -f "$f" ] || continue
			name=\${f##*/}
			case "$name" in
				"$tag"|"$tag"*)
					if [ -f "$STATE/fail/recheck-tag-sha" ]; then
						sha=0000000000000000000000000000000000000009
					else
						sha=$(cat "$f")
					fi
					entry="{\\"ref\\":\\"refs/tags/$name\\",\\"object\\":{\\"sha\\":\\"$sha\\",\\"type\\":\\"commit\\"}}"
					if [ "$first" -eq 1 ]; then out="$out$entry"; first=0; else out="$out,$entry"; fi
					;;
			esac
		done
		echo "$out]"
		;;
	"$BASE"/git/refs)
		if [ "$method" != "POST" ]; then
			echo "gh: unexpected method for git/refs" >&2
			exit 1
		fi
		fail_if post-refs
		ref=$(get_kv ref)
		sha=$(get_kv sha)
		tag=\${ref#refs/tags/}
		if [ -e "$STATE/tags/$tag" ]; then
			echo "gh: 422 ref already exists" >&2
			exit 1
		fi
		printf '%s\\n' "$sha" > "$STATE/tags/$tag"
		log "reserve $tag $sha"
		echo "{\\"ref\\":\\"$ref\\",\\"object\\":{\\"sha\\":\\"$sha\\",\\"type\\":\\"commit\\"}}"
		;;
	"$BASE"/releases)
		fail_if releases
		if [ "$method" = "POST" ]; then
			id=$(cat "$STATE/nextid")
			printf '%s\\n' $((id + 1)) > "$STATE/nextid"
			tag=$(get_kv tag_name)
			target=$(get_kv target_commitish)
			name=$(get_kv name)
			json="{\\"id\\":$id,\\"tag_name\\":\\"$tag\\",\\"name\\":\\"$name\\",\\"draft\\":true,\\"prerelease\\":false,\\"target_commitish\\":\\"$target\\",\\"upload_url\\":\\"https://uploads.github.com/$BASE/releases/$id/assets{?name,label}\\"}"
			printf '%s\\n' "$json" > "$STATE/releases/$id.json"
			log "draft $id $tag"
			echo "$json"
		else
			out="["
			first=1
			for f in "$STATE/releases"/*.json; do
				[ -f "$f" ] || continue
				if [ "$first" -eq 1 ]; then out="$out$(cat "$f")"; first=0; else out="$out,$(cat "$f")"; fi
			done
			echo "$out]"
		fi
		;;
	"$BASE"/releases/*/assets)
		fail_if assets
		id=\${path#"$BASE"/releases/}
		id=\${id%%/*}
		out="["
		first=1
		for f in "$STATE/uploads/$id"/*; do
			[ -f "$f" ] || continue
			size=$(wc -c < "$f" | tr -d ' ')
			name=\${f##*/}
			entry="{\\"name\\":\\"$name\\",\\"state\\":\\"uploaded\\",\\"size\\":$size}"
			if [ "$first" -eq 1 ]; then out="$out$entry"; first=0; else out="$out,$entry"; fi
		done
		echo "$out]"
		;;
	"$BASE"/releases/*)
		id=\${path#"$BASE"/releases/}
		f="$STATE/releases/$id.json"
		if [ ! -f "$f" ]; then
			echo "gh: 404 release $id" >&2
			exit 1
		fi
		if [ "$method" = "PATCH" ]; then
			if [ "$(get_kv make_latest)" = "true" ]; then
				tag=$(sed -n 's/.*"tag_name":"\\([^"]*\\)".*/\\1/p' "$f")
				printf '%s\\n' "$tag" > "$STATE/latest"
				log "publish $id"
			fi
			sed 's/"draft":true/"draft":false/' "$f" > "$f.tmp"
			mv "$f.tmp" "$f"
		fi
		cat "$f"
		;;
	*)
		echo "gh: unexpected path: $path" >&2
		exit 1
		;;
esac
`;
}

function curlShim(state: string): string {
	return `#!/bin/sh
set -eu
STATE="${state}"
url=""
datafile=""
while [ $# -gt 0 ]; do
	case "$1" in
		--data-binary) datafile=\${2#@}; shift 2 ;;
		http*) url="$1"; shift ;;
		*) shift ;;
	esac
done
if [ -z "$url" ]; then
	echo "curl: no URL" >&2
	exit 1
fi
name=\${url##*name=}
id=\${url#*/releases/}
id=\${id%%/*}
if [ -f "$STATE/fail/curl-$name" ]; then
	echo "curl: simulated upload failure: $name" >&2
	exit 22
fi
mkdir -p "$STATE/uploads/$id"
cat "$datafile" > "$STATE/uploads/$id/$name"
printf '%s\\n' "upload $id $name" >> "$STATE/log"
echo "{\\"name\\":\\"$name\\",\\"state\\":\\"uploaded\\"}"
`;
}

function dateShim(state: string): string {
	return `#!/bin/sh
set -eu
minutes=$(cat "${state}/minutes")
exec /bin/date -u -r "$((minutes * 60))" "$@"
`;
}

function sleepShim(state: string): string {
	return `#!/bin/sh
set -eu
STATE="${state}"
cur=$(cat "$STATE/minutes")
printf '%s\\n' $((cur + 1)) > "$STATE/minutes"
printf '%s\\n' "sleep $1" >> "$STATE/log"
`;
}

async function makeFixture(opts: { minute: number; fails?: string[] }): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bwoah-publish-"));
	tempDirs.push(root);
	const state = path.join(root, "state");
	await fs.mkdir(path.join(state, "tags"), { recursive: true });
	await fs.mkdir(path.join(state, "releases"));
	await fs.mkdir(path.join(state, "uploads"));
	await fs.mkdir(path.join(state, "fail"));
	await fs.writeFile(path.join(state, "minutes"), `${opts.minute}\n`);
	await fs.writeFile(path.join(state, "nextid"), "5001\n");
	const binDir = path.join(root, "bin");
	await fs.mkdir(binDir);
	await writeExecutable(binDir, "gh", ghShim(state));
	await writeExecutable(binDir, "curl", curlShim(state));
	await writeExecutable(binDir, "date", dateShim(state));
	await writeExecutable(binDir, "sleep", sleepShim(state));

	// Real tarball and real checksum file, produced by the existing generator.
	const assetDir = path.join(root, "assets");
	await fs.mkdir(assetDir);
	await fs.writeFile(path.join(assetDir, "omp"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
	const tarball = path.join(assetDir, "omp-darwin-arm64.tar.gz");
	const built = await run(["tar", "-czf", tarball, "-C", assetDir, "omp"]);
	expect(built.exitCode, built.stderr).toBe(0);
	const sums = await run([
		"bun",
		"scripts/ci-release-checksums.ts",
		path.join(assetDir, "omp-darwin-arm64.tar.gz.sha256"),
		tarball,
	]);
	expect(sums.exitCode, sums.stderr).toBe(0);

	for (const fail of opts.fails ?? []) {
		await fs.writeFile(path.join(state, "fail", fail), "1\n");
	}
	return { root, state, assetDir };
}

function publisherEnv(fixture: Fixture, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${path.join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
		HOME: fixture.root,
		GH_TOKEN: "test-token",
		GITHUB_REPOSITORY: REPO,
		GITHUB_REF: "refs/heads/main",
		GITHUB_SHA: SHA,
		...overrides,
	};
}

async function readTagSha(state: string, tag: string): Promise<string> {
	return (await fs.readFile(path.join(state, "tags", tag), "utf8")).trim();
}

async function readLatest(state: string): Promise<string | null> {
	try {
		return (await fs.readFile(path.join(state, "latest"), "utf8")).trim();
	} catch {
		return null;
	}
}

async function readRelease(state: string, id: number): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(path.join(state, "releases", `${id}.json`), "utf8"));
}

async function releaseIds(state: string): Promise<number[]> {
	const names = await fs.readdir(path.join(state, "releases"));
	return names
		.filter(name => name.endsWith(".json"))
		.map(name => Number(name.slice(0, -5)))
		.sort((a, b) => a - b);
}

async function logLines(state: string): Promise<string[]> {
	try {
		return (await fs.readFile(path.join(state, "log"), "utf8")).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function uploaded(state: string, id: number): Promise<Record<string, number>> {
	const dir = path.join(state, "uploads", String(id));
	const out: Record<string, number> = {};
	for (const name of await fs.readdir(dir)) {
		out[name] = (await fs.stat(path.join(dir, name))).size;
	}
	return out;
}

describe("publish-bwoah-release", () => {
	test("publishes a free minute atomically: reservation targets the supplied SHA, uploads and latest bind to the draft id", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });
		const tag = "bwoah-v9.4.1-20260922-1430";

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(`Published ${tag}`);

		// Atomic reservation created the tag at the supplied SHA.
		expect(await readTagSha(fixture.state, tag)).toBe(SHA);
		// Draft creation retained a numeric id; uploads and publication address it.
		const ids = await releaseIds(fixture.state);
		expect(ids).toHaveLength(1);
		const release = await readRelease(fixture.state, ids[0]!);
		expect(release.tag_name).toBe(tag);
		expect(release.draft).toBe(false);
		expect(release.target_commitish).toBe(SHA);
		expect(String(release.name)).toContain("Bwoah My Pi 9.4.1 — 2026-09-22 14:30 UTC");
		const assets = await uploaded(fixture.state, ids[0]!);
		expect(Object.keys(assets).sort()).toEqual(["omp-darwin-arm64.tar.gz", "omp-darwin-arm64.tar.gz.sha256"]);
		expect(assets["omp-darwin-arm64.tar.gz"]).toBeGreaterThan(0);
		// Latest selection happened only via this run's release.
		expect(await readLatest(fixture.state)).toBe(tag);

		const lines = await logLines(fixture.state);
		const draftLine = lines.findIndex(line => line.startsWith("draft "));
		const uploadLines = lines.map(line => line.startsWith("upload ")).lastIndexOf(true);
		const publishLine = lines.findIndex(line => line.startsWith("publish "));
		expect(draftLine).toBeGreaterThanOrEqual(0);
		expect(uploadLines).toBeGreaterThan(draftLine);
		expect(publishLine).toBeGreaterThan(uploadLines);
		// Both assets were uploaded before publication addressed the draft id.
		expect(
			lines
				.filter(line => line.startsWith("upload "))
				.map(line => line.split(" ")[2])
				.sort(),
		).toEqual(["omp-darwin-arm64.tar.gz", "omp-darwin-arm64.tar.gz.sha256"]);
		expect(lines[publishLine]).toBe(`publish ${ids[0]}`);
	});

	test("current minute occupied by an existing git ref waits and publishes the next actual minute", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });
		await fs.writeFile(path.join(fixture.state, "tags", "bwoah-v9.4.1-20260922-1430"), `${OTHER_SHA}\n`);

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const tag = "bwoah-v9.4.1-20260922-1431";
		expect(result.stdout).toContain(`Published ${tag}`);
		// Waited for the minute to actually change: no numeric suffix, no future timestamp.
		expect((await logLines(fixture.state)).some(line => line.startsWith("sleep "))).toBe(true);
		expect(await readTagSha(fixture.state, tag)).toBe(SHA);
		expect(await readTagSha(fixture.state, "bwoah-v9.4.1-20260922-1430")).toBe(OTHER_SHA);
		expect(await readLatest(fixture.state)).toBe(tag);
	});

	test("current minute occupied only by a draft release (no matching git ref) waits and publishes the next minute", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });
		const candidate = "bwoah-v9.4.1-20260922-1430";
		await fs.writeFile(
			path.join(fixture.state, "releases", "4000.json"),
			`{"id":4000,"tag_name":"${candidate}","draft":true,"upload_url":"https://uploads.github.com/repos/${REPO}/releases/4000/assets{?name,label}"}`,
		);
		await fs.writeFile(path.join(fixture.state, "nextid"), "4001\n");

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const tag = "bwoah-v9.4.1-20260922-1431";
		expect(result.stdout).toContain(`Published ${tag}`);
		// The stale draft never became latest; this run's release did.
		expect(await readLatest(fixture.state)).toBe(tag);
		expect((await readRelease(fixture.state, 4000)).draft).toBe(true);
	});

	test("occupied minute before midnight UTC rolls over to the next day instead of respinning a suffix", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 23, 59) });
		await fs.writeFile(path.join(fixture.state, "tags", "bwoah-v9.4.1-20260922-2359"), `${OTHER_SHA}\n`);

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const tag = "bwoah-v9.4.1-20260923-0000";
		expect(result.stdout).toContain(`Published ${tag}`);
		expect(await readTagSha(fixture.state, tag)).toBe(SHA);
		const ids = await releaseIds(fixture.state);
		expect(String((await readRelease(fixture.state, ids[0]!)).name)).toContain("2026-09-23 00:00 UTC");
	});

	test("post-probe competing ref fails the atomic reservation with no release created", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30), fails: ["post-refs"] });

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		// Absence probe passed, but ownership comes only from reservation: no
		// release, no draft, no latest, no upload.
		expect(await releaseIds(fixture.state)).toEqual([]);
		expect(await readLatest(fixture.state)).toBeNull();
		expect((await logLines(fixture.state)).some(line => line.startsWith("draft "))).toBe(false);
		expect((await logLines(fixture.state)).some(line => line.startsWith("upload "))).toBe(false);
	});

	test("tag moving off the source SHA after reservation fails the recheck before publication", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30), fails: ["recheck-tag-sha"] });

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		// Reservation and uploads happened, but latest was never selected.
		expect(await readLatest(fixture.state)).toBeNull();
		const lines = await logLines(fixture.state);
		expect(lines.filter(line => line.startsWith("upload "))).toHaveLength(2);
		expect(lines.some(line => line.startsWith("publish "))).toBe(false);
	});

	test("asset upload failure leaves the draft unpublished and prior latest untouched", async () => {
		const fixture = await makeFixture({
			minute: epochMinute(2026, 9, 22, 14, 30),
			fails: ["curl-omp-darwin-arm64.tar.gz.sha256"],
		});

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		const ids = await releaseIds(fixture.state);
		expect(ids).toEqual([5001]);
		expect((await readRelease(fixture.state, 5001)).draft).toBe(true);
		expect(await readLatest(fixture.state)).toBeNull();
		const lines = await logLines(fixture.state);
		expect(lines.some(line => line.startsWith("upload 5001 omp-darwin-arm64.tar.gz.sha256"))).toBe(false);
		expect(lines.some(line => line.startsWith("publish "))).toBe(false);
	});

	test("refuses to replace an asset that already exists on the fresh draft", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });
		await fs.mkdir(path.join(fixture.state, "uploads", "5001"), { recursive: true });
		await fs.writeFile(path.join(fixture.state, "uploads", "5001", "omp-darwin-arm64.tar.gz"), "stale\n");

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		expect(await readLatest(fixture.state)).toBeNull();
		expect((await logLines(fixture.state)).some(line => line.startsWith("upload "))).toBe(false);
	});

	test("GitHub API failure fails closed before any state change", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30), fails: ["matching-refs"] });

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		// An API error is fatal, never treated as "tag absent".
		const entries = await fs.readdir(path.join(fixture.state, "tags"));
		expect(entries).toEqual([]);
		expect(await releaseIds(fixture.state)).toEqual([]);
		expect(await readLatest(fixture.state)).toBeNull();
	});

	test("wrong GITHUB_REPOSITORY is rejected before any GitHub call", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });

		const result = await run(["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir], {
			...publisherEnv(fixture),
			GITHUB_REPOSITORY: "can1357/oh-my-pi",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("GITHUB_REPOSITORY");
		// No state was touched: validation precedes every gh invocation.
		expect((await fs.readdir(path.join(fixture.state, "tags"))).length).toBe(0);
		expect(await releaseIds(fixture.state)).toEqual([]);
		expect(
			await fs.stat(path.join(fixture.state, "log")).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	test("GITHUB_SHA not matching the supplied commit is rejected before any GitHub call", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });

		const result = await run(["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir], {
			...publisherEnv(fixture),
			GITHUB_SHA: OTHER_SHA,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("GITHUB_SHA");
		expect((await fs.readdir(path.join(fixture.state, "tags"))).length).toBe(0);
		expect(await releaseIds(fixture.state)).toEqual([]);
	});

	test("invalid version and malformed commit SHA are rejected without side effects", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });

		const badVersion = await run(
			["sh", "scripts/publish-bwoah-release.sh", "9.4.1+build.7", SHA, fixture.assetDir],
			publisherEnv(fixture),
		);
		expect(badVersion.exitCode).not.toBe(0);

		const shortSha = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, "deadbeef", fixture.assetDir],
			publisherEnv(fixture),
		);
		expect(shortSha.exitCode).not.toBe(0);

		expect((await fs.readdir(path.join(fixture.state, "tags"))).length).toBe(0);
		expect(await releaseIds(fixture.state)).toEqual([]);
	});

	test("missing or tampered local checksum aborts before any GitHub call", async () => {
		const fixture = await makeFixture({ minute: epochMinute(2026, 9, 22, 14, 30) });
		await fs.writeFile(
			path.join(fixture.assetDir, "omp-darwin-arm64.tar.gz.sha256"),
			"nothex  omp-darwin-arm64.tar.gz\n",
		);

		const result = await run(
			["sh", "scripts/publish-bwoah-release.sh", VERSION, SHA, fixture.assetDir],
			publisherEnv(fixture),
		);

		expect(result.exitCode).not.toBe(0);
		expect((await fs.readdir(path.join(fixture.state, "tags"))).length).toBe(0);
		expect(await releaseIds(fixture.state)).toEqual([]);
	});
});
