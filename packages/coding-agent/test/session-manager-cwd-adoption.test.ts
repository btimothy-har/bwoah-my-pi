import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { makeAssistantMessage } from "./session-manager/helpers";
import { readTerminalBreadcrumbEntry } from "@oh-my-pi/pi-coding-agent/session/session-paths";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalTmuxPane = process.env.TMUX_PANE;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

beforeEach(() => {
	setAgentDir(path.join(makeTempDir("@pi-cwd-agent-dir-"), "agent"));
	process.env.TMUX_PANE = "%cwd-adoption-test";
});

afterEach(async () => {
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("PI_PROFILE", originalPiProfile);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("TMUX_PANE", originalTmuxPane);
	__resetDirsFromEnvForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * Persist a materialized conversation under `cwd`/`sessionDir` and return its file path.
 * The on-disk header records `cwd`, which is what resume adoption keys off of.
 */
async function writeSession(cwd: string, sessionDir: string): Promise<string> {
	const manager = SessionManager.create(cwd, sessionDir);
	try {
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		return file;
	} finally {
		await manager.close();
	}
}

async function rewriteHeaderCwd(file: string, cwd: string): Promise<string> {
	const original = await Bun.file(file).text();
	const lines = original.split("\n");
	const headerIndex = lines.findIndex(line => {
		try {
			const parsed: unknown = JSON.parse(line);
			return (
				parsed !== null &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				"type" in parsed &&
				parsed.type === "session"
			);
		} catch {
			return false;
		}
	});
	if (headerIndex < 0) throw new Error("expected a session header");
	const parsed: unknown = JSON.parse(lines[headerIndex]!);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected an object session header");
	}
	const header = parsed as Record<string, unknown>;
	header.cwd = cwd;
	lines[headerIndex] = JSON.stringify(header);
	const rewritten = lines.join("\n");
	await Bun.write(file, rewritten);
	return rewritten;
}

async function readHeader(file: string) {
	const header = (await loadEntriesFromFile(file)).find(entry => entry.type === "session");
	if (!header) throw new Error("expected a session header");
	return header;
}

async function createFallbackSession(label: string): Promise<{
	home: string;
	runtime: string;
	bucket: string;
	persistedRoot: string;
	file: string;
	branchPoint: string;
	manager: SessionManager;
}> {
	const home = makeTempDir(`@pi-cwd-${label}-home-`);
	const runtime = makeTempDir(`@pi-cwd-${label}-runtime-`);
	const bucket = makeTempDir(`@pi-cwd-${label}-bucket-`);
	const persistedRoot = path.join(home, "persisted-extra");
	const source = SessionManager.create(home, bucket);
	await source.addWorkspaceDirectory(persistedRoot);
	source.appendMessage({ role: "user", content: `${label} source`, timestamp: Date.now() });
	const branchPoint = source.appendMessage(makeAssistantMessage());
	await source.flush();
	const file = source.getSessionFile();
	if (!file) throw new Error("expected a materialized source session");
	await source.close();
	await removeWithRetries(home);
	const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: runtime });
	return { home, runtime, bucket, persistedRoot, file, branchPoint, manager };
}

