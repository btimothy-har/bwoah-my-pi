import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expandSlashCommand, loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("loadSlashCommands argument-hint", () => {
	test("parses argument-hint frontmatter into FileSlashCommand.argumentHint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-arg-hint-"));
		try {
			const commandsDir = path.join(cwd, ".agent", "commands");
			await fs.mkdir(commandsDir, { recursive: true });
			await Bun.write(
				path.join(commandsDir, "git-sync-branch.md"),
				[
					"---",
					"description: Rebase current branch",
					'argument-hint: "[base-branch]"',
					"---",
					"Rebase onto $ARGUMENTS",
					"",
				].join("\n"),
			);
			await Bun.write(
				path.join(commandsDir, "plain.md"),
				["---", "description: No hint here", "---", "Body", ""].join("\n"),
			);

			const commands = await loadSlashCommands({ cwd });
			const withHint = commands.find(command => command.name === "git-sync-branch");
			const withoutHint = commands.find(command => command.name === "plain");

			expect(withHint?.argumentHint).toBe("[base-branch]");
			expect(withoutHint?.argumentHint).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("bundled pull-request command", () => {
	test("expands in a clean home and yields to a project command", async () => {
		const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pull-request-command-"));
		const originalAgentDir = getAgentDir();
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		try {
			const cwd = path.join(tempHome, "project");
			await fs.mkdir(cwd);
			const bundled = await loadSlashCommands({ cwd });
			expect(bundled.filter(command => command.name === "pull-request")).toHaveLength(1);
			const bare = expandSlashCommand("/pull-request", bundled);
			expect(bare).toContain("skill://pull-request");
			expect(bare).not.toContain("$@");

			const additional = "Only draft the title and body";
			const expanded = expandSlashCommand(`/pull-request ${additional}`, bundled);
			expect(expanded).toContain(additional);
			expect(expanded.split(additional)).toHaveLength(2);
			expect(expanded).not.toContain("$@");

			const projectCommands = path.join(cwd, ".agent", "commands");
			await fs.mkdir(projectCommands, { recursive: true });
			await Bun.write(
				path.join(projectCommands, "pull-request.md"),
				"---\ndescription: Local override\n---\nLOCAL_OVERRIDE $@\n",
			);
			const overridden = await loadSlashCommands({ cwd });
			expect(overridden.filter(command => command.name === "pull-request")).toHaveLength(1);
			const selected = expandSlashCommand("/pull-request custom note", overridden);
			expect(selected).toContain("LOCAL_OVERRIDE custom note");
			expect(selected).not.toContain("skill://pull-request");
		} finally {
			homedirSpy.mockRestore();
			setAgentDir(originalAgentDir);
			await removeWithRetries(tempHome);
		}
	});
});
