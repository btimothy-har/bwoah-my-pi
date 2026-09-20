/**
 * Execution-directory binding persistence (`/wt` execution-only activation).
 *
 * `SessionManager.setExecutionCwd` binds the live execution directory (E)
 * without relocating the canonical session home (H): the header carries
 * `executionCwd`, the transcript and artifacts stay in the home bucket, and
 * minted conversations (`/new`, `/fork`, `/branch`) anchor at H and carry a
 * live binding forward.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("worktree execution binding", () => {
	let root: string;

	afterEach(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	async function makeManager(): Promise<SessionManager> {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const home = path.join(root, "home");
		const sessions = path.join(root, "sessions");
		await fs.mkdir(home, { recursive: true });
		return SessionManager.create(home, sessions);
	}

	async function makeWorktree(): Promise<string> {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const worktree = path.join(root, "wt");
		await fs.mkdir(worktree, { recursive: true });
		return worktree;
	}

	it("persists a header-only activation so a fresh open of the same transcript restores the binding", async () => {
		const manager = await makeManager();
		const worktree = await makeWorktree();
		await manager.setExecutionCwd(worktree);

		// Header-only session: the activation survived an immediate exit/resume.
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getExecutionCwd()).toBe(worktree);
		expect(reopened.getCwd()).toBe(worktree);
		expect(reopened.getSessionHome()).toBe(manager.getSessionHome());
		await reopened.close();
		await manager.close();
	});

	it("keeps the binding on a same-context reload and anchors minted new/fork/branch headers at the home", async () => {
		const manager = await makeManager();
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await manager.rewriteEntries();
		const worktree = await makeWorktree();
		await manager.setExecutionCwd(worktree);

		// Same-context reload: unchanged identity + binding must not reset E to H.
		await manager.setSessionFile(manager.getSessionFile()!);
		expect(manager.getExecutionCwd()).toBe(worktree);
		expect(manager.getCwd()).toBe(worktree);

		const home = manager.getSessionHome();
		const expectBoundHeader = async (file: string | undefined): Promise<void> => {
			if (!file) throw new Error("expected a persisted session");
			const reopened = await SessionManager.open(file);
			try {
				expect(reopened.getSessionHome()).toBe(home);
				expect(reopened.getExecutionCwd()).toBe(worktree);
				expect(reopened.getCwd()).toBe(worktree);
			} finally {
				await reopened.close();
			}
		};

		// Branch and fork mint from the bound conversation; /new starts a fresh
		// conversation under the same home and binding.
		await expectBoundHeader((await manager.fork())?.newSessionFile);
		const leafId = manager.getLeafId();
		if (!leafId) throw new Error("expected a branchable user entry");
		await expectBoundHeader(manager.createBranchedSession(leafId));
		await expectBoundHeader(await manager.newSession());
		await manager.close();
	});

	it("clears the binding when execution is re-anchored onto the active worktree via moveTo", async () => {
		const manager = await makeManager();
		const worktree = await makeWorktree();
		await manager.setExecutionCwd(worktree);

		// `/move .` on a bound session is an explicit re-anchoring request:
		// H re-homes onto the worktree and the binding dissolves.
		await manager.moveTo(worktree);
		expect(manager.getSessionHome()).toBe(worktree);
		expect(manager.getCwd()).toBe(worktree);
		expect(manager.getExecutionCwd()).toBeUndefined();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		try {
			expect(reopened.getExecutionCwd()).toBeUndefined();
			expect(reopened.getSessionHome()).toBe(worktree);
		} finally {
			await reopened.close();
		}
		await manager.close();
	});
});
