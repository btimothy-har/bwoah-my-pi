import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { BuildSessionContextOptions, SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #3846: in-TUI `/resume` rebuilt the *previous*
 * session's display context before switching files. That call expands persisted
 * snapcompact archives and `openaiRemoteCompaction.replacementHistory` payloads
 * into messages, which can OOM on huge pre-fix sessions even though the loader
 * itself streams. The previous context is only needed for same-session reloads
 * (where `#didSessionMessagesChange` compares against the freshly rebuilt one);
 * different-session switches MUST skip that work.
 */
describe("AgentSession.switchSession previous-context build", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function buildSession(
		tempDir: TempDir,
		extensionRunner?: ExtensionRunner,
	): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	/** Wrap `sessionManager.buildSessionContext` so each call's caller-visible
	 *  state (the manager's currently-loaded session file) is recorded in
	 *  invocation order. The constructor itself calls `buildSessionContext`
	 *  once; spying *after* construction means only switchSession-driven calls
	 *  are observed. */
	function instrumentBuildSessionContext(sessionManager: SessionManager): {
		calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }>;
		restore: () => void;
	} {
		const calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }> = [];
		const original = sessionManager.buildSessionContext.bind(sessionManager);
		const patched = (options?: BuildSessionContextOptions): SessionContext => {
			calls.push({ sessionFile: sessionManager.getSessionFile(), transcript: options?.transcript });
			return original(options);
		};
		sessionManager.buildSessionContext = patched as SessionManager["buildSessionContext"];
		return {
			calls,
			restore: () => {
				sessionManager.buildSessionContext = original;
			},
		};
	}

	it("skips building the previous display context when switching to a different session", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-different-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(previousSessionFile);
		await otherManager.close();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(targetSessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(targetSessionFile);
		} finally {
			restore();
		}

		// The previous session's display context MUST NOT be materialized. Only
		// the new target context (post-`setSessionFile`) should be built.
		expect(calls).toEqual([{ sessionFile: targetSessionFile!, transcript: undefined }]);
	});

	it("builds the previous display context for same-session reloads", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-reload-");
		const workspaceDir = TempDir.createSync("@pi-switch-prev-ctx-workspace-");
		tempDirs.push(tempDir, workspaceDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeString();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(sessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			restore();
		}

		expect(
			session.agent.state.messages.some(message => message.role === "user" && message.content === "current"),
		).toBe(true);
		await sessionManager.addWorkspaceDirectory(workspaceDir.path());
		await sessionManager.flush();
		const reopened = await SessionManager.open(sessionFile!);
		try {
			expect(reopened.getAdditionalDirectories()).toEqual([workspaceDir.path()]);
		} finally {
			await reopened.close();
		}

		// Same-session reload must snapshot the pre-reload context so
		// `#didSessionMessagesChange` can detect rollback edits.
		expect(calls).toEqual([
			{ sessionFile: sessionFile!, transcript: undefined },
			{ sessionFile: sessionFile!, transcript: undefined },
		]);
	});

	it.each(["id", "cwd"] as const)(
		"rejects callback-free same-path switches when the header %s changes",
		async changedField => {
			const homeDir = TempDir.createSync(`@pi-switch-same-path-${changedField}-home-`);
			const executionDir = TempDir.createSync(`@pi-switch-same-path-${changedField}-execution-`);
			const foreignDir = TempDir.createSync(`@pi-switch-same-path-${changedField}-foreign-`);
			tempDirs.push(homeDir, executionDir, foreignDir);

			const { session, sessionManager } = buildSession(homeDir);
			sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
			await sessionManager.ensureOnDisk();
			sessionManager.setCwdWithoutRelocation(executionDir.path());
			const sessionFile = sessionManager.getSessionFile();
			expect(sessionFile).toBeString();
			const originalSessionId = sessionManager.getSessionId();
			const originalBytes = await Bun.file(sessionFile!).text();
			const lines = originalBytes.split("\n");
			const headerIndex = lines.findIndex(line => {
				try {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					return parsed.type === "session";
				} catch {
					return false;
				}
			});
			if (headerIndex === -1) throw new Error("Expected a generated session header");
			const header = JSON.parse(lines[headerIndex]!) as Record<string, unknown>;
			if (changedField === "id") {
				header.id = `${String(header.id)}-replacement`;
			} else {
				header.cwd = foreignDir.path();
			}
			lines[headerIndex] = JSON.stringify(header);
			await Bun.write(sessionFile!, lines.join("\n"));

			try {
				expect(await session.switchSession(sessionFile!)).toBe(false);
				expect(session.sessionId).toBe(originalSessionId);
				expect(sessionManager.getSessionId()).toBe(originalSessionId);
				expect(sessionManager.getSessionHome()).toBe(homeDir.path());
				expect(sessionManager.getCwd()).toBe(executionDir.path());
				expect(sessionManager.getSessionFile()).toBe(sessionFile);
			} finally {
				await Bun.write(sessionFile!, originalBytes);
			}
		},
	);

	it("restores the previous session when cwd adoption is rejected", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-cwd-source-");
		const targetDir = TempDir.createSync("@pi-switch-cwd-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(previousSessionFile).toBeString();
		expect(targetSessionFile).toBeString();

		const onCwdChange = vi.fn(async () => false);
		const switched = await session.switchSession(targetSessionFile!, { onCwdChange });

		expect(switched).toBe(false);
		expect(onCwdChange).toHaveBeenCalledWith(targetDir.path(), sourceDir.path());
		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
	});
	it("rejects callback-free switches across project directories", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-no-callback-source-");
		const targetDir = TempDir.createSync("@pi-switch-no-callback-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();

		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();

		const switched = await session.switchSession(targetSessionFile!);

		expect(switched).toBe(false);
		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
	});
	it("adopts a foreign replica without changing the local cwd", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-collab-source-");
		const targetDir = TempDir.createSync("@pi-switch-collab-target-");
		const extraDir = TempDir.createSync("@pi-switch-collab-extra-");
		tempDirs.push(sourceDir, targetDir, extraDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "host snapshot", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(targetSessionFile).toBeString();

		const processCwd = process.cwd();
		const onCwdChange = vi.fn(async () => {
			throw new Error("collab must not invoke cwd callback");
		});
		const switched = await session.switchSession(targetSessionFile!, {
			preserveLocalCwd: true,
			onCwdChange,
		});

		expect(switched).toBe(true);
		expect(onCwdChange).not.toHaveBeenCalled();
		expect(process.cwd()).toBe(processCwd);
		expect(sessionManager.getSessionFile()).toBe(targetSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
		expect(sessionManager.getRecordedCwd()).toBe(targetDir.path());
		await sessionManager.addWorkspaceDirectory(extraDir.path());
		expect(await Bun.file(targetSessionFile!).text()).not.toContain(extraDir.path());
	});

	it("fails closed when cwd rollback throws after changing it", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-cwd-error-source-");
		const targetDir = TempDir.createSync("@pi-switch-cwd-error-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(targetSessionFile).toBeString();

		let actualCwd = sourceDir.path();
		let callbackCount = 0;
		const onCwdChange = vi.fn(async (newCwd: string, _previousCwd: string) => {
			actualCwd = newCwd;
			const call = callbackCount++;
			if (call === 0) throw new Error("settings reload failed");
			if (call === 1) throw new Error("cwd restore denied");
			return true;
		});

		await expect(session.switchSession(targetSessionFile!, { onCwdChange })).rejects.toThrow(
			/settings reload failed.*cwd restore denied.*process may remain in/,
		);

		expect(actualCwd).toBe(sourceDir.path());
		expect(onCwdChange).toHaveBeenCalledTimes(2);
		expect(onCwdChange).toHaveBeenNthCalledWith(2, sourceDir.path(), targetDir.path());
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
		expect(session.isDisposed).toBe(true);
	});
	it("rejects reload when the session-before-switch hook cancels", async () => {
		const homeDir = TempDir.createSync("@pi-switch-reload-cancel-home-");
		const executionDir = TempDir.createSync("@pi-switch-reload-cancel-execution-");
		tempDirs.push(homeDir, executionDir);

		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_switch",
			emit,
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(homeDir, extensionRunner);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		sessionManager.setCwdWithoutRelocation(executionDir.path());
		const sessionFile = session.sessionFile;
		const sessionId = session.sessionId;
		expect(sessionFile).toBeString();

		await expect(session.reload()).rejects.toBeInstanceOf(Error);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "session_before_switch", targetSessionFile: sessionFile }),
		);
		expect(session.sessionId).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
		expect(sessionManager.getSessionId()).toBe(sessionId);
		expect(sessionManager.getSessionHome()).toBe(homeDir.path());
		expect(sessionManager.getRecordedCwd()).toBe(homeDir.path());
		expect(sessionManager.getCwd()).toBe(executionDir.path());
		expect(sessionManager.getSessionFile()).toBe(sessionFile);
	});
});
