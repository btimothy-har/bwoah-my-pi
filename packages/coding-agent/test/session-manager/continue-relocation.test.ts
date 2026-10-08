import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	parseTerminalBreadcrumb,
	readCwdIdentity,
	writeTerminalBreadcrumb,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as ttyIdModule from "@oh-my-pi/pi-tui/ttyid";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader =>
			typeof e === "object" && e !== null && "type" in e && (e as { type: unknown }).type === "session",
	);
}

function writeBreadcrumb(
	cwd: string,
	sessionFile: string,
	fresh = false,
	runtimeFallback?: { cwd: string; sessionId: string },
): string {
	const terminalId = ttyIdModule.getTerminalId();
	if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
	writeTerminalBreadcrumb(cwd, sessionFile, fresh, runtimeFallback ? { runtimeFallback } : undefined);
	return path.join(getTerminalSessionsDir(), terminalId);
}

function writeRawFallbackBreadcrumb(home: string, sessionFile: string, fallbackCwd: string, sessionId: string): string {
	const terminalId = ttyIdModule.getTerminalId();
	if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
	const cwdIdentity = readCwdIdentity(fallbackCwd);
	if (!cwdIdentity) throw new Error("Expected a fallback cwd identity");
	const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
	fs.mkdirSync(path.dirname(breadcrumbFile), { recursive: true });
	fs.writeFileSync(
		breadcrumbFile,
		`${path.resolve(home)}\n${path.resolve(sessionFile)}\nruntime-fallback ${JSON.stringify({
			cwd: path.resolve(fallbackCwd),
			cwdIdentity,
			sessionId,
		})}\n`,
	);
	return breadcrumbFile;
}

/** Simulate `mv` / `git worktree move`: same directory inode at a new path. */
async function renameProjectDir(from: string, to: string): Promise<void> {
	await fsp.rm(to, { recursive: true, force: true });
	await fsp.rename(from, to);
}

function stripHeaderCwd(file: string): void {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const rewritten = lines.map(line => {
		if (!line.trim()) return line;
		const obj = JSON.parse(line) as { type?: string; cwd?: unknown };
		if (obj.type === "session") delete obj.cwd;
		return JSON.stringify(obj);
	});
	fs.writeFileSync(file, rewritten.join("\n"));
}

function setHeaderCwdEmpty(file: string): string {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const headerIndex = lines.findIndex(line => {
		if (!line.trim()) return false;
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null && "type" in value && value.type === "session";
	});
	if (headerIndex < 0) throw new Error("Expected a session header");
	const header: unknown = JSON.parse(lines[headerIndex]);
	if (typeof header !== "object" || header === null || Array.isArray(header) || !("cwd" in header)) {
		throw new Error("Expected a session header with a cwd field");
	}
	header.cwd = "";
	lines[headerIndex] = JSON.stringify(header);
	fs.writeFileSync(file, lines.join("\n"));
	return lines[headerIndex];
}