describe("SessionManager cwd adoption on resume", () => {
	it("adopts an enterable session's home and persistence bucket", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);
		const manager = SessionManager.create(projectA, path.join(projectA, "sessions"));

		try {
			expect(manager.getCwd()).toBe(path.resolve(projectA));
			await manager.setSessionFile(fileB);
			expect(manager.getCwd()).toBe(path.resolve(projectB));
			expect(manager.getSessionHome()).toBe(path.resolve(projectB));
			expect(manager.getSessionDir()).toBe(path.resolve(sessionsB));
			expect(manager.getHeader()?.cwd).toBe(path.resolve(projectB));
		} finally {
			await manager.close();
		}
	});

	it("keeps legacy header bytes unchanged and uses the loading cwd as effective home", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);
		const legacyBytes = await rewriteHeaderCwd(fileB, "");
		const launchDir = path.join(projectA, "sessions");
		const manager = SessionManager.create(projectA, launchDir);

		try {
			await manager.setSessionFile(fileB);
			expect(manager.getCwd()).toBe(path.resolve(projectA));
			expect(manager.getSessionHome()).toBe(path.resolve(projectA));
			expect(manager.getRecordedCwd()).toBe("");
			expect(manager.getSessionDir()).toBe(path.resolve(sessionsB));
		} finally {
			await manager.close();
		}
		expect(await Bun.file(fileB).text()).toBe(legacyBytes);
	});

	it("restores cwd and bucket ownership when a session switch is rolled back", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsA = path.join(projectA, "sessions");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);
		const manager = SessionManager.create(projectA, sessionsA);

		try {
			const snapshot = manager.captureState();
			await manager.setSessionFile(fileB);
			expect(manager.getCwd()).toBe(path.resolve(projectB));

			manager.restoreState(snapshot);
			expect(manager.getCwd()).toBe(path.resolve(projectA));
			expect(manager.getSessionHome()).toBe(path.resolve(projectA));
			expect(manager.getSessionDir()).toBe(path.resolve(sessionsA));
		} finally {
			await manager.close();
		}
	});

	it("clears fallback persistence after adopting an accessible session", async () => {
		const launch = makeTempDir("@pi-cwd-fallback-launch-");
		const deniedProject = makeTempDir("@pi-cwd-fallback-denied-");
		const store = makeTempDir("@pi-cwd-fallback-store-");
		const launchSessions = path.join(launch, "sessions");
		const deniedFile = await writeSession(deniedProject, store);
		const accessibleFile = await writeSession(launch, launchSessions);
		await removeWithRetries(deniedProject);

		const manager = await SessionManager.open(deniedFile, undefined, undefined, { initialCwd: launch });
		await manager.setSessionFile(accessibleFile);
		await manager.addWorkspaceDirectory(path.join(launch, "extra"));
		await manager.flush();
		await manager.close();

		const reopened = await SessionManager.open(accessibleFile);
		try {
			expect(reopened.getAdditionalDirectories()).toContain(path.join(launch, "extra"));
		} finally {
			await reopened.close();
		}
	});

	it("keeps the recorded home and source bucket when the project directory is gone", async () => {
		const launch = makeTempDir("@pi-cwd-launch-");
		const store = makeTempDir("@pi-cwd-store-");
		const goneProject = makeTempDir("@pi-cwd-gone-");
		const file = await writeSession(goneProject, store);
		await removeWithRetries(goneProject);

		const manager = SessionManager.create(launch, path.join(launch, "sessions"));
		try {
			await manager.setSessionFile(file);
			expect(manager.getCwd()).toBe(path.resolve(launch));
			expect(manager.getSessionHome()).toBe(path.resolve(goneProject));
			expect(manager.getSessionDir()).toBe(path.resolve(store));
		} finally {
			await manager.close();
		}
	});

	it("loads a missing-home transcript once without moving it to the launch bucket", async () => {
		const launch = makeTempDir("@pi-cwd-launch-");
		const store = makeTempDir("@pi-cwd-store-");
		const goneProject = makeTempDir("@pi-cwd-gone-");
		const file = await writeSession(goneProject, store);
		await removeWithRetries(goneProject);
		class CountingFileSessionStorage extends FileSessionStorage {
			fullReads = 0;

			override readText(filePath: string): Promise<string> {
				this.fullReads++;
				return super.readText(filePath);
			}
		}
		const storage = new CountingFileSessionStorage();
		const manager = await SessionManager.open(file, undefined, storage, { initialCwd: launch });

		try {
			expect(manager.getCwd()).toBe(path.resolve(launch));
			expect(manager.getSessionHome()).toBe(path.resolve(goneProject));
			expect(manager.getSessionDir()).toBe(path.resolve(store));
			expect(manager.getSessionDir()).not.toBe(SessionManager.getDefaultSessionDir(launch));
			expect(storage.fullReads).toBe(1);
		} finally {
			await manager.close();
		}
	});

	it("appends and resolves artifacts under the original file while preserving H, runtime F, and custom bucket C", async () => {
		const home = makeTempDir("@pi-cwd-artifact-home-");
		const runtime = makeTempDir("@pi-cwd-artifact-runtime-");
		const bucket = makeTempDir("@pi-cwd-artifact-bucket-");
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const file = source.getSessionFile();
		const id = source.getSessionId();
		const oldArtifactId = await source.saveArtifact("home-owned artifact", "bash");
		if (!file || !oldArtifactId) throw new Error("expected a durable source and artifact");
		const oldArtifactPath = await source.getArtifactPath(oldArtifactId);
		if (!oldArtifactPath) throw new Error("expected the artifact to resolve");
		await source.close();
		await removeWithRetries(home);

		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: runtime });
		try {
			expect(manager.getSessionFile()).toBe(file);
			expect(manager.getSessionId()).toBe(id);
			expect(manager.getCwd()).toBe(path.resolve(runtime));
			expect(manager.getSessionHome()).toBe(path.resolve(home));
			expect(manager.getSessionDir()).toBe(path.resolve(bucket));
			expect(manager.getHeader()?.cwd).toBe(path.resolve(home));

			manager.appendMessage({ role: "user", content: "append while H is unavailable", timestamp: Date.now() });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			expect(await Bun.file(oldArtifactPath).text()).toBe("home-owned artifact");
			const newArtifactId = await manager.saveArtifact("second artifact", "bash");
			if (!newArtifactId) throw new Error("expected a second durable artifact");
			const newArtifactPath = await manager.getArtifactPath(newArtifactId);
			expect(newArtifactPath).not.toBeNull();
			expect(path.resolve(newArtifactPath!)).toBe(
				path.join(path.resolve(file.slice(0, -6)), `${newArtifactId}.bash.log`),
			);
			expect(await Bun.file(newArtifactPath!).text()).toBe("second artifact");
			expect(await readHeader(file)).toMatchObject({ id, cwd: path.resolve(home) });
			expect(await Bun.file(file).text()).toContain("append while H is unavailable");
			expect(manager.getSessionFile()).toBe(file);
			expect(manager.getSessionId()).toBe(id);
			expect(fs.existsSync(home)).toBe(false);
		} finally {
			await manager.close();
		}

		const listed = await SessionManager.listForPicker(runtime, bucket);
		expect(listed.some(session => session.id === id && path.resolve(session.path) === path.resolve(file))).toBe(true);
		const resumable = await resolveResumableSession(id, runtime, bucket);
		expect(resumable?.scope).toBe("local");
		expect(path.resolve(resumable?.session.path ?? "")).toBe(path.resolve(file));
	});

	it("keeps a default H-derived bucket when resuming from a different runtime cwd", async () => {
		const home = makeTempDir("@pi-cwd-default-home-");
		const runtime = makeTempDir("@pi-cwd-default-runtime-");
		const defaultBucket = SessionManager.getDefaultSessionDir(home);
		const source = SessionManager.create(home);
		source.appendMessage({ role: "user", content: "default bucket owner", timestamp: Date.now() });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const file = source.getSessionFile();
		if (!file) throw new Error("expected a materialized source session");
		expect(path.dirname(path.resolve(file))).toBe(path.resolve(defaultBucket));
		await source.close();
		await removeWithRetries(home);

		const resumed = await SessionManager.open(file, undefined, undefined, { initialCwd: runtime });
		try {
			expect(resumed.getCwd()).toBe(path.resolve(runtime));
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(resumed.getSessionDir()).toBe(path.resolve(defaultBucket));
			expect(resumed.getSessionDir()).not.toBe(SessionManager.getDefaultSessionDir(runtime));
			expect(fs.existsSync(home)).toBe(false);
		} finally {
			await resumed.close();
		}
	});

	it("switches buckets with same-home files and preserves an explicit open bucket through reload, adoption, and new", async () => {
		const home = makeTempDir("@pi-cwd-switch-home-");
		const runtime = makeTempDir("@pi-cwd-switch-runtime-");
		const bucketA = makeTempDir("@pi-cwd-switch-a-");
		const bucketB = makeTempDir("@pi-cwd-switch-b-");
		const explicitBucket = makeTempDir("@pi-cwd-switch-explicit-");
		const fileA = await writeSession(home, bucketA);
		const fileB = await writeSession(home, bucketB);
		const manager = SessionManager.create(runtime, bucketA);

		try {
			await manager.setSessionFile(fileA);
			expect(manager.getSessionHome()).toBe(path.resolve(home));
			expect(manager.getSessionDir()).toBe(path.resolve(bucketA));
			await manager.setSessionFile(fileB);
			expect(manager.getSessionHome()).toBe(path.resolve(home));
			expect(manager.getSessionDir()).toBe(path.resolve(bucketB));
			const newFileInB = await manager.newSession();
			expect(path.dirname(newFileInB ?? "")).toBe(path.resolve(bucketB));
			expect(manager.getHeader()?.cwd).toBe(path.resolve(home));
		} finally {
			await manager.close();
		}

		const explicit = await SessionManager.open(fileB, explicitBucket, undefined, { initialCwd: runtime });
		try {
			const originalId = explicit.getSessionId();
			expect(explicit.getSessionDir()).toBe(path.resolve(explicitBucket));
			await explicit.setSessionFile(fileB);
			expect(explicit.getSessionId()).toBe(originalId);
			expect(explicit.getSessionDir()).toBe(path.resolve(explicitBucket));
			explicit.adoptRecordedCwd();
			expect(explicit.getCwd()).toBe(path.resolve(home));
			expect(explicit.getSessionHome()).toBe(path.resolve(home));
			expect(explicit.getSessionDir()).toBe(path.resolve(explicitBucket));
			const freshFile = await explicit.newSession();
			expect(path.dirname(freshFile ?? "")).toBe(path.resolve(explicitBucket));
			expect(explicit.getHeader()?.cwd).toBe(path.resolve(home));
			expect(explicit.getSessionDir()).toBe(path.resolve(explicitBucket));
		} finally {
			await explicit.close();
		}
	});

	it("keeps H-owned roots persisted and runtime-only roots live across fallback fork and branch", async () => {
		const forkState = await createFallbackSession("fork");
		const forkRuntimeRoot = path.join(forkState.runtime, "runtime-only");
		try {
			await forkState.manager.addWorkspaceDirectory(forkRuntimeRoot);
			const sourceId = forkState.manager.getSessionId();
			const forked = await forkState.manager.fork();
			if (!forked) throw new Error("expected a persisted fork");
			const header = await readHeader(forked.newSessionFile);
			expect(forkState.manager.getCwd()).toBe(path.resolve(forkState.runtime));
			expect(forkState.manager.getSessionHome()).toBe(path.resolve(forkState.home));
			expect(forkState.manager.getSessionDir()).toBe(path.resolve(forkState.bucket));
			expect(path.dirname(forked.newSessionFile)).toBe(path.resolve(forkState.bucket));
			expect(forkState.manager.getSessionId()).not.toBe(sourceId);
			expect(header).toMatchObject({
				cwd: path.resolve(forkState.home),
				additionalDirectories: [forkState.persistedRoot],
			});
			expect(forkState.manager.getAdditionalDirectories()).toEqual([forkState.persistedRoot, forkRuntimeRoot]);
			expect(fs.existsSync(forkState.home)).toBe(false);
			expect((await loadEntriesFromFile(forkState.file)).some(entry => entry.type === "message")).toBe(true);
		} finally {
			await forkState.manager.close();
		}

		const branchState = await createFallbackSession("branch");
		const branchRuntimeRoot = path.join(branchState.runtime, "runtime-only");
		try {
			await branchState.manager.addWorkspaceDirectory(branchRuntimeRoot);
			const sourceId = branchState.manager.getSessionId();
			const branchFile = branchState.manager.createBranchedSession(branchState.branchPoint);
			if (!branchFile) throw new Error("expected a persisted branch");
			const header = await readHeader(branchFile);
			expect(header.id).not.toBe(sourceId);
			expect(branchState.manager.getCwd()).toBe(path.resolve(branchState.runtime));
			expect(branchState.manager.getSessionHome()).toBe(path.resolve(branchState.home));
			expect(branchState.manager.getSessionDir()).toBe(path.resolve(branchState.bucket));
			expect(path.dirname(branchFile)).toBe(path.resolve(branchState.bucket));
			expect(header).toMatchObject({
				cwd: path.resolve(branchState.home),
				additionalDirectories: [branchState.persistedRoot],
			});
			expect(branchState.manager.getAdditionalDirectories()).toEqual([branchState.persistedRoot, branchRuntimeRoot]);
			expect(fs.existsSync(branchState.home)).toBe(false);
			expect((await loadEntriesFromFile(branchState.file)).some(entry => entry.type === "message")).toBe(true);
		} finally {
			await branchState.manager.close();
		}
	});

	it("keeps /new on H and C while configured runtime roots stay live only", async () => {
		const state = await createFallbackSession("new");
		const configuredRoot = path.join(state.runtime, "configured-extra");
		const previousFile = state.manager.getSessionFile();
		const previousId = state.manager.getSessionId();
		try {
			const newFile = await state.manager.newSession({ additionalDirectories: [configuredRoot] });
			expect(path.dirname(newFile ?? "")).toBe(path.resolve(state.bucket));
			expect(state.manager.getSessionFile()).toBe(newFile);
			expect(state.manager.getSessionId()).not.toBe(previousId);
			expect(state.manager.getCwd()).toBe(path.resolve(state.runtime));
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.home));
			expect(state.manager.getSessionDir()).toBe(path.resolve(state.bucket));
			expect(state.manager.getHeader()?.cwd).toBe(path.resolve(state.home));
			expect(state.manager.getHeader()?.additionalDirectories).toBeUndefined();
			expect(state.manager.getAdditionalDirectories()).toEqual([configuredRoot]);
			expect(fs.existsSync(state.home)).toBe(false);
			expect((await loadEntriesFromFile(state.file)).some(entry => entry.type === "message")).toBe(true);
			expect(previousFile).toBe(state.file);
		} finally {
			await state.manager.close();
		}
	});

	it("copies an H/runtime-divergent in-memory session to explicit and H-derived destinations without changing its source", async () => {
		const home = makeTempDir("@pi-cwd-copy-home-");
		const runtime = makeTempDir("@pi-cwd-copy-runtime-");
		const explicitBucket = makeTempDir("@pi-cwd-copy-explicit-");
		const source = SessionManager.inMemory(home);
		source.setCwdWithoutRelocation(runtime);
		source.appendMessage({ role: "user", content: "in-memory source", timestamp: Date.now() });
		source.appendMessage(makeAssistantMessage());
		const sourceEntries = structuredClone(source.getEntries());
		const sourceId = source.getSessionId();

		const explicit = await source.persistCopy({ sessionDir: explicitBucket, suppressBreadcrumb: true });
		const defaultCopy = await source.persistCopy({ suppressBreadcrumb: true });
		try {
			expect(explicit.getSessionDir()).toBe(path.resolve(explicitBucket));
			expect(explicit.getCwd()).toBe(path.resolve(runtime));
			expect(explicit.getSessionHome()).toBe(path.resolve(home));
			expect(explicit.getHeader()?.cwd).toBe(path.resolve(home));
			expect(path.dirname(explicit.getSessionFile() ?? "")).toBe(path.resolve(explicitBucket));
			expect(defaultCopy.getSessionDir()).toBe(path.resolve(SessionManager.getDefaultSessionDir(home)));
			expect(defaultCopy.getSessionDir()).not.toBe(SessionManager.getDefaultSessionDir(runtime));
			expect(defaultCopy.getCwd()).toBe(path.resolve(runtime));
			expect(defaultCopy.getSessionHome()).toBe(path.resolve(home));
			expect(path.dirname(defaultCopy.getSessionFile() ?? "")).toBe(
				path.resolve(SessionManager.getDefaultSessionDir(home)),
			);
			expect(source.getSessionFile()).toBeUndefined();
			expect(source.getSessionId()).toBe(sourceId);
			expect(source.getEntries()).toEqual(sourceEntries);
		} finally {
			await explicit.close();
			await defaultCopy.close();
			await source.close();
		}

		const persistentState = await createFallbackSession("copy-bytes");
		const destination = makeTempDir("@pi-cwd-copy-bytes-destination-");
		const originalBytes = await Bun.file(persistentState.file).bytes();
		const copy = await persistentState.manager.persistCopy({ sessionDir: destination, suppressBreadcrumb: true });
		try {
			expect(path.dirname(copy.getSessionFile() ?? "")).toBe(path.resolve(destination));
			expect(copy.getHeader()?.cwd).toBe(path.resolve(persistentState.home));
			expect(await Bun.file(persistentState.file).bytes()).toEqual(originalBytes);
		} finally {
			await copy.close();
			await persistentState.manager.close();
		}
	});

	it("keeps static cross-project forkFrom owned by its caller destination", async () => {
		const sourceHome = makeTempDir("@pi-cwd-forkfrom-source-");
		const sourceBucket = makeTempDir("@pi-cwd-forkfrom-source-bucket-");
		const destinationHome = makeTempDir("@pi-cwd-forkfrom-destination-");
		const destinationBucket = makeTempDir("@pi-cwd-forkfrom-destination-bucket-");
		const sourceFile = await writeSession(sourceHome, sourceBucket);
		const forked = await SessionManager.forkFrom(sourceFile, destinationHome, destinationBucket, undefined, {
			suppressBreadcrumb: true,
		});

		try {
			expect(forked.getCwd()).toBe(path.resolve(destinationHome));
			expect(forked.getSessionHome()).toBe(path.resolve(destinationHome));
			expect(forked.getSessionDir()).toBe(path.resolve(destinationBucket));
			expect(path.dirname(forked.getSessionFile() ?? "")).toBe(path.resolve(destinationBucket));
			expect(forked.getHeader()?.cwd).toBe(path.resolve(destinationHome));
			expect(forked.getHeader()?.cwd).not.toBe(path.resolve(sourceHome));
		} finally {
			await forked.close();
		}
	});

	it("pins fallback H and divergent live roots across reload, clone, and snapshot restore", async () => {
		const state = await createFallbackSession("snapshot");
		const runtimeOnlyRoot = path.join(state.runtime, "runtime-only");
		const nextRuntime = makeTempDir("@pi-cwd-snapshot-next-runtime-");
		const otherHome = makeTempDir("@pi-cwd-snapshot-other-home-");
		const otherBucket = makeTempDir("@pi-cwd-snapshot-other-bucket-");
		const otherFile = await writeSession(otherHome, otherBucket);

		try {
			await state.manager.addWorkspaceDirectory(runtimeOnlyRoot);
			state.manager.setCwdWithoutRelocation(nextRuntime);
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.home));
			expect(state.manager.getCwd()).toBe(path.resolve(nextRuntime));
			await state.manager.setSessionFile(state.file);
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.home));
			expect(state.manager.getCwd()).toBe(path.resolve(nextRuntime));

			const snapshot = state.manager.captureState();
			const clone = state.manager.cloneCurrentSession();
			try {
				expect(clone.getSessionHome()).toBe(path.resolve(state.home));
				expect(clone.getCwd()).toBe(path.resolve(nextRuntime));
				expect(clone.getAdditionalDirectories()).toEqual([state.persistedRoot, runtimeOnlyRoot]);
				expect(clone.getHeader()?.additionalDirectories).toEqual([state.persistedRoot]);
			} finally {
				await clone.close();
			}

			await state.manager.setSessionFile(otherFile);
			expect(state.manager.getSessionHome()).toBe(path.resolve(otherHome));
			state.manager.restoreState(snapshot);
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.home));
			expect(state.manager.getCwd()).toBe(path.resolve(nextRuntime));
			expect(state.manager.getSessionDir()).toBe(path.resolve(state.bucket));
			expect(state.manager.getAdditionalDirectories()).toEqual([state.persistedRoot, runtimeOnlyRoot]);
			expect(state.manager.getHeader()?.additionalDirectories).toEqual([state.persistedRoot]);
		} finally {
			await state.manager.close();
		}
	});

	it("pins a different legacy identity to its loading cwd without rewriting its empty header", async () => {
		const state = await createFallbackSession("legacy-switch");
		const loadingCwd = makeTempDir("@pi-cwd-legacy-loading-");
		const legacyHome = makeTempDir("@pi-cwd-legacy-home-");
		const legacyBucket = makeTempDir("@pi-cwd-legacy-bucket-");
		const legacyFile = await writeSession(legacyHome, legacyBucket);
		const legacyBytes = await rewriteHeaderCwd(legacyFile, "");

		try {
			state.manager.setCwdWithoutRelocation(loadingCwd);
			await state.manager.setSessionFile(legacyFile);
			expect(state.manager.getCwd()).toBe(path.resolve(loadingCwd));
			expect(state.manager.getSessionHome()).toBe(path.resolve(loadingCwd));
			expect(state.manager.getRecordedCwd()).toBe("");
			expect(state.manager.getSessionDir()).toBe(path.resolve(legacyBucket));
		} finally {
			await state.manager.close();
		}
		expect(await Bun.file(legacyFile).text()).toBe(legacyBytes);
	});

	it("mints runtime-owned identities for missing and empty non-strict switch targets", async () => {
		const state = await createFallbackSession("fresh-target");
		const missingTarget = path.join(state.bucket, "missing-target.jsonl");
		const emptyTarget = path.join(state.bucket, "empty-target.jsonl");
		await Bun.write(emptyTarget, "");
		const oldId = state.manager.getSessionId();

		try {
			await state.manager.setSessionFile(missingTarget);
			const missingId = state.manager.getSessionId();
			expect(missingId).not.toBe(oldId);
			expect(state.manager.getSessionFile()).toBe(path.resolve(missingTarget));
			expect(state.manager.getCwd()).toBe(path.resolve(state.runtime));
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.runtime));
			expect(state.manager.getHeader()?.cwd).toBe(path.resolve(state.runtime));
			expect(state.manager.getSessionDir()).toBe(path.resolve(state.bucket));

			await state.manager.setSessionFile(emptyTarget);
			expect(state.manager.getSessionId()).not.toBe(missingId);
			expect(state.manager.getSessionFile()).toBe(path.resolve(emptyTarget));
			expect(state.manager.getCwd()).toBe(path.resolve(state.runtime));
			expect(state.manager.getSessionHome()).toBe(path.resolve(state.runtime));
			expect(state.manager.getHeader()?.cwd).toBe(path.resolve(state.runtime));
			expect(state.manager.getSessionDir()).toBe(path.resolve(state.bucket));
			expect((await loadEntriesFromFile(state.file)).some(entry => entry.type === "message")).toBe(true);
		} finally {
			await state.manager.close();
		}
	});

	it("does not rewrite empty or invalid explicit targets when strict loading rejects them", async () => {
		const runtime = makeTempDir("@pi-cwd-strict-runtime-");
		const bucket = makeTempDir("@pi-cwd-strict-bucket-");
		const emptyFile = path.join(bucket, "strict-empty.jsonl");
		const invalidFile = path.join(bucket, "strict-invalid.jsonl");
		await Bun.write(emptyFile, "");
		await Bun.write(invalidFile, "{not valid json}\n");
		const emptyBefore = await Bun.file(emptyFile).text();
		const invalidBefore = await Bun.file(invalidFile).text();

		await expect(
			SessionManager.open(emptyFile, undefined, undefined, { initialCwd: runtime, throwIfMissing: true }),
		).rejects.toThrow();
		const emptyBreadcrumb = await readTerminalBreadcrumbEntry();
		expect(path.resolve(emptyBreadcrumb?.sessionFile ?? "")).not.toBe(path.resolve(emptyFile));
		await expect(
			SessionManager.open(invalidFile, undefined, undefined, { initialCwd: runtime, throwIfMissing: true }),
		).rejects.toThrow();
		const invalidBreadcrumb = await readTerminalBreadcrumbEntry();
		expect(path.resolve(invalidBreadcrumb?.sessionFile ?? "")).not.toBe(path.resolve(invalidFile));
		expect(await Bun.file(emptyFile).text()).toBe(emptyBefore);
		expect(await Bun.file(invalidFile).text()).toBe(invalidBefore);
	});
});
