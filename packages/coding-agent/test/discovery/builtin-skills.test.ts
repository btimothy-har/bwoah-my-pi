/**
 * The bundled `omp-builtin` skills provider ships skills embedded into the
 * binary and materializes them under `<agentDir>/builtin-skills/` so the
 * standard skill pipeline (scan, `skill://` protocol, disabledExtensions)
 * serves them unchanged. These tests defend discovery through the real
 * loadSkills path, user-skill override precedence, and stable materialization.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@oh-my-pi/pi-coding-agent/discovery";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function builtinSkillPath(): string {
	// Resolve per call: setAgentDir() redirects getAgentDir() mid-test.
	return path.join(getAgentDir(), "builtin-skills", "code-review", "SKILL.md");
}

async function readMaterializedSkill(): Promise<string> {
	return fs.readFile(builtinSkillPath(), "utf8");
}

describe("builtin-skills provider", () => {
	let tempHome: string;
	let originalAgentDir: string;
	let restoreHomedir: (() => void) | undefined;

	afterEach(async () => {
		resetActiveSkillsForTests();
		if (restoreHomedir) {
			restoreHomedir();
			restoreHomedir = undefined;
		}
		setAgentDir(originalAgentDir);
		if (tempHome) await removeWithRetries(tempHome);
	});

	async function isolateAgentDir(): Promise<void> {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-skills-"));
		originalAgentDir = getAgentDir();
		// getAgentDir is module-frozen; setAgentDir redirects it for the test.
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const spy = spyOn(os, "homedir").mockReturnValue(tempHome);
		restoreHomedir = () => spy.mockRestore();
	}

	it("discovers the code-review skill through the real loadSkills path and serves it via skill://", async () => {
		await isolateAgentDir();

		const { skills, warnings } = await loadSkills();
		expect(warnings).toEqual([]);
		const skill = skills.find(entry => entry.name === "code-review");
		expect(skill).toBeDefined();
		expect(skill!.filePath).toBe(builtinSkillPath());
		expect(skill!.description).toContain("code review");
		expect(skill!.source).toBe("omp-builtin:user");

		setActiveSkills(skills);
		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://code-review"));
		expect(resource.sourcePath).toBe(builtinSkillPath());
		// Semantic markers: the four procedure phases and the trust boundary.
		for (const marker of ["### 1. Prepare", "### 2. Dispatch", "### 3. Synthesize", "### 4. Report", "UNTRUSTED DATA"]) {
			expect(resource.content).toContain(marker);
		}
	});

	it("lets a user-level skill of the same name override the bundled copy", async () => {
		await isolateAgentDir();

		const userSkillDir = path.join(getAgentDir(), "skills", "code-review");
		await fs.mkdir(userSkillDir, { recursive: true });
		await Bun.write(
			path.join(userSkillDir, "SKILL.md"),
			'---\nname: code-review\ndescription: "User override for the code review procedure."\n---\n\n# user override body\n',
		);

		const { skills } = await loadSkills();
		const winners = skills.filter(skill => skill.name === "code-review");
		expect(winners).toHaveLength(1);
		expect(winners[0]!.description).toBe("User override for the code review procedure.");
		expect(winners[0]!.filePath).toBe(path.join(userSkillDir, "SKILL.md"));
		expect(winners[0]!._source?.provider).not.toBe("omp-builtin");
	});

	it("does not rewrite the materialized file when content is unchanged (mtime stable)", async () => {
		await isolateAgentDir();

		await loadSkills();
		const first = await fs.stat(builtinSkillPath());
		const contentBefore = await readMaterializedSkill();

		await loadSkills();

		// No wall-clock sleep: APFS mtimeMs has nanosecond granularity, so a
		// rewrite would almost certainly move it.
		const second = await fs.stat(builtinSkillPath());
		expect(second.mtimeMs).toBe(first.mtimeMs);
		expect(await readMaterializedSkill()).toBe(contentBefore);
	});

	it("re-materializes the bundled copy when the file diverges from the embedded content", async () => {
		await isolateAgentDir();

		await loadSkills();
		await Bun.write(builtinSkillPath(), "---\nname: code-review\ndescription: tampered\n---\ntampered\n");
		await loadSkills();

		expect(await readMaterializedSkill()).toContain("### 1. Prepare");
	});

	it("registers at the lowest skills-provider priority", () => {
		const cap = getCapability("skills");
		expect(cap).toBeDefined();
		const provider = cap!.providers.find(entry => entry.id === "omp-builtin");
		expect(provider).toBeDefined();
		expect(provider!.priority).toBe(1);
		const otherPriorities = cap!.providers.filter(p => p.id !== "omp-builtin").map(p => p.priority);
		expect(provider!.priority).toBeLessThan(Math.min(...otherPriorities));
	});
});
