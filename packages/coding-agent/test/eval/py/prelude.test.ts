import { describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";
const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	// The full prelude exceeds Windows' ~32k `python -c` command-line limit
	// (ENAMETOOLONG); a script file behaves identically on every platform.
	const dir = await TempDir.create("omp-py-prelude-");
	try {
		const scriptPath = dir.join("script.py");
		await Bun.write(scriptPath, script);
		const proc = Bun.spawn([pythonPath, scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// Python's text-mode stdout emits \r\n on Windows.
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	} finally {
		await dir.remove();
	}
}

describe("python prelude", () => {
	it("infers eval tool schemas and replaces definitions by name", async () => {
		const result = await runPrelude(
			[
				"from typing import Annotated, Literal, Optional",
				"@tool",
				"def word_count(text: Annotated[str, 'Text to split'], sep: Literal[' ', ','] = ' ', limit: Optional[int] = None) -> dict:",
				'    """Count words in text."""',
				"    return {'count': len(text.split(sep))}",
				"first = __omp_tools__['word_count'].describe()",
				"@tool(name='word_count', description='Replacement')",
				"def replacement(text: str) -> dict:",
				"    return {'count': 1}",
				"print(json.dumps({'first': first, 'current': __omp_tools__['word_count'].describe(), 'defined': tool.defined()}, sort_keys=True))",
				"print(tool.undefine('word_count'), tool.defined())",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines[0] ?? "{}");
		expect(value.first).toEqual({
			name: "word_count",
			description: "Count words in text.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Text to split" },
					sep: { enum: [" ", ","], default: " " },
					limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
				},
				required: ["text"],
				additionalProperties: false,
			},
		});
		expect(value.current.description).toBe("Replacement");
		expect(value.defined).toEqual(["word_count"]);
		expect(lines[1]).toBe("True []");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("bypasses discovered proxies for loopback bridge calls", async () => {
		let proxyRequests = 0;
		const bridge = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args?: { path?: string } };
				return Response.json({
					ok: true,
					value: body.args?.path,
				});
			},
		});
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxyRequests++;
				return new Response("proxy intercepted", { status: 502 });
			},
		});

		try {
			const proxyUrl = proxy.url.toString();
			// urllib also reads macOS SystemConfiguration; environment injection
			// is the hermetic equivalent for this subprocess test.
			const result = await runPrelude(
				[
					"async def main():",
					'    paths = ["one.ts", "two.ts", "three.ts"]',
					"    results = []",
					"    for path in paths:",
					'        results.append(await tool.read({"path": path}))',
					"    print(results)",
					"asyncio.run(main())",
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: bridge.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
				},
			);

			expect(result).toEqual({
				stdout: "['one.ts', 'two.ts', 'three.ts']\n",
				stderr: "",
				exitCode: 0,
			});
			expect(proxyRequests).toBe(0);
		} finally {
			bridge.stop(true);
			proxy.stop(true);
		}
	});

	it("forwards mutable through agent()/workpool() and rejects obsolete kwargs before any bridge call", async () => {
		const result = await runPrelude(
			[
				"calls = []",
				"def _capture(name, args):",
				"    calls.append(args)",
				"    if name == '__agent__':",
				"        return {'id': 'a1', 'agent': 'task'}",
				"    return {'name': 'pool-1', 'agent': 'task', 'limit': 2}",
				"_bridge_call = _capture",
				"def raised(fn):",
				"    try:",
				"        fn()",
				"    except TypeError as exc:",
				"        return str(exc)",
				"    return None",
				"out = {}",
				"handle = agent('do work', mutable=False)",
				"out['agent_false'] = calls[-1]",
				"out['agent_handle'] = handle.id",
				"agent('more work', mutable=True)",
				"out['agent_true'] = calls[-1]",
				"out['agent_mutable_int'] = raised(lambda: agent('x', mutable=1))",
				"out['agent_isolated'] = raised(lambda: agent('x', isolated=True))",
				"out['agent_apply'] = raised(lambda: agent('x', apply=True))",
				"out['agent_merge'] = raised(lambda: agent('x', merge=True))",
				"out['agent_call_count'] = len(calls)",
				"pool = workpool('task', mutable=False)",
				"out['pool_false'] = calls[-1]",
				"out['pool_name'] = pool.name",
				"out['pool_mutable_int'] = raised(lambda: workpool(mutable=1))",
				"out['pool_isolated'] = raised(lambda: workpool(isolated=True))",
				"out['pool_call_count'] = len(calls)",
				"print(json.dumps(out, sort_keys=True))",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
		// Boolean mutable forwards verbatim, in both polarities.
		expect(out.agent_false).toEqual({ prompt: "do work", mutable: false });
		expect(out.agent_true).toEqual({ prompt: "more work", mutable: true });
		expect(out.agent_handle).toBe("a1");
		// Non-bool mutable and the removed isolation controls raise TypeError
		// before any bridge dispatch: only the two valid agent() calls landed.
		expect(out.agent_mutable_int).toContain("agent() mutable must be a bool");
		expect(out.agent_isolated).toContain("unexpected keyword argument 'isolated'");
		expect(out.agent_apply).toContain("unexpected keyword argument 'apply'");
		expect(out.agent_merge).toContain("unexpected keyword argument 'merge'");
		expect(out.agent_call_count).toBe(2);
		// Same contract on pool creation.
		expect(out.pool_false).toEqual({ op: "create", agent: "task", mutable: false });
		expect(out.pool_name).toBe("pool-1");
		expect(out.pool_mutable_int).toContain("workpool() mutable must be a bool");
		expect(out.pool_isolated).toContain("unexpected keyword argument 'isolated'");
		expect(out.pool_call_count).toBe(3);
	});
});
