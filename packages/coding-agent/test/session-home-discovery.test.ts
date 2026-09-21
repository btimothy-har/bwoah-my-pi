/**
 * Canonical-home discovery vs execution-root routing (H/E split).
 *
 * A `/wt`-bound session must keep harness discovery — context files, skills,
 * project settings, agents — anchored at the session home (H) while native
 * tools execute in the bound worktree (E). Divergent H/E fixtures make the
 * split observable: H markers must appear, E markers must not, and a relative
 * native read must land in E.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const HOME_CONTEXT = "HOME-CONTEXT-MARKER-ONLY";
const EXEC_CONTEXT = "EXECUTION-CONTEXT-MARKER-ONLY";
const HOME_SENTINEL = "HOME file content\n";
const EXEC_SENTINEL = "EXECUTION file content\n";

let root: string;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
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
