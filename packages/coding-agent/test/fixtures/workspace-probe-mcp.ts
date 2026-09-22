#!/usr/bin/env bun
/**
 * Test fixture: a well-behaved stdio MCP server that reports its workspace
 * identity. Usage: `bun workspace-probe-mcp.ts <tag> [markerFile]`.
 *
 * After the client finishes initialization the server sends a server-initiated
 * `roots/list` request and records the response. It exposes:
 *
 * - a `probe` tool returning JSON with the fixture tag, the server process's
 *   cwd and pid, the roots recorded at initialization, and a fresh roots/list
 *   re-issued at call time (the tool waits for that response rather than
 *   racing it);
 * - one prompt named `prompt-<tag>`;
 * - one resource at `probe://<tag>/resource`.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`).
 * Stdout carries protocol traffic only; lifecycle observations go through the
 * marker file so tests never parse stdout for anything but JSON-RPC frames.
 */
import { appendFile } from "node:fs/promises";
import * as readline from "node:readline";

export const PROBE_TOOL_NAME = "probe";

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

type Root = { uri: string; name: string };

const TAG = process.argv[2] ?? "untagged";
const MARKER_PATH = process.argv[3] ?? null;

/** Roots returned for the server-initiated `roots/list` sent right after `notifications/initialized`. */
let initialRootsPromise: Promise<Root[]> | null = null;

let nextServerRequestId = 1000;
const pendingServerRequests = new Map<string | number, (result: Record<string, unknown>) => void>();

function send(message: JsonRpcMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Issue a server-to-client request and resolve with its response result. */
function requestFromServer(method: string): Promise<Record<string, unknown>> {
	const id = nextServerRequestId++;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	pendingServerRequests.set(id, resolve);
	send({ jsonrpc: "2.0", id, method, params: {} });
	return promise;
}

async function probePayload(): Promise<Record<string, unknown>> {
	const rootsAtCall = await requestFromServer("roots/list");
	return {
		tag: TAG,
		pid: process.pid,
		cwd: process.cwd(),
		initialRoots: await (initialRootsPromise ?? Promise.resolve([])),
		rootsAtCall,
	};
}

function buildResult(method: string): Promise<Record<string, unknown>> | Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: `workspace-probe-${TAG}`, version: "1.0.0" },
				capabilities: { tools: {}, prompts: {}, resources: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: PROBE_TOOL_NAME,
						description: `Workspace probe server (${TAG}).`,
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call":
			return probePayload().then(payload => ({
				content: [{ type: "text", text: JSON.stringify(payload) }],
				isError: false,
			}));
		case "prompts/list":
			return {
				prompts: [{ name: `prompt-${TAG}`, description: `Probe prompt for ${TAG}.`, arguments: [] }],
			};
		case "prompts/get":
			return {
				description: `Probe prompt for ${TAG}.`,
				messages: [{ role: "user", content: { type: "text", text: `prompt-body-${TAG}` } }],
			};
		case "resources/list":
			return {
				resources: [{ uri: `probe://${TAG}/resource`, name: `resource-${TAG}`, mimeType: "text/plain" }],
			};
		case "resources/templates/list":
			return { resourceTemplates: [] };
		case "resources/read":
			return {
				contents: [{ uri: `probe://${TAG}/resource`, mimeType: "text/plain", text: `resource-body-${TAG}` }],
			};
		default:
			return {};
	}
}

async function writeMarker(event: Record<string, unknown>): Promise<void> {
	if (!MARKER_PATH) return;
	await appendFile(MARKER_PATH, `${JSON.stringify({ tag: TAG, pid: process.pid, cwd: process.cwd(), ...event })}\n`);
}

async function startServer(): Promise<void> {
	await writeMarker({ event: "start" });

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(trimmed) as JsonRpcMessage;
			} catch {
				return;
			}

			// Response to one of our server-initiated requests.
			if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
				const resolve = pendingServerRequests.get(msg.id);
				if (!resolve) return;
				pendingServerRequests.delete(msg.id);
				resolve(msg.result ?? {});
				return;
			}

			// Notification: start the workspace handshake once initialized.
			if (msg.id === undefined || msg.id === null) {
				if (msg.method === "notifications/initialized" && !initialRootsPromise) {
					initialRootsPromise = requestFromServer("roots/list").then(async result => {
						const roots = (result.roots as Root[] | undefined) ?? [];
						await writeMarker({ event: "roots", roots });
						return roots;
					});
				}
				return;
			}

			// Request from the client.
			try {
				const result = await buildResult(msg.method ?? "");
				send({ jsonrpc: "2.0", id: msg.id, result });
			} catch (error) {
				send({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
				});
			}
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	void startServer();
}
