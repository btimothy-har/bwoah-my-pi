/**
 * Canonical-home discovery vs execution-root routing (H/E split).
 *
 * A `/wt`-bound session must keep harness discovery — context files, skills,
 * project settings, agents — anchored at the session home (H) while native
 * tools execute in the bound worktree (E). Divergent H/E fixtures make the
 * split observable: H markers must appear, E markers must not, and a relative
 * native read must land in E.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createSessionDefaults } from "./helpers/session-defaults";

const HOME_CONTEXT = "HOME-CONTEXT-MARKER-ONLY";
const EXEC_CONTEXT = "EXECUTION-CONTEXT-MARKER-ONLY";
const HOME_SENTINEL = "HOME file content\n";
const EXEC_SENTINEL = "EXECUTION file content\n";

let root: string;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = "";
});

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
	await Bun.write(path.join(dir, "sentinel.txt"), "seed\n");
	await repo.stageFiles(["sentinel.txt"]);
	await repo.commitCreate("init", {});
}

async function makeLinkedWorktree(homeDir: string, worktreePath: string, branch: string): Promise<void> {
	const repo = vcs.git(homeDir);
	if (!repo) throw new Error(`git repository not discovered at ${homeDir}`);
	await repo.createBranch(branch, "HEAD", false);
	await repo.worktreeAdd(worktreePath, branch, { detach: false, clone: false });
}

interface SplitFixture {
	home: string;
	execution: string;
	sessionManager: SessionManager;
	session: AgentSession;
	sessionFile: string;
}

async function createBoundSession(): Promise<SplitFixture> {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-discovery-"));
	const home = path.join(root, "home");
	const execution = path.join(root, "worktree");
	const sessions = path.join(root, "sessions");
	const agentDir = path.join(root, "agent");
	await initRepoAt(home);
	await makeLinkedWorktree(home, execution, "feature/exec");
	// Divergent configuration: only H markers may reach the session.
	await Bun.write(path.join(home, "AGENTS.md"), HOME_CONTEXT);
	await Bun.write(path.join(execution, "AGENTS.md"), EXEC_CONTEXT);
	await Bun.write(path.join(home, "sentinel.txt"), HOME_SENTINEL);
	await Bun.write(path.join(execution, "sentinel.txt"), EXEC_SENTINEL);
	await Bun.write(
		path.join(home, ".omp", "skills", "home-skill", "SKILL.md"),
		"---\nname: home-skill\ndescription: Home-scoped skill.\n---\nbody\n",
	);
	await Bun.write(
		path.join(execution, ".omp", "skills", "execution-skill", "SKILL.md"),
		"---\nname: execution-skill\ndescription: Execution-scoped skill.\n---\nbody\n",
	);

	const sessionManager = SessionManager.create(home, sessions);
	await sessionManager.setExecutionCwd(execution);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");

	const authStorage = createInMemoryAuthStorage();
	const { session } = await createAgentSession({
		agentDir,
		sessionManager,
		modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
		model: getBundledModel("openai", "gpt-4o-mini"),
		settings: undefined,
		skills: undefined,
		disableExtensionDiscovery: true,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read"],
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	return { home, execution, sessionManager, session, sessionFile };
}

describe("session-home discovery", () => {
	it("discovers instructions and skills from the home while native tools execute in the worktree", async () => {
		const { session } = await createBoundSession();

		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(HOME_CONTEXT);
		expect(prompt).not.toContain(EXEC_CONTEXT);
		expect(session.skills.map(skill => skill.name)).toContain("home-skill");
		expect(session.skills.map(skill => skill.name)).not.toContain("execution-skill");

		const readTool = session.getToolByName("read");
		if (!readTool) throw new Error("Expected native read tool");
		const result = await readTool.execute("home-discovery-read", { path: "sentinel.txt" });
		expect(result.isError).not.toBe(true);
		const text = result.content
			.filter(item => item.type === "text")
			.map(item => item.text)
			.join("\n");
		expect(text).toContain(EXEC_SENTINEL.trim());
		expect(text).not.toContain(HOME_SENTINEL.trim());
	});

	it("keeps the home's context after refresh; execution-only edits are not promoted", async () => {
		const { home, execution, session } = await createBoundSession();
		expect(session.systemPrompt.join("\n")).toContain(HOME_CONTEXT);

		// Editing only the worktree's instructions must not reach the prompt.
		await Bun.write(path.join(execution, "AGENTS.md"), `${EXEC_CONTEXT}-updated`);
		await session.refreshSkills();
		let prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(HOME_CONTEXT);
		expect(prompt).not.toContain(`${EXEC_CONTEXT}-updated`);

		// Editing the home's instructions refreshes into the prompt.
		await Bun.write(path.join(home, "AGENTS.md"), `${HOME_CONTEXT}-updated`);
		await session.refreshSkills();
		prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(`${HOME_CONTEXT}-updated`);
		expect(prompt).not.toContain(HOME_CONTEXT + "\n");
	});

	it("reopens with the same split: persisted binding restores E, discovery stays at H", async () => {
		const first = await createBoundSession();
		await first.session.dispose();
		cleanups.length = 0;

		const reopenedManager = await SessionManager.open(first.sessionFile);
		expect(reopenedManager.getCwd()).toBe(first.execution);
		expect(reopenedManager.getSessionHome()).toBe(first.home);

		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			agentDir: path.join(root, "agent"),
			sessionManager: reopenedManager,
			modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});

		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(HOME_CONTEXT);
		expect(prompt).not.toContain(EXEC_CONTEXT);
		expect(session.skills.map(skill => skill.name)).toContain("home-skill");
	});
});

describe("native child H/E bootstrap", () => {
	const childAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	function mockChildSession() {
		const session = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-ok",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				} as AgentSessionEvent);
				return () => {};
			},
			prompt: async () => true,
		};
		return session as unknown as AgentSession;
	}

	function mockAgentSdk() {
		return vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					session: mockChildSession(),
					extensionsResult: {} as unknown as LoadExtensionsResult,
					setToolUIContext: () => {},
					eventBus: new EventBus(),
				}) satisfies CreateAgentSessionResult,
		);
	}

	it("anchors a fresh child at the parent home with a durable execution binding", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-child-roots-"));
		const home = path.join(root, "home");
		const execution = path.join(root, "worktree");
		await initRepoAt(home);
		await makeLinkedWorktree(home, execution, "feature/child");

		const parent = SessionManager.create(home, path.join(root, "sessions"));
		await parent.setExecutionCwd(execution);
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Expected a persisted parent session");
		const parentArtifacts = parentFile.slice(0, -6);

		mockAgentSdk();
		const result = await runSubprocess({
			cwd: execution,
			sessionHome: home,
			agent: childAgent,
			task: "do work",
			index: 0,
			id: "child-rooted",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			sessionFile: parentFile,
			artifactsDir: parentArtifacts,
		});
		expect(result.aborted).toBe(false);

		const childFile = path.join(parentArtifacts, "child-rooted.jsonl");
		const header = (await loadEntriesFromFile(childFile)).find(entry => entry.type === "session");
		if (!header) throw new Error("Expected a child session header");
		expect(header.cwd).toBe(path.resolve(home));
		expect(header.executionCwd).toBe(execution);
		expect(header.parentSession).toBe(parentFile);

		// A later parent rebind must not rewrite the child's recorded roots.
		await parent.setExecutionCwd(home);
		const reopened = await SessionManager.open(childFile);
		try {
			expect(reopened.getSessionHome()).toBe(path.resolve(home));
			expect(reopened.getCwd()).toBe(execution);
			expect(reopened.getExecutionCwd()).toBe(execution);
		} finally {
			await reopened.close();
		}
		await parent.close();
	});

	it("binds native isolation for the live process only and keeps the generic guard", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-child-iso-"));
		const home = path.join(root, "home");
		const isolation = path.join(root, "isolated");
		await initRepoAt(home);
		await fs.mkdir(isolation, { recursive: true });

		// Generic caller: a detached/plain directory is not a verified worktree.
		const generic = SessionManager.create(home, path.join(root, "sessions-generic"));
		await expect(generic.setExecutionCwd(isolation)).rejects.toThrow("could not be verified");
		await generic.close();

		// Trusted executor handoff: live-only binding, nothing persisted.
		const manager = SessionManager.create(home, path.join(root, "sessions"));
		await manager.setExecutionCwd(isolation, { isolatedTaskRoot: isolation });
		expect(manager.getCwd()).toBe(isolation);
		expect(manager.getSessionHome()).toBe(path.resolve(home));
		expect(manager.getExecutionCwd()).toBeUndefined();
		await manager.close();
		const header = (await loadEntriesFromFile(manager.getSessionFile()!)).find(entry => entry.type === "session");
		expect(header?.executionCwd).toBeUndefined();

		// The token path rejects mismatched roots and existing durable bindings.
		await expect(
			SessionManager.inMemory(home).setExecutionCwd(isolation, { isolatedTaskRoot: path.join(root, "other") }),
		).rejects.toThrow("could not be verified");
		const bound = SessionManager.create(home, path.join(root, "sessions-bound"));
		const linked = path.join(root, "linked");
		await makeLinkedWorktree(home, linked, "feature/bound");
		await bound.setExecutionCwd(linked);
		await expect(bound.setExecutionCwd(isolation, { isolatedTaskRoot: isolation })).rejects.toThrow(
			"durable execution binding",
		);
		await bound.close();
	});

	it("never reseeds an existing child header from newer caller roots", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-child-reseed-"));
		const home = path.join(root, "home");
		const execution = path.join(root, "worktree");
		const sessions = path.join(root, "sessions");
		await initRepoAt(home);
		await makeLinkedWorktree(home, execution, "feature/existing");
		const childFile = path.join(sessions, "child.jsonl");

		const created = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: home,
			initialExecutionCwd: execution,
			parentSession: path.join(sessions, "parent.jsonl"),
			suppressBreadcrumb: true,
		});
		await created.close();

		const otherHome = path.join(root, "other-home");
		await initRepoAt(otherHome);
		const reopened = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: otherHome,
			initialExecutionCwd: otherHome,
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getSessionHome()).toBe(path.resolve(home));
			expect(reopened.getExecutionCwd()).toBe(execution);
			expect(reopened.getCwd()).toBe(execution);
		} finally {
			await reopened.close();
		}
	});
});
