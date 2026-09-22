import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const installer = path.join(repoRoot, "scripts", "install-bwoah.sh");
const tempDirs: string[] = [];

const FORK_TAG = "bwoah-v18.2.5-20260922-1430";
const FORK_VERSION = "18.2.5";
const ARCHIVE = "omp-darwin-arm64.tar.gz";
const ARCHIVE_CHECKSUM = "omp-darwin-arm64.tar.gz.sha256";
const LICENSE = "Bwoah My Pi is distributed under the MIT license.\n";
const NOTICES = "third-party notices for bundled components\n";
const FORK_CLONE_URL = "https://github.com/btimothy-har/bwoah-my-pi.git";
const GIT_COMMIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = repoRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd,
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

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(file).arrayBuffer());
	return hasher.digest("hex");
}

function ompPayload(markerPath: string | null, version: string): string {
	const lines = ["#!/bin/sh"];
	if (markerPath !== null) {
		lines.push(`printf 'x\\n' >> ${JSON.stringify(markerPath)}`);
	}
	lines.push(`echo "omp/${version}+bwoah"`);
	lines.push("");
	return lines.join("\n");
}

type FixtureMode = "ok" | "bad-checksum" | "extra-member" | "corrupt" | "link-member";

async function buildReleaseFixture(
	dir: string,
	opts: { mode?: FixtureMode; version?: string; markerPath?: string | null } = {},
): Promise<void> {
	const mode = opts.mode ?? "ok";
	const version = opts.version ?? FORK_VERSION;
	const stage = path.join(dir, "stage");
	await fs.mkdir(stage, { recursive: true });
	await Bun.write(path.join(stage, "omp"), ompPayload(opts.markerPath ?? null, version));
	await fs.chmod(path.join(stage, "omp"), 0o755);
	await Bun.write(path.join(stage, "LICENSE"), LICENSE);
	await Bun.write(path.join(stage, "THIRD-PARTY-NOTICES.txt"), NOTICES);

	const tarball = path.join(dir, ARCHIVE);
	if (mode === "corrupt") {
		await Bun.write(tarball, "definitely not a gzip archive\n");
	} else {
		const members = ["omp", "LICENSE", "THIRD-PARTY-NOTICES.txt"];
		if (mode === "extra-member") {
			await Bun.write(path.join(stage, "evil.txt"), "unexpected payload\n");
			members.push("evil.txt");
		}
		if (mode === "link-member") {
			// Names match the contract exactly; only the entry type is wrong.
			// Plain `tar -t` prints just the name, so the installer must catch
			// this post-extraction.
			await fs.rm(path.join(stage, "omp"));
			await fs.symlink("LICENSE", path.join(stage, "omp"));
		}
		const result = await run(
			["tar", "-czf", tarball, "--", ...members],
			{ ...process.env, COPYFILE_DISABLE: "1" },
			stage,
		);
		expect(result.exitCode, result.stderr).toBe(0);
	}

	const digest = mode === "bad-checksum" ? "0".repeat(64) : await sha256(tarball);
	await Bun.write(path.join(dir, ARCHIVE_CHECKSUM), `${digest}  ${ARCHIVE}\n`);
}

async function writeCurlShim(
	binDir: string,
	opts: { tag: string; fixtureDir: string; logPath: string },
): Promise<void> {
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
printf 'curl %s\\n' "$*" >> "${opts.logPath}"
url=""
out=""
wflag=0
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift 2 ;;
		-w) wflag=1; shift 2 ;;
		--proto|--connect-timeout|--max-time) shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
if [ "$wflag" = "1" ]; then
	printf '%s' "https://github.com/btimothy-har/bwoah-my-pi/releases/tag/${opts.tag}"
	exit 0