describe("SessionManager.continueRecent relocation", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Force a deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%relocation-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-reloc-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "worktree-old");
		cwdB = path.join(testAgentDir, "worktree-new");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("does not re-root into an unrelated cwd when the breadcrumb directory is merely missing", async () => {
		const oldProject = path.join(testAgentDir, "projects", "old-project");
		const unrelated = path.join(testAgentDir, "elsewhere", "unrelated-project");
		fs.mkdirSync(oldProject, { recursive: true });
		fs.mkdirSync(unrelated, { recursive: true });

		const session = SessionManager.create(oldProject);
		session.appendMessage({ role: "user", content: "original project", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		writeBreadcrumb(oldProject, oldFile);
		// Deleted / offline / never-mounted: absence is not evidence of a move.
		await fsp.rm(oldProject, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(unrelated);
		try {
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(resumed.getSessionFile()).not.toBe(oldFile);
			const oldHeader = getHeader(await loadEntriesFromFile(oldFile));
			expect(oldHeader?.cwd).toBe(path.resolve(oldProject));
			expect(oldHeader?.cwd).not.toBe(path.resolve(unrelated));
			expect(resumed.getCwd()).toBe(path.resolve(unrelated));
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("does not re-root from a two-line breadcrumb that recorded no directory identity", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "legacy crumb", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		const terminalId = ttyIdModule.getTerminalId();
		if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
		fs.writeFileSync(path.join(getTerminalSessionsDir(), terminalId), `${cwdA}\n${oldFile}\n`);
		await renameProjectDir(cwdA, cwdB);

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(path.resolve(cwdA));
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("re-roots the terminal's session when its directory was moved/renamed", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		// Breadcrumb points at the old session, recorded under the old cwd.
		writeBreadcrumb(cwdA, oldFile);
		// Real move/rename: the continue cwd is the same directory inode.
		await renameProjectDir(cwdA, cwdB);

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// The relocated session is adopted, not discarded for a fresh one.
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(newFile).not.toBe(oldFile);
			expect(fs.existsSync(oldFile)).toBe(false);

			const entries = await loadEntriesFromFile(newFile);
			expect(getHeader(entries)?.cwd).toBe(path.resolve(cwdB));
			const userMessages = entries.filter(e => e.type === "message" && e.message.role === "user");
			expect(userMessages).toHaveLength(1);
		} finally {
			await resumed.close();
		}
	});

	it("starts without re-rooting when another live process still writes the moved session", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		const ownedId = session.getSessionId();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();
		writeBreadcrumb(cwdA, oldFile);
		await renameProjectDir(cwdA, cwdB);

		// The omp that was running in the renamed directory still holds the session.
		class OwnedElsewhereStorage extends FileSessionStorage {
			override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
				return sessionId === ownedId ? null : super.claimSession(sessionId, sessionPath);
			}
		}
		const resumed = await SessionManager.continueRecent(cwdB, undefined, new OwnedElsewhereStorage());
		try {
			// Startup goes on, and the owner's file is not moved out from under it.
			expect(resumed.getSessionFile()).not.toBe(oldFile);
			expect(fs.existsSync(oldFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("does not hijack the session when the recorded directory still exists (plain cd)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "other project", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		// Breadcrumb from a still-existing different project; user just cd'd elsewhere.
		writeBreadcrumb(cwdA, oldFile);

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// Old project's session is left untouched; a fresh session starts in cwdB.
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(resumed.getSessionFile()).not.toBe(oldFile);
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("keeps same-cwd breadcrumbs inside an explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "intended-sessions");
		const foreignSessionDir = path.join(testAgentDir, "foreign-sessions");
		const intended = SessionManager.create(cwdB, explicitSessionDir);
		intended.appendMessage({ role: "user", content: "intended session", timestamp: 1 });
		intended.appendMessage(makeAssistantMessage());
		await intended.flush();
		const intendedFile = intended.getSessionFile();
		if (!intendedFile) throw new Error("Expected persisted intended session file");
		await intended.close();

		const foreign = SessionManager.create(cwdB, foreignSessionDir);
		foreign.appendMessage({ role: "user", content: "foreign session", timestamp: 2 });
		foreign.appendMessage(makeAssistantMessage());
		await foreign.flush();
		const foreignFile = foreign.getSessionFile();
		if (!foreignFile) throw new Error("Expected persisted foreign session file");
		await foreign.close();

		writeBreadcrumb(cwdB, foreignFile);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			expect(resumed.getSessionFile()).toBe(intendedFile);
		} finally {
			await resumed.close();
		}
	});

	it("ignores foreign fresh breadcrumbs with an explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "intended-sessions");
		const intended = SessionManager.create(cwdB, explicitSessionDir);
		intended.appendMessage({ role: "user", content: "intended session", timestamp: 1 });
		intended.appendMessage(makeAssistantMessage());
		await intended.flush();
		const intendedFile = intended.getSessionFile();
		if (!intendedFile) throw new Error("Expected persisted intended session file");
		await intended.close();

		const foreignMissingFile = path.join(testAgentDir, "foreign-sessions", "missing.jsonl");
		fs.mkdirSync(path.dirname(foreignMissingFile), { recursive: true });
		writeBreadcrumb(cwdB, foreignMissingFile, true);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			expect(resumed.getSessionFile()).toBe(intendedFile);
		} finally {
			await resumed.close();
		}
	});

	it("honors in-directory fresh breadcrumbs with an explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "intended-sessions");
		const prior = SessionManager.create(cwdB, explicitSessionDir);
		prior.appendMessage({ role: "user", content: "prior session", timestamp: 1 });
		prior.appendMessage(makeAssistantMessage());
		await prior.flush();
		const priorFile = prior.getSessionFile();
		if (!priorFile) throw new Error("Expected persisted prior session file");
		await prior.close();

		const freshMissingFile = path.join(explicitSessionDir, "missing.jsonl");
		fs.mkdirSync(path.dirname(freshMissingFile), { recursive: true });
		writeBreadcrumb(cwdB, freshMissingFile, true);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			expect(resumed.getSessionFile()).not.toBe(priorFile);
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("does not re-root when the new directory already has its own sessions", async () => {
		const moved = SessionManager.create(cwdA);
		moved.appendMessage({ role: "user", content: "moved", timestamp: 1 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted session file");
		await moved.close();

		// cwdB already owns a local session.
		const local = SessionManager.create(cwdB);
		local.appendMessage({ role: "user", content: "local", timestamp: 2 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();

		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// Prefer cwdB's own recent session over re-rooting the moved one.
			expect(resumed.getSessionFile()).toBe(localFile);
			expect(fs.existsSync(movedFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});
	it("skips an empty local stub when the breadcrumb file is newest", async () => {
		// Explicit session dir shared by both projects so the breadcrumb file
		// can be newest there while cwdB owns its own sessions.
		const explicitSessionDir = path.join(testAgentDir, "shared-sessions");
		const moved = SessionManager.create(cwdA, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "moved", timestamp: 1 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted session file");
		await moved.close();

		const local = SessionManager.create(cwdB, explicitSessionDir);
		local.appendMessage({ role: "user", content: "local", timestamp: 2 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();
		// Untitled header-only stub in the shared dir, newer than the answered
		// local transcript: the shape where the fallback could pick wrong.
		const stub = SessionManager.create(cwdB, explicitSessionDir);
		await stub.ensureOnDisk();
		const sharedStub = stub.getSessionFile();
		if (!sharedStub) throw new Error("Expected materialized stub file");
		await stub.close();
		expect(fs.existsSync(sharedStub)).toBe(true);
		// Order newest-first: breadcrumb target, then the empty stub, then the
		// answered local transcript — the fallback only runs on this shape.
		const newestFirst = new Date("2026-02-03T00:00:00.000Z");
		const middle = new Date("2026-02-02T00:00:00.000Z");
		const oldest = new Date("2026-02-01T00:00:00.000Z");
		fs.utimesSync(movedFile, newestFirst, newestFirst);
		fs.utimesSync(sharedStub, middle, middle);
		fs.utimesSync(localFile, oldest, oldest);
		// Breadcrumb cwd gone; breadcrumb file newest in the shared dir.
		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			// The empty stub must not shadow cwdB's latest answered transcript.
			expect(resumed.getSessionFile()).toBe(path.resolve(localFile));
			expect(fs.existsSync(movedFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("moves a relocated breadcrumb session into an explicit sessionDir", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "explicit dir", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		const explicitSessionDir = path.join(testAgentDir, "custom-sessions");
		writeBreadcrumb(cwdA, oldFile);
		await renameProjectDir(cwdA, cwdB);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(path.dirname(newFile)).toBe(path.resolve(explicitSessionDir));
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});

	it("re-roots when the stale breadcrumb file is already in the explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-custom-sessions");
		const session = SessionManager.create(cwdA, explicitSessionDir);
		session.appendMessage({ role: "user", content: "same explicit dir", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		expect(path.dirname(oldFile)).toBe(path.resolve(explicitSessionDir));
		await session.close();

		writeBreadcrumb(cwdA, oldFile);
		await renameProjectDir(cwdA, cwdB);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(newFile).toBe(oldFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});

	it("prefers an existing current-cwd session in a shared explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-current-sessions");
		const local = SessionManager.create(cwdB, explicitSessionDir);
		local.appendMessage({ role: "user", content: "local current cwd", timestamp: 1 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();

		// Ensure the stale moved session is newer than the local current-cwd session.
		await new Promise(resolve => setTimeout(resolve, 20));
		const moved = SessionManager.create(cwdA, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "newer stale moved cwd", timestamp: 2 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted moved session file");
		await moved.close();

		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			expect(resumed.getSessionFile()).toBe(localFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(fs.existsSync(movedFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("re-roots past a cwd-less legacy session in a shared explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-legacy-sessions");
		const legacy = SessionManager.create(cwdB, explicitSessionDir);
		legacy.appendMessage({ role: "user", content: "legacy without cwd", timestamp: 1 });
		legacy.appendMessage(makeAssistantMessage());
		await legacy.flush();
		const legacyFile = legacy.getSessionFile();
		if (!legacyFile) throw new Error("Expected persisted legacy session file");
		await legacy.close();
		stripHeaderCwd(legacyFile);

		// Ensure the stale moved session is newer than the cwd-less legacy session.
		await new Promise(resolve => setTimeout(resolve, 20));
		const moved = SessionManager.create(cwdA, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "newer stale moved cwd", timestamp: 2 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted moved session file");
		await moved.close();

		writeBreadcrumb(cwdA, movedFile);
		await renameProjectDir(cwdA, cwdB);

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			// The moved session is re-rooted; the cwd-less legacy session is not hijacked.
			expect(resumed.getSessionFile()).toBe(movedFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(fs.existsSync(legacyFile)).toBe(true);
			expect(getHeader(await loadEntriesFromFile(movedFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});
	it("resumes the H-owned conversation from its runtime fallback without a sessionDir", async () => {
		const home = path.join(testAgentDir, "canonical-home");
		const fallback = path.join(testAgentDir, "runtime-fallback");
		const bucket = path.join(testAgentDir, "custom-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });

		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "conversation owned by H", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();

		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(sessionFile));
			expect(resumed.getSessionId()).toBe(sessionId);
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(resumed.getCwd()).toBe(path.resolve(fallback));
			expect(resumed.getSessionDir()).toBe(path.resolve(bucket));
			expect(JSON.stringify(resumed.getEntries())).toContain("conversation owned by H");
			expect(fs.existsSync(home)).toBe(false);

			const persisted = await loadEntriesFromFile(sessionFile);
			expect(getHeader(persisted)?.cwd).toBe(path.resolve(home));
			expect(JSON.stringify(persisted)).toContain("conversation owned by H");
		} finally {
			await resumed.close();
		}
	});

	it("does not use a fallback hint from an unrelated launch cwd", async () => {
		const home = path.join(testAgentDir, "hinted-home");
		const fallback = path.join(testAgentDir, "hinted-fallback");
		const unrelated = path.join(testAgentDir, "unrelated-launch");
		const bucket = path.join(testAgentDir, "hinted-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		fs.mkdirSync(unrelated, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "must not be hijacked", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(unrelated);
		try {
			expect(resumed.getSessionFile()).not.toBe(path.resolve(sessionFile));
			expect(resumed.getSessionHome()).toBe(path.resolve(unrelated));
			expect(resumed.getEntries()).toHaveLength(0);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("does not use a fallback hint recorded by a different terminal", async () => {
		const home = path.join(testAgentDir, "terminal-home");
		const fallback = path.join(testAgentDir, "terminal-fallback");
		const bucket = path.join(testAgentDir, "terminal-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const terminalId = vi.spyOn(ttyIdModule, "getTerminalId").mockReturnValue("fallback-origin-terminal");
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "terminal-local only", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		terminalId.mockReturnValue("different-terminal");
		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).not.toBe(path.resolve(sessionFile));
			expect(resumed.getEntries()).toHaveLength(0);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("rejects a fallback hint when the fallback path has been replaced", async () => {
		const home = path.join(testAgentDir, "replaced-home");
		const fallback = path.join(testAgentDir, "replaced-fallback");
		const retiredFallback = path.join(testAgentDir, "retired-fallback");
		const bucket = path.join(testAgentDir, "replaced-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "old fallback inode", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();

		writeRawFallbackBreadcrumb(home, sessionFile, fallback, sessionId);
		const oldIdentity = readCwdIdentity(fallback);
		if (!oldIdentity) throw new Error("Expected the original fallback identity");
		await fsp.rm(home, { recursive: true, force: true });
		await fsp.rename(fallback, retiredFallback);
		fs.mkdirSync(fallback, { recursive: true });
		expect(readCwdIdentity(fallback)).not.toEqual(oldIdentity);

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).not.toBe(path.resolve(sessionFile));
			expect(resumed.getEntries()).toHaveLength(0);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("rejects fallback candidates whose id or header home contradicts the hint", async () => {
		for (const mismatch of ["id", "home"] as const) {
			const home = path.join(testAgentDir, `mismatch-home-${mismatch}`);
			const breadcrumbHome = mismatch === "home" ? path.join(testAgentDir, "different-breadcrumb-home") : home;
			const fallback = path.join(testAgentDir, `mismatch-fallback-${mismatch}`);
			const bucket = path.join(testAgentDir, `mismatch-bucket-${mismatch}`);
			fs.mkdirSync(home, { recursive: true });
			fs.mkdirSync(breadcrumbHome, { recursive: true });
			fs.mkdirSync(fallback, { recursive: true });
			const source = SessionManager.create(home, bucket);
			source.appendMessage({ role: "user", content: `mismatched ${mismatch}`, timestamp: 1 });
			source.appendMessage(makeAssistantMessage());
			await source.flush();
			const sessionFile = source.getSessionFile();
			const sessionId = source.getSessionId();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await source.close();
			writeBreadcrumb(breadcrumbHome, sessionFile, false, {
				cwd: fallback,
				sessionId: mismatch === "id" ? `${sessionId}-different` : sessionId,
			});
			await fsp.rm(home, { recursive: true, force: true });
			if (breadcrumbHome !== home) await fsp.rm(breadcrumbHome, { recursive: true, force: true });

			const resumed = await SessionManager.continueRecent(fallback);
			try {
				expect(resumed.getSessionFile()).not.toBe(path.resolve(sessionFile));
				expect(resumed.getEntries()).toHaveLength(0);
				expect(fs.existsSync(sessionFile)).toBe(true);
			} finally {
				await resumed.close();
			}
		}
	});

	it("does not let a malformed fallback hint select its transcript", async () => {
		const home = path.join(testAgentDir, "malformed-hint-home");
		const fallback = path.join(testAgentDir, "malformed-hint-fallback");
		const bucket = path.join(testAgentDir, "malformed-hint-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "malformed hint must not select", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		const terminalId = ttyIdModule.getTerminalId();
		if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
		const fallbackIdentity = readCwdIdentity(fallback);
		if (!fallbackIdentity) throw new Error("Expected a fallback cwd identity");
		fs.writeFileSync(
			path.join(getTerminalSessionsDir(), terminalId),
			`${home}\n${sessionFile}\nruntime-fallback ${JSON.stringify({
				cwd: "relative/fallback",
				cwdIdentity: fallbackIdentity,
				sessionId,
			})}\n`,
		);
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).not.toBe(path.resolve(sessionFile));
			expect(resumed.getEntries()).toHaveLength(0);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("restores a legacy empty-cwd session's private home without rewriting its header", async () => {
		const home = path.join(testAgentDir, "legacy-home");
		const fallback = path.join(testAgentDir, "legacy-fallback");
		const bucket = path.join(testAgentDir, "legacy-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "legacy conversation", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		setHeaderCwdEmpty(sessionFile);
		const originalBytes = fs.readFileSync(sessionFile, "utf8");
		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(sessionFile));
			expect(resumed.getSessionId()).toBe(sessionId);
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(resumed.getCwd()).toBe(path.resolve(fallback));
			expect(getHeader(await loadEntriesFromFile(sessionFile))?.cwd).toBe("");
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(originalBytes);
		} finally {
			await resumed.close();
		}
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(originalBytes);
	});

	it("adopts a recovered home and removes the terminal-local fallback hint", async () => {
		const home = path.join(testAgentDir, "recovered-home");
		const fallback = path.join(testAgentDir, "recovered-fallback");
		const bucket = path.join(testAgentDir, "recovered-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "recovered conversation", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(resumed.getCwd()).toBe(path.resolve(fallback));
			await fsp.mkdir(home, { recursive: true });
			resumed.adoptRecordedCwd();
			expect(resumed.getSessionId()).toBe(sessionId);
			expect(resumed.getSessionFile()).toBe(path.resolve(sessionFile));
			expect(resumed.getCwd()).toBe(path.resolve(home));
			const terminalId = ttyIdModule.getTerminalId();
			if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
			const parsed = parseTerminalBreadcrumb(
				fs.readFileSync(path.join(getTerminalSessionsDir(), terminalId), "utf8"),
			);
			expect(parsed?.runtimeFallback).toBeUndefined();
		} finally {
			await resumed.close();
		}
	});

	it("continues the same conversation under H when H reappears", async () => {
		const home = path.join(testAgentDir, "home-reappeared");
		const fallback = path.join(testAgentDir, "fallback-reappeared");
		const bucket = path.join(testAgentDir, "bucket-reappeared");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "same transcript after recovery", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		writeBreadcrumb(home, sessionFile, false, { cwd: fallback, sessionId });
		await fsp.rm(home, { recursive: true, force: true });
		await fsp.mkdir(home, { recursive: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(sessionFile));
			expect(resumed.getSessionId()).toBe(sessionId);
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(resumed.getCwd()).toBe(path.resolve(home));
			expect(JSON.stringify(resumed.getEntries())).toContain("same transcript after recovery");
			const terminalId = ttyIdModule.getTerminalId();
			if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
			const parsed = parseTerminalBreadcrumb(
				fs.readFileSync(path.join(getTerminalSessionsDir(), terminalId), "utf8"),
			);
			expect(parsed?.runtimeFallback).toBeUndefined();
		} finally {
			await resumed.close();
		}
	});
	it("matches a fallback hint through an equivalent symlink path", async () => {
		const home = path.join(testAgentDir, "symlink-home");
		const fallback = path.join(testAgentDir, "symlink-fallback");
		const fallbackAlias = path.join(testAgentDir, "fallback-alias");
		const bucket = path.join(testAgentDir, "symlink-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		fs.symlinkSync(fallback, fallbackAlias, "dir");
		const source = SessionManager.create(home, bucket);
		source.appendMessage({ role: "user", content: "symlink-equivalent fallback", timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.flush();
		const sessionFile = source.getSessionFile();
		const sessionId = source.getSessionId();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await source.close();
		writeBreadcrumb(home, sessionFile, false, { cwd: fallbackAlias, sessionId });
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(sessionFile));
			expect(resumed.getSessionId()).toBe(sessionId);
			expect(resumed.getSessionHome()).toBe(path.resolve(home));
			expect(JSON.stringify(resumed.getEntries())).toContain("symlink-equivalent fallback");
		} finally {
			await resumed.close();
		}
	});
});
