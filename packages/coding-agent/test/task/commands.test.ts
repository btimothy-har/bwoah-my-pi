import { describe, expect, it } from "bun:test";
import { expandCommand, loadBundledCommands, type WorkflowCommand } from "@oh-my-pi/pi-coding-agent/task/commands";

function makeCommand(instructions: string): WorkflowCommand {
	return { name: "test", description: "test", instructions, source: "project", filePath: "test.md" };
}

describe("expandCommand", () => {
	it("substitutes $@ with the input", () => {
		expect(expandCommand(makeCommand("Do: $@ and again $@"), "fix the bug")).toBe(
			"Do: fix the bug and again fix the bug",
		);
	});

	it("keeps $-patterns in user input literal", () => {
		expect(expandCommand(makeCommand("Run $@"), "echo $$ $& $' $` $@")).toBe("Run echo $$ $& $' $` $@");
	});

	it("expands the embedded pull-request workflow without interpreting user dollar patterns", () => {
		const command = loadBundledCommands().find(entry => entry.name === "pull-request");
		expect(command).toBeDefined();
		const instructions = "Only draft; retain $1 and $$ literally";
		const expanded = expandCommand(command!, instructions);
		expect(expanded).toContain("skill://pull-request");
		expect(expanded).toContain(instructions);
		expect(expanded).not.toContain("$@");
	});
});
