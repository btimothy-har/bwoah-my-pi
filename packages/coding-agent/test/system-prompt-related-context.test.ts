/**
 * System-prompt rendering of `workspace.related` inputs.
 *
 * Contract: shared context files render in `<related-context>` after the
 * repository's own `<repo-rules>`; related roots render as a read-only
 * `<related-directories>` listing that names each root's own context file
 * paths for on-demand reading — their contents are never inlined.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const RELATED_RULE_SENTINEL = "RELATED-RULE-SENTINEL";
const PRIMARY_RULE_SENTINEL = "PRIMARY-RULE-SENTINEL";
const SHARED_CONTEXT_SENTINEL = "SHARED-CONTEXT-SENTINEL";

function block(text: string, tag: string): string | null {
	const match = text.match(new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, "m"));
	return match?.[1] ?? null;
}

describe("related workspace context in the system prompt", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let primaryDir = "";
	let relatedDir = "";
	let sharedContextPath = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-related-context-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-related-context-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		primaryDir = path.join(tempDir, "primary");
		relatedDir = path.join(tempDir, "related");
		fs.mkdirSync(primaryDir, { recursive: true });
		fs.mkdirSync(relatedDir, { recursive: true });
		fs.writeFileSync(path.join(relatedDir, "AGENTS.md"), RELATED_RULE_SENTINEL);
		sharedContextPath = path.join(tempDir, "shared-context.md");
		fs.writeFileSync(sharedContextPath, SHARED_CONTEXT_SENTINEL);
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	function buildOptions(overrides: Record<string, unknown> = {}) {
		return {
			cwd: primaryDir,
			contextFiles: [{ path: path.join(primaryDir, "AGENTS.md"), content: PRIMARY_RULE_SENTINEL }],
			additionalWorkspaceRoots: [relatedDir],
			relatedContextFiles: [{ path: sharedContextPath, content: SHARED_CONTEXT_SENTINEL }],
			skills: [],
			rules: [],
			includeWorkspaceTree: false,
			activeRepoContext: null,
			...overrides,
		};
	}

	it("renders shared context after repo rules and lists related roots read-only without inlining their context", async () => {
		const { systemPrompt } = await buildSystemPrompt(buildOptions());
		const text = systemPrompt.join("\n");

		// Repository context and shared context both render; the related root's
		// own AGENTS.md content must NOT be inlined.
		expect(text).toContain(PRIMARY_RULE_SENTINEL);
		expect(text).toContain(SHARED_CONTEXT_SENTINEL);
		expect(text).not.toContain(RELATED_RULE_SENTINEL);

		// Order: repo rules, then shared context, then the related-directories list.
		const repoRulesEnd = text.indexOf("</repo-rules>");
		const relatedContextStart = text.search(/^<related-context>$/m);
		const relatedDirsStart = text.search(/^<related-directories>$/m);
		expect(repoRulesEnd).toBeGreaterThanOrEqual(0);
		expect(relatedContextStart).toBeGreaterThan(repoRulesEnd);
		expect(relatedDirsStart).toBeGreaterThan(relatedContextStart);

		// The shared context block carries the file path and body.
		const relatedContext = block(text, "related-context");
		expect(relatedContext).not.toBeNull();
		expect(relatedContext).toContain(sharedContextPath);
		expect(relatedContext).toContain(SHARED_CONTEXT_SENTINEL);

		// The related root is listed read-only, with its context file path named
		// for on-demand reading (discovery may realpath the temp dir on macOS).
		const relatedDirs = block(text, "related-directories");
		expect(relatedDirs).not.toBeNull();
		expect(relatedDirs).toContain(relatedDir);
		const agentsCandidates = [relatedDir, fs.realpathSync(relatedDir)].map(root => path.join(root, "AGENTS.md"));
		expect(agentsCandidates.some(candidate => relatedDirs!.includes(candidate))).toBe(true);
		expect(text).toContain("NEVER create, modify, or delete files under these roots");

		// The old writable-roots block is gone.
		expect(text).not.toContain("<workspace-roots>");
	});

	it("renders neither related block when the map supplies nothing", async () => {
		const { systemPrompt } = await buildSystemPrompt(
			buildOptions({ additionalWorkspaceRoots: [], relatedContextFiles: [] }),
		);
		const text = systemPrompt.join("\n");
		expect(text).toContain(PRIMARY_RULE_SENTINEL);
		expect(block(text, "related-context")).toBeNull();
		expect(block(text, "related-directories")).toBeNull();
	});

	it("renders each related block exactly once when a custom system prompt owns block 0", async () => {
		const { systemPrompt } = await buildSystemPrompt(
			buildOptions({ resolvedCustomPrompt: "CUSTOM-PROMPT-SENTINEL" }),
		);
		const text = systemPrompt.join("\n");
		expect(text).toContain("CUSTOM-PROMPT-SENTINEL");
		expect(text.match(/^<related-context>$/gm)).toHaveLength(1);
		expect(text.match(/^<related-directories>$/gm)).toHaveLength(1);
		expect(text).toContain(SHARED_CONTEXT_SENTINEL);
		expect(text).not.toContain(RELATED_RULE_SENTINEL);
	});
});