fi
case "$url" in
	*"releases/download/${opts.tag}/${ARCHIVE_CHECKSUM}") cp "${opts.fixtureDir}/${ARCHIVE_CHECKSUM}" "$out"; exit 0 ;;
	*"releases/download/${opts.tag}/${ARCHIVE}") cp "${opts.fixtureDir}/${ARCHIVE}" "$out"; exit 0 ;;
esac
exit 22
`,
	);
}

async function writeUnameShim(binDir: string, opts: { system: string; machine: string }): Promise<void> {
	await writeExecutable(
		binDir,
		"uname",
		`#!/bin/sh
case "$1" in
	-s) echo "${opts.system}" ;;
	-m) echo "${opts.machine}" ;;
esac
exit 0
`,
	);
}

async function writeSysctlShim(binDir: string, arm64: "0" | "1"): Promise<void> {
	await writeExecutable(
		binDir,
		"sysctl",
		`#!/bin/sh
case "$*" in
	*hw.optional.arm64*) echo "${arm64}" ;;
esac
exit 0
`,
	);
}

async function writeBunShim(binDir: string, opts: { logPath: string; globalBin: string }): Promise<void> {
	await writeExecutable(
		binDir,
		"bun",
		`#!/bin/sh
printf 'bun %s\\n' "$*" >> "${opts.logPath}"
case "$1" in
	--version) echo "1.3.14"; exit 0 ;;
	pm) echo "${opts.globalBin}"; exit 0 ;;
	setup) exit 0 ;;
esac
exit 0
`,
	);
}

async function writeGitShim(binDir: string, opts: { fixtureRepo: string }): Promise<void> {
	const realGit = Bun.which("git");
	expect(realGit).toBeString();
	await writeExecutable(
		binDir,
		"git",
		`#!/bin/sh
REAL_GIT=${JSON.stringify(realGit ?? "git")}
FIXTURE=${JSON.stringify(opts.fixtureRepo)}
FORK=${JSON.stringify(FORK_CLONE_URL)}
if [ "$1" = "clone" ]; then
	args=""
	for a in "$@"; do
		if [ "$a" = "$FORK" ]; then args="$args $FIXTURE"; else args="$args $a"; fi
	done
	# shellcheck disable=SC2086
	"$REAL_GIT" $args || exit $?
	dest=""
	for a in "$@"; do dest="$a"; done
	"$REAL_GIT" -C "$dest" remote set-url origin "$FORK"
	"$REAL_GIT" -C "$dest" config url."$FIXTURE".insteadOf "$FORK"
	exit 0
