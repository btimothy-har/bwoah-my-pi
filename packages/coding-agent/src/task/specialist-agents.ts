import { Effort } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import clarityMd from "../prompts/agents/specialists/code-clarity-specialist.md" with { type: "text" };
import conventionsMd from "../prompts/agents/specialists/conventions-specialist.md" with { type: "text" };
import dataModelMd from "../prompts/agents/specialists/data-model-specialist.md" with { type: "text" };
import devilMd from "../prompts/agents/specialists/devils-advocate.md" with { type: "text" };
import docsMd from "../prompts/agents/specialists/docs-specialist.md" with { type: "text" };
import integrationMd from "../prompts/agents/specialists/integration-specialist.md" with { type: "text" };
import reviewMethodMd from "../prompts/agents/specialists/review-method.md" with { type: "text" };
import securityMd from "../prompts/agents/specialists/security-specialist.md" with { type: "text" };
import testingMd from "../prompts/agents/specialists/testing-specialist.md" with { type: "text" };
import type { AgentFrontmatter, EmbeddedAgentDef } from "./agents";

// Each lens body uses this partial when loadBundledAgents renders its template.
prompt.registerPartial("specialistReviewMethod", reviewMethodMd);

export const REVIEW_LENS_OUTPUT = {
	properties: {
		overall_correctness: {
			metadata: { description: "incorrect when any P0/P1 finding survives, else correct" },
			enum: ["correct", "incorrect"],
		},
		explanation: { metadata: { description: "1-3 sentences: what was examined and the verdict" }, type: "string" },
		confidence: { metadata: { description: "Verdict confidence (0.0-1.0)" }, type: "number" },
	},
	optionalProperties: {
		findings: {
			metadata: {
				description:
					'Populate via incremental yield sections under type: ["findings"]; do not repeat it in a final payload.',
			},
			elements: {
				properties: {
					title: { metadata: { description: "Imperative, ≤80 chars" }, type: "string" },
					body: {
						metadata: {
							description: "One paragraph: violated contract or convention, trigger, impact, evidence",
						},
						type: "string",
					},
					priority: {
						metadata: {
							description: "P0-P3: 0 blocks release, 1 fix next cycle, 2 fix eventually, 3 nice to have",
						},
						type: "number",
					},
					confidence: { metadata: { description: "Confidence it is real (0.0-1.0)" }, type: "number" },
					file_path: { metadata: { description: "Repository-relative path" }, type: "string" },
					line_start: { metadata: { description: "First line (1-indexed)" }, type: "number" },
					line_end: { metadata: { description: "Last line (1-indexed, ≤10 lines)" }, type: "number" },
				},
				optionalProperties: {
					recommendation: { metadata: { description: "Smallest sufficient fix direction" }, type: "string" },
				},
			},
		},
	},
} as const;

export const CHALLENGE_OUTPUT = {
	properties: {
		target: { type: "string" },
		verdict: { enum: ["defensible", "fragile", "likely_wrong", "underspecified"] },
		objections: { elements: { properties: { claim: { type: "string" }, why_it_matters: { type: "string" } } } },
		bottom_line: { type: "string" },
	},
	optionalProperties: {
		missing_evidence: { elements: { type: "string" } },
		alternative: { type: "string" },
		failure_modes: { elements: { type: "string" } },
		open_questions: { elements: { type: "string" } },
	},
} as const;

const LENS_TOOLS = ["read", "grep", "glob", "bash", "lsp", "web_search", "ast_grep"];

function lens(
	fileName: string,
	frontmatter: Omit<AgentFrontmatter, "tools" | "spawns">,
	template: string,
): EmbeddedAgentDef {
	return {
		fileName,
		frontmatter: { ...frontmatter, tools: LENS_TOOLS, spawns: "scout", output: REVIEW_LENS_OUTPUT },
		template,
	};
}

export const SPECIALIST_AGENT_DEFS: EmbeddedAgentDef[] = [
	lens(
		"conventions-specialist.md",
		{
			name: "conventions-specialist",
			description:
				"Reviews or advises on adherence to this repository's documented rules, established patterns, and canonical owners; cites where each convention is established",
			model: "@slow",
			thinkingLevel: Effort.High,
		},
		conventionsMd,
	),
	lens(
		"integration-specialist.md",
		{
			name: "integration-specialist",
			description:
				"Reviews or advises on cross-component contracts: producer/consumer parity, runtime wiring, migrations, rollout, and operational completion",
			model: "@slow",
			thinkingLevel: Effort.High,
		},
		integrationMd,
	),
	lens(
		"testing-specialist.md",
		{
			name: "testing-specialist",
			description:
				"Reviews or advises on whether tests catch the regressions that matter: coverage gaps, counterfactual strength, mock and assertion quality",
			model: "@task",
			thinkingLevel: Effort.Medium,
		},
		testingMd,
	),
	lens(
		"code-clarity-specialist.md",
		{
			name: "code-clarity-specialist",
			description:
				"Reviews or advises on unnecessary complexity, hidden invariants, redundancy, and misplaced responsibilities; every suggestion preserves behavior",
			model: "@task",
			thinkingLevel: Effort.Medium,
		},
		clarityMd,
	),
	lens(
		"docs-specialist.md",
		{
			name: "docs-specialist",
			description:
				"Reviews or advises on documentation accuracy, completeness, placement, and long-term value against the implemented behavior",
			model: "@task",
			thinkingLevel: Effort.Low,
		},
		docsMd,
	),
	lens(
		"security-specialist.md",
		{
			name: "security-specialist",
			description:
				"Change-review and design lens for trust boundaries, runtime principals, injection, secrets, and data exposure (not the security-scan worker security-reviewer)",
			model: "@slow",
			thinkingLevel: Effort.High,
		},
		securityMd,
	),
	lens(
		"data-model-specialist.md",
		{
			name: "data-model-specialist",
			description:
				"Reviews or advises on SQL and dbt models: grain, joins and fan-out, lineage, materialization, schema contracts, tests, dimensional modeling",
			model: "@task",
			thinkingLevel: Effort.High,
		},
		dataModelMd,
	),
	{
		fileName: "devils-advocate.md",
		frontmatter: {
			name: "devils-advocate",
			description:
				"Contrarian second opinion on a brief, plan, diagnosis, or conclusion; returns objections, missing evidence, alternatives — never edits",
			tools: ["read", "grep", "glob", "web_search"],
			model: "@slow",
			thinkingLevel: Effort.High,
			output: CHALLENGE_OUTPUT,
		},
		template: devilMd,
	},
];
