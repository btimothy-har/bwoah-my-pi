import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Fork app-update policy, exercised through the real CLI process (no dispatch
// mocks): app updates refuse cleanly, the persisted channel is never mutated,
// no upstream release-metadata request is attempted (npm_config_registry points
// at a local recording server), and the plugin branch still performs an actual
// marketplace upgrade against a local fixture.

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

interface CliRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Launch the fork CLI as a real subprocess against an isolated home. Only an
 * explicit minimal env is inherited: no ambient profile, XDG, or credential
 * variables reach the child, so all state lands under `home`.
 */
async function runCli(
	args: string[],
	home: string,
	cwd: string,
	extraEnv: Record<string, string> = {},
): Promise<CliRun> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd,
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			HOME: home,
			USERPROFILE: home,
			NO_COLOR: "1",
			// Default mode honors a non-profile PI_CODING_AGENT_DIR; config.yml
			// resolves to <home>/.omp/agent/config.yml.
			PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
			...extraEnv,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Seed `update.channel: stable` and return the config file bytes for equality checks. */
async function seedStableChannel(home: string): Promise<{ configPath: string; seeded: string }> {
	const agentDir = path.join(home, ".omp", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const configPath = path.join(agentDir, "config.yml");
	const seeded = "update:\n  channel: stable\n";
	await Bun.write(configPath, seeded);
	return { configPath, seeded };
}

/**
 * Local recording registry. Subprocesses point `npm_config_registry` here (the
 * second-priority source in npm-registry resolution), so any release-metadata
 * request the CLI attempts is captured locally instead of reaching upstream;
 * assertions require zero recorded requests.
 */
function startRecordingRegistry(): { port: number; requests: string[]; stop: () => void } {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			requests.push(`${req.method} ${req.url}`);
			return Response.json({ version: "0.0.0" });
		},
	});
	const port = server.port;
	if (port === undefined) {
		server.stop(true);
		throw new Error("recording registry failed to bind a port");
	}
	return { port, requests, stop: () => server.stop(true) };
}

async function readInstalledRegistry(home: string): Promise<Record<string, Array<{ version: string }>>> {
	const registryPath = path.join(home, ".omp", "plugins", "installed_plugins.json");
	const raw = (await Bun.file(registryPath).json()) as {
		plugins: Record<string, Array<{ version: string }>>;
	};
	return raw.plugins;
}

