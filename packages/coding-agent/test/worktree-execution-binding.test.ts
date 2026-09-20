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
import * as vcs from "@oh-my-pi/pi-natives/vcs";

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

	/** Only `git init` lacks a native facade API; config and the seed commit go through the VCS natives. */
	async function gitCli(cwd: string, ...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
		return stdout.trim();
	}

	async function initRepoAt(dir: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
		await gitCli(dir, "init", "-q", "-b", "main");
		const repo = vcs.git(dir);
		if (!repo) throw new Error(`git repository not discovered at ${dir}`);
		await repo.configSet("user.email", "test@example.com");
		await repo.configSet("user.name", "test");
		await Bun.write(path.join(dir, "README.md"), "seed\n");
		await repo.stageFiles(["README.md"]);
		await repo.commitCreate("init", {});
	}

	async function makeLinkedWorktree(homeDir: string, worktreePath: string, branch: string): Promise<void> {
		const repo = vcs.git(homeDir);
		if (!repo) throw new Error(`git repository not discovered at ${homeDir}`);
		await repo.createBranch(branch, "HEAD", false);
		await repo.worktreeAdd(worktreePath, branch, { detach: false, clone: false });
	}

	async function removeWorktree(homeDir: string, worktreePath: string): Promise<void> {
		const repo = vcs.git(homeDir);
		if (!repo) throw new Error(`git repository not discovered at ${homeDir}`);
		await repo.worktreeRemove(worktreePath, true);
		await fs.rm(worktreePath, { recursive: true, force: true });
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

	it("binds a linked worktree of the home repository: reopen, branch switch, and symlink alias keep the binding", async () => {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const home = path.join(root, "home");
		await initRepoAt(home);
		const worktree = path.join(root, "wt");
		await makeLinkedWorktree(home, worktree, "feature/x");

		const manager = SessionManager.create(home, path.join(root, "sessions"));
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile()!;
		await manager.setExecutionCwd(worktree);
		await manager.close();

		// Fresh open: the binding is live at the worktree while the home,
		// session id, transcript, and artifact location all stay anchored at H.
		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.getCwd()).toBe(worktree);
			expect(reopened.getExecutionCwd()).toBe(worktree);
			expect(reopened.getSessionHome()).toBe(home);
			expect(reopened.getSessionId()).toBe(sessionId);
			expect(reopened.getSessionFile()).toBe(sessionFile);
			// Transcript bytes preserved: the header still names the same session.
			expect(await Bun.file(sessionFile).text()).toContain(sessionId);
		} finally {
			await reopened.close();
		}

		// Branch identity is not repository identity: another branch checked
		// out in the worktree does not invalidate the binding.
		const linked = vcs.git(worktree);
		if (!linked) throw new Error("git repository not discovered at worktree");
		await linked.checkoutNewBranch("develop");
		const onDevelop = await SessionManager.open(sessionFile);
		try {
			expect(onDevelop.getCwd()).toBe(worktree);
			expect(onDevelop.getExecutionCwd()).toBe(worktree);
		} finally {
			await onDevelop.close();
		}

		// A symlink alias of the worktree must not produce a false mismatch.
		const alias = path.join(root, "wt-alias");
		await fs.symlink(worktree, alias);
		const aliased = await SessionManager.open(sessionFile);
		try {
			await aliased.setExecutionCwd(alias);
			expect(aliased.getExecutionCwd()).toBe(alias);
			expect(aliased.getCwd()).toBe(alias);
		} finally {
			await aliased.close();
		}
	});

	it("falls back to the home when the saved execution path is replaced by an independent repository", async () => {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const home = path.join(root, "home");
		await initRepoAt(home);
		const worktree = path.join(root, "wt");
		await makeLinkedWorktree(home, worktree, "feature/x");

		const manager = SessionManager.create(home, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await manager.rewriteEntries();
		const sessionFile = manager.getSessionFile()!;
		const artifactDir = sessionFile.slice(0, -".jsonl".length);
		const artifactFile = path.join(artifactDir, "artifact.txt");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(artifactFile, "keep\n");
		await manager.setExecutionCwd(worktree);
		await manager.close();

		// Remove the disposable linked checkout and put an independent
		// repository at the same path.
		await removeWorktree(home, worktree);
		await initRepoAt(worktree);

		const fallbacks: Array<{ missingCwd: string; home: string }> = [];
		const reopened = await SessionManager.open(sessionFile);
		reopened.onExecutionCwdFallback(fallback => fallbacks.push(fallback));
		try {
			// The conversation runs at the canonical home; the foreign path is
			// declined and retained only as a recorded, unusable binding.
			expect(reopened.getCwd()).toBe(home);
			expect(reopened.getSessionHome()).toBe(home);
			expect(reopened.getExecutionCwd()).toBe(worktree);
			expect(fallbacks).toEqual([{ missingCwd: worktree, home }]);
			expect(reopened.getEntries().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(
				true,
			);
			expect(await Bun.file(artifactFile).text()).toBe("keep\n");
			// Startup re-adoption must not resurrect the foreign binding.
			reopened.adoptRecordedCwd();
			expect(reopened.getCwd()).toBe(home);
		} finally {
			await reopened.close();
		}

		// The replacement repository was not provisioned over and the source
		// checkout is intact.
		expect(vcs.git(worktree)).not.toBeNull();
		expect(await Bun.file(path.join(home, "README.md")).text()).toBe("seed\n");
	});

	it("declines restoration when the saved execution path is missing or holds no repository", async () => {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const home = path.join(root, "home");
		await initRepoAt(home);
		const worktree = path.join(root, "wt");
		await makeLinkedWorktree(home, worktree, "feature/x");

		const manager = SessionManager.create(home, path.join(root, "sessions"));
		const sessionFile = manager.getSessionFile()!;
		await manager.setExecutionCwd(worktree);
		await manager.close();

		// Missing E: fall back to the home, keep the saved field for diagnosis,
		// and never recreate the worktree.
		await removeWorktree(home, worktree);
		const missingFallbacks: Array<{ missingCwd: string; home: string }> = [];
		const missing = await SessionManager.open(sessionFile);
		missing.onExecutionCwdFallback(fallback => missingFallbacks.push(fallback));
		try {
			expect(missing.getCwd()).toBe(home);
			expect(missing.getExecutionCwd()).toBe(worktree);
			expect(missingFallbacks).toEqual([{ missingCwd: worktree, home }]);
			await expect(fs.stat(worktree)).rejects.toThrow();
			expect(vcs.git(home)).not.toBeNull();
		} finally {
			await missing.close();
		}

		// Enterable but non-Git E: still declined for a Git-backed home, and no
		// repository gets provisioned at the path.
		await fs.mkdir(worktree, { recursive: true });
		const plainFallbacks: Array<{ missingCwd: string; home: string }> = [];
		const plain = await SessionManager.open(sessionFile);
		plain.onExecutionCwdFallback(fallback => plainFallbacks.push(fallback));
		try {
			expect(plain.getCwd()).toBe(home);
			expect(plain.getExecutionCwd()).toBe(worktree);
			expect(plainFallbacks).toEqual([{ missingCwd: worktree, home }]);
			expect(vcs.git(worktree)).toBeNull();
			expect(vcs.git(home)).not.toBeNull();
			expect(await Bun.file(path.join(home, "README.md")).text()).toBe("seed\n");
		} finally {
			await plain.close();
		}
	});

	it("rejects binding execution to an independent repository and keeps the prior binding", async () => {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const home = path.join(root, "home");
		await initRepoAt(home);
		const worktree = path.join(root, "wt");
		await makeLinkedWorktree(home, worktree, "feature/x");
		const foreign = path.join(root, "foreign");
		await initRepoAt(foreign);

		const manager = SessionManager.create(home, path.join(root, "sessions"));
		await manager.setExecutionCwd(worktree);

		await expect(manager.setExecutionCwd(foreign)).rejects.toThrow(
			"Execution directory could not be verified as belonging to the session repository",
		);

		// The failed attempt mutated nothing: the prior valid binding is intact
		// and still restores.
		expect(manager.getCwd()).toBe(worktree);
		expect(manager.getExecutionCwd()).toBe(worktree);
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		try {
			expect(reopened.getExecutionCwd()).toBe(worktree);
			expect(reopened.getCwd()).toBe(worktree);
			expect(reopened.getSessionHome()).toBe(home);
		} finally {
			await reopened.close();
		}

		// Selecting the home still clears the binding.
		await manager.setExecutionCwd(home);
		expect(manager.getExecutionCwd()).toBeUndefined();
		expect(manager.getCwd()).toBe(home);
		await manager.close();
	});

	it("restores through a different-context setSessionFile against the loaded header's home", async () => {
		root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-exec-binding-"));
		const homeA = path.join(root, "home-a");
		const homeB = path.join(root, "home-b");
		await initRepoAt(homeA);
		await initRepoAt(homeB);
		const worktreeA = path.join(root, "wt-a");
		await makeLinkedWorktree(homeA, worktreeA, "feature/a");

		const managerA = SessionManager.create(homeA, path.join(root, "sessions-a"));
		managerA.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await managerA.rewriteEntries();
		await managerA.setExecutionCwd(worktreeA);
		const fileA = managerA.getSessionFile()!;
		await managerA.close();

		// Replace A's worktree with a foreign repository, then hand the
		// transcript to a manager currently living in a different repository.
		await removeWorktree(homeA, worktreeA);
		await initRepoAt(worktreeA);

		const managerB = SessionManager.create(homeB, path.join(root, "sessions-b"));
		const fallbacks: Array<{ missingCwd: string; home: string }> = [];
		managerB.onExecutionCwdFallback(fallback => fallbacks.push(fallback));
		try {
			await managerB.setSessionFile(fileA);
			// The loaded header's home was adopted, not the previous home; the
			// foreign execution path was declined against that loaded home.
			expect(managerB.getSessionHome()).toBe(homeA);
			expect(managerB.getCwd()).toBe(homeA);
			expect(managerB.getExecutionCwd()).toBe(worktreeA);
			expect(fallbacks).toEqual([{ missingCwd: worktreeA, home: homeA }]);
		} finally {
			await managerB.close();
		}
	});
});
