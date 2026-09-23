import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ExtensionCustomOptions, ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { resolveArtifactFile } from "../../src/internal-urls/artifact-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { prepareReview, reviewFindingsSchema } from "../../src/review/report";
import { ArtifactManager } from "../../src/session/artifacts";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { postProcessToolResult, wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { BUILTIN_TOOLS, type ToolSession } from "../../src/tools";
import { ReviewFindingsTool } from "../../src/tools/review-findings";
import type {
	ReviewFeedbackResult,
	ReviewFindingInput,
	ReviewFindingsInput,
} from "@oh-my-pi/pi-tui/overlays/review-findings-model";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ReviewToolDetails } from "@oh-my-pi/pi-tui/tools/review-findings";
import { type } from "@oh-my-pi/omptype";

// =============================================================================
// Fixtures
// =============================================================================

interface UiHarness {
	ui: ExtensionUIContext;
	customCalls: number;
	/** Resolves when the tool reaches the modal boundary (ui.custom invoked). */
	whenOpened: Promise<void>;
	/** True once the modal boundary has been entered (ui.custom invoked). */
	modalOpened: boolean;
	lastOptions: ExtensionCustomOptions | undefined;
	/** Invoked synchronously when the modal boundary is entered (feedback is now being awaited). */
	onModalOpen: (() => void) | undefined;
	settle: (result: ReviewFeedbackResult) => void;
}

/** UI interception happens only at the modal boundary: `ui.custom` records the
 *  request and never constructs the real overlay; the test settles the modal
 *  outcome exactly as `showHookCustom` would after the overlay called `done`. */
function createUiHarness(options: { supportsCustomComponents?: boolean } = {}): UiHarness {
	const outcome = Promise.withResolvers<ReviewFeedbackResult>();
	const opened = Promise.withResolvers<void>();
	const harness: UiHarness = {
		customCalls: 0,
		whenOpened: opened.promise,
		modalOpened: false,
		lastOptions: undefined,
		onModalOpen: undefined,
		settle: result => outcome.resolve(result),
		// Default mirrors the interactive TUI host; pass false for the RPC
		// negative contract (hasUI without custom-component support).
		ui: {
			supportsCustomComponents: options.supportsCustomComponents ?? true,
			custom: (_factory: unknown, options?: ExtensionCustomOptions) => {
				harness.customCalls += 1;
				harness.modalOpened = true;
				opened.resolve();
				harness.lastOptions = options;
				harness.onModalOpen?.();
				// Mirror showHookCustom: the host rejects the modal promise on abort.
				const signal = options?.signal;
				const abortReason = () => signal?.reason ?? new DOMException("Dialog aborted", "AbortError");
				if (signal?.aborted) return Promise.reject(abortReason());
				const aborted = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => aborted.reject(abortReason()), { once: true });
				return Promise.race([outcome.promise, aborted.promise]);
			},
		} as unknown as ExtensionUIContext,
	};
	return harness;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function makeTempRoot(prefix: string): Promise<string> {
	const dir = TempDir.createSync(prefix).path();
	if (!dir) throw new Error("TempDir did not report a path");
	// Absolute: relative temp paths would defeat findRepoRoot's absolute-path
	// normalization and make Bun.file(sessionFile) resolve against process cwd.
	const absolute = path.resolve(dir);
	cleanupRoots.push(absolute);
	return absolute;
}

interface RepoFixture {
	repoDir: string;
	manager: SessionManager;
	artifacts: ArtifactManager;
}

async function createRepoFixture(): Promise<RepoFixture> {
	const repoDir = await makeTempRoot("omp-review-findings-repo-");
	// `findRepoRoot` walks up for a `.git` entry; keep the fixture self-contained.
	await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
	const manager = SessionManager.create(repoDir, repoDir);
	const artifacts = manager.getArtifactManager();
	if (!artifacts) throw new Error("Expected a persisted session to have an ArtifactManager");
	return { repoDir, manager, artifacts };
}

