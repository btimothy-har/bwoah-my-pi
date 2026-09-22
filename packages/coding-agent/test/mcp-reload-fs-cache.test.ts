import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();

async function writeExternalProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp reload picks up external mcp.json edits", () => {
	let projectDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reload-project-"));
		setProjectDir(projectDir);
		clearCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCache();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reloadForCwd clears the fs cache before rediscovery", async () => {
		const configPath = getMCPConfigPath("project", projectDir);
		await writeExternalProjectConfig(projectDir, {
			test: { type: "stdio", command: "old-cmd" },
		});

		const primed = await readFile(configPath);
		expect(primed).toContain("old-cmd");

		await Bun.write(
			configPath,
			`${JSON.stringify({ mcpServers: { test: { type: "stdio", command: "new-cmd" } } }, null, 2)}\n`,
		);

		const stale = await readFile(configPath);
		expect(stale).toContain("old-cmd");
		expect(stale).not.toContain("new-cmd");

		// The injected loader reads the config THROUGH the capability fs cache, so
		// it only observes the external edit if the reload cleared the cache. The
		// loader returns an empty config map, keeping the test hermetic (no server
		// processes) while still exercising the real manager reload.
		const discoveredCommands: string[] = [];
		const manager = new MCPManager(projectDir, null, async cwd => {
			const content = await readFile(getMCPConfigPath("project", cwd));
			if (content) {
				const parsed = JSON.parse(content) as {
					mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
				};
				for (const server of Object.values(parsed.mcpServers ?? {})) {
					if (server.command) {
						discoveredCommands.push(server.command);
					}
					if (server.env) {
						discoveredCommands.push(...Object.values(server.env));
					}
				}
			}
			return { configs: {}, sources: {}, exaApiKeys: [] };
		});

		const setMCPPromptCommands = vi.fn();
		const refreshMCPTools = vi.fn(async (_tools: unknown[]) => {});
		// The adapter mirrors the SDK-owned reload sequence so the controller
		// drives a real manager.reloadForCwd, not a mock echo of the callback.
		const reloadMCP = async () => {
			setMCPPromptCommands([]);
			await refreshMCPTools([]);
			const result = await manager.reloadForCwd(projectDir, {
				enableProjectConfig: true,
				filterExa: true,
				filterBrowser: false,
			});
			await refreshMCPTools(manager.getTools());
			return result;
		};
		const ctx = createInteractiveModeContext({
			session: { refreshMCPTools, setMCPPromptCommands, reloadMCP },
			mcpManager: manager,
		});

		const controller = new MCPCommandController(ctx);
		await controller.reloadServers();

		expect(setMCPPromptCommands).toHaveBeenCalledWith([]);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		// The reloaded (empty) catalog was published after the clear.
		expect(refreshMCPTools).toHaveBeenLastCalledWith([]);
		expect(discoveredCommands).toContain("new-cmd");
		expect(discoveredCommands).not.toContain("old-cmd");
	});
});
