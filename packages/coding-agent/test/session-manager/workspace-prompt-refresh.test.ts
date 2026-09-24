import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi();

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
	await gitCli(dir, "init", "-q", "-b", "main");
	const repo = vcs.git(dir);
	if (!repo) throw new Error(`git repository not discovered at ${dir}`);
	await repo.configSet("user.email", "test@example.com");
	await repo.configSet("user.name", "test");
	await Bun.write(path.join(dir, "README.md"), "seed\n");
	await repo.stageFiles(["README.md"]);
	await repo.commitCreate("init", {});
}

/**
 * Contract: when `/add-dir` (or `addWorkspaceDirectory` + `refreshBaseSystemPrompt`)
 * runs mid-session, the rebuilt system prompt MUST list the newly-added directory
 * in its <related-directories> block. The sessionManager state updates immediately
 * (so `/dirs` reflects the add), but the system prompt is only re-read on the next
 * `refreshBaseSystemPrompt`; this test guards that refresh path end-to-end.
 */
describe("workspace directories in the system prompt", () => {
	it("adds a directory to the <related-directories> block after addWorkspaceDirectory + refreshBaseSystemPrompt", async () => {
		const dir = TempDir.createSync("@ws-prompt-add-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			const extraDir = path.join(dir.path(), "extra-root");
			fs.mkdirSync(extraDir, { recursive: true });
			const laterDir = path.join(dir.path(), "later-root");
			fs.mkdirSync(laterDir, { recursive: true });

			const mockModel = createMockModel({ id: "text", handler: () => ({ content: ["ok"] }) });
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"retry.enabled": false,
			});
			const sessionManager = SessionManager.inMemory(dir.path());
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				additionalDirectories: [extraDir],
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: mockModel,
				settings,
				sessionManager,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			try {
				// Sanity: the seed dir is present in the sessionManager state.
				expect(sessionManager.getAdditionalDirectories()).toEqual([extraDir]);

				// Add a second directory live (as /add-dir does) and refresh the prompt.
				await sessionManager.addWorkspaceDirectory(laterDir);
				await session.refreshBaseSystemPrompt();

				// sessionManager state now has both.
				expect(sessionManager.getAdditionalDirectories()).toEqual([extraDir, laterDir]);

				// Send a prompt so we can inspect the system prompt the provider received.
				await session.prompt("noop");

				const calls = mockModel.calls ?? [];
				const lastCall = calls.at(-1);
				const systemPrompt = (lastCall?.context?.systemPrompt as string[] | undefined)?.join("\n") ?? "";

				// Both directories must appear in the <related-directories> block.
				expect(systemPrompt).toContain("<related-directories>");
				expect(systemPrompt).toContain(extraDir);
				expect(systemPrompt).toContain(laterDir);
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});

	it("renders workspace.related map directories and shared context live, without persisting them into the session", async () => {
		const dir = TempDir.createSync("@ws-prompt-related-");
		const mapRoot = TempDir.createSync("@ws-prompt-map-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			// The map only applies to a canonical checkout: make cwd a real Git repo.
			await initRepoAt(dir.path());
			const mapDir = path.join(mapRoot.path(), "map-root");
			fs.mkdirSync(mapDir, { recursive: true });
			fs.writeFileSync(path.join(mapDir, "AGENTS.md"), "MAP-ROOT-RULE-SENTINEL");
			const ctxFile = path.join(mapRoot.path(), "shared-context.md");
			fs.writeFileSync(ctxFile, "SHARED-CONTEXT-SENTINEL");

			const mockModel = createMockModel({ id: "text", handler: () => ({ content: ["ok"] }) });
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"retry.enabled": false,
				"workspace.related": {
					[dir.path()]: { directories: [mapDir], contextFiles: [ctxFile] },
				},
			});
			const sessionManager = SessionManager.inMemory(dir.path());
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: mockModel,
				settings,
				sessionManager,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			try {
				await session.prompt("noop");

				const calls = mockModel.calls ?? [];
				const lastCall = calls.at(-1);
				const systemPrompt = (lastCall?.context?.systemPrompt as string[] | undefined)?.join("\n") ?? "";

				// The map directory renders in <related-directories> (the resolver
				// realpaths map entries; macOS temp dirs resolve under /private).
				const mapDirReal = fs.realpathSync(mapDir);
				const relatedDirs =
					systemPrompt.match(/^<related-directories>\n([\s\S]*?)\n<\/related-directories>$/m)?.[1] ?? "";
				expect(relatedDirs).toContain(mapDirReal);
				// Its own context file path is listed, but the content is not inlined.
				expect(relatedDirs).toContain(path.join(mapDirReal, "AGENTS.md"));
				expect(systemPrompt).not.toContain("MAP-ROOT-RULE-SENTINEL");

				// The shared context file renders inside <related-context>.
				const relatedContext =
					systemPrompt.match(/^<related-context>\n([\s\S]*?)\n<\/related-context>$/m)?.[1] ?? "";
				expect(relatedContext).toContain("SHARED-CONTEXT-SENTINEL");

				// The map directory is recomputed per rebuild, never persisted into
				// the session's additional directories.
				expect(sessionManager.getAdditionalDirectories()).toEqual([]);

				// The per-request reminder rides as a trailing synthetic developer
				// control pointing at <related-directories> — not inside user text.
				const messages = (lastCall?.context?.messages ?? []) as Array<{
					role: string;
					synthetic?: boolean;
					content: unknown;
				}>;
				const reminder = messages
					.filter(
						message =>
							message.role === "developer" &&
							message.synthetic === true &&
							String(message.content).includes("Current working directory:"),
					)
					.at(-1);
				expect(reminder).toBeDefined();
				expect(String(reminder!.content)).toContain("Related read-only directories are listed");
				const userText = messages
					.filter(message => message.role === "user")
					.map(message => String(message.content))
					.join("\n");
				expect(userText).not.toContain("Related read-only directories");
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
			mapRoot.removeSync();
		}
	});
});