function baseInput(repoDir: string): ReviewFindingsInput {
	return {
		scope: "branch main..feature/counter",
		overall_correctness: "incorrect",
		explanation: "The change introduces a data race on the shared counter.",
		recommendation: "Guard the counter before merging.",
		confidence: 0.9,
		findings: [
			{
				title: "Unguarded counter mutation",
				body: "Two threads mutate the counter without synchronization.",
				recommendation: "Protect the counter with a mutex.",
				priority: 1,
				confidence: 0.8,
				file_path: path.join(repoDir, "src/counter.ts"),
				line_start: 10,
				line_end: 14,
			},
		],
	};
}

function createToolSession(manager: SessionManager, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: manager.getCwd(),
		hasUI: false,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getSessionId: () => manager.getSessionId(),
		getArtifactManager: () => manager.getArtifactManager(),
		registerSessionChangeCallback: () => () => {},
		registerDisposeCallback: () => () => {},
		isDisposed: () => false,
		...overrides,
	};
}

function createContext(options: {
	manager: SessionManager;
	ui?: ExtensionUIContext | null;
	hasUI?: boolean;
	settings?: Settings;
}): AgentToolContext {
	return {
		sessionManager: options.manager,
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		settings: options.settings ?? Settings.isolated(),
		hasUI: options.hasUI ?? options.ui !== undefined,
		ui: options.ui ?? undefined,
	} as unknown as AgentToolContext;
}

async function artifactFileCount(artifacts: ArtifactManager): Promise<number> {
	return (await artifacts.listFiles()).length;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find(part => part.type === "text");
	const text = block?.type === "text" ? block.text : undefined;
	if (!text) throw new Error("Expected a text content block");
	return text;
}

interface PersistedArtifactJson {
	schema_version: number;
	scope: string;
	recommendation: string;
	feedback_status: string;
	findings: Array<{ id: string; file_path: string; feedback: { comment: string | null } }>;
}

/** Read a returned `artifact://<id>` reference through the native internal-URL
 *  resolution path (the same `artifact://` handler the read tool uses), pinned
 *  to the calling session's artifacts directory. */
async function readPersistedArtifact(manager: SessionManager, reviewRef: string): Promise<PersistedArtifactJson> {
	const resolved = await resolveArtifactFile(parseInternalUrl(reviewRef), {
		localProtocolOptions: { getArtifactsDir: () => manager.getArtifactsDir() },
	});
	return JSON.parse(await Bun.file(resolved.path).text()) as PersistedArtifactJson;
}

// =============================================================================
// Schema (execution validation path)
// =============================================================================

describe("reviewFindingsSchema", () => {
	const repoDir = "/repo";
	const valid = baseInput(repoDir);

	it("accepts a well-formed review", () => {
		expect(reviewFindingsSchema(valid) instanceof type.errors).toBe(false);
	});

	it("rejects forged finding ids and feedback fields at the finding level", () => {
		const forged = {
			...valid,
			findings: [{ ...valid.findings[0], id: "finding-1", feedback: { comment: "forged" } }],
		};
		const parsed = reviewFindingsSchema(forged);
		expect(parsed instanceof type.errors).toBe(true);
		expect(parsed instanceof type.errors && String(parsed.summary)).toContain("id");
	});

	it("rejects unknown top-level fields", () => {
		expect(reviewFindingsSchema({ ...valid, extra: true }) instanceof type.errors).toBe(true);
	});

	it("rejects reversed line ranges by message", () => {
		const reversed = {
			...valid,
			findings: [{ ...valid.findings[0], line_start: 14, line_end: 10 }],
		};
		const parsed = reviewFindingsSchema(reversed);
		expect(parsed instanceof type.errors).toBe(true);
		expect(parsed instanceof type.errors && String(parsed.summary)).toContain("line_end");
	});

	it("rejects out-of-bounds bounds, priorities, confidences, and empty strings", () => {
		const finding = valid.findings[0];
		if (!finding) throw new Error("fixture missing");
		const invalidInputs = [
			{ ...valid, findings: [{ ...finding, line_start: 0 }] },
			{ ...valid, findings: [{ ...finding, line_end: 0 }] },
			{ ...valid, findings: [{ ...finding, line_start: 1.5 }] },
			{ ...valid, findings: [{ ...finding, priority: 4 }] },
			{ ...valid, findings: [{ ...finding, confidence: 1.5 }] },
			{ ...valid, confidence: -0.1 },
			{ ...valid, findings: [{ ...finding, title: "" }] },
			{ ...valid, scope: "" },
		];
		for (const invalid of invalidInputs) {
			expect(reviewFindingsSchema(invalid) instanceof type.errors).toBe(true);
		}
	});
});

