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
import { getBundledAgent, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { REVIEW_LENS_OUTPUT } from "@oh-my-pi/pi-coding-agent/task/specialist-agents";
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

	it("preserves specialist tool policy, model selection, and review schema through bundled frontmatter", () => {
		const lenses = [
			["conventions-specialist", "@slow", Effort.High],
			["integration-specialist", "@slow", Effort.High],
			["testing-specialist", "@task", Effort.Medium],
			["code-clarity-specialist", "@task", Effort.Medium],
			["docs-specialist", "@task", Effort.Low],
			["security-specialist", "@slow", Effort.High],
			["data-model-specialist", "@task", Effort.High],
		] as const;

		for (const [name, model, effort] of lenses) {
			const agent = getBundledAgent(name);
			expect(agent?.output).toEqual(REVIEW_LENS_OUTPUT);
			expect(agent?.model).toEqual([model]);
			expect(agent?.thinkingLevel).toBe(effort);
			expect(agent?.isolation).toBeUndefined();
			expect(agent?.spawns).toEqual(["scout"]);
			for (const tool of ["read", "bash", "yield"]) {
				expect(agent?.tools).toContain(tool);
			}
			expect(agent?.tools).not.toContain("edit");
			expect(agent?.tools).not.toContain("write");
		}
	});

	it("validates incremental specialist findings and rejects incomplete ones", () => {
		const validator = buildOutputValidator(getBundledAgent("conventions-specialist")?.output);
		expect(validator.error).toBeUndefined();
		const findingValidator = validator.validator?.validateSection.get("findings");
		expect(findingValidator).toBeDefined();
		const finding = {
			title: "Use the canonical helper",
			body: "The change bypasses the shared helper and produces a divergent result.",
			priority: 2,
			confidence: 0.9,
			file_path: "src/feature.ts",
			line_start: 10,
			line_end: 10,
			recommendation: "Call the existing helper.",
		};
		expect(findingValidator?.(finding).success).toBe(true);
		expect(findingValidator?.({ ...finding, title: undefined }).success).toBe(false);
	});

	it("keeps the devil's advocate read-only and rejects unrecognized verdicts", () => {
		const agent = getBundledAgent("devils-advocate");
		expect(agent?.isolation).toBeUndefined();
		expect(agent?.tools).toEqual(["read", "grep", "glob", "web_search", "yield"]);
		const validator = buildOutputValidator(agent?.output);
		const response = {
			target: "A migration plan",
			verdict: "fragile",
			objections: [{ claim: "Old consumers persist", why_it_matters: "They cannot parse the new field" }],
			bottom_line: "Keep the compatibility window.",
		};
		expect(validator.validator?.validate(response).success).toBe(true);
		expect(validator.validator?.validate({ ...response, verdict: "maybe" }).success).toBe(false);
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
	it("keeps unpacked workers applying their edits under default isolation", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-unpack-"));
		try {
			await $`git init -q ${repo}`.quiet();
			await runAgentsCommand({
				action: "unpack",
				flags: { dir: path.join(repo, ".omp", "agents"), json: true },
			});
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

	// Issue #4761: with `modelRoles.slow: ...:xhigh`, the role's explicit effort
	// suffix must survive agent-pattern expansion and model resolution for the
	// bundled agents routed at that role. The executor prefers an explicit
	// resolved suffix over the agent-definition default (task/executor.ts), so
	// the resolved level below is what the subagent runs at.
	it("resolves the configured slow-role effort suffix for reviewer", () => {
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
		const settings = Settings.isolated({
			modelRoles: { slow: "openai-codex/gpt-5.5:xhigh" },
		});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const agent = getBundledAgent("reviewer");
		expect(agent?.thinkingLevel).toBeUndefined();
		const patterns = resolveAgentModelPatterns({ agentModel: agent?.model, settings });
		const resolved = resolveModelOverride(patterns, registry, settings);
		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.5");
		expect(resolved.thinkingLevel).toBe(Effort.XHigh);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});

	// The alias is expanded before it reaches the executor, so the role identity
	// only survives as the `role` half of the selection. A subagent's inherited
	// `retry.fallbackChains` entry is keyed off it — lose it and every bundled
	// agent silently retries on the `default` role's chain.
	it("keeps the role identity of every alias-routed bundled agent through expansion", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/opus",
				task: "anthropic/sonnet",
				smol: "fast/hy3",
				slow: "codex/sol",
			},
		});

		for (const [name, role, model] of [
			["task", "task", "anthropic/sonnet"],
			["sonic", "smol", "fast/hy3"],
			["scout", "smol", "fast/hy3"],
			["reviewer", "slow", "codex/sol"],
		] as const) {
			const agent = getBundledAgent(name);
			expect(resolveAgentModelSelection({ agentModel: agent?.model, settings })).toEqual({
				patterns: [model],
				role,
			});
		}
	});
});
