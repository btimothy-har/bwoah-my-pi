import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CwdWorkspaceReminderInjector } from "@oh-my-pi/pi-coding-agent/session/cwd-workspace-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const policyText = (text: string) => `Workspace: state\n${text}`;
const policy = (text: string) => ({ ownerId: "session-a", text: policyText(text) });
const controls = (messages: readonly Message[]) =>
	messages.filter(
		message =>
			message.role === "developer" &&
			message.synthetic === true &&
			// The user's own developer continuations are synthetic too; only
			// workspace-policy controls carry the marker.
			String(message.content).startsWith("Workspace:"),
	);
const controlText = (messages: readonly Message[]) => controls(messages).map(message => String(message.content));

function toolResult(id: string, timestamp: number): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "data" }],
		isError: false,
		timestamp,
	};
}

describe("CwdWorkspaceReminderInjector", () => {
	it("emits one control after each new user request and none on replay or tool continuation", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
		const result = toolResult("c1", 2);
		const secondUser: Message = { role: "user", content: "second", timestamp: 1 };
		const request: Message[] = [firstUser, createAssistantMessage("done"), result, secondUser];

		const first = injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, policy("A"));
		expect(controlText(first.messages)).toEqual([policyText("A")]);
		expect(first.messages.at(-1)?.role).toBe("developer");

		// Identical content and timestamps at a new position: still a new request.
		const second = injector.transform({ systemPrompt: ["system"], messages: request }, policy("A"));
		expect(controlText(second.messages)).toEqual([policyText("A"), policyText("A")]);
		expect(second.messages.at(-1)?.role).toBe("developer");

		// Replay of the same request adds nothing and preserves bytes.
		const replay = injector.transform({ systemPrompt: ["system"], messages: request }, policy("A"));
		expect(controlText(replay.messages)).toHaveLength(2);
		expect(replay.messages).toEqual(second.messages);

		// A tool-only continuation with unchanged state adds nothing.
		const continuation = injector.transform(
			{
				systemPrompt: ["system"],
				messages: [firstUser, createAssistantMessage("done"), result, secondUser, createAssistantMessage("ok")],
			},
			policy("A"),
		);
		expect(controlText(continuation.messages)).toHaveLength(2);
	});

	it("emits once when workspace state changes on a tool continuation, then not again", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const user: Message = { role: "user", content: "go", timestamp: 1 };
		const result = toolResult("c1", 2);

		injector.transform({ systemPrompt: ["system"], messages: [user] }, policy("A"));
		const continuation = injector.transform(
			{ systemPrompt: ["system"], messages: [user, createAssistantMessage("ran"), result] },
			policy("A"),
		);
		expect(controlText(continuation.messages)).toHaveLength(1);

		const changed = injector.transform(
			{ systemPrompt: ["system"], messages: [user, createAssistantMessage("ran"), result] },
			policy("B"),
		);
		expect(controlText(changed.messages)).toEqual([policyText("A"), policyText("B")]);
		expect(changed.messages.at(-1)?.role).toBe("developer");
		expect(changed.systemPrompt).toEqual(["system"]);
		expect(user.content).toBe("go");
	});

	it("ignores synthetic and agent-attributed inputs but honors user-initiated continuations", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const user: Message = { role: "user", content: "start", timestamp: 1 };
		injector.transform({ systemPrompt: ["system"], messages: [user] }, policy("A"));

		const syntheticUser: Message = {
			role: "user",
			content: "loop-guard nudge",
			synthetic: true,
			attribution: "agent",
			timestamp: 2,
		};
		const withSynthetic = injector.transform(
			{ systemPrompt: ["system"], messages: [user, createAssistantMessage("a"), syntheticUser] },
			policy("A"),
		);
		expect(controlText(withSynthetic.messages)).toHaveLength(1);

		const initiated: Message = {
			role: "developer",
			content: "continue",
			synthetic: true,
			userInitiated: true,
			timestamp: 3,
		};
		const withContinue = injector.transform(
			{ systemPrompt: ["system"], messages: [user, createAssistantMessage("a"), syntheticUser, initiated] },
			policy("A"),
		);
		expect(controlText(withContinue.messages)).toHaveLength(2);
	});

	it("coalesces batched user inputs into one control for the request", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const firstUser: Message = { role: "user", content: "one", timestamp: 1 };
		injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, policy("A"));

		const secondUser: Message = { role: "user", content: "two", timestamp: 2 };
		const thirdUser: Message = { role: "user", content: "three", timestamp: 3 };
		const batched = injector.transform(
			{ systemPrompt: ["system"], messages: [firstUser, secondUser, thirdUser] },
			policy("A"),
		);
		expect(controlText(batched.messages)).toHaveLength(2);
	});

	it("re-emits current policy after compaction and clears state on owner change", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const user: Message = { role: "user", content: "task", timestamp: 1 };
		const result = toolResult("c1", 2);
		injector.transform({ systemPrompt: ["system"], messages: [user] }, policy("A"));
		injector.transform(
			{ systemPrompt: ["system"], messages: [user, createAssistantMessage("did"), result] },
			policy("A"),
		);

		// Compaction shrinks history: controls from the dropped tail must not
		// survive, and the current policy is re-asserted for the rebuilt context.
		const compactedUser: Message = { role: "user", content: "task", timestamp: 1 };
		const compacted = injector.transform({ systemPrompt: ["system"], messages: [compactedUser] }, policy("A"));
		expect(controlText(compacted.messages)).toEqual([policyText("A")]);

		// A new owning session with identical-looking messages gets fresh state.
		const other = injector.transform(
			{ systemPrompt: ["system"], messages: [compactedUser] },
			{ ownerId: "session-b", text: policyText("B") },
		);
		expect(controlText(other.messages)).toEqual([policyText("B")]);
	});

	it("survives cloned message objects from provider-context transforms", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const user: Message = { role: "user", content: "work", timestamp: 1 };
		injector.transform({ systemPrompt: ["system"], messages: [user] }, policy("A"));

		// Secret obfuscation and steering wraps hand back fresh objects with the
		// same content; the retained control must reattach without duplicating.
		const replay = injector.transform({ systemPrompt: ["system"], messages: [{ ...user }] }, policy("A"));
		expect(controlText(replay.messages)).toHaveLength(1);
	});

	it("never emits or churns controls for unserializable tail content", () => {
		const injector = new CwdWorkspaceReminderInjector();
		// Circular content defeats fingerprinting; the anchor can never be
		// validated on reattach, so delivery is skipped rather than dropped
		// and re-emitted every request.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const user = { role: "user", content: circular, timestamp: 1 } as never as Message;

		const first = injector.transform({ systemPrompt: ["system"], messages: [user] }, policy("A"));
		expect(controlText(first.messages)).toHaveLength(0);
		const second = injector.transform({ systemPrompt: ["system"], messages: [{ ...user }] }, policy("A"));
		expect(controlText(second.messages)).toHaveLength(0);
	});

	it("leaves contexts without a system prompt or messages untouched", () => {
		const injector = new CwdWorkspaceReminderInjector();
		const noSystem: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const empty: Context = { systemPrompt: ["system"], messages: [] };
		expect(injector.transform(noSystem, policy("A"))).toBe(noSystem);
		expect(injector.transform(empty, policy("A"))).toBe(empty);
	});
});

