import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

/** Custom definition with a read-only tool list and no spawn authority. */
function customReadOnly(tools: string[], extra: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "custom-lens",
		description: "Custom read-only lens",
		systemPrompt: "prompt",
		source: "user",
		tools,
		...extra,
	};
}

describe("task agent capability descriptions", () => {
	it("classifies every bundled agent as delegating, never read-only", () => {
		// All bundled agents declare `spawns` and share the common coding
		// toolset; capability is no longer derived from a definition's tool list.
		for (const agent of loadBundledAgents()) {
			expect(agent.spawns).toBeDefined();
			expect(isReadOnlyAgent(agent)).toBe(false);
		}
	});

	it("does not classify an agent declaring `hub` as read-only", () => {
		// `hub` resolves to exec approval for start/stop/restart, process-stdin
		// `send`, unrecognized ops and malformed params, so declaring it must
		// disqualify an agent from the read-only label surfaced to the model.
		expect(isReadOnlyAgent(customReadOnly(["read", "grep", "hub", "yield"]))).toBe(false);
		expect(isReadOnlyAgent(customReadOnly(["hub"]))).toBe(false);

		// Guard against over-correcting: the positive case must still hold.
		expect(isReadOnlyAgent(customReadOnly(["read", "grep", "yield"]))).toBe(true);
	});

	it("does not label a nested-spawning agent read-only when its listed tools are reads", () => {
		expect(isReadOnlyAgent(customReadOnly(["read", "yield"], { spawns: ["task"] }))).toBe(false);
	});

	it("does not classify memory-dependent or state-mutating tools read-only", () => {
		for (const tool of ["recall", "reflect", "retain", "memory_edit", "todo", "checkpoint", "rewind"]) {
			expect(isReadOnlyAgent(customReadOnly(["read", tool, "yield"]))).toBe(false);
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
			"conventions-advisor",
			"integration-advisor",
			"testing-advisor",
			"code-clarity-advisor",
			"docs-advisor",
			"security-advisor",
			"data-model-advisor",
			"devils-advocate",
		]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});
