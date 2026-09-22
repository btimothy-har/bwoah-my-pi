import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type {
	MCPPrompt,
	MCPResource,
	MCPServerCapabilities,
	MCPServerConnection,
	MCPStdioServerConfig,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import {
	getAgentDir,
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { PROBE_TOOL_NAME } from "./fixtures/workspace-probe-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "workspace-probe-mcp.ts");
const originalProjectDir = getProjectDir();
const originalAgentDir = getAgentDir();

type Root = { uri: string; name: string };
type ProbePayload = {
	tag: string;
	pid: number;
	cwd: string;
	initialRoots: Root[];
	rootsAtCall: { roots: Root[] };
};

const RELOAD_OPTIONS = { enableProjectConfig: true, filterExa: true, filterBrowser: false } as const;

function probeServerConfig(tag: string, markerPath: string, timeout = 10_000): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, tag, markerPath], timeout };
}

async function writeProjectConfig(dir: string, servers: Record<string, MCPStdioServerConfig>): Promise<void> {
	await fs.mkdir(path.join(dir, ".omp"), { recursive: true });
	await Bun.write(getMCPConfigPath("project", dir), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

async function writeUserConfig(servers: Record<string, MCPStdioServerConfig>): Promise<void> {
	await Bun.write(getMCPConfigPath("user", getProjectDir()), `${JSON.stringify({ mcpServers: servers })}\n`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function invokeProbe(manager: MCPManager, serverName: string): Promise<ProbePayload> {
	const tool = manager.getTools().find(t => t.name === createMCPToolName(serverName, PROBE_TOOL_NAME));
	if (!tool) throw new Error(`probe tool for server "${serverName}" not registered`);
	const result = await tool.execute("probe-call", {}, undefined, undefined as never, undefined);
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	return JSON.parse(text) as ProbePayload;
}

async function waitForToolNames(manager: MCPManager, names: string[]): Promise<void> {
	const satisfied = () => {
		const have = new Set(manager.getTools().map(tool => tool.name));
		return names.every(name => have.has(name));
	};
	if (satisfied()) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const listener = () => {
		if (satisfied()) {
			resolve();
		}
	};
	manager.setOnToolsChanged(listener);
	await promise;
	await manager.waitForPendingConnections();
}

async function pollUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("pollUntil timed out");
		await Bun.sleep(25);
	}
}

function probeToolDefinition(): MCPToolDefinition {
	return {
		name: PROBE_TOOL_NAME,
		description: "stale definition",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	};
}

describe("MCPManager.reloadForCwd workspace rebind", () => {
	let root = "";
	let e1 = "";
	let e2 = "";
	let agentDir = "";
	let manager: MCPManager | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-rebind-"));
		e1 = path.join(root, "e1");
		e2 = path.join(root, "e2");
		agentDir = path.join(root, "agent");
		await Promise.all([fs.mkdir(e1, { recursive: true }), fs.mkdir(e2, { recursive: true }), fs.mkdir(agentDir)]);
		[e1, e2, agentDir] = await Promise.all([fs.realpath(e1), fs.realpath(e2), fs.realpath(agentDir)]);
		setProjectDir(e1);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (manager) {
			await manager.disconnectAll().catch(() => {});
			manager = undefined;
		}
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		clearCache();
		await removeWithRetries(root);
	});

	test("reloadForCwd replaces the catalog and roots with the destination workspace", async () => {
		await writeProjectConfig(e1, {
			"old-only": probeServerConfig("e1", path.join(e1, "old-only.marker.json")),
			shared: probeServerConfig("shared-e1", path.join(e1, "shared.marker.json")),
		});
		await writeUserConfig({
			"user-server": probeServerConfig("user-scope", path.join(agentDir, "user-server.marker.json")),
		});
		manager = new MCPManager(e1);
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		await waitForToolNames(manager, [
			createMCPToolName("old-only", PROBE_TOOL_NAME),
			createMCPToolName("shared", PROBE_TOOL_NAME),
			createMCPToolName("user-server", PROBE_TOOL_NAME),
		]);
		const oldShared = await invokeProbe(manager, "shared");
		expect(oldShared.rootsAtCall.roots.map(root => root.uri)).toContain(url.pathToFileURL(e1).href);

		await writeProjectConfig(e2, {
			"new-only": probeServerConfig("e2", path.join(e2, "new-only.marker.json")),
			shared: probeServerConfig("shared-e2", path.join(e2, "shared-e2.marker.json")),
		});
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		await waitForToolNames(manager, [
			createMCPToolName("new-only", PROBE_TOOL_NAME),
			createMCPToolName("shared", PROBE_TOOL_NAME),
			createMCPToolName("user-server", PROBE_TOOL_NAME),
		]);

		// The old generation is gone: old-only is neither connected nor advertised,
		// and the E1 shared process was closed.
		expect(manager.getConnectedServers()).not.toContain("old-only");
		expect(manager.getTools().map(tool => tool.name)).not.toContain(createMCPToolName("old-only", PROBE_TOOL_NAME));
		expect(isPidAlive(oldShared.pid)).toBe(false);

		// The replacement servers answer from E2 with E2 roots.
		const newOnly = await invokeProbe(manager, "new-only");
		expect(newOnly.tag).toBe("e2");
		expect(newOnly.rootsAtCall.roots.map(root => root.uri)).toContain(url.pathToFileURL(e2).href);
		const shared = await invokeProbe(manager, "shared");
		expect(shared.tag).toBe("shared-e2");
		expect(shared.rootsAtCall.roots.map(root => root.uri)).toContain(url.pathToFileURL(e2).href);
		const userServer = await invokeProbe(manager, "user-server");
		expect(userServer.rootsAtCall.roots.map(root => root.uri)).toContain(url.pathToFileURL(e2).href);

		// Old prompt/resource entries disappeared with the E1 connections.
		const sharedConnection = manager.getConnection("shared");
		expect(sharedConnection?.prompts?.map(prompt => prompt.name)).toContain("prompt-shared-e2");
		expect(sharedConnection?.prompts?.map(prompt => prompt.name)).not.toContain("prompt-shared-e1");
		const sharedResources = manager.getServerResources("shared");
		expect(sharedResources?.resources.map(resource => resource.uri)).toContain("probe://shared-e2/resource");
		expect(sharedResources?.resources.map(resource => resource.uri)).not.toContain("probe://shared-e1/resource");
	}, 60_000);

	test("an absent destination config empties the catalog instead of retaining old tools", async () => {
		await writeProjectConfig(e1, {
			"old-only": probeServerConfig("e1", path.join(e1, "old-only.marker.json")),
		});
		manager = new MCPManager(e1);
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		await waitForToolNames(manager, [createMCPToolName("old-only", PROBE_TOOL_NAME)]);

		// E2 has no MCP config at all.
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		await manager.waitForPendingConnections();

		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	}, 60_000);

	test("enableProjectConfig:false keeps project servers out of the rebind", async () => {
		await writeProjectConfig(e1, {
			"old-only": probeServerConfig("e1", path.join(e1, "old-only.marker.json")),
		});
		await writeUserConfig({
			"user-server": probeServerConfig("user-scope", path.join(agentDir, "user-server.marker.json")),
		});
		manager = new MCPManager(e1);
		await manager.discoverAndConnect({ ...RELOAD_OPTIONS, enableProjectConfig: false });
		await waitForToolNames(manager, [createMCPToolName("user-server", PROBE_TOOL_NAME)]);

		await writeProjectConfig(e2, {
			"new-only": probeServerConfig("e2", path.join(e2, "new-only.marker.json")),
		});
		await manager.reloadForCwd(e2, { ...RELOAD_OPTIONS, enableProjectConfig: false });
		await waitForToolNames(manager, [createMCPToolName("user-server", PROBE_TOOL_NAME)]);
		expect(manager.getConnectedServers()).toEqual(["user-server"]);
		expect(manager.getTools().map(tool => tool.name)).not.toContain(createMCPToolName("new-only", PROBE_TOOL_NAME));
	}, 60_000);

	test("a rebind that lands during config loading starts no old-E server", async () => {
		const loadGate = Promise.withResolvers<void>();
		const loadStarted = Promise.withResolvers<void>();
		const loader = async (cwd: string) => {
			if (path.resolve(cwd) === path.resolve(e1)) {
				loadStarted.resolve();
				await loadGate.promise;
				return {
					configs: { "old-only": probeServerConfig("e1", path.join(e1, "old-only.marker.json")) },
					sources: {},
					exaApiKeys: [] as string[],
				};
			}
			return loadAllMCPConfigs(cwd, { enableProjectConfig: true, filterExa: true, filterBrowser: false });
		};
		manager = new MCPManager(e1, null, loader);

		// E1 discovery parks inside the gated loader.
		const staleDiscovery = manager.discoverAndConnect(RELOAD_OPTIONS);
		await loadStarted.promise;

		// The rebind tears the old generation down, rediscovers at E2, and only
		// then is the parked E1 load released.
		await writeProjectConfig(e2, {
			"new-only": probeServerConfig("e2", path.join(e2, "new-only.marker.json")),
		});
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		loadGate.resolve();
		await staleDiscovery;
		await manager.waitForPendingConnections();

		expect(manager.getConnectedServers()).toContain("new-only");
		expect(manager.getConnectedServers()).not.toContain("old-only");
		expect(await Bun.file(path.join(e1, "old-only.marker.json")).exists(), "E1 server process must never start").toBe(
			false,
		);
	}, 60_000);

	test("a gated tools/list resolving after the rebind never publishes old-E tools", async () => {
		await writeProjectConfig(e1, {
			shared: probeServerConfig("shared-e1", path.join(e1, "shared.marker.json")),
		});
		manager = new MCPManager(e1);

		const listGate = Promise.withResolvers<MCPToolDefinition[]>();
		const listSpy = vi.spyOn(mcpClient, "listTools").mockImplementationOnce(() => listGate.promise);
		const staleLoad = manager.discoverAndConnect(RELOAD_OPTIONS);
		// Wait for the real stdio connection to attach (the gated tools/list has
		// not resolved yet, so no "connected" status fires).
		await pollUntil(() => manager!.getConnection("shared") !== undefined);

		await writeProjectConfig(e2, {
			shared: probeServerConfig("shared-e2", path.join(e2, "shared-e2.marker.json")),
		});
		const rebind = manager.reloadForCwd(e2, RELOAD_OPTIONS);
		await rebind;
		listSpy.mockRestore();
		listGate.resolve([probeToolDefinition()]);
		await staleLoad;
		await manager.waitForPendingConnections();

		// The E2 shared server connected and its tools are advertised; the stale
		// E1 tools/list result must not have replaced or joined them.
		await waitForToolNames(manager, [createMCPToolName("shared", PROBE_TOOL_NAME)]);
		const shared = await invokeProbe(manager, "shared");
		expect(shared.tag).toBe("shared-e2");
	}, 60_000);

	test("a retained deferred tool's connection getter throws stale after the rebind", async () => {
		const deferredConfig = probeServerConfig("deferred-e1", path.join(e1, "deferred.marker.json"));
		await writeProjectConfig(e1, { deferred: deferredConfig });
		const storage = await AgentStorage.open();
		manager = new MCPManager(e1, new MCPToolCache(storage));

		// Phase 1: a successful load populates the tool cache.
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		await waitForToolNames(manager, [createMCPToolName("deferred", PROBE_TOOL_NAME)]);

		// Phase 2: reconnect with the tools/list parked past the startup race so
		// the catalog falls back to cached deferred tools.
		const listGate = Promise.withResolvers<MCPToolDefinition[]>();
		vi.spyOn(mcpClient, "listTools").mockImplementationOnce(() => listGate.promise);
		await manager.disconnectAll();
		const deferredLoad = await manager.discoverAndConnect(RELOAD_OPTIONS);
		const deferredTool = deferredLoad.tools.find(
			tool => tool.name === createMCPToolName("deferred", PROBE_TOOL_NAME),
		);
		if (!deferredTool) throw new Error("cached deferred probe tool not registered");

		// Rebind while the deferred connection getter is still pending.
		await writeProjectConfig(e2, {
			deferred: probeServerConfig("deferred-e2", path.join(e2, "deferred-e2.marker.json")),
		});
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		listGate.resolve([probeToolDefinition()]);

		const result = await deferredTool.execute("stale-deferred", {}, undefined, undefined as never, undefined);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toContain("was disconnected during initial connection");
		expect(text).not.toContain("deferred-e2");
	}, 60_000);

	test("a config-loader rejection during the rebind propagates and leaves an empty catalog", async () => {
		await writeProjectConfig(e1, {
			shared: probeServerConfig("shared-e1", path.join(e1, "shared.marker.json")),
		});
		manager = new MCPManager(e1);
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		await waitForToolNames(manager, [createMCPToolName("shared", PROBE_TOOL_NAME)]);

		await manager.disconnectAll();
		const failing = new MCPManager(e2, null, async () => {
			throw new Error("injected destination config failure");
		});
		await expect(failing.reloadForCwd(e2, RELOAD_OPTIONS)).rejects.toThrow("injected destination config failure");
		await failing.disconnectAll().catch(() => {});

		// The original manager is reusable after the teardown: a reload against a
		// good config recovers a working catalog (the rollback path relies on
		// this — the failed transition left the manager disconnected, and the
		// restore reloads at the previous cwd).
		await manager.reloadForCwd(e1, RELOAD_OPTIONS);
		await waitForToolNames(manager, [createMCPToolName("shared", PROBE_TOOL_NAME)]);
		const shared = await invokeProbe(manager, "shared");
		expect(shared.tag).toBe("shared-e1");
	}, 60_000);
});

