/**
 * Builtin Skills Provider
 *
 * Ships bundled skills embedded into the binary and materializes them under
 * `<agentDir>/builtin-skills/` so the standard skill pipeline (scan, parse,
 * `skill://` protocol, `/skill:` commands, disabledSkills filtering) handles
 * everything else unchanged. Registered at the lowest priority so any
 * user/project skill with the same `name` overrides the bundled copy
 * (first-wins dedup by name).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../../capability";
import { type Skill, skillCapability } from "../../capability/skill";
import type { LoadContext, LoadResult } from "../../capability/types";
import { scanSkillsFromDir } from "../helpers";
import codeReviewSkill from "./code-review/SKILL.md" with { type: "text" };

const PROVIDER_ID = "omp-builtin";
const DISPLAY_NAME = "Builtin Skills";
// Lowest priority: every other skill provider wins a name conflict.
const PRIORITY = 1;

const BUILTIN_SKILLS: Record<string, string> = {
	"code-review": codeReviewSkill,
};

/**
 * Materialize embedded skills to disk when missing or content-differs
 * (read-compare, so an unchanged file keeps its mtime). Bun.write creates
 * parent directories.
 */
async function materializeBuiltinSkills(): Promise<string> {
	const builtinDir = path.join(getAgentDir(), "builtin-skills");
	for (const [name, content] of Object.entries(BUILTIN_SKILLS)) {
		const skillPath = path.join(builtinDir, name, "SKILL.md");
		const current = await fs.readFile(skillPath, "utf8").catch(() => undefined);
		if (current === content) continue;
		// Temp sibling + rename: a concurrent discovery scanning this directory
		// must never observe a truncated file mid-write.
		const tempPath = `${skillPath}.${process.pid}.tmp`;
		await Bun.write(tempPath, content);
		await fs.rename(tempPath, skillPath);
	}
	return builtinDir;
}

async function loadBuiltinSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const builtinDir = await materializeBuiltinSkills();
	return scanSkillsFromDir(ctx, {
		dir: builtinDir,
		providerId: PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Skills shipped with the agent (materialized under <agentDir>/builtin-skills)",
	priority: PRIORITY,
	load: loadBuiltinSkills,
});