describe.skipIf(process.platform === "win32")("omp update fork refusal (real CLI subprocess)", () => {
	it("refuses --check with the fork policy, no metadata request, channel untouched", async () => {
		using dir = TempDir.createSync("@omp-fork-update-check-");
		const registry = startRecordingRegistry();
		try {
			const home = dir.join("home");
			await fs.mkdir(home, { recursive: true });
			const { configPath, seeded } = await seedStableChannel(home);

			const run = await runCli(["update", "--check"], home, dir.path(), {
				npm_config_registry: `http://127.0.0.1:${registry.port}/`,
			});

			expect(run.exitCode, `stdout: ${run.stdout}`).toBe(1);
			expect(run.stderr).toContain("does not support app self-update");
			expect(run.stderr).toContain("omp update --plugins");
			expect(await Bun.file(configPath).text()).toBe(seeded);
			// The refusal precedes every upstream effect: the recording registry
			// saw no release-metadata request.
			expect(registry.requests).toEqual([]);
		} finally {
			registry.stop();
		}
	}, 120_000);

	it("refuses --force --canary without metadata requests or channel switch", async () => {
		using dir = TempDir.createSync("@omp-fork-update-canary-");
		const registry = startRecordingRegistry();
		try {
			const home = dir.join("home");
			await fs.mkdir(home, { recursive: true });
			const { configPath, seeded } = await seedStableChannel(home);

			const run = await runCli(["update", "--force", "--canary"], home, dir.path(), {
				npm_config_registry: `http://127.0.0.1:${registry.port}/`,
			});

			expect(run.exitCode, `stdout: ${run.stdout}`).toBe(1);
			expect(run.stderr).toContain("does not support app self-update");
			// The channel switch must never be persisted.
			expect(await Bun.file(configPath).text()).toBe(seeded);
			// App flags never bypass the refusal into release metadata.
			expect(registry.requests).toEqual([]);
		} finally {
			registry.stop();
		}
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("omp --version fork display (real CLI subprocess)", () => {
	it("reports omp/<upstream-version>+bwoah while the workspace version stays plain", async () => {
		const utilsPackage = (await Bun.file(path.join(repoRoot, "packages/utils/package.json")).json()) as {
			version: string;
		};
		using dir = TempDir.createSync("@omp-fork-version-");
		const home = dir.join("home");
		await fs.mkdir(home, { recursive: true });

		const run = await runCli(["--version"], home, dir.path());

		expect(run.exitCode).toBe(0);
		// DISPLAY_VERSION reaches the CLI registry; the suffix is fork-only.
		expect(run.stdout).toBe(`omp/${utilsPackage.version}+bwoah\n`);
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("omp update --plugins (real CLI subprocess)", () => {
	it("upgrades an installed marketplace plugin to the newer catalog revision", async () => {
		using dir = TempDir.createSync("@omp-fork-plugins-upgrade-");
		const home = dir.join("home");
		const project = dir.join("project");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(project, { recursive: true });

		// Local marketplace fixture serving bwoah-plugin at 1.0.0.
		const marketplaceDir = dir.join("marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "bwoah-plugin");
		await fs.mkdir(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginDir, "extensions"), { recursive: true });
		const catalog = {
			name: "test-marketplace",
			owner: { name: "Fork Test" },
			plugins: [
				{
					name: "bwoah-plugin",
					source: "./plugins/bwoah-plugin",
					description: "Fork upgrade probe plugin",
					version: "1.0.0",
				},
			],
		};
		await Bun.write(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog));
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "bwoah-plugin", version: "1.0.0", omp: { extensions: ["./extensions"] } }),
		);
		await Bun.write(
			path.join(pluginDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "bwoah-plugin", version: "1.0.0" }),
		);
		await Bun.write(path.join(pluginDir, "extensions", "index.ts"), "export default {};\n");

		const registry = startRecordingRegistry();
		try {
			const registryEnv = { npm_config_registry: `http://127.0.0.1:${registry.port}/` };

			const add = await runCli(["plugin", "marketplace", "add", marketplaceDir], home, project, registryEnv);
			expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);

			const install = await runCli(
				["plugin", "install", "bwoah-plugin@test-marketplace"],
				home,
				project,
				registryEnv,
			);
			expect(install.exitCode, `${install.stdout}\n${install.stderr}`).toBe(0);

			expect((await readInstalledRegistry(home))["bwoah-plugin@test-marketplace"]?.[0]?.version).toBe("1.0.0");

			// Advance the marketplace to revision 2.0.0: the source fixture and the
			// cached catalog both move (checkForUpdates reads the cached catalog).
			catalog.plugins[0].version = "2.0.0";
			await Bun.write(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog));
			await Bun.write(
				path.join(pluginDir, "package.json"),
				JSON.stringify({ name: "bwoah-plugin", version: "2.0.0", omp: { extensions: ["./extensions"] } }),
			);
			await Bun.write(
				path.join(pluginDir, ".claude-plugin", "plugin.json"),
				JSON.stringify({ name: "bwoah-plugin", version: "2.0.0" }),
			);
			const cachedCatalogPath = path.join(
				home,
				".omp",
				"plugins",
				"cache",
				"marketplaces",
				"test-marketplace",
				"marketplace.json",
			);
			await Bun.write(cachedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

			// `omp update --plugins` is the supported branch: a real upgrade runs.
			const upgrade = await runCli(["update", "--plugins"], home, project, registryEnv);
			expect(upgrade.exitCode, `${upgrade.stdout}\n${upgrade.stderr}`).toBe(0);
			expect(upgrade.stdout).toContain("1.0.0 -> 2.0.0");

			// The installed registry now records 2.0.0 and the runtime link resolves
			// into the 2.0.0 cache entry.
			expect((await readInstalledRegistry(home))["bwoah-plugin@test-marketplace"]?.[0]?.version).toBe("2.0.0");
			const link = path.join(home, ".omp", "plugins", "node_modules", "bwoah-plugin");
			expect(await fs.realpath(link)).toContain("test-marketplace___bwoah-plugin___2.0.0");

			// Plugin updates never consult the app-update release metadata either.
			expect(registry.requests).toEqual([]);
		} finally {
			registry.stop();
		}
	}, 180_000);
});