fi
exec "$REAL_GIT" "$@"
`,
	);
}

async function makeSourceFixture(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const g = async (args: string[]): Promise<void> => {
		// -c flags keep a signing/enforcing global gitconfig from turning
		// fixture commits/tags into interactive or annotated operations.
		const result = await run(
			["git", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
			GIT_COMMIT_ENV,
			dir,
		);
		expect(result.exitCode, result.stderr).toBe(0);
	};
	await g(["init", "-b", "main"]);
	await Bun.write(path.join(dir, "a.txt"), "one\n");
	await g(["add", "."]);
	await g(["commit", "-m", "one"]);
	await Bun.write(path.join(dir, "a.txt"), "two\n");
	await g(["commit", "-am", "two"]);
	await g(["tag", "v1.0.0", "HEAD~1"]);
}

async function runInstaller(
	env: NodeJS.ProcessEnv,
	args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return run(["sh", installer, ...args], env);
}

function installerEnv(home: string, binDir: string, installDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		HOME: home,
		PI_INSTALL_DIR: installDir,
	};
}

function sourceEnv(home: string, binDir: string): NodeJS.ProcessEnv {
	return installerEnv(home, binDir, path.join(home, ".local", "bin"));
}

async function expectNoSetupRun(dir: string): Promise<void> {
	const bunLog = path.join(dir, "bun.log");
	if (await pathExists(bunLog)) {
		expect(await Bun.file(bunLog).text()).not.toContain("setup");
	}
}

describe("install-bwoah.sh binary mode", () => {
	test("installs the latest release with notices and leaves existing config untouched", async () => {
		const dir = await makeTempDir("bwoah-install-ok-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(path.join(home, ".omp"), { recursive: true });
		const marker = path.join(dir, "marker");
		await buildReleaseFixture(fixture, { markerPath: marker });
		const settingsPath = path.join(home, ".omp", "settings.json");
		await Bun.write(settingsPath, '{"startup":{"checkUpdate":true}}\n');

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir));

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(FORK_TAG);
		expect(result.stdout).toContain(`omp/${FORK_VERSION}+bwoah`);

		const installed = await Bun.file(path.join(installDir, "omp")).text();
		expect(installed).toBe(ompPayload(marker, FORK_VERSION));
		const installedStat = await fs.stat(path.join(installDir, "omp"));
		expect((installedStat.mode & 0o111) !== 0).toBe(true);
		expect(
			await Bun.file(path.join(installDir, "..", "share", "bwoah-my-pi-releases", FORK_TAG, "LICENSE")).text(),
		).toBe(LICENSE);
		expect(
			await Bun.file(
				path.join(installDir, "..", "share", "bwoah-my-pi-releases", FORK_TAG, "THIRD-PARTY-NOTICES.txt"),
			).text(),
		).toBe(NOTICES);
		expect(await Bun.file(settingsPath).text()).toBe('{"startup":{"checkUpdate":true}}\n');
		expect(await pathExists(marker)).toBe(true);

		const log = await Bun.file(path.join(dir, "curl.log")).text();
		const lines = log.split("\n").filter(l => l.length > 0);
		expect(lines.filter(l => l.includes("/releases/latest")).length).toBe(1);
		expect(lines.filter(l => l.includes(`releases/download/${FORK_TAG}/`)).length).toBe(2);
	});

	test("--ref pins one tag and never resolves latest", async () => {
		const dir = await makeTempDir("bwoah-install-ref-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(`omp/${FORK_VERSION}+bwoah`);
		const log = await Bun.file(path.join(dir, "curl.log")).text();
		const lines = log.split("\n").filter(l => l.length > 0);
		expect(lines.filter(l => l.includes("/releases/latest")).length).toBe(0);
		expect(lines.filter(l => l.includes(`releases/download/${FORK_TAG}/`)).length).toBe(2);
	});

	test("bad checksum fails, preserves the destination, and never executes the payload", async () => {
		const dir = await makeTempDir("bwoah-install-badsum-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		const marker = path.join(dir, "marker");
		await buildReleaseFixture(fixture, { mode: "bad-checksum", markerPath: marker });
		const dest = path.join(installDir, "omp");
		await Bun.write(dest, "SENTINEL\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(dest).text()).toBe("SENTINEL\n");
		expect(await pathExists(marker)).toBe(false);
		expect(await pathExists(path.join(installDir, "..", "share", "bwoah-my-pi-releases", FORK_TAG))).toBe(false);
	});

	test("archive with an extra member fails and preserves the destination", async () => {
		const dir = await makeTempDir("bwoah-install-extra-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		const marker = path.join(dir, "marker");
		await buildReleaseFixture(fixture, { mode: "extra-member", markerPath: marker });
		const dest = path.join(installDir, "omp");
		await Bun.write(dest, "SENTINEL\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("archive layout");
		expect(await Bun.file(dest).text()).toBe("SENTINEL\n");
		expect(await pathExists(marker)).toBe(false);
	});

	test("archive with a symlink member fails and preserves the destination", async () => {
		const dir = await makeTempDir("bwoah-install-linkmember-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		const marker = path.join(dir, "marker");
		await buildReleaseFixture(fixture, { mode: "link-member", markerPath: marker });
		const dest = path.join(installDir, "omp");
		await Bun.write(dest, "SENTINEL\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not a regular file");
		expect(await Bun.file(dest).text()).toBe("SENTINEL\n");
		expect(await pathExists(marker)).toBe(false);
	});

	test("corrupt archive fails and preserves the destination", async () => {
		const dir = await makeTempDir("bwoah-install-corrupt-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await buildReleaseFixture(fixture, { mode: "corrupt" });
		const dest = path.join(installDir, "omp");
		await Bun.write(dest, "SENTINEL\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(dest).text()).toBe("SENTINEL\n");
	});

	test("wrong upstream version fails the probe and preserves the destination", async () => {
		const dir = await makeTempDir("bwoah-install-wrongver-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await buildReleaseFixture(fixture, { version: "99.0.0", markerPath: null });
		const dest = path.join(installDir, "omp");
		await Bun.write(dest, "SENTINEL\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(`omp/${FORK_VERSION}+bwoah`);
		expect(await Bun.file(dest).text()).toBe("SENTINEL\n");
		expect(await pathExists(path.join(installDir, "..", "share", "bwoah-my-pi-releases", FORK_TAG))).toBe(false);
	});

	test("replaces an existing destination symlink without touching its target", async () => {
		const dir = await makeTempDir("bwoah-install-symlink-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });

		const target = path.join(dir, "bin-target", "wrapper.sh");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "#!/bin/sh\necho original\n");
		await fs.chmod(target, 0o755);
		await fs.symlink(target, path.join(installDir, "omp"));

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode, result.stderr).toBe(0);
		const dest = path.join(installDir, "omp");
		const destStat = await fs.lstat(dest);
		expect(destStat.isSymbolicLink()).toBe(false);
		expect(await Bun.file(dest).text()).toBe(ompPayload(null, FORK_VERSION));
		expect(await Bun.file(target).text()).toBe("#!/bin/sh\necho original\n");
	});

	test("warns when another launcher shadows the install instead of claiming success", async () => {
		const dir = await makeTempDir("bwoah-install-shadow-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const shadowDir = path.join(dir, "shadow");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(shadowDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });
		await writeExecutable(shadowDir, "omp", "#!/bin/sh\necho shadowed\n");

		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const env = {
			...installerEnv(home, binDir, installDir),
			PATH: `${binDir}:${shadowDir}:${installDir}:${process.env.PATH ?? ""}`,
		};
		const result = await runInstaller(env, ["--ref", FORK_TAG]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).toContain(`${shadowDir}/omp`);
		expect(result.stdout).toContain(`export PATH="${installDir}:$PATH"`);
	});

	test("accepts an arm64 host under Rosetta where uname reports x86_64", async () => {
		const dir = await makeTempDir("bwoah-install-rosetta-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });

		await writeUnameShim(binDir, { system: "Darwin", machine: "x86_64" });
		await writeSysctlShim(binDir, "1");
		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(ompPayload(null, FORK_VERSION));
	});

	test("refuses an Intel mac before any download", async () => {
		const dir = await makeTempDir("bwoah-install-intel-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });

		await writeSysctlShim(binDir, "0");
		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("darwin-arm64");
		expect(result.stderr).toContain("--source");
		expect(await pathExists(path.join(dir, "curl.log"))).toBe(false);
	});

	test("refuses a Linux host before any download", async () => {
		const dir = await makeTempDir("bwoah-install-linux-");
		const home = path.join(dir, "home");
		const installDir = path.join(dir, "install");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });

		await writeUnameShim(binDir, { system: "Linux", machine: "x86_64" });
		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });
		const result = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Darwin");
		expect(result.stderr).toContain("--source");
		expect(await pathExists(path.join(dir, "curl.log"))).toBe(false);
	});
});

describe("install-bwoah.sh command surface", () => {
	test("--help exits zero and documents both modes", async () => {
		const result = await run(["sh", installer, "--help"], { ...process.env, PATH: "/usr/bin:/bin" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--source");
		expect(result.stdout).toContain("--ref");
	});

	test("unknown flags, conflicting modes, and missing --ref values fail before side effects", async () => {
		const env = { ...process.env, PATH: "/usr/bin:/bin" };
		for (const args of [["--bogus"], ["--binary", "--source"], ["--ref"]]) {
			const result = await run(["sh", installer, ...args], env);
			expect(result.exitCode, args.join(" ")).not.toBe(0);
		}
	});
});

describe("install-bwoah.sh source mode", () => {
	test("binary install then --source uses the durable checkout without dirtying it", async () => {
		const dir = await makeTempDir("bwoah-install-src-");
		const home = path.join(dir, "home");
		const installDir = path.join(home, ".local", "bin");
		const binDir = path.join(dir, "bin");
		const fixture = path.join(dir, "fixture");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(binDir, { recursive: true });
		await buildReleaseFixture(fixture, { markerPath: null });
		await writeCurlShim(binDir, { tag: FORK_TAG, fixtureDir: fixture, logPath: path.join(dir, "curl.log") });

		const binaryResult = await runInstaller(installerEnv(home, binDir, installDir), ["--ref", FORK_TAG]);
		expect(binaryResult.exitCode, binaryResult.stderr).toBe(0);

		const fixtureRepo = path.join(dir, "fixture-repo");
		await makeSourceFixture(fixtureRepo);
		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeExecutable(globalBin, "omp", "#!/bin/sh\necho source-launcher\n");
		await writeGitShim(binDir, { fixtureRepo });
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const sourceResult = await runInstaller(sourceEnv(home, binDir), ["--source"]);
		expect(sourceResult.exitCode, sourceResult.stderr).toBe(0);
		expect(sourceResult.stdout).toContain("source-launcher");

		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		expect(await pathExists(path.join(sourceDir, ".git"))).toBe(true);
		const status = await run(["git", "status", "--porcelain"], process.env, sourceDir);
		expect(status.stdout).toBe("");
		const bunLog = await Bun.file(path.join(dir, "bun.log")).text();
		expect(bunLog.split("\n").filter(l => l.includes("setup")).length).toBe(1);

		const noticesDir = path.join(home, ".local", "share", "bwoah-my-pi-releases", FORK_TAG);
		expect(await pathExists(noticesDir)).toBe(true);
		expect(await pathExists(path.join(sourceDir, "share", "bwoah-my-pi-releases"))).toBe(false);
	});

	test("wrong origin remote fails without running setup or touching the checkout", async () => {
		const dir = await makeTempDir("bwoah-install-remote-");
		const home = path.join(dir, "home");
		const binDir = path.join(dir, "bin");
		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		await fs.mkdir(binDir, { recursive: true });
		await makeSourceFixture(sourceDir);
		await run(["git", "remote", "add", "origin", "https://github.com/can1357/oh-my-pi.git"], process.env, sourceDir);
		const headBefore = (await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout;

		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const result = await runInstaller(sourceEnv(home, binDir), ["--source"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(sourceDir);
		expect(result.stderr).toContain("origin");
		expect((await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout).toBe(headBefore);
		await expectNoSetupRun(dir);
	});

	test("dirty checkout fails without destructive changes", async () => {
		const dir = await makeTempDir("bwoah-install-dirty-");
		const home = path.join(dir, "home");
		const binDir = path.join(dir, "bin");
		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		await fs.mkdir(binDir, { recursive: true });
		await makeSourceFixture(sourceDir);
		await run(["git", "remote", "add", "origin", FORK_CLONE_URL], process.env, sourceDir);
		await Bun.write(path.join(sourceDir, "a.txt"), "tampered\n");
		const headBefore = (await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout;

		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const result = await runInstaller(sourceEnv(home, binDir), ["--source"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("uncommitted changes");
		expect(await Bun.file(path.join(sourceDir, "a.txt")).text()).toBe("tampered\n");
		expect((await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout).toBe(headBefore);
		await expectNoSetupRun(dir);
	});

	test("ref mismatch (tag requested, branch checked out) fails without changes", async () => {
		const dir = await makeTempDir("bwoah-install-refmismatch-");
		const home = path.join(dir, "home");
		const binDir = path.join(dir, "bin");
		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		await fs.mkdir(binDir, { recursive: true });
		await makeSourceFixture(sourceDir);
		await run(["git", "remote", "add", "origin", FORK_CLONE_URL], process.env, sourceDir);
		const headBefore = (await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout;

		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const result = await runInstaller(sourceEnv(home, binDir), ["--source", "--ref", "v1.0.0"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("ref mismatch");
		expect((await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout).toBe(headBefore);
		await expectNoSetupRun(dir);
	});

	test("a matching pinned tag is kept unchanged and setup still runs", async () => {
		const dir = await makeTempDir("bwoah-install-tagmatch-");
		const home = path.join(dir, "home");
		const binDir = path.join(dir, "bin");
		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		await fs.mkdir(binDir, { recursive: true });
		await makeSourceFixture(sourceDir);
		await run(["git", "remote", "add", "origin", FORK_CLONE_URL], process.env, sourceDir);
		await run(["git", "checkout", "v1.0.0"], process.env, sourceDir);
		const headBefore = (await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout;

		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeExecutable(globalBin, "omp", "#!/bin/sh\necho omp/18.2.5+bwoah\n");
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const result = await runInstaller(sourceEnv(home, binDir), ["--source", "--ref", "v1.0.0"]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Already at v1.0.0");
		expect((await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout).toBe(headBefore);
		const bunLog = await Bun.file(path.join(dir, "bun.log")).text();
		expect(bunLog.split("\n").filter(l => l.includes("setup")).length).toBe(1);
	});

	test("a matching branch fast-forwards to the fetched remote head", async () => {
		const dir = await makeTempDir("bwoah-install-ff-");
		const home = path.join(dir, "home");
		const binDir = path.join(dir, "bin");
		const sourceDir = path.join(home, ".local", "share", "bwoah-my-pi");
		const fixtureRepo = path.join(dir, "fixture-repo");
		await fs.mkdir(binDir, { recursive: true });
		await makeSourceFixture(sourceDir);
		await run(["git", "remote", "add", "origin", FORK_CLONE_URL], process.env, sourceDir);
		await run(["git", "config", `url.${fixtureRepo}.insteadOf`, FORK_CLONE_URL], process.env, sourceDir);
		// Clone the checkout so histories share commits and a ff-only merge is possible.
		const cloneResult = await run(["git", "clone", "--quiet", sourceDir, fixtureRepo], process.env, dir);
		expect(cloneResult.exitCode, cloneResult.stderr).toBe(0);
		await Bun.write(path.join(fixtureRepo, "a.txt"), "three\n");
		const commitResult = await run(["git", "commit", "-a", "-m", "three"], GIT_COMMIT_ENV, fixtureRepo);
		expect(commitResult.exitCode, commitResult.stderr).toBe(0);

		const globalBin = path.join(dir, "global-bin");
		await fs.mkdir(globalBin, { recursive: true });
		await writeBunShim(binDir, { logPath: path.join(dir, "bun.log"), globalBin });
		await writeExecutable(binDir, "rustup", "#!/bin/sh\nexit 0\n");

		const result = await runInstaller(sourceEnv(home, binDir), ["--source"]);
		expect(result.exitCode, result.stderr).toBe(0);

		const sourceHead = (await run(["git", "rev-parse", "HEAD"], process.env, sourceDir)).stdout;
		const fixtureHead = (await run(["git", "rev-parse", "HEAD"], process.env, fixtureRepo)).stdout;
		expect(sourceHead).toBe(fixtureHead);
		const bunLog = await Bun.file(path.join(dir, "bun.log")).text();
		expect(bunLog.split("\n").filter(l => l.includes("setup")).length).toBe(1);
	});
});
