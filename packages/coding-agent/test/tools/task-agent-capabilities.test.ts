import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled review lenses as read-only without executable or nested tools", () => {
		const agents = loadBundledAgents();

		for (const name of [
			"scout",
			"devils-advocate",
			"conventions-specialist",
			"integration-specialist",
			"testing-specialist",
			"code-clarity-specialist",
			"docs-specialist",
			"security-specialist",
			"data-model-specialist",
		]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(true);
		}
		for (const name of ["task", "sonic", "reviewer", "security-reviewer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("does not classify an agent declaring `hub` as read-only", () => {
		// `hub` resolves to exec approval for start/stop/restart, process-stdin
		// `send`, unrecognized ops and malformed params, so declaring it must
		// disqualify an agent from the read-only label surfaced to the model.
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "hub", "yield"] })).toBe(false);
		expect(isReadOnlyAgent({ ...scout, tools: ["hub"] })).toBe(false);

		// Guard against over-correcting: the positive case must still hold.
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "yield"] })).toBe(true);
	});

	it("does not label a nested-spawning agent read-only when its listed tools are reads", () => {
		const scout = agentByName(loadBundledAgents(), "scout");
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "yield"], spawns: ["task"] })).toBe(false);
	});

	it("does not label state-changing memory or session tools read-only", () => {
		const scout = agentByName(loadBundledAgents(), "scout");
		for (const tool of ["retain", "memory_edit", "todo", "checkpoint", "rewind"]) {
			expect(isReadOnlyAgent({ ...scout, tools: ["read", tool, "yield"] })).toBe(false);
		}
	});

	it("disables read summarization for scout, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("keeps bundled agent bodies distinguishable for persisted transcript attribution", () => {
		const agents = loadBundledAgents();
		for (const a of agents) {
			for (const b of agents) {
				if (
					a.name === b.name ||
					(a.name === "task" && b.name === "sonic") ||
					(a.name === "sonic" && b.name === "task")
				)
					continue;
				expect(b.systemPrompt.includes(a.systemPrompt.trim())).toBe(false);
			}
		}
	});

	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of [
			"task",
			"scout",
			"sonic",
			"reviewer",
			"security-reviewer",
			"conventions-specialist",
			"integration-specialist",
			"testing-specialist",
			"code-clarity-specialist",
			"docs-specialist",
			"security-specialist",
			"data-model-specialist",
			"devils-advocate",
		]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});
