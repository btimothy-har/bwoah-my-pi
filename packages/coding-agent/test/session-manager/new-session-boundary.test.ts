import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseTerminalBreadcrumb, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

describe("SessionManager.continueRecent /new boundary", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%new-boundary-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-new-boundary-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
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

	it("honors a same-terminal lazy fresh-session breadcrumb when no output was produced", async () => {
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "older work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		// Initial session creation remains lazy. Its terminal-scoped breadcrumb
		// must keep same-terminal auto-resume from selecting the older file.
		const fresh = SessionManager.create(cwd);
		const freshFile = fresh.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");
		expect(fs.existsSync(freshFile)).toBe(false);
		await fresh.close();

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			expect(relaunched.getEntries()).toHaveLength(0);
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(freshFile));
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(oldFile));
		} finally {
			await relaunched.close();
		}
	});

	it("skips an explicit /new boundary on a different terminal and continues the latest non-empty session", async () => {
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "pre-new work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		const resumed = await SessionManager.continueRecent(cwd);
		await resumed.newSession();
		const freshFile = resumed.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");
		await resumed.close();

		// Filesystems may assign both rapid writes the same mtime. Session-header
		// creation time must still order the explicit boundary newest deterministically.
		const tiedMtime = new Date("2026-01-01T00:00:00.000Z");
		fs.utimesSync(oldFile, tiedMtime, tiedMtime);
		fs.utimesSync(freshFile, tiedMtime, tiedMtime);

		// Closing a terminal tab/window changes its TTY identity, so the next
		// process has no breadcrumb pointing at the empty boundary: -c skips
		// the 0-turn stub and continues the latest non-empty transcript.
		process.env.TMUX_PANE = "%new-boundary-relaunched-terminal";
		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			expect(JSON.stringify(relaunched.getEntries())).toContain("pre-new work");
			expect(path.resolve(relaunched.getSessionFile() ?? "")).toBe(path.resolve(oldFile));
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(freshFile));
		} finally {
			await relaunched.close();
		}
	});

	it("still falls back to the most-recent session for a genuinely stale breadcrumb", async () => {
		// A normal persisted session (survives).
		const first = SessionManager.create(cwd);
		first.appendMessage({ role: "user", content: "first session", timestamp: 1 });
		first.appendMessage(makeAssistantMessage());
		await first.flush();
		await first.close();

		// A distinct second session becomes the terminal's breadcrumb target and
		// materializes on disk (re-stamped non-fresh), then is externally deleted.
		const second = SessionManager.create(cwd);
		second.appendMessage({ role: "user", content: "second session", timestamp: 1 });
		second.appendMessage(makeAssistantMessage());
		await second.flush();
		const secondFile = second.getSessionFile();
		if (!secondFile) throw new Error("Expected persisted second session file");
		await second.close();
		await fsp.rm(secondFile, { force: true });

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			// Materialized-then-deleted target (non-fresh) → fall back to the
			// most-recent surviving session, not a fresh empty one.
			expect(JSON.stringify(relaunched.getEntries())).toContain("first session");
		} finally {
			await relaunched.close();
		}
	});

	it("-c skips an empty newest stub when the breadcrumb belongs to another project", async () => {
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "real work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		// All writes below share one terminal, so the breadcrumb points at the
		// foreign project while -c runs in cwd: the different-cwd branch.
		process.env.TMUX_PANE = "%new-boundary-skip-empty-terminal";
		const stubFile = SessionManager.createEmptySessionFile(cwd);
		expect(fs.existsSync(stubFile)).toBe(true);

		const cwdOther = path.join(testAgentDir, "other-project");
		fs.mkdirSync(cwdOther, { recursive: true });
		const other = SessionManager.create(cwdOther);
		other.appendMessage({ role: "user", content: "other work", timestamp: 1 });
		other.appendMessage(makeAssistantMessage());
		await other.flush();
		await other.close();

		// Newest file in cwd is the untitled stub; -c must fall back past it.
		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			expect(path.resolve(relaunched.getSessionFile() ?? "")).toBe(path.resolve(oldFile));
			expect(JSON.stringify(relaunched.getEntries())).toContain("real work");
		} finally {
			await relaunched.close();
		}
	});
	it("mints a fresh H-owned identity for a matching fallback boundary", async () => {
		const home = path.join(testAgentDir, "boundary-home");
		const fallback = path.join(testAgentDir, "boundary-fallback");
		const bucket = path.join(testAgentDir, "boundary-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const old = SessionManager.create(home, bucket);
		old.appendMessage({ role: "user", content: "before fallback /new", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		const oldId = old.getSessionId();
		if (!oldFile) throw new Error("Expected persisted prior session file");
		await old.close();

		const boundaryFile = path.join(bucket, "not-yet-materialized.jsonl");
		const boundaryId = "fresh-boundary-id";
		writeTerminalBreadcrumb(home, boundaryFile, true, {
			runtimeFallback: { cwd: fallback, sessionId: boundaryId },
		});
		await fsp.rm(home, { recursive: true, force: true });

		const fresh = await SessionManager.continueRecent(fallback);
		const newId = fresh.getSessionId();
		try {
			expect(fresh.getSessionFile()).not.toBe(path.resolve(boundaryFile));
			expect(fresh.getSessionFile()).not.toBe(path.resolve(oldFile));
			expect(newId).not.toBe(oldId);
			expect(newId).not.toBe(boundaryId);
			expect(fresh.getSessionHome()).toBe(path.resolve(home));
			expect(fresh.getCwd()).toBe(path.resolve(fallback));
			expect(fresh.getSessionDir()).toBe(path.resolve(bucket));
			expect(fresh.getEntries()).toHaveLength(0);
			await fresh.ensureOnDisk();
			const freshFile = fresh.getSessionFile();
			if (!freshFile) throw new Error("Expected a fresh session file");
			expect(path.dirname(freshFile)).toBe(path.resolve(bucket));
			expect(fs.existsSync(home)).toBe(false);
			const entries = await loadEntriesFromFile(freshFile);
			expect(entries.some(entry => entry.type === "session" && entry.cwd === path.resolve(home))).toBe(true);
		} finally {
			await fresh.close();
		}
		const terminalId = getTerminalId();
		if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
		const breadcrumb = fs.readFileSync(path.join(getTerminalSessionsDir(), terminalId), "utf8");
		const parsed = parseTerminalBreadcrumb(breadcrumb);
		expect(parsed?.runtimeFallback?.sessionId).toBe(newId);
	});

	it("keeps a lazy H-owned boundary fresh and pins a relative explicit bucket across home adoption", async () => {
		const home = path.join(testAgentDir, "adopt-home");
		const fallback = path.join(testAgentDir, "adopt-fallback");
		const bucket = path.join(testAgentDir, "adopt-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		fs.mkdirSync(bucket, { recursive: true });
		const missingFile = path.join(bucket, "missing-boundary.jsonl");
		writeTerminalBreadcrumb(home, missingFile, true, {
			runtimeFallback: { cwd: fallback, sessionId: "unmaterialized-boundary" },
		});
		await fsp.rm(home, { recursive: true, force: true });

		const relativeBucket = path.relative(process.cwd(), bucket);
		const fresh = await SessionManager.continueRecent(fallback, relativeBucket);
		const firstId = fresh.getSessionId();
		expect(fresh.getSessionDir()).toBe(path.resolve(bucket));
		fs.mkdirSync(home, { recursive: true });
		fresh.adoptRecordedCwd();
		await fresh.close();

		const terminalId = getTerminalId();
		if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
		const adoptedBreadcrumb = parseTerminalBreadcrumb(
			fs.readFileSync(path.join(getTerminalSessionsDir(), terminalId), "utf8"),
		);
		expect(adoptedBreadcrumb?.fresh).toBe(true);
		expect(adoptedBreadcrumb?.runtimeFallback).toBeUndefined();

		const relaunched = await SessionManager.continueRecent(home, relativeBucket);
		try {
			expect(relaunched.getSessionId()).not.toBe(firstId);
			expect(relaunched.getSessionHome()).toBe(path.resolve(home));
			expect(relaunched.getCwd()).toBe(path.resolve(home));
			expect(relaunched.getSessionDir()).toBe(path.resolve(bucket));
			expect(relaunched.getEntries()).toHaveLength(0);
		} finally {
			await relaunched.close();
		}
	});

	it("keeps a fallback fresh boundary inside an explicit sessionDir", async () => {
		const home = path.join(testAgentDir, "contained-home");
		const fallback = path.join(testAgentDir, "contained-fallback");
		const bucket = path.join(testAgentDir, "contained-bucket");
		const explicitDir = path.join(testAgentDir, "explicit-other-bucket");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(fallback, { recursive: true });
		const old = SessionManager.create(home, bucket);
		old.appendMessage({ role: "user", content: "contained prior session", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted prior session file");
		await old.close();
		writeTerminalBreadcrumb(home, path.join(bucket, "fresh-missing.jsonl"), true, {
			runtimeFallback: { cwd: fallback, sessionId: "contained-boundary-id" },
		});
		await fsp.rm(home, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(fallback, explicitDir);
		try {
			expect(resumed.getSessionFile()).not.toBe(path.resolve(oldFile));
			expect(resumed.getSessionHome()).toBe(path.resolve(fallback));
			expect(resumed.getCwd()).toBe(path.resolve(fallback));
			expect(resumed.getSessionDir()).toBe(path.resolve(explicitDir));
			expect(resumed.getEntries()).toHaveLength(0);
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(fs.existsSync(home)).toBe(false);
		} finally {
			await resumed.close();
		}
	});

	it("does not let an unrelated fresh breadcrumb hide the launch project's session", async () => {
		const local = SessionManager.create(cwd);
		local.appendMessage({ role: "user", content: "launch project conversation", timestamp: 1 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		const localId = local.getSessionId();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();

		const unrelatedHome = path.join(testAgentDir, "unrelated-fresh-home");
		const unrelatedFile = path.join(testAgentDir, "unrelated-fresh-bucket", "missing.jsonl");
		fs.mkdirSync(unrelatedHome, { recursive: true });
		writeTerminalBreadcrumb(unrelatedHome, unrelatedFile, true);

		const resumed = await SessionManager.continueRecent(cwd);
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(localFile));
			expect(resumed.getSessionId()).toBe(localId);
			expect(JSON.stringify(resumed.getEntries())).toContain("launch project conversation");
		} finally {
			await resumed.close();
		}
	});
});
