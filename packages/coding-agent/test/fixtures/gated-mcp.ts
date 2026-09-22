#!/usr/bin/env bun
/**
 * Test fixture: a well-behaved stdio MCP server whose process lifecycle a test
 * controls through files. Speaks newline-delimited JSON-RPC 2.0 (the wire
 * format of `StdioTransport`): one JSON object per line on stdin, one JSON
 * response per line on stdout. Only requests (objects with an `id`) get a
 * response; notifications (including `notifications/initialized`) are dropped.
 *
 * Protocol stdout stays clean: lifecycle observations go to a log file.
 *
 * Usage: gated-mcp.ts <logPath> [gatePath]
 *
 * - `<logPath>`: every lifecycle event is appended here (`spawn <pid>`,
 *   `gate-refused`, `exit`).
 * - `<gatePath>`: when this file exists at spawn, the server exits before the
 *   protocol starts — models a server that connected at setup but fails to
 *   reconnect later.
 */
import * as readline from "node:readline";
import * as fs from "node:fs";

const logPath = process.argv[2] || undefined;
const gatePath = process.argv[3] || undefined;

function log(event: string): void {
	if (!logPath) return;
	fs.appendFileSync(logPath, `${event}\n`);
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "gated-mcp-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: "gated_tool",
						description: "Fixture tool from the gated MCP server.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		default:
			return {};
	}
}

async function startServer(): Promise<void> {
	log(`spawn ${process.pid}`);
	if (gatePath && (await Bun.file(gatePath).exists())) {
		log("gate-refused");
		process.exit(1);
	}
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			log("exit");
			process.exit(0);
		});
	}

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => {
		log("exit");
		process.exit(0);
	});
}

if (import.meta.main) {
	void startServer();
}
