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
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function builtinSkillPath(name: string): string {
	// Resolve per call: setAgentDir() redirects getAgentDir() mid-test.
	return path.join(getAgentDir(), "builtin-skills", name, "SKILL.md");
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
		expect(skill!.filePath).toBe(builtinSkillPath("code-review"));
		expect(skill!.source).toBe("omp-builtin:user");

		setActiveSkills(skills);
		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://code-review"));
		expect(resource.sourcePath).toBe(builtinSkillPath("code-review"));
	});

	it("serves a review schema that validates clean and finding reports", async () => {
		await isolateAgentDir();
		const { skills } = await loadSkills();
		setActiveSkills(skills);
		const { content } = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://code-review"));
		const fence = "```json\n";
		const start = content.indexOf(fence);
		const end = content.indexOf("\n```", start + fence.length);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const schema: unknown = JSON.parse(content.slice(start + fence.length, end));
		const validator = buildOutputValidator(schema).validator;
		const clean = { overall_correctness: "correct", explanation: "No defects found.", confidence: 0.9 };
		const finding = {
			title: "Handle missing input",
			body: "Missing input reaches an unsafe path.",
			priority: 1,
			confidence: 0.9,
			file_path: "src/input.ts",
			line_start: 5,
			line_end: 5,
		};
		for (const result of [
			clean,
			{ ...clean, overall_correctness: "incorrect", findings: [finding] },
			{
				...clean,
				overall_correctness: "incorrect",
				findings: [{ ...finding, recommendation: "Reject missing input." }],
			},
		]) {
			expect(validator?.validate(result).success).toBe(true);
		}
		expect(validator?.validate({ ...clean, findings: [{ ...finding, title: undefined }] }).success).toBe(false);
	});

	it("serves the builtin pull-request skill, yields to a user override, and respects disablement", async () => {
		await isolateAgentDir();
		const handler = new SkillProtocolHandler();

		// Empty agent home: the embedded builtin materializes and resolves.
		const { skills: builtinSkills } = await loadSkills();
		const skill = builtinSkills.find(entry => entry.name === "pull-request");
		expect(skill).toBeDefined();
		expect(skill!.filePath).toBe(builtinSkillPath("pull-request"));
		expect(skill!.source).toBe("omp-builtin:user");
		// Ordinary discoverable skill: not hidden from the model-facing listing.
		expect(skill!.hide).toBeFalsy();

		setActiveSkills(builtinSkills);
		const builtinResource = await handler.resolve(parseInternalUrl("skill://pull-request"));
		expect(builtinResource.sourcePath).toBe(builtinSkillPath("pull-request"));

		// A same-named user skill with distinguishable content wins by name.
		const userSkillDir = path.join(getAgentDir(), "skills", "pull-request");
		await fs.mkdir(userSkillDir, { recursive: true });
		await Bun.write(
			path.join(userSkillDir, "SKILL.md"),
			'---\nname: pull-request\ndescription: "User override for the pull request workflow."\n---\n\n# user override body\n',
		);

		const { skills: overriddenSkills } = await loadSkills();
		expect(overriddenSkills.filter(entry => entry.name === "pull-request")).toHaveLength(1);
		setActiveSkills(overriddenSkills);
		const userResource = await handler.resolve(parseInternalUrl("skill://pull-request"));
		expect(userResource.sourcePath).toBe(path.join(userSkillDir, "SKILL.md"));
		expect(userResource.content).toContain("user override body");

		// Disablement removes the skill from the served set entirely.
		const { skills: disabledSkills } = await loadSkills({ disabledExtensions: ["skill:pull-request"] });
		expect(disabledSkills.some(entry => entry.name === "pull-request")).toBe(false);
		setActiveSkills(disabledSkills);
		await expect(handler.resolve(parseInternalUrl("skill://pull-request"))).rejects.toThrow(
			"Unknown skill: pull-request",
		);
	});

	it("does not rewrite the materialized file when content is unchanged (mtime stable)", async () => {
		await isolateAgentDir();

		await loadSkills();
		const first = await fs.stat(builtinSkillPath("code-review"));
		const contentBefore = await fs.readFile(builtinSkillPath("code-review"), "utf8");

		await loadSkills();

		// No wall-clock sleep: APFS mtimeMs has nanosecond granularity, so a
		// rewrite would almost certainly move it.
		const second = await fs.stat(builtinSkillPath("code-review"));
		expect(second.mtimeMs).toBe(first.mtimeMs);
		expect(await fs.readFile(builtinSkillPath("code-review"), "utf8")).toBe(contentBefore);
	});

	it("re-materializes the bundled copy when the file diverges from the embedded content", async () => {
		await isolateAgentDir();

		const { skills } = await loadSkills();
		setActiveSkills(skills);
		const baseline = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://code-review"));

		await Bun.write(
			builtinSkillPath("code-review"),
			"---\nname: code-review\ndescription: tampered\n---\ntampered\n",
		);
		await loadSkills();

		expect(await fs.readFile(builtinSkillPath("code-review"), "utf8")).toBe(baseline.content);
	});
});
