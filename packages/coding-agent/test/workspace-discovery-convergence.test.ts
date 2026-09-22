/**
 * Baseline reproduction for the TUI task-agent roster convergence gap
 * (bwoah-my-pi issue #9): the model-visible task tool roster must follow the
 * resolved execution workspace across TUI cwd transitions.
 *
 * The harness drives the real TUI transition surface: a real SDK
 * `AgentSession` (task tool active, MCP/LSP/extensions disabled) wrapped in a
 * real `InteractiveMode` that is never given an input loop, and a provider
 * `Context` capture via `registerCustomApi`. The task tool's description is
 * copied at provider invocation time — never read from the live object after
 * the fact. Nothing here stubs `applyCwdChange`, `refreshAgentDiscovery`,
 * `TaskTool.description`, or provider tool serialization.
 *
 * On the current baseline `InteractiveMode.applyCwdChange()` rescopes
 * settings, skills, and slash commands but never publishes a discovery
 * snapshot for the new root, so `TaskTool.description` keeps falling back to
 * its construction-time roster. The E2 and /move assertions below fail on
 * that baseline by design.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPPrompt, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { PROBE_TOOL_NAME } from "./fixtures/workspace-probe-mcp";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { getThemeByName, initTheme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const API_ID = "test-roster-convergence";

/** OMP-native task agent definition, same shape as test/task/discovery.test.ts. */
function agentMd(name: string): string {
	return ["---", `name: ${name}`, `description: ${name} probe agent.`, "---", `body ${name}`].join("\n");
}

async function writeAgent(dir: string, name: string): Promise<void> {
	await fs.mkdir(path.join(dir, ".omp", "agents"), { recursive: true });
	await fs.writeFile(path.join(dir, ".omp", "agents", `${name}.md`), agentMd(name));
}