describe("prepareReview", () => {
	it("gives equivalent absolute and relative in-repo paths identical ids and order", async () => {
		const repoDir = await makeTempRoot("omp-review-findings-norm-");
		await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
		const base = baseInput(repoDir);
		const finding = base.findings[0];
		if (!finding) throw new Error("fixture missing");
		// The same defect, once expressed as an absolute in-repo path and once
		// as the equivalent repository-relative path, must prepare identically.
		const other: ReviewFindingInput = {
			title: "Stale doc comment",
			body: "The comment describes the old behavior.",
			recommendation: "Refresh the comment.",
			priority: 2,
			confidence: 0.6,
			file_path: "docs/notes.md",
			line_start: 3,
			line_end: 5,
		};
		const absoluteForm = {
			...base,
			findings: [other, finding],
		};
		const relativeForm = {
			...base,
			findings: [other, { ...finding, file_path: "src/counter.ts" }],
		};
		const fromAbsolute = prepareReview(absoluteForm, repoDir);
		const fromRelative = prepareReview(relativeForm, repoDir);
		expect(fromAbsolute.findings).toEqual(fromRelative.findings);
		expect(fromAbsolute.findings.map(item => item.id)).toEqual(["finding-1", "finding-2"]);
		expect(fromAbsolute.findings[0]?.file_path).toBe("src/counter.ts");
	});
});

// =============================================================================
// ReviewFindingsTool
// =============================================================================