describe("workspace reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];
	let root: string;

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		if (root) await fs.rm(root, { recursive: true, force: true });
		root = undefined as never;
	});

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

	const workspaceControls = (context: Context) =>
		context.messages.filter(
			message =>
				message.role === "developer" &&
				message.synthetic === true &&
				String(message.content).includes("Current working directory:"),
		);

	async function makeWireSession(manager: SessionManager, options?: { isolatedTaskRoot?: string }) {
		const api = "test-workspace-reminder";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "workspace-reminder",
			name: "Workspace reminder",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(path.join(root, `auth-${Snowflake.next()}.db`));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const { session } = await createAgentSession({
			cwd: manager.getSessionHome(),
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
			...(options?.isolatedTaskRoot ? { isolatedTaskRoot: options.isolatedTaskRoot } : {}),
		});
		sessions.push(session);
		return { session, contexts, authStorage };
	}

	it("tracks primary → execution worktree → fallback-to-primary across the session lifecycle", async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-wire-")));
		const home = path.join(root, "home");
		const worktree = path.join(root, "wt");
		await initRepoAt(home);
		await makeLinkedWorktree(home, worktree, "feature/wire");

		const manager = SessionManager.create(home, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected parent session file");

		const first = await makeWireSession(manager);
		await first.session.sendUserMessage("primary turn");
		let latest = workspaceControls(first.contexts.at(-1)!);
		expect(latest).toHaveLength(1);
		expect(String(latest.at(-1)!.content)).toContain("operating in the repository's primary checkout");
		expect(String(latest.at(-1)!.content)).toContain("Default to read-only investigation");

		await first.session.setExecutionCwd(worktree);
		await first.session.sendUserMessage("worktree turn one");
		latest = workspaceControls(first.contexts.at(-1)!);
		expect(latest).toHaveLength(2);
		const worktreeText = String(latest.at(-1)!.content);
		expect(worktreeText).toContain("operating in a worktree");
		expect(worktreeText).toContain("All your work MUST occur within this worktree");
		expect(worktreeText).toContain(normalizePromptPath(worktree));

		await first.session.sendUserMessage("worktree turn two");
		latest = workspaceControls(first.contexts.at(-1)!);
		expect(latest).toHaveLength(3);
		expect(String(latest.at(-1)!.content)).toContain("operating in a worktree");
		await first.session.dispose();
		sessions.splice(sessions.indexOf(first.session), 1);
		await first.authStorage.close();

		// Remove E and reopen: the discarded binding resets execution to H.
		const repo = vcs.git(home);
		if (!repo) throw new Error("home repository missing");
		await repo.worktreeRemove(worktree, true);
		await fs.rm(worktree, { recursive: true, force: true });
		const reopened = await SessionManager.open(sessionFile);
		const second = await makeWireSession(reopened);
		await second.session.sendUserMessage("after fallback");
		latest = workspaceControls(second.contexts.at(-1)!);
		expect(String(latest.at(-1)!.content)).toContain("operating in the repository's primary checkout");
		expect(String(latest.at(-1)!.content)).toContain(normalizePromptPath(home));
		await second.authStorage.close();
	});

	it("keeps an affirmative isolated-workspace reminder for trusted native task sandboxes", async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-iso-")));
		const isolated = path.join(root, "isolated");
		await initRepoAt(isolated);

		const manager = SessionManager.inMemory(isolated);
		const first = await makeWireSession(manager, { isolatedTaskRoot: isolated });
		await first.session.sendUserMessage("isolated turn");
		let latest = workspaceControls(first.contexts.at(-1)!).at(-1)!;
		expect(String(latest.content)).toContain("MUST occur within the current working directory");
		expect(String(latest.content)).toContain(normalizePromptPath(isolated));
		expect(String(latest.content)).not.toContain("operating in the repository's primary checkout");
		await first.session.dispose();
		sessions.splice(sessions.indexOf(first.session), 1);
		await first.authStorage.close();

		// A rebuilt session with the same trusted root starts with fresh reminder
		// state and still classifies as isolated.
		const second = await makeWireSession(SessionManager.inMemory(isolated), { isolatedTaskRoot: isolated });
		await second.session.sendUserMessage("isolated again");
		latest = workspaceControls(second.contexts.at(-1)!).at(-1)!;
		expect(String(latest.content)).toContain("MUST occur within the current working directory");
		await second.authStorage.close();
	});
});
