import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hashPath } from "@oh-my-pi/pi-utils/dirs";
import type { SessionData } from "../src/export/html";
import { buildShareSnapshot, normalizeShareServerUrl, SERVER_MAX_SEALED_BYTES, sealToFit } from "../src/export/share";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { SessionEntry } from "../src/session/session-entries";
import { sessionDirForCwd } from "../src/session/session-paths";
import type { SessionManager } from "../src/session/session-manager";

const IV_LENGTH = 12;
const TEST_MAX_SEALED_BYTES = 4_000;
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
const LOOPBACK_GUARD = path.join(import.meta.dir, "fixtures", "share-loopback-guard.ts");
const PUBLICATION_FIXTURE = path.join(import.meta.dir, "fixtures", "share-publication-fixture.ts");
const BUN_EXECUTABLE = path.resolve(process.execPath);

interface ChildRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface Workspace {
	agentDir: string;
	launchCwd: string;
	sessionsRoot: string;
	blobsDir: string;
	customFilesDir: string;
	terminalSessionsDir: string;
	tmuxPane: string;
	env: Record<string, string>;
}
interface LoopbackSink {
	server: Bun.Server<undefined>;
	origin: string;
	uploads: Uint8Array<ArrayBuffer>[];
	readonly requestCount: number;
}

function captureLoopbackUploads({ status, redirectTo }: { status?: number; redirectTo?: string } = {}): LoopbackSink {
	const uploads: Uint8Array<ArrayBuffer>[] = [];
	let requestCount = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requestCount++;
			if (request.method === "POST") uploads.push(new Uint8Array(await request.arrayBuffer()));
			if (redirectTo) return new Response("redirect", { status: 302, headers: { location: redirectTo } });
			if (status !== undefined) return new Response("sink rejected publication", { status });
			return Response.json({ id: "localshare01" });
		},
	});
	return {
		server,
		origin: `http://127.0.0.1:${server.port}`,
		uploads,
		get requestCount() {
			return requestCount;
		},
	};
}

async function runChild(argv: string[], cwd: string, env: Record<string, string>): Promise<ChildRun> {
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function createWorkspace(tempDir: TempDir, origin: string): Promise<Workspace> {
	const root = tempDir.path();
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const launchCwd = path.join(root, "launch-project");
	const emptyBin = path.join(root, "empty-bin");
	const tmp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? path.dirname(root);
	const tmuxPane = `share-${process.pid}-${crypto.randomUUID()}`;
	const sessionsRoot = path.join(agentDir, "sessions");
	const blobsDir = path.join(agentDir, "blobs");
	const customFilesDir = path.join(agentDir, "custom-session-files");
	const terminalSessionsDir = path.join(agentDir, "terminal-sessions");

	await Promise.all(
		[
			home,
			agentDir,
			launchCwd,
			emptyBin,
			path.join(home, ".config"),
			path.join(home, ".local", "share"),
			path.join(home, ".local", "state"),
			path.join(home, ".cache"),
			blobsDir,
			customFilesDir,
			terminalSessionsDir,
		].map(dir => fs.mkdir(dir, { recursive: true })),
	);
	await fs.writeFile(path.join(blobsDir, "artifact-sentinel.bin"), Buffer.from("existing-artifact"));
	const env: Record<string, string> = {
		PATH: emptyBin,
		TMPDIR: process.env.TMPDIR ?? tmp,
		TMP: process.env.TMP ?? tmp,
		TEMP: process.env.TEMP ?? tmp,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		OMP_TEST_SHARE_ORIGIN: origin,
		TMUX_PANE: tmuxPane,
		NO_COLOR: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	for (const key of ["SystemRoot", "WINDIR"] as const) {
		const value = process.env[key];
		if (value) env[key] = value;
	}

	return { agentDir, launchCwd, sessionsRoot, blobsDir, customFilesDir, terminalSessionsDir, tmuxPane, env };
}

async function writeSettings(
	filePath: string,
	{
		serverUrl,
		redactSecrets,
		secretsEnabled,
	}: { serverUrl?: string; redactSecrets: boolean; secretsEnabled: boolean },
): Promise<void> {
	const shareUrl = serverUrl === undefined ? "" : `  serverUrl: ${JSON.stringify(serverUrl)}\n`;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(
		filePath,
		`share:\n${shareUrl}  store: blob\n  redactSecrets: ${redactSecrets}\nsecrets:\n  enabled: ${secretsEnabled}\n`,
	);
}

async function writeSecrets(filePath: string, secret: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(
		filePath,
		`- type: plain\n  content: ${JSON.stringify(secret)}\n  mode: replace\n  replacement: "[synthetic-secret-redacted]"\n`,
	);
}
async function configureGlobalSettings(
	workspace: Workspace,
	origin: string,
	{ redactSecrets = false, secretsEnabled = false }: { redactSecrets?: boolean; secretsEnabled?: boolean } = {},
): Promise<void> {
	await writeSettings(path.join(workspace.agentDir, "config.yml"), {
		serverUrl: origin,
		redactSecrets,
		secretsEnabled,
	});
}

async function writeTranscript(
	sessionPath: string,
	transcript: {
		id: string;
		cwd?: unknown;
		executionCwd?: unknown;
		previousSessionFiles?: string[];
		text: string;
		imageBlobRef?: string;
	},
): Promise<void> {
	const { id, cwd, executionCwd, previousSessionFiles, text, imageBlobRef } = transcript;
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-10-09T00:00:00.000Z",
	};
	if (Object.hasOwn(transcript, "cwd")) header.cwd = cwd;
	if (executionCwd !== undefined) header.executionCwd = executionCwd;
	if (previousSessionFiles !== undefined) header.previousSessionFiles = previousSessionFiles;
	const entry = messageEntry("message-1", null, text, imageBlobRef);
	await fs.mkdir(path.dirname(sessionPath), { recursive: true });
	await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
}

async function snapshotTree(root: string): Promise<string> {
	const records: Array<Record<string, string | number>> = [];
	const visit = async (current: string): Promise<void> => {
		const stat = await fs.stat(current, { bigint: true }).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (!stat) return;
		const relative = path.relative(root, current) || ".";
		records.push({
			path: relative,
			kind: "directory",
			mtimeNs: String(stat.mtimeNs),
			mode: Number(stat.mode & 0o777n),
		});
		const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const child of children) {
			const childPath = path.join(current, child.name);
			if (child.isDirectory()) {
				await visit(childPath);
			} else if (child.isFile()) {
				const [fileStat, bytes] = await Promise.all([fs.stat(childPath, { bigint: true }), fs.readFile(childPath)]);
				records.push({
					path: path.relative(root, childPath),
					kind: "file",
					mtimeNs: String(fileStat.mtimeNs),
					mode: Number(fileStat.mode & 0o777n),
					bytes: bytes.toString("base64"),
				});
			} else if (child.isSymbolicLink()) {
				records.push({
					path: path.relative(root, childPath),
					kind: "symlink",
					target: await fs.readlink(childPath),
				});
			}
		}
	};
	const rootStat = await fs.stat(root).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!rootStat) return "missing";
	await visit(root);
	return JSON.stringify(records);
}

