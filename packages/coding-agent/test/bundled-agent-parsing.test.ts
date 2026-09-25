import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	resolveAgentModelPatterns,
	resolveAgentModelSelection,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { getBundledAgent, loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { resolveEffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

describe("bundled agent parsing", () => {
	it("defaults the task agent to the auto thinking selector", () => {
		const task = getBundledAgent("task");

		expect(task).toBeDefined();
		expect(task?.model).toEqual(["@task"]);
		expect(task?.thinkingLevel).toBe(AUTO_THINKING);
	});

	it("parses specialist Markdown frontmatter without imposing a consultation schema", () => {
		const lenses = [
			["conventions-specialist", Effort.High],
			["integration-specialist", Effort.High],
			["testing-specialist", Effort.Medium],
			["code-clarity-specialist", Effort.Medium],
			["docs-specialist", Effort.Low],
			["security-specialist", Effort.High],
			["data-model-specialist", Effort.High],
		] as const;

		for (const [name, effort] of lenses) {
			const agent = getBundledAgent(name);
			expect(agent?.output).toBeUndefined();
			expect(agent?.thinkingLevel).toBe(effort);
			expect(agent?.isolation).toBeUndefined();
			expect(agent?.spawns).toBeUndefined();
			expect(agent?.tools).toEqual(["read", "find", "grep", "glob", "ast_grep", "yield"]);
		}
	});

	it("keeps the devil's advocate read-only and unschematized by default", () => {
		const agent = getBundledAgent("devils-advocate");
		expect(agent?.isolation).toBeUndefined();
		expect(agent?.tools).toEqual(["read", "grep", "glob", "web_search", "yield"]);
		expect(agent?.thinkingLevel).toBe(Effort.High);
		expect(agent?.output).toBeUndefined();
	});

	it("accepts apply only when explicitly configured and defaults invalid isolation to discard", () => {
		expect(getBundledAgent("task")?.isolation).toBe("apply");
		expect(getBundledAgent("sonic")?.isolation).toBe("apply");
		expect(getBundledAgent("reviewer")?.isolation).toBeUndefined();
		for (const [value, expected] of [
			["apply", "apply"],
			["discard", "discard"],
			["typo", undefined],
		] as const) {
			const agent = parseAgent(
				"custom.md",
				`---\nname: custom\ndescription: Custom agent\nisolation: ${value}\n---\nReview the assignment.`,
				"user",
			);
			expect(agent.isolation).toBe(expected);
		}
	});

	it("keeps unpacked workers applying edits and specialists reporting without a default schema", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-unpack-"));
		try {
			await $`git init -q ${repo}`.quiet();
			await runAgentsCommand({
				action: "unpack",
				flags: { dir: path.join(repo, ".omp", "agents"), json: true },
			});
			for (const name of [
				"conventions-specialist",
				"integration-specialist",
				"testing-specialist",
				"code-clarity-specialist",
				"docs-specialist",
				"security-specialist",
				"data-model-specialist",
			]) {
				const unpacked = path.join(repo, ".omp", "agents", `${name}.md`);
				const parsed = parseAgent(unpacked, await Bun.file(unpacked).text(), "project");
				expect(parsed.systemPrompt).toContain("## Review method");
				expect(parsed.systemPrompt).not.toContain("{{> specialistReviewMethod}}");
			}
			const session = {
				cwd: repo,
				settings: Settings.isolated({ "task.isolation.enabled": true }),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			};
			for (const name of ["task", "sonic"]) {
				const policy = await resolveEffectiveSubagentPolicy({
					session,
					invocationKind: "task",
					assignment: "Edit a file",
					agent: name,
				});
				expect(policy.agent.source).toBe("project");
				expect(policy.isIsolated).toBe(true);
				expect(policy.discardChanges).toBe(false);
				expect(policy.applyChanges).toBe(true);
			}

			for (const name of ["conventions-specialist", "devils-advocate"]) {
				const policy = await resolveEffectiveSubagentPolicy({
					session,
					invocationKind: "task",
					assignment: "Review the change",
					agent: name,
				});
				expect(policy.agent.source).toBe("project");
				expect(policy.isIsolated).toBe(true);
				expect(policy.discardChanges).toBe(true);
				expect(policy.applyChanges).toBe(false);
				expect(policy.schema.source).toBe("none");
			}
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("accepts security-reviewer findings with optional remediation metadata", () => {
		const securityReviewer = getBundledAgent("security-reviewer");
		const findingValidator = buildOutputValidator(securityReviewer?.output).validator?.validateSection.get(
			"findings",
		);

		expect(findingValidator).toBeDefined();
		expect(
			findingValidator?.({
				rule_id: "command-injection",
				title: "Unsanitized command input",
				summary: "User input reaches a shell command",
				severity: "high",
				confidence: "high",
				category: "injection",
				locations: [{ path: "src/run.ts", start_line: 10 }],
				cwe: ["CWE-78"],
				evidence: [{ label: "data flow", explanation: "Input reaches exec" }],
				anchor: "run",
				remediation: "Pass arguments without a shell",
			}).success,
		).toBe(true);
	});

	it("inherits an explicit parent effort suffix for reviewer", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({ modelRoles: { default: "openai-codex/gpt-5.5:low" } });
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const agent = getBundledAgent("reviewer");
		const patterns = resolveAgentModelPatterns({
			agentModel: agent?.model,
			settings,
			activeModelPattern: "openai-codex/gpt-5.5:xhigh",
		});
		const resolved = resolveModelOverride(patterns, registry, settings);
		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.5");
		expect(resolved.thinkingLevel).toBe(Effort.XHigh);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});

	it("routes non-worker agents to the active model without changing worker roles", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/opus",
				task: "anthropic/sonnet",
				smol: "fast/hy3",
			},
		});
		const activeModelPattern = "codex/sol:medium";

		for (const [name, role, model] of [
			["task", "task", "anthropic/sonnet"],
			["sonic", "smol", "fast/hy3"],
		] as const) {
			const agent = getBundledAgent(name);
			expect(resolveAgentModelSelection({ agentModel: agent?.model, settings, activeModelPattern })).toEqual({
				patterns: [model],
				role,
			});
		}
		for (const agent of loadBundledAgents().filter(agent => !["task", "sonic"].includes(agent.name))) {
			expect(resolveAgentModelSelection({ agentModel: agent.model, settings, activeModelPattern })).toEqual({
				patterns: [activeModelPattern],
				role: undefined,
			});
		}
		const reviewer = getBundledAgent("reviewer");
		expect(resolveAgentModelSelection({ agentModel: reviewer?.model, settings })).toEqual({
			patterns: ["anthropic/opus"],
			role: undefined,
		});
	});
});