class FakeTransport implements MCPTransport {
	connected = true;
	closeCalls = 0;
	onClose?: () => void;

	request<T>(): Promise<T> {
		throw new Error("Unexpected transport request");
	}

	async notify(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

function fakeConnection(
	name: string,
	capabilities: MCPServerCapabilities = { tools: {} },
): { connection: MCPServerConnection; transport: FakeTransport } {
	const transport = new FakeTransport();
	return {
		connection: {
			name,
			config: { type: "stdio", command: "unused" },
			transport,
			serverInfo: { name: "fake", version: "1.0.0" },
			capabilities,
		},
		transport,
	};
}

describe("MCPManager stale-generation publication (mock seams)", () => {
	let root = "";
	let e1 = "";
	let e2 = "";
	let manager: MCPManager | undefined;
	const FAKE_CONFIG: MCPStdioServerConfig = { type: "stdio", command: "unused" };

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stale-gen-"));
		e1 = path.join(root, "e1");
		e2 = path.join(root, "e2");
		await fs.mkdir(e1, { recursive: true });
		await fs.mkdir(e2, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (manager) {
			await manager.disconnectAll().catch(() => {});
			manager = undefined;
		}
		await removeWithRetries(root);
	});

	test("an in-flight E1 tool call fails without replaying into the rebind's same-named server", async () => {
		const e1Conn = fakeConnection("shared");
		const e2Conn = fakeConnection("shared");
		const e2Connected = Promise.withResolvers<void>();
		const e1CallEntered = Promise.withResolvers<void>();
		const callGate = Promise.withResolvers<MCPToolCallResult>();
		const e2Executions: string[] = [];
		vi.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(e1Conn.connection)
			.mockImplementation(() => {
				e2Connected.resolve();
				return Promise.resolve(e2Conn.connection);
			});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([probeToolDefinition()]);
		vi.spyOn(mcpClient, "callTool").mockImplementation((connection: MCPServerConnection) => {
			if (connection === e1Conn.connection) {
				e1CallEntered.resolve();
				return callGate.promise;
			}
			e2Executions.push(connection.name);
			return Promise.resolve({ content: [{ type: "text", text: "e2-response" }], isError: false });
		});

		const loader = async (cwd: string) =>
			path.resolve(cwd) === path.resolve(e2)
				? { configs: { shared: FAKE_CONFIG }, sources: {}, exaApiKeys: [] as string[] }
				: { configs: { shared: FAKE_CONFIG }, sources: {}, exaApiKeys: [] as string[] };
		manager = new MCPManager(e1, null, loader);
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		const staleTool = manager.getTools().find(tool => tool.name === createMCPToolName("shared", PROBE_TOOL_NAME));
		if (!staleTool) throw new Error("E1 shared tool not registered");

		// The call parks in the (gated) E1 transport failure; the rebind lands
		// and connects E2's same-named server before the failure is released.
		const call = staleTool.execute("stale-call", {}, undefined, undefined as never, undefined);
		await e1CallEntered.promise;
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		await e2Connected.promise;
		await manager.waitForPendingConnections();
		callGate.reject(new Error("transport closed: held E1 transport failure"));

		const result = await call;
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toContain("held E1 transport failure");
		expect(text).not.toContain("e2-response");
		// The new generation's server executed zero old-argument calls.
		expect(e2Executions).toEqual([]);
	}, 15_000);

	test("a stale pending handshake's onRequest rejects instead of answering with destination roots", async () => {
		const e2Conn = fakeConnection("shared");
		const connectGate = Promise.withResolvers<MCPServerConnection>();
		let e1OnRequest: ((method: string, params: unknown) => Promise<unknown>) | undefined;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, _config, options) => {
			if (!e1OnRequest) {
				e1OnRequest = options?.onRequest;
				return connectGate.promise;
			}
			return Promise.resolve(e2Conn.connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([probeToolDefinition()]);
		const loader = async () => ({ configs: { shared: FAKE_CONFIG }, sources: {}, exaApiKeys: [] as string[] });
		manager = new MCPManager(e1, null, loader);

		// The E1 connect parks inside the gated connectToServer with its
		// onRequest captured — a pending auth/handshake work item.
		const staleDiscovery = manager.discoverAndConnect(RELOAD_OPTIONS);
		await pollUntil(() => e1OnRequest !== undefined);
		const staleOnRequest = e1OnRequest;
		if (!staleOnRequest) throw new Error("Expected pending E1 connection handlers");

		// Complete an E2 rebind while the E1 handshake is still pending.
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);

		// The stale E1 onRequest must reject: answering roots/list from the
		// rebound manager cwd would leak destination E2 roots to the old server.
		let rejection: unknown;
		try {
			await staleOnRequest("roots/list", {});
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeInstanceOf(Error);
		const message = rejection instanceof Error ? rejection.message : String(rejection);
		expect(message).toContain("was disconnected during initial connection");
		expect(message).not.toContain(e2);

		// The eventual stale connect must not displace E2's same-named server.
		connectGate.resolve(fakeConnection("shared").connection);
		await staleDiscovery;
		await manager.waitForPendingConnections();
		expect(manager.getConnection("shared")).toBe(e2Conn.connection);
		expect(manager.getTools().map(tool => tool.name)).toEqual([createMCPToolName("shared", PROBE_TOOL_NAME)]);
	}, 15_000);

	test("a reconnect tools/list resolving after the rebind never republishes the old catalog", async () => {
		const e2Conn = fakeConnection("shared");
		let listCalls = 0;
		const listGate = Promise.withResolvers<MCPToolDefinition[]>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async () => e2Conn.connection);
		vi.spyOn(mcpClient, "listTools").mockImplementation(() => {
			listCalls += 1;
			if (listCalls === 2) return listGate.promise;
			return Promise.resolve([probeToolDefinition()]);
		});
		const loader = async () => ({
			configs: { shared: FAKE_CONFIG },
			sources: {},
			exaApiKeys: [] as string[],
		});
		manager = new MCPManager(e1, null, loader);
		await manager.discoverAndConnect(RELOAD_OPTIONS);

		// A transport-loss reconnect parks inside its gated tools/list.
		const reconnect = manager.reconnectServer("shared", { manual: true });
		await pollUntil(() => listCalls >= 2);

		// The rebind tears the reconnect's generation down; only then does the
		// stale tools/list resolve.
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		listGate.resolve([probeToolDefinition()]);
		await reconnect;
		await manager.waitForPendingConnections();

		expect(manager.getConnection("shared")).toBe(e2Conn.connection);
		expect(manager.getTools().map(tool => tool.name)).toEqual([createMCPToolName("shared", PROBE_TOOL_NAME)]);
	}, 15_000);

	test("a notification-driven prompt refresh resolving after the rebind publishes nothing", async () => {
		const e1Conn = fakeConnection("shared", { tools: {}, prompts: {} });
		const e2Conn = fakeConnection("shared", { tools: {} });
		let promptsCalls = 0;
		const promptsGate = Promise.withResolvers<MCPPrompt[]>();
		vi.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(e1Conn.connection)
			.mockResolvedValue(e2Conn.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([probeToolDefinition()]);
		vi.spyOn(mcpClient, "listPrompts").mockImplementation(() => {
			promptsCalls += 1;
			if (promptsCalls === 2) return promptsGate.promise;
			return Promise.resolve([{ name: `prompt-${e1Conn.connection.name}`, description: "p", arguments: [] }]);
		});
		const loader = async () => ({ configs: { shared: FAKE_CONFIG }, sources: {}, exaApiKeys: [] as string[] });
		manager = new MCPManager(e1, null, loader);
		await manager.discoverAndConnect(RELOAD_OPTIONS);

		const promptEvents: string[] = [];
		manager.setOnPromptsChanged(serverName => promptEvents.push(serverName));

		// Park a prompt-list refresh mid-flight, then rebind underneath it.
		const staleRefresh = manager.refreshServerPrompts("shared");
		await pollUntil(() => promptsCalls >= 2);
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		promptsGate.resolve([]);
		await staleRefresh;

		// No stale prompt publication: the old connection's refresh returned
		// without announcing, and the E2 connection loads no prompts.
		expect(promptEvents).toEqual([]);
		expect(manager.getServerPrompts("shared")).toEqual([]);
	}, 15_000);

	test("a notification-driven resource refresh resolving after the rebind attaches no old subscriptions", async () => {
		const e1Conn = fakeConnection("shared", { tools: {}, resources: { subscribe: true } });
		const e2Conn = fakeConnection("shared", { tools: {}, resources: { subscribe: true } });
		let resourceCalls = 0;
		const resourcesGate = Promise.withResolvers<MCPResource[]>();
		vi.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(e1Conn.connection)
			.mockResolvedValue(e2Conn.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([probeToolDefinition()]);
		vi.spyOn(mcpClient, "listResourceTemplates").mockResolvedValue([]);
		vi.spyOn(mcpClient, "subscribeToResources").mockResolvedValue(undefined);
		vi.spyOn(mcpClient, "unsubscribeFromResources").mockResolvedValue(undefined);
		vi.spyOn(mcpClient, "listResources").mockImplementation(() => {
			resourceCalls += 1;
			if (resourceCalls === 2) return resourcesGate.promise;
			const tag = resourceCalls === 1 ? "shared-e1" : "shared-e2";
			return Promise.resolve([{ uri: `probe://${tag}/resource`, name: `resource-${tag}`, mimeType: "text/plain" }]);
		});
		const loader = async () => ({ configs: { shared: FAKE_CONFIG }, sources: {}, exaApiKeys: [] as string[] });
		manager = new MCPManager(e1, null, loader);
		manager.setNotificationsEnabled(true);
		// Capture the E1 initial load's catalog event; attaching before discovery
		// guarantees the event is not missed.
		const initialLoaded = Promise.withResolvers<void>();
		manager.addCatalogChangeListener(event => {
			if (event.serverName === "shared" && event.kind === "resources") initialLoaded.resolve();
		});
		await manager.discoverAndConnect(RELOAD_OPTIONS);
		await initialLoaded.promise;
		// Let the refresh's cleanup microtasks run so the parked refresh below is
		// a distinct notification-driven refresh rather than a coalesced wait.
		await Bun.sleep(1);

		// Park a notification-driven resource refresh mid-flight, then rebind.
		const staleRefresh = manager.refreshServerResources("shared");
		await pollUntil(() => resourceCalls >= 2);
		await manager.reloadForCwd(e2, RELOAD_OPTIONS);
		resourcesGate.resolve([]);
		await staleRefresh;
		await manager.waitForPendingConnections();

		// The live subscription tracks E2's resource only; the stale refresh
		// attached nothing from E1.
		const subscriptions = manager.getNotificationState().subscriptions.get("shared");
		expect(subscriptions?.has("probe://shared-e2/resource")).toBe(true);
		expect(subscriptions?.has("probe://shared-e1/resource")).toBe(false);
	}, 15_000);
});