describe("workspace discovery convergence: TUI task roster", () => {
	let root: string;
	let home: string;
	let e1: string;
	let e2: string;
	let moveTarget: string;
	let contexts: Context[];
	let taskDescriptions: Array<string | undefined>;
	let toolNames: string[];
	let originalProjectDir: string;
	let harness:
		| {
				session: AgentSession;
				manager: SessionManager;
				mode: InteractiveMode;
				authStorage: AuthStorage;
		  }
		| undefined;

	beforeAll(async () => {
		initTheme();
		const theme = await getThemeByName("dark");
		if (theme) setThemeInstance(theme);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		originalProjectDir = getProjectDir();

		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws-convergence-")));
		home = path.join(root, "home");
		e1 = path.join(root, "wt-e1");
		e2 = path.join(root, "wt-e2");
		moveTarget = path.join(root, "move-target");

		// Canonical home repo with two linked worktrees, as in
		// test/cwd-workspace-reminder.test.ts.
		await fs.mkdir(home, { recursive: true });
		const gitCli = async (...args: string[]) => {
			const proc = Bun.spawn(["git", ...args], { cwd: home, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
			return stdout.trim();
		};
		await gitCli("init", "-q", "-b", "main");
		const repo = vcs.git(home);
		if (!repo) throw new Error(`git repository not discovered at ${home}`);
		await repo.configSet("user.email", "test@example.com");
		await repo.configSet("user.name", "test");
		await Bun.write(path.join(home, "README.md"), "seed\n");
		await repo.stageFiles(["README.md"]);
		await repo.commitCreate("init", {});
		await repo.createBranch("probe/e1", "HEAD", false);
		await repo.worktreeAdd(e1, "probe/e1", { detach: false, clone: false });
		await repo.createBranch("probe/e2", "HEAD", false);
		await repo.worktreeAdd(e2, "probe/e2", { detach: false, clone: false });

		await fs.mkdir(moveTarget, { recursive: true });
		await writeAgent(e1, "e1-only");
		await writeAgent(e2, "e2-only");
		await writeAgent(moveTarget, "m-only");

		// Provider-side Context capture: copy the task tool description at
		// invocation time rather than inspecting a mutated live object later.
		contexts = [];
		taskDescriptions = [];
		toolNames = [];
		registerCustomApi(API_ID, (_model, context) => {
			contexts.push(context);
			taskDescriptions.push(context.tools?.find(tool => tool.name === "task")?.description);
			toolNames.push((context.tools ?? []).map(tool => tool.name).join(","));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (harness) {
			harness.mode.stop();
			await harness.session.dispose();
			harness.authStorage.close();
			harness = undefined;
		}
		setProjectDir(originalProjectDir);
		resetSettingsForTest();
		clearCustomApis();
		await fs.rm(root, { recursive: true, force: true });
		root = undefined as never;
	});

	async function makeHarness(): Promise<NonNullable<typeof harness>> {
		const manager = SessionManager.create(home, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await manager.ensureOnDisk();
		// Construct the session at E1 via its execution binding so the tool
		// session cwd — and therefore TaskTool's construction-time discovery —
		// resolves to E1.
		await manager.setExecutionCwd(e1);

		await Settings.init({ inMemory: true, cwd: e1 });
		const authStorage = await AuthStorage.create(path.join(root, `auth-${Snowflake.next()}.db`));
		const model = buildModel({
			id: "roster-probe",
			name: "Roster probe",
			api: API_ID,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));

		const { session } = await createAgentSession({
			cwd: e1,
			agentDir: root,
			sessionManager: manager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		// Real InteractiveMode without its input loop, following
		// test/btw-session-lifecycle.test.ts.
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		mode.ui.setFocus = vi.fn();
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(
			() =>
				({
					hide: vi.fn(),
					setHidden: vi.fn(),
					isHidden: () => false,
				}) as never,
		);
		vi.spyOn(mode, "renderInitialMessages").mockResolvedValue(undefined);
		vi.spyOn(mode, "reloadTodos").mockResolvedValue(undefined);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showError").mockImplementation(() => {});

		harness = { session, manager, mode, authStorage };
		return harness;
	}

	/** Send one user turn and return the task tool description captured at provider invocation. */
	async function promptAndCapture(session: AgentSession): Promise<string | undefined> {
		const index = taskDescriptions.length;
		await session.sendUserMessage("probe the task roster");
		const description = taskDescriptions[index];
		expect(description).toBeDefined();
		return description;
	}

	it("refreshes the roster after the TUI execution-worktree transition to E2", async () => {
		const { session, manager, mode } = await makeHarness();
		const before = await promptAndCapture(session);
		expect(before).toContain("e1-only");

		// The same TUI transition `/wt` performs: bind E on the session
		// manager, then rescope the interactive mode to the new root.
		await session.setExecutionCwd(e2);
		const applied = await mode.applyCwdChange(e2);
		expect(applied).toBe(true);
		expect(manager.getSessionHome()).toBe(home);
		expect(manager.getExecutionCwd()).toBe(path.resolve(e2));

		const after = await promptAndCapture(session);
		expect(after).toContain("e2-only");
		expect(after).not.toContain("e1-only");
	});

	it("refreshes the roster after CommandController.handleMoveCommand relocation", async () => {
		const { session, manager, mode } = await makeHarness();
		const before = await promptAndCapture(session);
		expect(before).toContain("e1-only");

		await new CommandController(mode).handleMoveCommand(moveTarget);

		expect(manager.getSessionHome()).toBe(path.resolve(moveTarget));
		const after = await promptAndCapture(session);
		expect(after).toContain("m-only");
		expect(after).not.toContain("e1-only");
		expect(after).not.toContain("e2-only");
	});

	it("restores the E1 roster when E2 discovery fails during the worktree transaction", async () => {
		const { session, manager, mode } = await makeHarness();
		const before = await promptAndCapture(session);
		expect(before).toContain("e1-only");

		const realDiscoverAgents = taskDiscovery.discoverAgents;
		const discoverySpy = vi.spyOn(taskDiscovery, "discoverAgents").mockImplementation(async (...args: unknown[]) => {
			const [cwd, discoveryHome, extensionRoots] = args as Parameters<typeof realDiscoverAgents>;
			if (path.resolve(cwd) === path.resolve(e2)) {
				throw new Error("injected E2 discovery failure");
			}
			return realDiscoverAgents(cwd, discoveryHome, extensionRoots);
		});
		// Pre-existing E2 is supplied by the probe instead of cloning a new
		// checkout, so the controller still drives its real binding +
		// activation transaction.
		const worktreeSpy = vi
			.spyOn(sessionWorktree, "createSessionWorktree")
			.mockImplementation(async () => ({ path: e2, branch: "probe/e2" }));

		try {
			await new CommandController(mode).handleWorktreeCommand("probe/e2");

			// The failed activation must roll the saved binding back to E1...
			expect(manager.getExecutionCwd()).toBe(path.resolve(e1));
			// ...and the next model request must advertise the E1 roster again.
			const after = await promptAndCapture(session);
			expect(after).toContain("e1-only");
			expect(after).not.toContain("e2-only");
		} finally {
			worktreeSpy.mockRestore();
			discoverySpy.mockRestore();
		}
	});
});

/**
 * MCP publication through the real TUI transition surface: a real SDK session
 * with an SDK-owned MCP manager (`hasUI: true` → deferred startup on the
 * SDK's lifecycle queue) wrapped in a real `InteractiveMode`, driving the
 * workspace-probe stdio fixture. The manager catalog is observed through the
 * session's registered tools and the provider `Context` capture — never
 * through manager-only mocks.
 */
describe("workspace discovery convergence: TUI MCP publication", () => {
	const PROBE_FIXTURE = path.join(import.meta.dir, "fixtures", "workspace-probe-mcp.ts");

	let root: string;
	let home: string;
	let e1: string;
	let e2: string;
	let contexts: Context[];
	let toolNames: string[];
	let originalProjectDir: string;
	let harness:
		| {
				session: AgentSession;
				manager: SessionManager;
				mode: InteractiveMode;
				authStorage: AuthStorage;
				mcp: MCPManager;
		  }
		| undefined;

	function probeConfig(tag: string, markerPath: string): MCPStdioServerConfig {
		return { type: "stdio", command: process.execPath, args: [PROBE_FIXTURE, tag, markerPath], timeout: 10_000 };
	}

	async function writeMcpConfig(dir: string, servers: Record<string, MCPStdioServerConfig>): Promise<void> {
		await Bun.write(getMCPConfigPath("project", dir), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
	}

	let harnessErrors: string[] = [];
	async function pollUntil(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error("pollUntil timed out");
			await Bun.sleep(50);
		}
	}

	beforeAll(async () => {
		initTheme();
		const theme = await getThemeByName("dark");
		if (theme) setThemeInstance(theme);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		MCPManager.resetForTests();
		originalProjectDir = getProjectDir();

		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-convergence-")));
		home = path.join(root, "home");
		e1 = path.join(root, "wt-e1");
		e2 = path.join(root, "wt-e2");

		await fs.mkdir(home, { recursive: true });
		const gitCli = async (...args: string[]) => {
			const proc = Bun.spawn(["git", ...args], { cwd: home, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
			return stdout.trim();
		};
		await gitCli("init", "-q", "-b", "main");
		const repo = vcs.git(home);
		if (!repo) throw new Error(`git repository not discovered at ${home}`);
		await repo.configSet("user.email", "test@example.com");
		await repo.configSet("user.name", "test");
		await Bun.write(path.join(home, "README.md"), "seed\n");
		await repo.stageFiles(["README.md"]);
		await repo.commitCreate("init", {});
		await repo.createBranch("probe/e1", "HEAD", false);
		await repo.worktreeAdd(e1, "probe/e1", { detach: false, clone: false });
		await repo.createBranch("probe/e2", "HEAD", false);
		await repo.worktreeAdd(e2, "probe/e2", { detach: false, clone: false });

		// E1 MCP config with distinct probe servers; the probe tool reports the
		// server process's cwd and the roots it received from the real client.
		await writeMcpConfig(e1, {
			"old-only": probeConfig("e1", path.join(e1, "old-only.marker.json")),
			shared: probeConfig("shared-e1", path.join(e1, "shared.marker.json")),
		});

		// Provider-side Context capture, same seam as the roster describe.
		contexts = [];
		toolNames = [];
		harnessErrors = [];
		registerCustomApi(API_ID, (_model, context) => {
			contexts.push(context);
			toolNames.push((context.tools ?? []).map(tool => tool.name).join(","));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (harness) {
			harness.mode.stop();
			await harness.session.dispose();
			harness.authStorage.close();
			harness = undefined;
		}
		MCPManager.resetForTests();
		setProjectDir(originalProjectDir);
		resetSettingsForTest();
		clearCustomApis();
		await fs.rm(root, { recursive: true, force: true });
		root = undefined as never;
	});

	async function makeMcpHarness(): Promise<NonNullable<typeof harness>> {
		const manager = SessionManager.create(home, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await manager.ensureOnDisk();
		await manager.setExecutionCwd(e1);

		await Settings.init({ inMemory: true, cwd: e1 });
		const authStorage = await AuthStorage.create(path.join(root, `auth-${Snowflake.next()}.db`));
		const model = buildModel({
			id: "mcp-probe",
			name: "MCP probe",
			api: API_ID,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));

		// The stdio transport spawns children at the process project dir; pin it
		// to E1 the way the CLI process would run there.
		setProjectDir(e1);

		// `hasUI: true` selects the SDK's deferred startup discovery: the manager
		// is SDK-owned and every later publication runs on the SDK lifecycle
		// queue — exactly the production TUI shape.
		const { session } = await createAgentSession({
			cwd: e1,
			agentDir: root,
			sessionManager: manager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			hasUI: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
		});

		const mcp = MCPManager.instance();
		if (!mcp) throw new Error("SDK-owned MCP manager not installed as the process-global instance");

		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		mode.ui.setFocus = vi.fn();
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(
			() =>
				({
					hide: vi.fn(),
					setHidden: vi.fn(),
					isHidden: () => false,
				}) as never,
		);
		vi.spyOn(mode, "renderInitialMessages").mockResolvedValue(undefined);
		vi.spyOn(mode, "reloadTodos").mockResolvedValue(undefined);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showError").mockImplementation(message => {
			harnessErrors.push(message);
		});

		harness = { session, manager, mode, authStorage, mcp };
		return harness;
	}

	/** Invoke a registered probe tool and return its JSON payload. */
	async function invokeProbe(mcp: MCPManager, serverName: string): Promise<Record<string, unknown>> {
		const tool = mcp.getTools().find(t => t.name === createMCPToolName(serverName, PROBE_TOOL_NAME));
		if (!tool) throw new Error(`probe tool for "${serverName}" not registered`);
		const result = await tool.execute("probe-call", {}, undefined, undefined as never, undefined);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return JSON.parse(text) as Record<string, unknown>;
	}

	it("republishes MCP tools and roots from E2 after the TUI worktree transition", async () => {
		const { session, mode, mcp } = await makeMcpHarness();

		// Deferred startup discovery lands the E1 catalog on the live session.
		await pollUntil(() => session.getToolByName(createMCPToolName("shared", PROBE_TOOL_NAME)) !== undefined);
		await pollUntil(() => session.getToolByName(createMCPToolName("old-only", PROBE_TOOL_NAME)) !== undefined);
		const before = await invokeProbe(mcp, "shared");
		expect(before.tag).toBe("shared-e1");
		expect(before.cwd).toBe(e1);

		// The same TUI transition `/wt` performs.
		await session.setExecutionCwd(e2);
		await writeMcpConfig(e2, {
			"new-only": probeConfig("e2", path.join(e2, "new-only.marker.json")),
			shared: probeConfig("shared-e2", path.join(e2, "shared-e2.marker.json")),
		});
		const applied = await mode.applyCwdChange(e2);
		expect(applied).toBe(true);

		// The reloaded catalog is E2's, published through the same session tool
		// surface the model sees.
		await pollUntil(() => session.getToolByName(createMCPToolName("new-only", PROBE_TOOL_NAME)) !== undefined);
		expect(session.getToolByName(createMCPToolName("old-only", PROBE_TOOL_NAME))).toBeUndefined();
		const after = await invokeProbe(mcp, "shared");
		expect(after.tag).toBe("shared-e2");
		expect(after.cwd).toBe(e2);
		expect((after.rootsAtCall as { roots: Array<{ uri: string }> }).roots.map(root => root.uri)).toContain(
			`file://${e2}`,
		);

		// MCP tools mount under xd:// devices rather than top-level provider
		// tool names; the session registry is the surface the model reaches.
		expect(session.getToolByName(createMCPToolName("new-only", PROBE_TOOL_NAME))).toBeDefined();
		expect(session.getToolByName(createMCPToolName("old-only", PROBE_TOOL_NAME))).toBeUndefined();
	}, 60_000);

	it("disposal during deferred startup registers no tools and starts no server", async () => {
		const realLoad = mcpConfig.loadAllMCPConfigs;
		const loadStarted = Promise.withResolvers<void>();
		const loadGate = Promise.withResolvers<void>();
		vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockImplementation((...args: Parameters<typeof realLoad>) => {
			loadStarted.resolve();
			return loadGate.promise.then(() => realLoad(...args));
		});

		const { session, mcp } = await makeMcpHarness();
		await loadStarted.promise;

		// Dispose while startup discovery is parked in config loading: the owned
		// abort controller fires, the released load must not start any server,
		// and the queued publication must drop.
		const disposing = session.dispose();
		loadGate.resolve();
		await disposing;
		await mcp.waitForPendingConnections();

		expect(mcp.getConnectedServers()).toEqual([]);
		expect(mcp.getTools()).toEqual([]);
		expect(await Bun.file(path.join(e1, "old-only.marker.json")).exists(), "E1 probe server must never start").toBe(
			false,
		);
	}, 60_000);

	it("clears an old prompt command that publishes during the reload pre-clear", async () => {
		const { session, mcp } = await makeMcpHarness();
		const sharedTool = createMCPToolName("shared", PROBE_TOOL_NAME);
		const staleCommand = "shared:prompt-shared-e1";
		await pollUntil(() => session.getToolByName(sharedTool) !== undefined);
		await pollUntil(() => session.mcpPromptCommands.some(command => command.command.name === staleCommand));

		// Park the next prompt refresh. The old connection remains live until the
		// SDK's delayed registry clear finishes, so releasing this gate reproduces
		// the pre-clear republish race.
		const promptListStarted = Promise.withResolvers<void>();
		const promptListGate = Promise.withResolvers<MCPPrompt[]>();
		vi.spyOn(mcpClient, "listPrompts").mockImplementation(async connection => {
			promptListStarted.resolve();
			const prompts = await promptListGate.promise;
			connection.prompts = prompts;
			return prompts;
		});
		const staleRefresh = mcp.refreshServerPrompts("shared");
		await promptListStarted.promise;

		// Hold only the reload's initial tool clear, then let the stale prompt
		// callback publish before manager teardown begins.
		const originalRefreshMCPTools = session.refreshMCPTools.bind(session);
		const releaseClear = Promise.withResolvers<void>();
		let delayedClear = false;
		vi.spyOn(session, "refreshMCPTools").mockImplementation(async tools => {
			if (!delayedClear && tools.length === 0) {
				delayedClear = true;
				await releaseClear.promise;
			}
			return originalRefreshMCPTools(tools);
		});

		await session.setExecutionCwd(e2);
		const reload = session.reloadMCP();
		await pollUntil(() => !session.mcpPromptCommands.some(command => command.command.name === staleCommand));
		promptListGate.resolve([{ name: "prompt-shared-e1", description: "stale E1 prompt", arguments: [] }]);
		await pollUntil(() => session.mcpPromptCommands.some(command => command.command.name === staleCommand));

		releaseClear.resolve();
		await reload;
		await staleRefresh;

		// The final catalog republish wins over the stale pre-clear callback even
		// though E2 has no MCP config and therefore emits no replacement prompt.
		expect(session.mcpPromptCommands.some(command => command.command.name === staleCommand)).toBe(false);
	}, 60_000);

	it("rolls the MCP catalog back to E1 when the destination config load fails", async () => {
		const realLoad = mcpConfig.loadAllMCPConfigs;
		vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockImplementation((...args: Parameters<typeof realLoad>) => {
			const [cwd] = args;
			if (path.resolve(String(cwd)) === path.resolve(e2)) {
				return Promise.reject(new Error("injected E2 config failure"));
			}
			return realLoad(...args);
		});

		const { session, manager, mode, mcp } = await makeMcpHarness();
		await pollUntil(() => session.getToolByName(createMCPToolName("shared", PROBE_TOOL_NAME)) !== undefined);
		await writeMcpConfig(e2, {
			"new-only": probeConfig("e2", path.join(e2, "new-only.marker.json")),
		});

		// Pre-existing E2 is supplied by the probe instead of cloning, so the
		// controller drives its real binding + activation transaction (same as
		// the roster rollback test). Only the controller's rollbackMove restores
		// the saved execution binding, so the command surface is the one under
		// test — a bare applyCwdChange call cannot prove binding restoration.
		const worktreeSpy = vi
			.spyOn(sessionWorktree, "createSessionWorktree")
			.mockImplementation(async () => ({ path: e2, branch: "probe/e2" }));
		try {
			await new CommandController(mode).handleWorktreeCommand("probe/e2");
		} finally {
			worktreeSpy.mockRestore();
		}
		expect(manager.getExecutionCwd()).toBe(path.resolve(e1));

		// The restore branch reloaded MCP at E1: the E1 catalog is back and no
		// E2 tool ever appeared.
		await pollUntil(() => session.getToolByName(createMCPToolName("shared", PROBE_TOOL_NAME)) !== undefined);
		expect(session.getToolByName(createMCPToolName("new-only", PROBE_TOOL_NAME))).toBeUndefined();
		const restored = await invokeProbe(mcp, "shared");
		expect(restored.tag).toBe("shared-e1");
	}, 60_000);
});

/**
 * ACP variant with REAL SDK sessions: the ACP client's server list is the only
 * MCP source (the SDK session runs with `enableMCP: false`, so on-disk
 * discovery can never leak in), and workspace transitions reconfigure exactly
 * that list. Uses the AcpAgent dispatch surface (`agent.prompt` driving the
 * real builtin `/move` and `/mcp reload` handlers).
 */
describe("workspace discovery convergence: ACP real sessions", () => {
	const PROBE_FIXTURE = path.join(import.meta.dir, "fixtures", "workspace-probe-mcp.ts");
	const ACP_API_ID = "test-acp-mcp-convergence";

	let root: string;
	let cwdA: string;
	let moveTarget: string;
	let diskOnlyMarker: string;
	let clientMarker: string;
	let originalProjectDir: string;
	let sessions: AgentSession[];
	let agent: AcpAgent | undefined;
	let cleanup: (() => Promise<void>) | undefined;

	async function pollUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error("pollUntil timed out");
			await Bun.sleep(50);
		}
	}

	beforeAll(async () => {
		initTheme();
		const theme = await getThemeByName("dark");
		if (theme) setThemeInstance(theme);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		MCPManager.resetForTests();
		originalProjectDir = getProjectDir();
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-mcp-conv-")));
		cwdA = path.join(root, "cwd-a");
		moveTarget = path.join(root, "move-target");
		await fs.mkdir(cwdA, { recursive: true });
		await fs.mkdir(moveTarget, { recursive: true });
		diskOnlyMarker = path.join(cwdA, "disk-only.marker.json");
		clientMarker = path.join(root, "client-probe.marker.json");
		sessions = [];

		// On-disk project MCP config: must NEVER start for ACP sessions.
		await Bun.write(
			getMCPConfigPath("project", cwdA),
			`${JSON.stringify({
				mcpServers: {
					"disk-only": {
						type: "stdio",
						command: process.execPath,
						args: [PROBE_FIXTURE, "disk-only", diskOnlyMarker],
						timeout: 10_000,
					},
				},
			})}\n`,
		);

		const contexts: Context[] = [];
		registerCustomApi(ACP_API_ID, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const authStorage = await AuthStorage.create(path.join(root, `auth-${Snowflake.next()}.db`));
		const model = buildModel({
			id: "acp-mcp-probe",
			name: "ACP MCP probe",
			api: ACP_API_ID,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		await Settings.init({ inMemory: true, cwd: cwdA });

		const updates: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;

		const factory = async (cwd: string) => {
			const { session } = await createAgentSession({
				cwd,
				agentDir: root,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model,
				// ACP owns MCP through the client-supplied list; the SDK session
				// must never discover on-disk config itself.
				enableMCP: false,
				enableLsp: false,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skipPythonPreflight: true,
			});
			sessions.push(session);
			return { session, setToolUIContext: undefined as unknown as (ui: ExtensionUIContext, hasUI: boolean) => void };
		};

		agent = new AcpAgent(connection, factory);
		cleanup = async () => {
			for (const session of sessions) {
				await session.dispose().catch(() => {});
			}
			authStorage.close();
		};
	});

	afterEach(async () => {
		if (cleanup) await cleanup();
		cleanup = undefined;
		agent = undefined;
		MCPManager.resetForTests();
		setProjectDir(originalProjectDir);
		resetSettingsForTest();
		clearCustomApis();
		await fs.rm(root, { recursive: true, force: true });
		root = undefined as never;
	});

	async function invokeProbe(session: AgentSession, serverName: string): Promise<Record<string, unknown>> {
		const tool = session.getToolByName(createMCPToolName(serverName, PROBE_TOOL_NAME));
		if (!tool) throw new Error(`probe tool for "${serverName}" not registered`);
		const result = await tool.execute("probe-call", {}, undefined, undefined as never, undefined);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return JSON.parse(text) as Record<string, unknown>;
	}

	it("reconfigures the client server list across /move and /mcp reload; on-disk servers never start", async () => {
		if (!agent) throw new Error("ACP agent not constructed");
		const created = await agent.newSession({
			cwd: cwdA,
			mcpServers: [
				{
					name: "client-probe",
					command: process.execPath,
					args: [PROBE_FIXTURE, "acp-probe", clientMarker],
					env: [],
				},
			],
		});
		const session = sessions.find(s => s.sessionId === created.sessionId);
		if (!session) throw new Error("ACP session not created");

		// The client-supplied probe connected through ACP's own manager.
		await pollUntil(() => session.getToolByName(createMCPToolName("client-probe", PROBE_TOOL_NAME)) !== undefined);
		const before = await invokeProbe(session, "client-probe");
		expect(before.tag).toBe("acp-probe");
		expect((before.rootsAtCall as { roots: Array<{ uri: string }> }).roots.map(r => r.uri)).toContain(
			`file://${cwdA}`,
		);
		// The on-disk-only server never started.
		expect(await Bun.file(diskOnlyMarker).exists()).toBe(false);

		// Real ACP dispatch: /move, then /mcp reload, both through agent.prompt.
		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: `/move ${moveTarget}` }] });
		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/mcp reload" }] });

		await pollUntil(async () => {
			try {
				const after = await invokeProbe(session, "client-probe");
				return (after.rootsAtCall as { roots: Array<{ uri: string }> }).roots.some(root =>
					root.uri.includes(moveTarget),
				);
			} catch {
				return false;
			}
		});
		const after = await invokeProbe(session, "client-probe");
		expect(after.tag).toBe("acp-probe");
		expect((after.rootsAtCall as { roots: Array<{ uri: string }> }).roots.map(r => r.uri)).toContain(
			`file://${moveTarget}`,
		);
		expect(await Bun.file(diskOnlyMarker).exists()).toBe(false);
	}, 60_000);

	it("an empty client list stays empty and starts no on-disk servers", async () => {
		if (!agent) throw new Error("ACP agent not constructed");
		const created = await agent.newSession({ cwd: cwdA, mcpServers: [] });
		const session = sessions.find(s => s.sessionId === created.sessionId);
		if (!session) throw new Error("ACP session not created");
		await Bun.sleep(100);

		expect(session.getToolByName(createMCPToolName("client-probe", PROBE_TOOL_NAME))).toBeUndefined();
		expect(session.getToolByName(createMCPToolName("disk-only", PROBE_TOOL_NAME))).toBeUndefined();
		expect(await Bun.file(diskOnlyMarker).exists()).toBe(false);
	}, 60_000);

	it("a failed replacement setup rejects and starts no on-disk servers", async () => {
		if (!agent) throw new Error("ACP agent not constructed");
		await expect(
			agent.newSession({
				cwd: cwdA,
				mcpServers: [{ name: "broken", command: "/nonexistent/omp-no-such-binary", env: [] }],
			}),
		).rejects.toThrow();
		expect(await Bun.file(diskOnlyMarker).exists()).toBe(false);
	}, 60_000);
});