async function fileState(filePath: string): Promise<string> {
	try {
		const [stat, bytes] = await Promise.all([fs.stat(filePath, { bigint: true }), fs.readFile(filePath)]);
		return JSON.stringify({
			bytes: bytes.toString("base64"),
			mtimeNs: String(stat.mtimeNs),
			mode: Number(stat.mode & 0o777n),
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}

async function setSourceReadOnly(sessionPath: string): Promise<void> {
	if (process.platform === "win32") return;
	await fs.chmod(sessionPath, 0o444);
	await fs.chmod(path.dirname(sessionPath), 0o555);
}

async function restoreSourcePermissions(sessionPath: string): Promise<void> {
	if (process.platform === "win32") return;
	await fs.chmod(path.dirname(sessionPath), 0o755);
	await fs.chmod(sessionPath, 0o644);
}

async function sourceState(workspace: Workspace, sessionPath: string): Promise<string> {
	return JSON.stringify({
		source: await snapshotTree(path.dirname(sessionPath)),
		sessions: await snapshotTree(workspace.sessionsRoot),
		blobs: await snapshotTree(workspace.blobsDir),
		customFiles: await snapshotTree(workspace.customFilesDir),
		terminalSessions: await snapshotTree(workspace.terminalSessionsDir),
		breadcrumb: await fileState(path.join(workspace.terminalSessionsDir, `tmux-${workspace.tmuxPane}`)),
	});
}

async function writeBreadcrumb(workspace: Workspace, sessionPath: string): Promise<string> {
	const breadcrumbPath = path.join(workspace.terminalSessionsDir, `tmux-${workspace.tmuxPane}`);
	await fs.writeFile(breadcrumbPath, `${workspace.launchCwd}\n${sessionPath}\n`);
	return breadcrumbPath;
}

function guardedArgs(entry: string, ...args: string[]): string[] {
	return [BUN_EXECUTABLE, "--preload", LOOPBACK_GUARD, entry, ...args];
}

async function runCliShare(workspace: Workspace, sessionArg: string): Promise<ChildRun> {
	return runChild(guardedArgs(CLI_ENTRY, "share", sessionArg), workspace.launchCwd, workspace.env);
}

async function runPublicationFixture(
	tempDir: TempDir,
	workspace: Workspace,
	mode: "data" | "live",
	manifest: Record<string, unknown>,
): Promise<ChildRun> {
	const manifestPath = path.join(tempDir.path(), `publication-${mode}-${crypto.randomUUID()}.json`);
	await fs.writeFile(manifestPath, JSON.stringify(manifest));
	return runChild(guardedArgs(PUBLICATION_FIXTURE, mode, manifestPath), workspace.launchCwd, workspace.env);
}

async function decryptUpload(url: string, sink: LoopbackSink): Promise<SessionData> {
	expect(sink.uploads).toHaveLength(1);
	expect(sink.requestCount).toBe(1);
	const parsed = new URL(url);
	expect(parsed.origin).toBe(sink.origin);
	expect(parsed.pathname).toBe("/localshare01");
	expect(parsed.hash.length).toBeGreaterThan(1);
	const key = await crypto.subtle.importKey("raw", Buffer.from(parsed.hash.slice(1), "base64url"), "AES-GCM", false, [
		"decrypt",
	]);
	return open(key, sink.uploads[0]!);
}

function cliShareUrl(stdout: string): string {
	const line = stdout.split(/\r?\n/).find(value => value.startsWith("Share URL: "));
	if (!line) throw new Error(`No share URL in child output: ${stdout}`);
	return line.slice("Share URL: ".length);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

describe("share publication network fence", () => {
	test("rejects a disallowed origin before making a network request", async () => {
		using tempDir = TempDir.createSync("@omp-share-guard-deny-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			const script = `void (async () => {
				try { await fetch("https://outside.invalid/"); console.log("unexpected success"); process.exitCode = 2; }
				catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
			})();`;
			const run = await runChild(
				[BUN_EXECUTABLE, "--preload", LOOPBACK_GUARD, "-e", script],
				workspace.launchCwd,
				workspace.env,
			);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toContain("Blocked network request: target is not the configured loopback share origin");
			expect(sink.requestCount).toBe(0);
			expect(sink.uploads).toHaveLength(0);
		} finally {
			sink.server.stop(true);
		}
	});

	test("rejects redirects instead of following them to a disallowed origin", async () => {
		using tempDir = TempDir.createSync("@omp-share-guard-redirect-");
		const sink = captureLoopbackUploads({ redirectTo: "https://outside.invalid/" });
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			const script = `void (async () => {
				try {
					await fetch(${JSON.stringify(sink.origin)});
					console.log("unexpected success"); process.exitCode = 2;
				} catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
			})();`;
			const run = await runChild(
				[BUN_EXECUTABLE, "--preload", LOOPBACK_GUARD, "-e", script],
				workspace.launchCwd,
				workspace.env,
			);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toMatch(/redirect/i);
			expect(sink.requestCount).toBe(1);
			expect(sink.uploads).toHaveLength(0);
		} finally {
			sink.server.stop(true);
		}
	});
});

describe("child-fenced publication APIs", () => {
	test("publishes plain data with projected headers, redaction, and input immutability", async () => {
		using tempDir = TempDir.createSync("@omp-share-data-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			const secret = "data-child-secret-Q7";
			const data = {
				header: {
					type: "session",
					version: 3,
					id: "data-main",
					timestamp: "2026-10-09T00:00:00.000Z",
					cwd: "/projects/home-owner",
					additionalDirectories: ["/projects/workspace-root"],
					executionCwd: "/private/runtime-binding",
					previousSessionFiles: ["/private/move-history.jsonl"],
				},
				entries: [messageEntry("main-1", null, `main conversation contains ${secret}`)],
				leafId: "main-1",
				subSessions: {
					Child: {
						agentId: "Child",
						parent: null,
						header: {
							type: "session",
							version: 3,
							id: "data-child",
							timestamp: "2026-10-09T00:00:00.000Z",
							cwd: "/projects/home-owner/child",
							executionCwd: 17,
							previousSessionFiles: ["/private/child-move-history.jsonl"],
						},
						entries: [messageEntry("child-1", null, `nested conversation ${secret}`)],
						leafId: "child-1",
						aborted: false,
					},
				},
			} as unknown as SessionData;
			const original = JSON.stringify(data);
			const run = await runPublicationFixture(tempDir, workspace, "data", { data, secret });
			expect(run.exitCode, run.stderr).toBe(0);
			const report = JSON.parse(run.stdout) as {
				result: { url: string; method: string; gistUrl?: string };
				unchanged: boolean;
			};
			expect(report.unchanged).toBe(true);
			expect(report.result.method).toBe("server");
			expect(report.result.gistUrl).toBeUndefined();
			expect(JSON.stringify(data)).toBe(original);

			const opened = await decryptUpload(report.result.url, sink);
			const flat = JSON.stringify(opened);
			expect(opened.header?.cwd).toBe("/projects/home-owner");
			expect(opened.header?.additionalDirectories).toEqual(["/projects/workspace-root"]);
			expect(opened.entries).toHaveLength(1);
			expect(flat).toContain("main conversation");
			expect(flat).toContain("nested conversation");
			expect(flat).toContain("/projects/home-owner");
			expect(flat).not.toContain(secret);
			expect(Object.hasOwn(opened.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(opened.header ?? {}, "previousSessionFiles")).toBe(false);
			const child = opened.subSessions?.Child;
			expect(child?.header?.cwd).toBe("/projects/home-owner/child");
			expect(Object.hasOwn(child?.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(child?.header ?? {}, "previousSessionFiles")).toBe(false);
			expect(child?.entries).toHaveLength(1);
		} finally {
			sink.server.stop(true);
		}
	}, 30_000);

	test("strips private metadata from plain data without an obfuscator", async () => {
		using tempDir = TempDir.createSync("@omp-share-data-no-obfuscator-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			const data = {
				header: {
					type: "session",
					version: 3,
					id: "clear-main",
					timestamp: "2026-10-09T00:00:00.000Z",
					cwd: "/projects/clear-owner",
					executionCwd: false,
					previousSessionFiles: ["/private/old.jsonl"],
				},
				entries: [messageEntry("clear-1", null, "unredacted conversation")],
				leafId: "clear-1",
				subSessions: {
					Nested: {
						agentId: "Nested",
						parent: null,
						header: {
							type: "session",
							version: 3,
							id: "clear-child",
							timestamp: "2026-10-09T00:00:00.000Z",
							cwd: "/projects/clear-owner/nested",
							executionCwd: null,
							previousSessionFiles: ["/private/nested-old.jsonl"],
						},
						entries: [messageEntry("nested-1", null, "nested remains clear")],
						leafId: "nested-1",
						aborted: false,
					},
				},
			} as unknown as SessionData;
			const original = JSON.stringify(data);
			const run = await runPublicationFixture(tempDir, workspace, "data", { data });
			expect(run.exitCode, run.stderr).toBe(0);
			const report = JSON.parse(run.stdout) as {
				result: { url: string; method: string };
				unchanged: boolean;
			};
			expect(report.unchanged).toBe(true);
			expect(report.result.method).toBe("server");
			expect(JSON.stringify(data)).toBe(original);

			const opened = await decryptUpload(report.result.url, sink);
			expect(JSON.stringify(opened)).toContain("unredacted conversation");
			expect(opened.header?.cwd).toBe("/projects/clear-owner");
			expect(Object.hasOwn(opened.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(opened.header ?? {}, "previousSessionFiles")).toBe(false);
			expect(Object.hasOwn(opened.subSessions?.Nested?.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(opened.subSessions?.Nested?.header ?? {}, "previousSessionFiles")).toBe(false);
		} finally {
			sink.server.stop(true);
		}
	}, 30_000);

	test("publishes live sessions without mutating their state or legacy header", async () => {
		using tempDir = TempDir.createSync("@omp-share-live-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			const source = path.join(tempDir.path(), "live-source", "session.jsonl");
			const secret = "live-child-secret-U8";
			await fs.mkdir(path.join(tempDir.path(), "session-home"), { recursive: true });
			await writeTranscript(source, {
				id: "live-session",
				cwd: path.join(tempDir.path(), "session-home"),
				executionCwd: path.join(tempDir.path(), "launch-project"),
				previousSessionFiles: ["/private/live-move-history.jsonl"],
				text: `live conversation ${secret}`,
			});
			const before = await fileState(source);
			const run = await runPublicationFixture(tempDir, workspace, "live", { sessionPath: source, secret });
			expect(run.exitCode, run.stderr).toBe(0);
			const report = JSON.parse(run.stdout) as {
				result: { url: string; method: string };
				unchanged: boolean;
			};
			expect(report.unchanged).toBe(true);
			expect(await fileState(source)).toBe(before);
			expect(report.result.method).toBe("server");

			const opened = await decryptUpload(report.result.url, sink);
			expect(opened.header?.cwd).toBe(path.join(tempDir.path(), "session-home"));
			expect(Object.hasOwn(opened.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(opened.header ?? {}, "previousSessionFiles")).toBe(false);
			expect(JSON.stringify(opened)).toContain("live conversation");
			expect(JSON.stringify(opened)).not.toContain(secret);
		} finally {
			sink.server.stop(true);
		}
	}, 30_000);
});

async function makeKey(): Promise<CryptoKey> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Mirror of share-loader.js: AES-GCM open + gunzip + parse. */
async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<SessionData> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, IV_LENGTH) },
		key,
		sealed.subarray(IV_LENGTH),
	);
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))));
}

function messageEntry(id: string, parentId: string | null, text: string, imageBlobRef?: string): SessionEntry {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	if (imageBlobRef) content.push({ type: "image", data: imageBlobRef, mimeType: "image/png" });
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "user", content },
	} as unknown as SessionEntry;
}

function sessionData(entries: SessionEntry[], leafId: string): SessionData {
	return {
		header: { type: "session", version: 3, id: "t", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp" },
		entries,
		leafId,
	};
}

/** Incompressible filler so gzip cannot absorb the payload. */
function randomHex(words: number): string {
	return Array.from(crypto.getRandomValues(new Uint32Array(words)), v => v.toString(16)).join("");
}

describe("sealToFit", () => {
	test("round-trips losslessly when under budget", async () => {
		const key = await makeKey();
		const data = sessionData([messageEntry("e1", null, "hello"), messageEntry("e2", "e1", "world")], "e2");

		const { sealed, truncated } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(false);
		expect(await open(key, sealed)).toEqual(data);
	});

	test("trims oversized text into budget without dropping entries", async () => {
		const key = await makeKey();
		const data = sessionData(
			[messageEntry("e1", null, "keep me"), messageEntry("e2", "e1", randomHex(10_000))],
			"e2",
		);

		const { sealed, truncated } = await sealToFit(key, data, TEST_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		expect(sealed.byteLength).toBeLessThanOrEqual(TEST_MAX_SEALED_BYTES);
		const opened = await open(key, sealed);
		expect(opened.entries).toHaveLength(2);
		expect(opened.leafId).toBe("e2");
		expect(JSON.stringify(opened)).toContain("keep me");
		expect(JSON.stringify(opened)).toContain("…[truncated for share]");
	});

	test("replaces large inline images with placeholders before trimming text", async () => {
		const key = await makeKey();
		const imageEntry = {
			type: "message",
			id: "img",
			parentId: null,
			timestamp: "2026-06-12T00:00:00.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "see screenshot" },
					{ type: "image", data: randomHex(2_000), mimeType: "image/png" },
				],
			},
		} as unknown as SessionEntry;
		const data = sessionData([imageEntry], "img");

		const { sealed, truncated } = await sealToFit(key, data, TEST_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		const flat = JSON.stringify(await open(key, sealed));
		expect(flat).toContain("[image omitted from share]");
		expect(flat).toContain("see screenshot");
	});
});

describe("buildShareSnapshot", () => {
	test("redacts secrets through the obfuscator and leaves the original untouched", () => {
		const entries = [messageEntry("e1", null, "the token is hunter2-XYZZY, keep safe")];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "e1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "hunter2-XYZZY" }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });

		expect(JSON.stringify(snapshot)).not.toContain("hunter2-XYZZY");
		expect(JSON.stringify(snapshot)).toContain("the token is");
		// Source entries must keep the real value; redaction is share-only.
		expect(JSON.stringify(entries)).toContain("hunter2-XYZZY");

		const plain = buildShareSnapshot(sm, {});
		expect(JSON.stringify(plain)).toContain("hunter2-XYZZY");
	});

	test("drops revival-only work-pool yield items from a subagent's session_init", () => {
		const secret = "poolleak-QWERTY";
		const entries: SessionEntry[] = [
			{
				type: "session_init",
				id: "si",
				parentId: null,
				timestamp: "2026-10-04T00:00:00.000Z",
				systemPrompt: ["base"],
				task: "work",
				tools: ["yield"],
				workPoolYieldItems: [{ id: `pool-${secret}`, index: 0 }],
			},
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "si",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });

		expect(JSON.stringify(snapshot)).not.toContain(secret);
		expect(JSON.stringify(entries)).toContain(secret);
	});

	test("redacts header cwd, bookmark labels, and file-mention paths", () => {
		const secret = "shareleak-ABCDE";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "label",
				id: "l1",
				parentId: null,
				timestamp: ts,
				targetId: "e1",
				label: `bookmark ${secret}`,
			} as SessionEntry,
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "fileMention",
					files: [{ path: `/home/${secret}/.env`, content: `KEY=${secret}` }],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const header = {
			type: "session",
			version: 3,
			id: "t",
			timestamp: ts,
			cwd: `/home/${secret}/proj`,
			previousSessionFiles: [`/home/${secret}/old/session.jsonl`],
		};
		const sm = {
			getHeader: () => header,
			getEntries: () => entries,
			getLeafId: () => "e1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });
		const flat = JSON.stringify(snapshot);

		// cwd, label, file path, and file content are all redacted...
		expect(flat).not.toContain(secret);
		// ...while surrounding structure (the path shape) survives.
		expect(flat).toContain("/.env");
		// Source entries keep the real values; redaction is share-only.
		expect(JSON.stringify(entries)).toContain(secret);
		expect(JSON.stringify(header)).toContain(secret);
	});

	test("redacts assistant tool calls / error messages and bash meta, and drops provider replay payloads", () => {
		const secret = "asst-secret-ABCDE";
		const replaySentinel = "REPLAY_BLOB_SENTINEL_XYZ";
		const serverToolSentinel = "SERVER_TOOL_ENCRYPTED_SENTINEL_QWE";
		const ts = "2026-06-12T00:00:00.000Z";
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `answer ${secret}` },
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { path: `/x/${secret}` },
							intent: `intent ${secret}`,
							rawBlock: `raw ${secret}`,
						},
						{
							type: "anthropicServerTool",
							block: {
								type: "server_tool_use",
								id: "srvtoolu_1",
								name: "web_search",
								input: { query: `find ${secret}` },
							},
						},
						{
							type: "anthropicServerTool",
							block: {
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [{ type: "web_search_result", encrypted_content: serverToolSentinel }],
							},
						},
					],
					api: "test",
					provider: "test",
					model: "test",
					usage,
					stopReason: "toolUse",
					errorMessage: `boom ${secret}`,
					providerPayload: { type: "openaiResponsesHistory", items: [{ note: replaySentinel }] },
					timestamp: 1,
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "b1",
				parentId: "a1",
				timestamp: ts,
				message: {
					role: "bashExecution",
					command: `echo ${secret}`,
					output: `out ${secret}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					meta: {
						source: { type: "path", value: `/home/${secret}/log` },
						diagnostics: { summary: `diag ${secret}`, messages: [`msg ${secret}`] },
					},
					timestamp: 2,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "b1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		// Every freeform occurrence (text, tool-call args/intent/rawBlock, errorMessage, bash output + meta) is redacted.
		expect(flat).not.toContain(secret);
		// Opaque provider-replay payload is dropped wholesale — the sentinel is NOT a configured secret,
		// so its absence proves the subtree was removed rather than merely obfuscated.
		expect(flat).not.toContain(replaySentinel);
		// Native Anthropic server-tool blocks are opaque provider-replay state: dropped wholesale,
		// so neither the obfuscated query secret nor the encrypted result sentinel can leak.
		expect(flat).not.toContain(serverToolSentinel);
		// Source entries keep the real values; redaction is share-only.
		expect(JSON.stringify(entries)).toContain(secret);
	});

	test("redacts every title-change field before sharing", () => {
		const secret = "share-title-secret";
		const entries: SessionEntry[] = [
			{
				type: "title_change",
				id: "title-1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				title: `new ${secret}`,
				previousTitle: `old ${secret}`,
				source: "user",
				trigger: `rename ${secret}`,
			} as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "title-1",
		} as unknown as SessionManager;
		const snapshot = buildShareSnapshot(sm, {
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});

		expect(JSON.stringify(snapshot)).not.toContain(secret);
		expect(JSON.stringify(entries)).toContain(secret);
	});

	test("includes every title-change field in the regex collision pre-scan", () => {
		const plainTitle = "PLAIN_TITLE_SECRET";
		const plainPreviousTitle = "PLAIN_PREVIOUS_TITLE_SECRET";
		const plainTrigger = "PLAIN_TRIGGER_SECRET";
		const friendlyTitle = "TOKTITLEABC";
		const friendlyPreviousTitle = "TOKPREVABC";
		const friendlyTrigger = "TOKTRIGGERABC";
		const entries: SessionEntry[] = [
			{
				type: "title_change",
				id: "title-1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				title: "tok_title_abc",
				previousTitle: "tok_prev_abc",
				source: "user",
				trigger: "tok_trigger_abc",
			} as SessionEntry,
		];
		const sm = {
			getHeader: () => ({
				...sessionData([], "x").header,
				title: `${plainTitle} ${plainPreviousTitle} ${plainTrigger}`,
			}),
			getEntries: () => entries,
			getLeafId: () => "title-1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainTitle, friendlyName: friendlyTitle },
			{ type: "plain", content: plainPreviousTitle, friendlyName: friendlyPreviousTitle },
			{ type: "plain", content: plainTrigger, friendlyName: friendlyTrigger },
			{ type: "regex", content: "tok_title_[a-z]+" },
			{ type: "regex", content: "tok_prev_[a-z]+" },
			{ type: "regex", content: "tok_trigger_[a-z]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(friendlyTitle);
		expect(flat).not.toContain(friendlyPreviousTitle);
		expect(flat).not.toContain(friendlyTrigger);
	});

	test("collects regex-protected values across the whole snapshot so an earlier field's friendly-name placeholder cannot leak a later field's secret", () => {
		// `buildShareSnapshot` must precompute regex-matched secret values across the ENTIRE
		// snapshot (header + entries) before redacting any single field. Otherwise the header
		// (redacted first) would obfuscate `plainSecret` under its friendly name unaware that
		// `regexSecret` — only present in a LATER bash-output field — sanitizes to the exact
		// same label, and the friendly prefix would leak the regex secret's shape into the share.
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const header = {
			type: "session",
			version: 3,
			id: "t",
			timestamp: ts,
			cwd: "/tmp",
			title: `investigating ${plainSecret}`,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "b1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "bashExecution",
					command: "cat token.txt",
					output: `token is ${regexSecret}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => header,
			getEntries: () => entries,
			getLeafId: () => "b1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		// Neither raw secret leaves the share...
		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		// ...and the header's placeholder for `plainSecret` was NOT minted with the friendly
		// prefix that spells out the later field's regex-protected value's sanitized shape.
		expect(flat).not.toContain(`${friendlyName}_`);

		// Deobfuscating the redacted share recovers both originals (the stripped placeholder
		// still carries its friendly-name-independent alias), and is a fixed point.
		const recovered = obfuscator.deobfuscate(flat);
		expect(recovered).toContain(plainSecret);
		expect(recovered).toContain(regexSecret);
		expect(obfuscator.deobfuscate(recovered)).toBe(recovered);
	});

	test("skips raw image payload bytes when collecting regex-protected values, so image data cannot spuriously trigger friendly-prefix collision avoidance", () => {
		// Regression: the whole-snapshot collision pre-scan only skipped strings
		// already shaped like a `data:image/...` URL, but `ImageContent.data` at
		// rest is raw base64 (that URL form only exists in the rendered viewer).
		// Left unguarded, every image payload gets regex-scanned like any other
		// string on each share — wasteful for large images, and an accidental
		// regex match inside the base64 bytes would poison the whole-snapshot
		// collision set used to decide whether OTHER fields' friendly-name
		// placeholders are safe to render.
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		// A regex secret ("tok_[a-z0-9]+") happens to match literally inside this
		// "image" payload, cleanly bounded so the match is exactly `regexSecret`;
		// a correct scan must never see it.
		const imageData = `binary noise ${regexSecret} more noise`;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "user",
					content: [
						{ type: "text", text: `remember ${plainSecret} for later` },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		// The image payload is left byte-for-byte intact — redaction never
		// touches inline image bytes (size trimming is a separate later pass).
		expect(flat).toContain(imageData);
		// Because the image bytes were skipped by the collision pre-scan, the
		// sibling plain secret's friendly-name placeholder needed no collision
		// avoidance and keeps its normal friendly prefix.
		expect(flat).toContain(`${friendlyName}_`);
	});

	test("ignores dropped provider replay payloads when collecting regex collision values", () => {
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `remember ${plainSecret} for later` }],
					providerPayload: { items: [{ note: regexSecret }] },
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		expect(flat).toContain(`${friendlyName}_`);
	});

	test("collects regex values from tool arguments that resemble image blocks", () => {
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "read", arguments: { type: "image", value: regexSecret } },
					],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => ({ ...sessionData([], "x").header, title: `remember ${plainSecret}` }),
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		expect(flat).not.toContain(`${friendlyName}_`);
	});
});

describe("normalizeShareServerUrl", () => {
	test("strips trailing slashes and falls back to the default", () => {
		expect(normalizeShareServerUrl("https://my.omp.sh/s/")).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("https://example.com/s///")).toBe("https://example.com/s");
		expect(normalizeShareServerUrl(undefined)).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("   ")).toBe("https://my.omp.sh/s");
	});
});

async function writeProjectPolicy(
	projectCwd: string,
	origin: string,
	redactSecrets: boolean,
	secretsEnabled: boolean,
): Promise<void> {
	await writeSettings(path.join(projectCwd, ".omp", "config.yml"), {
		serverUrl: origin,
		redactSecrets,
		secretsEnabled,
	});
}

async function successfulCliShare(workspace: Workspace, sink: LoopbackSink, sessionArg: string): Promise<SessionData> {
	const run = await runCliShare(workspace, sessionArg);
	expect(run.exitCode, run.stderr).toBe(0);
	return decryptUpload(cliShareUrl(run.stdout), sink);
}

describe("share command", () => {
	test("uses the saved H policy for path shares from an unrelated launch project L", async () => {
		using tempDir = TempDir.createSync("@omp-share-path-policy-");
		const sink = captureLoopbackUploads();
		let source: string | undefined;
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			const owner = path.join(tempDir.path(), "saved-home-H");
			await fs.mkdir(owner, { recursive: true });
			const homeSecret = "synthetic-home-secret-H4";
			const launchSecret = "synthetic-launch-secret-L5";
			const artifact = Buffer.from("share-session-blob-fixture");
			const artifactHash = new Bun.SHA256().update(artifact).digest("hex");
			await fs.writeFile(path.join(workspace.blobsDir, artifactHash), artifact);
			await writeProjectPolicy(owner, sink.origin, true, true);
			await writeSecrets(path.join(owner, ".omp", "secrets.yml"), homeSecret);
			await writeProjectPolicy(workspace.launchCwd, "https://launch-policy.invalid/share", false, false);
			await writeSecrets(path.join(workspace.launchCwd, ".omp", "secrets.yml"), launchSecret);

			source = path.join(tempDir.path(), "read-only-custom-bucket", "session.jsonl");
			await writeTranscript(source, {
				id: "path-owned-session",
				cwd: owner,
				executionCwd: workspace.launchCwd,
				previousSessionFiles: [path.join(tempDir.path(), "private-move-history.jsonl")],
				text: `conversation uses H secret ${homeSecret}; L secret ${launchSecret} stays visible`,
				imageBlobRef: `blob:sha256:${artifactHash}`,
			});
			await setSourceReadOnly(source);
			const breadcrumbPath = await writeBreadcrumb(workspace, source);
			const before = await sourceState(workspace, source);
			const breadcrumbBefore = await fileState(breadcrumbPath);
			const markerPath = path.join(workspace.customFilesDir, hashPath(path.resolve(source)));

			const opened = await successfulCliShare(workspace, sink, source);

			const payload = JSON.stringify(opened);
			expect(opened.header?.cwd).toBe(owner);
			expect(Object.hasOwn(opened.header ?? {}, "executionCwd")).toBe(false);
			expect(Object.hasOwn(opened.header ?? {}, "previousSessionFiles")).toBe(false);
			expect(payload).not.toContain(homeSecret);
			expect(payload).toContain(launchSecret);
			expect(payload).toContain("conversation uses H secret");
			expect(payload).toContain(artifact.toString("base64"));
			expect(await sourceState(workspace, source)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(await pathExists(markerPath)).toBe(false);
		} finally {
			if (source && (await pathExists(source))) await restoreSourcePermissions(source);
			sink.server.stop(true);
		}
	}, 30_000);

	test("uses H policy for a global-only ID match without creating L's launch bucket", async () => {
		using tempDir = TempDir.createSync("@omp-share-global-id-");
		const sink = captureLoopbackUploads();
		let source: string | undefined;
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			const owner = path.join(tempDir.path(), "global-session-home-H");
			await fs.mkdir(owner, { recursive: true });
			const homeSecret = "synthetic-global-home-H6";
			const launchSecret = "synthetic-global-launch-L7";
			await writeProjectPolicy(owner, sink.origin, true, true);
			await writeSecrets(path.join(owner, ".omp", "secrets.yml"), homeSecret);
			await writeProjectPolicy(workspace.launchCwd, "https://launch-id-policy.invalid/share", false, false);
			await writeSecrets(path.join(workspace.launchCwd, ".omp", "secrets.yml"), launchSecret);

			const ownerBucket = sessionDirForCwd(owner, workspace.sessionsRoot);
			source = path.join(ownerBucket, `2026-10-09T000000_global-owner-001.jsonl`);
			await writeTranscript(source, {
				id: "global-owner-001",
				cwd: owner,
				executionCwd: workspace.launchCwd,
				text: `global conversation has ${homeSecret}; launch-only ${launchSecret}`,
			});
			const launchBucket = sessionDirForCwd(workspace.launchCwd, workspace.sessionsRoot);
			expect(await pathExists(launchBucket)).toBe(false);
			await setSourceReadOnly(source);
			const breadcrumbPath = await writeBreadcrumb(workspace, source);
			const before = await sourceState(workspace, source);
			const breadcrumbBefore = await fileState(breadcrumbPath);
			const markerPath = path.join(workspace.customFilesDir, hashPath(path.resolve(source)));

			const opened = await successfulCliShare(workspace, sink, "global-owner");

			const payload = JSON.stringify(opened);
			expect(opened.header?.cwd).toBe(owner);
			expect(payload).not.toContain(homeSecret);
			expect(payload).toContain(launchSecret);
			expect(payload).toContain("global conversation has");
			expect(await sourceState(workspace, source)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(await pathExists(markerPath)).toBe(false);
			expect(await pathExists(launchBucket)).toBe(false);
		} finally {
			if (source && (await pathExists(source))) await restoreSourcePermissions(source);
			sink.server.stop(true);
		}
	}, 30_000);

	test("keeps a legacy-named bucket in place during read-only ID lookup", async () => {
		using tempDir = TempDir.createSync("@omp-share-legacy-bucket-");
		const sink = captureLoopbackUploads();
		let source: string | undefined;
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			const owner = path.join(tempDir.path(), "legacy-owner-H");
			await fs.mkdir(owner, { recursive: true });
			await writeProjectPolicy(owner, sink.origin, false, false);
			const legacyName = `--${workspace.launchCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const legacyBucket = path.join(workspace.sessionsRoot, legacyName);
			const canonicalBucket = sessionDirForCwd(workspace.launchCwd, workspace.sessionsRoot);
			source = path.join(legacyBucket, "2026-10-09T000000_legacy-owner-001.jsonl");
			await writeTranscript(source, {
				id: "legacy-owner-001",
				cwd: owner,
				text: "conversation stays in the legacy bucket",
			});
			expect(await pathExists(canonicalBucket)).toBe(false);
			await setSourceReadOnly(source);
			const breadcrumbPath = await writeBreadcrumb(workspace, source);
			const before = await sourceState(workspace, source);
			const breadcrumbBefore = await fileState(breadcrumbPath);

			const opened = await successfulCliShare(workspace, sink, "legacy-owner");

			expect(JSON.stringify(opened)).toContain("conversation stays in the legacy bucket");
			expect(await sourceState(workspace, source)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(await pathExists(legacyBucket)).toBe(true);
			expect(await pathExists(source)).toBe(true);
			expect(await pathExists(canonicalBucket)).toBe(false);
		} finally {
			if (source && (await pathExists(source))) await restoreSourcePermissions(source);
			sink.server.stop(true);
		}
	}, 30_000);

	test("leaves the session layout absent after an unmatched ID lookup", async () => {
		using tempDir = TempDir.createSync("@omp-share-no-match-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			const launchBucket = sessionDirForCwd(workspace.launchCwd, workspace.sessionsRoot);
			const breadcrumbPath = await writeBreadcrumb(workspace, path.join(workspace.launchCwd, "not-created.jsonl"));
			const sessionsBefore = await snapshotTree(workspace.sessionsRoot);
			const blobsBefore = await snapshotTree(workspace.blobsDir);
			const breadcrumbBefore = await fileState(breadcrumbPath);
			const terminalSessionsBefore = await snapshotTree(workspace.terminalSessionsDir);

			const run = await runCliShare(workspace, "no-such-publication-session");

			expect(run.exitCode).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe('Session "no-such-publication-session" not found.\n');
			expect(sink.requestCount).toBe(0);
			expect(sink.uploads).toHaveLength(0);
			expect(await snapshotTree(workspace.sessionsRoot)).toBe(sessionsBefore);
			expect(await snapshotTree(workspace.blobsDir)).toBe(blobsBefore);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(await snapshotTree(workspace.terminalSessionsDir)).toBe(terminalSessionsBefore);
			expect(await pathExists(workspace.sessionsRoot)).toBe(false);
			expect(await pathExists(launchBucket)).toBe(false);
		} finally {
			sink.server.stop(true);
		}
	}, 30_000);

	test("preserves missing-path behavior under the child-only network fence", async () => {
		using tempDir = TempDir.createSync("@omp-share-missing-");
		const sink = captureLoopbackUploads();
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			const sessionArg = "./ghost.jsonl";
			const missingSession = path.join(workspace.launchCwd, "ghost.jsonl");
			const breadcrumbPath = await writeBreadcrumb(workspace, missingSession);
			const before = await sourceState(workspace, missingSession);
			const breadcrumbBefore = await fileState(breadcrumbPath);

			const run = await runCliShare(workspace, sessionArg);

			expect(run.exitCode).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe(`Session "${sessionArg}" not found.\n`);
			expect(await pathExists(missingSession)).toBe(false);
			expect(await sourceState(workspace, missingSession)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(sink.requestCount).toBe(0);
			expect(sink.uploads).toHaveLength(0);
		} finally {
			sink.server.stop(true);
		}
	}, 30_000);

	test("keeps a missing recorded H as policy scope instead of substituting launch L", async () => {
		using tempDir = TempDir.createSync("@omp-share-missing-home-");
		const sink = captureLoopbackUploads();
		let source: string | undefined;
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin, { redactSecrets: true, secretsEnabled: true });
			const missingHome = path.join(tempDir.path(), "recorded-but-missing-H");
			const globalSecret = "synthetic-global-secret-M8";
			const launchSecret = "synthetic-launch-secret-M9";
			await writeSecrets(path.join(workspace.agentDir, "secrets.yml"), globalSecret);
			await writeProjectPolicy(workspace.launchCwd, "https://launch-missing-home.invalid/share", false, true);
			await writeSecrets(path.join(workspace.launchCwd, ".omp", "secrets.yml"), launchSecret);
			source = path.join(tempDir.path(), "missing-home-source", "session.jsonl");
			await writeTranscript(source, {
				id: "missing-recorded-home",
				cwd: missingHome,
				executionCwd: workspace.launchCwd,
				text: `global policy sees ${globalSecret}; launch policy must not redact ${launchSecret}`,
			});
			expect(await pathExists(missingHome)).toBe(false);
			await setSourceReadOnly(source);
			const breadcrumbPath = await writeBreadcrumb(workspace, source);
			const before = await sourceState(workspace, source);
			const breadcrumbBefore = await fileState(breadcrumbPath);

			const opened = await successfulCliShare(workspace, sink, source);

			const payload = JSON.stringify(opened);
			expect(opened.header?.cwd).toBe(missingHome);
			expect(payload).not.toContain(globalSecret);
			expect(payload).toContain(launchSecret);
			expect(payload).toContain("global policy sees");
			expect(await pathExists(missingHome)).toBe(false);
			expect(await sourceState(workspace, source)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
		} finally {
			if (source && (await pathExists(source))) await restoreSourcePermissions(source);
			sink.server.stop(true);
		}
	}, 30_000);

	for (const cwdCase of ["absent", "null"] as const) {
		test(`falls back to launch L redaction when legacy cwd is ${cwdCase}`, async () => {
			using tempDir = TempDir.createSync(`@omp-share-${cwdCase}-cwd-`);
			const sink = captureLoopbackUploads();
			let source: string | undefined;
			try {
				const workspace = await createWorkspace(tempDir, sink.origin);
				await configureGlobalSettings(workspace, sink.origin);
				const launchSecret = `synthetic-${cwdCase}-fallback-secret-P2`;
				await writeProjectPolicy(workspace.launchCwd, sink.origin, true, true);
				await writeSecrets(path.join(workspace.launchCwd, ".omp", "secrets.yml"), launchSecret);
				source = path.join(tempDir.path(), `${cwdCase}-cwd-source`, "session.jsonl");
				const transcript = {
					id: `${cwdCase}-legacy-cwd-session`,
					executionCwd: path.join(tempDir.path(), "ignored-execution-binding"),
					text: `launch fallback redacts ${launchSecret}`,
				};
				if (cwdCase === "null") {
					await writeTranscript(source, { ...transcript, cwd: null });
				} else {
					await writeTranscript(source, transcript);
				}
				await setSourceReadOnly(source);
				const breadcrumbPath = await writeBreadcrumb(workspace, source);
				const before = await sourceState(workspace, source);
				const breadcrumbBefore = await fileState(breadcrumbPath);

				const opened = await successfulCliShare(workspace, sink, source);

				const payload = JSON.stringify(opened);
				expect(payload).not.toContain(launchSecret);
				expect(payload).toContain("launch fallback redacts");
				if (cwdCase === "null") {
					expect(Object.hasOwn(opened.header ?? {}, "cwd")).toBe(true);
					expect(opened.header?.cwd).toBeNull();
				} else {
					expect(Object.hasOwn(opened.header ?? {}, "cwd")).toBe(false);
				}
				expect(await sourceState(workspace, source)).toBe(before);
				expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			} finally {
				if (source && (await pathExists(source))) await restoreSourcePermissions(source);
				sink.server.stop(true);
			}
		}, 30_000);
	}

	test("surfaces upload failure without changing source, artifacts, or continuation state", async () => {
		using tempDir = TempDir.createSync("@omp-share-upload-error-");
		const sink = captureLoopbackUploads({ status: 500 });
		let source: string | undefined;
		try {
			const workspace = await createWorkspace(tempDir, sink.origin);
			await configureGlobalSettings(workspace, sink.origin);
			await writeProjectPolicy(workspace.launchCwd, sink.origin, false, false);
			source = path.join(tempDir.path(), "error-source", "session.jsonl");
			await writeTranscript(source, {
				id: "upload-error-session",
				cwd: workspace.launchCwd,
				text: "upload error conversation",
			});
			await setSourceReadOnly(source);
			const breadcrumbPath = await writeBreadcrumb(workspace, source);
			const before = await sourceState(workspace, source);
			const breadcrumbBefore = await fileState(breadcrumbPath);
			const markerPath = path.join(workspace.customFilesDir, hashPath(path.resolve(source)));

			const run = await runCliShare(workspace, source);

			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain("HTTP 500");
			expect(run.stderr).toContain(sink.origin);
			expect(sink.requestCount).toBe(1);
			expect(sink.uploads).toHaveLength(1);
			expect(await sourceState(workspace, source)).toBe(before);
			expect(await fileState(breadcrumbPath)).toBe(breadcrumbBefore);
			expect(await pathExists(markerPath)).toBe(false);
		} finally {
			if (source && (await pathExists(source))) await restoreSourcePermissions(source);
			sink.server.stop(true);
		}
	}, 30_000);
});