describe("ReviewFindingsTool", () => {
	it("is created at the primary session and never in children", () => {
		const fakeManager = { getCwd: () => "/", getSessionId: () => "s" } as unknown as SessionManager;
		expect(ReviewFindingsTool.createIf(createToolSession(fakeManager))).not.toBeNull();
		expect(ReviewFindingsTool.createIf(createToolSession(fakeManager, { taskDepth: 1 }))).toBeNull();
	});

	it("refuses direct execution in a child session without opening UI or saving", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		const tool = new ReviewFindingsTool(createToolSession(fixture.manager, { taskDepth: 1 }));
		await expect(
			tool.execute(
				"call-child",
				baseInput(fixture.repoDir),
				undefined,
				undefined,
				createContext({ manager: fixture.manager, ui: harness.ui }),
			),
		).rejects.toThrow(/primary session/);
		expect(harness.customCalls).toBe(0);
		expect(await artifactFileCount(fixture.artifacts)).toBe(0);
	});

	it("surfaces a ToolError when no session manager is available", async () => {
		const fixture = await createRepoFixture();
		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		await expect(tool.execute("call-no-manager", baseInput(fixture.repoDir))).rejects.toThrow(/session manager/);
	});

	it("persists submitted feedback with normalized locations and stable ids", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		// Listed out of priority order to prove ids are assigned after sorting.
		const input = baseInput(fixture.repoDir);
		const lowPriority = input.findings[0];
		if (!lowPriority) throw new Error("fixture missing");
		input.findings = [
			{
				title: "Stale doc comment",
				body: "The comment describes the old behavior.",
				recommendation: "Refresh the comment.",
				priority: 2,
				confidence: 0.6,
				file_path: path.join(fixture.repoDir, "docs/notes.md"),
				line_start: 3,
				line_end: 5,
			},
			lowPriority,
		];
		harness.settle({
			status: "submitted",
			comments: { "finding-1": "Check the concurrent caller before changing this." },
		});

		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		const result = await tool.execute(
			"call-1",
			input,
			undefined,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui }),
		);

		const details = result.details;
		if (!details || details.status !== "saved")
			throw new Error(`Expected saved details, got ${JSON.stringify(details)}`);
		expect(details.feedbackStatus).toBe("submitted");
		expect(details.storage).toBe("artifact");
		expect(details.reviewRef).toMatch(/^artifact:\/\/\d+$/);
		expect(details.findingCount).toBe(2);
		expect(details.counts).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
		expect(details.commentedCount).toBe(1);
		expect(textOf(result)).toContain(details.reviewRef);
		expect(harness.customCalls).toBe(1);
		expect(harness.lastOptions?.overlay).toBe(true);
		expect(harness.lastOptions?.overlayOptions).toEqual({
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});

		// Read the report back through the native artifact path.
		const artifact = await readPersistedArtifact(fixture.manager, details.reviewRef);
		expect(artifact.schema_version).toBe(2);
		expect(artifact.feedback_status).toBe("submitted");
		const first = artifact.findings[0];
		if (!first) throw new Error("Expected a persisted finding");
		// The P1 finding sorts first regardless of input order, and its absolute
		// path is normalized to repository-relative POSIX form.
		expect(first.id).toBe("finding-1");
		expect(first.file_path).toBe("src/counter.ts");
		expect(first.feedback).toEqual({ comment: "Check the concurrent caller before changing this." });
		const second = artifact.findings[1];
		if (!second) throw new Error("Expected a second persisted finding");
		expect(second.id).toBe("finding-2");
		expect(second.file_path).toBe("docs/notes.md");
		expect(second.feedback).toEqual({ comment: null });
	});

	it("skips the overlay for a clean review and records not_required", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		const input = { ...baseInput(fixture.repoDir), findings: [] };

		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		const result = await tool.execute(
			"call-clean",
			input,
			undefined,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui }),
		);

		const details = result.details;
		if (!details || details.status !== "saved") throw new Error("Expected saved details");
		expect(details.feedbackStatus).toBe("not_required");
		expect(details.findingCount).toBe(0);
		expect(harness.customCalls).toBe(0);
		const artifact = await readPersistedArtifact(fixture.manager, details.reviewRef);
		expect(artifact.findings).toEqual([]);
		expect(artifact.recommendation).toBe("Guard the counter before merging.");
		expect(artifact.feedback_status).toBe("not_required");
	});

	it("treats a hasUI host without custom-component support as unavailable (RPC contract)", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness({ supportsCustomComponents: false }); // hasUI without custom-component support
		const input = baseInput(fixture.repoDir);

		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		const result = await tool.execute(
			"call-rpc",
			input,
			undefined,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui, hasUI: true }),
		);

		const details = result.details;
		if (!details || details.status !== "saved") throw new Error("Expected saved details");
		expect(details.feedbackStatus).toBe("unavailable");
		expect(harness.customCalls).toBe(0);
		const artifact = await readPersistedArtifact(fixture.manager, details.reviewRef);
		expect(artifact.findings).toHaveLength(1);
		expect(artifact.findings[0]?.feedback).toEqual({ comment: null });
	});

	it("keeps findings but discards drafts when the user cancels the modal", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		harness.settle({ status: "cancelled" });
		const input = baseInput(fixture.repoDir);

		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		const result = await tool.execute(
			"call-cancel",
			input,
			undefined,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui }),
		);

		const details = result.details;
		if (!details || details.status !== "saved") throw new Error("Expected saved details");
		expect(details.feedbackStatus).toBe("cancelled");
		expect(details.commentedCount).toBe(0);
		const artifact = await readPersistedArtifact(fixture.manager, details.reviewRef);
		expect(artifact.findings).toHaveLength(1);
		expect(artifact.findings[0]?.feedback).toEqual({ comment: null });
	});

	it("suppresses save and delivery when the tool is aborted while the modal is open", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		const controller = new AbortController();

		const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
		const execution = tool.execute(
			"call-abort",
			baseInput(fixture.repoDir),
			controller.signal,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui }),
		);
		// Abort only once the modal boundary is reached, so ui.custom is in
		// flight; the host-facing modal promise rejects (showHookCustom contract)
		// and the tool converts it to a tool abort.
		await harness.whenOpened;
		controller.abort();
		await expect(execution).rejects.toThrow(/abort/i);
		expect(harness.customCalls).toBe(1);
		expect(await artifactFileCount(fixture.artifacts)).toBe(0);
	});

	it("suppresses save and delivery when the session is replaced during feedback", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		const realGetSessionId = fixture.manager.getSessionId.bind(fixture.manager);
		let replaced = false;
		const idSpy = spyOn(fixture.manager, "getSessionId").mockImplementation(() =>
			replaced ? "replaced-session-id" : realGetSessionId(),
		);
		harness.onModalOpen = () => {
			replaced = true;
		};
		harness.settle({ status: "submitted", comments: { "finding-1": "should never persist" } });

		try {
			const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
			await expect(
				tool.execute(
					"call-replaced",
					baseInput(fixture.repoDir),
					undefined,
					undefined,
					createContext({ manager: fixture.manager, ui: harness.ui }),
				),
			).rejects.toThrow(/session changed/i);
			expect(await artifactFileCount(fixture.artifacts)).toBe(0);
		} finally {
			idSpy.mockRestore();
		}
	});
	it("suppresses save and delivery when disposal starts while feedback is still awaiting", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		let disposed = false;
		let disposeCallback: (() => void) | undefined;
		const toolSession = createToolSession(fixture.manager, {
			isDisposed: () => disposed,
			registerDisposeCallback: callback => {
				disposeCallback = callback;
				return () => {};
			},
		});

		const tool = new ReviewFindingsTool(toolSession);
		const execution = tool.execute(
			"call-disposed",
			baseInput(fixture.repoDir),
			undefined,
			undefined,
			createContext({ manager: fixture.manager, ui: harness.ui }),
		);
		// Wait until feedback is being awaited, then set disposal state WITHOUT
		// firing the dispose callback: SDK teardown marks disposal before it
		// fires callbacks, so the isDisposed() guard itself must suppress the
		// save and success delivery.
		await harness.whenOpened;
		disposed = true;
		harness.settle({ status: "cancelled" });
		await expect(execution).rejects.toThrow(/disposed/i);
		expect(await artifactFileCount(fixture.artifacts)).toBe(0);
		// Dispose callbacks fire after the guard already rejected; firing one
		// now is pure cleanup and must not resurrect or alter the outcome.
		disposeCallback?.();
	});

	it("keeps a paused save owned by the captured old artifact manager across a session switch", async () => {
		const fixture = await createRepoFixture();
		const otherDir = await makeTempRoot("omp-review-findings-other-");
		const otherManager = SessionManager.create(otherDir, otherDir);
		const otherArtifacts = otherManager.getArtifactManager();
		if (!otherArtifacts) throw new Error("Expected a persisted session to have an ArtifactManager");

		const harness = createUiHarness();
		// The captured old manager's save HANGS on disk: release it only after
		// the session has been switched, then prove the old manager completes
		// the write while no result reaches the replacement session.
		const saveStarted = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const realSave = fixture.artifacts.save.bind(fixture.artifacts);
		const saveSpy = spyOn(fixture.artifacts, "save").mockImplementation(async (content, toolType) => {
			saveStarted.resolve();
			await releaseSave.promise;
			return realSave(content, toolType);
		});
		const realGetSessionId = fixture.manager.getSessionId.bind(fixture.manager);
		let replaced = false;
		const idSpy = spyOn(fixture.manager, "getSessionId").mockImplementation(() =>
			replaced ? "replaced-session-id" : realGetSessionId(),
		);

		try {
			const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
			const execution = tool.execute(
				"call-paused",
				baseInput(fixture.repoDir),
				undefined,
				undefined,
				createContext({ manager: fixture.manager, ui: harness.ui }),
			);
			await harness.whenOpened;
			harness.settle({ status: "cancelled" });
			await saveStarted.promise;
			// Session replacement happens while the save is still paused.
			replaced = true;
			releaseSave.resolve();
			await expect(execution).rejects.toThrow(/session changed/i);

			// The paused save completed in the CAPTURED old manager only.
			expect(saveSpy).toHaveBeenCalledTimes(1);
			expect(await artifactFileCount(fixture.artifacts)).toBe(1);
			expect(await artifactFileCount(otherArtifacts)).toBe(0);
		} finally {
			idSpy.mockRestore();
			saveSpy.mockRestore();
		}
	});

	it("returns the complete report as recovery JSON when persistence fails", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		harness.settle({
			status: "submitted",
			comments: { "finding-1": "Check the concurrent caller before changing this." },
		});
		const saveSpy = spyOn(fixture.artifacts, "save").mockRejectedValue(new Error("disk full"));

		try {
			const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
			const result = await tool.execute(
				"call-fail",
				baseInput(fixture.repoDir),
				undefined,
				undefined,
				createContext({ manager: fixture.manager, ui: harness.ui }),
			);

			expect(result.isError).toBe(true);
			const details = result.details;
			if (!details || details.status !== "save_failed") throw new Error("Expected save_failed details");
			expect(details.error).toContain("disk full");
			const recovered = JSON.parse(details.recoveryJson) as {
				findings: Array<{ id: string; feedback: { comment: string | null } }>;
			};
			expect(recovered.findings[0]?.feedback).toEqual({
				comment: "Check the concurrent caller before changing this.",
			});
			const text = textOf(result);
			expect(text).toContain("disk full");
			// No fabricated reference: nothing was saved.
			expect(text).not.toContain("artifact://");
			expect(await artifactFileCount(fixture.artifacts)).toBe(0);
		} finally {
			saveSpy.mockRestore();
		}
	});

	it("falls back to a readable blob on a real nonpersistent session", async () => {
		const repoDir = await makeTempRoot("omp-review-findings-blob-");
		await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
		// Real nonpersistent SessionManager: getArtifactManager() is null and
		// putBlob goes through the genuine blob store.
		const manager = SessionManager.inMemory(repoDir);
		const harness = createUiHarness();
		harness.settle({ status: "cancelled" });

		const tool = new ReviewFindingsTool(createToolSession(manager));
		const result = await tool.execute(
			"call-blob",
			baseInput(repoDir),
			undefined,
			undefined,
			createContext({ manager, ui: harness.ui }),
		);

		const details = result.details;
		if (!details || details.status !== "saved") throw new Error("Expected saved details");
		expect(details.storage).toBe("blob");
		const blob = JSON.parse(await Bun.file(details.reviewRef).text()) as { schema_version: number; scope: string };
		expect(blob.schema_version).toBe(2);
		expect(blob.scope).toBe("branch main..feature/counter");
	});

	it("routes a spilled save failure through the registered builtin without a fabricated reference", async () => {
		const fixture = await createRepoFixture();
		const harness = createUiHarness();
		const saveSpy = spyOn(fixture.artifacts, "save").mockRejectedValue(new Error("disk full"));
		const saveArtifactSpy = spyOn(fixture.manager, "saveArtifact");
		const input = baseInput(fixture.repoDir);
		const finding = input.findings[0];
		if (!finding) throw new Error("fixture missing");
		// Push recoveryJson past the configured spill threshold so the shared
		// output wrapper would want to save the oversized error text itself.
		input.findings = [{ ...finding, body: "evidence-".repeat(600) }];
		harness.settle({
			status: "submitted",
			comments: { "finding-1": "Check the concurrent caller before changing this." },
		});

		const factory = BUILTIN_TOOLS.review_findings;
		if (!factory) throw new Error("review_findings is not registered in BUILTIN_TOOLS");
		const constructed = await factory(createToolSession(fixture.manager));
		if (!constructed) throw new Error("Expected the registered builtin to construct");
		const wrapped = wrapToolWithMetaNotice(constructed);

		try {
			const result = await wrapped.execute(
				"call-spill",
				input,
				undefined,
				undefined,
				createContext({
					manager: fixture.manager,
					ui: harness.ui,
					settings: Settings.isolated({ "tools.artifactSpillThreshold": 1 }),
				}),
			);

			expect(result.isError).toBe(true);
			const details = result.details as ReviewToolDetails;
			expect(details.status).toBe("save_failed");
			// Exactly one save attempt (the tool's own, failed); the wrapper's
			// spill save for the oversized error text was suppressed by
			// meta.artifactError.
			expect(saveSpy).toHaveBeenCalledTimes(1);
			expect(saveArtifactSpy).not.toHaveBeenCalled();
			const text = textOf(result);
			expect(text).not.toContain("artifact://");
			expect(text).toContain("disk full");

			// Transcript round-trip: the recovery JSON survives journal
			// persistence with the complete comment text intact.
			fixture.manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-spill",
				toolName: "review_findings",
				content: result.content,
				details: result.details,
				isError: true,
				timestamp: Date.now(),
			});
			await fixture.manager.ensureOnDisk();
			await fixture.manager.flush();
			const sessionFile = fixture.manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			const raw = await Bun.file(sessionFile).text();
			const persisted = raw
				.split("\n")
				.filter(Boolean)
				.map(
					line =>
						JSON.parse(line) as { message?: { role?: string; toolCallId?: string; details?: ReviewToolDetails } },
				)
				.find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === "call-spill");
			const persistedDetails = persisted?.message?.details;
			if (!persistedDetails || persistedDetails.status !== "save_failed") {
				throw new Error("Expected the save_failed details to survive the transcript round-trip");
			}
			expect(persistedDetails.recoveryJson).toContain("Check the concurrent caller before changing this.");
		} finally {
			saveSpy.mockRestore();
			saveArtifactSpy.mockRestore();
		}
	});

	it("keeps post-processed failure content intact through the shared wrapper", async () => {
		const fixture = await createRepoFixture();
		const saveSpy = spyOn(fixture.artifacts, "save").mockRejectedValue(new Error("disk full"));
		try {
			const harness = createUiHarness();
			harness.settle({ status: "submitted", comments: { "finding-1": "keep me" } });
			const tool = new ReviewFindingsTool(createToolSession(fixture.manager));
			const result = await tool.execute(
				"call-wrapper",
				baseInput(fixture.repoDir),
				undefined,
				undefined,
				createContext({ manager: fixture.manager, ui: harness.ui }),
			);
			// The wrapper must not attempt its own artifact save for a result that
			// already carries meta.artifactError, and the recovery JSON stays whole.
			const processed = await postProcessToolResult(
				result,
				"review_findings",
				createContext({ manager: fixture.manager }),
			);
			expect(processed.isError).toBe(true);
			const details = processed.details;
			if (!details || details.status !== "save_failed") throw new Error("Expected save_failed details");
			expect(details.recoveryJson).toContain("keep me");
			expect(saveSpy).toHaveBeenCalledTimes(1);
		} finally {
			saveSpy.mockRestore();
		}
	});
});
