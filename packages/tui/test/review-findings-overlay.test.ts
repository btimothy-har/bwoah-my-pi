import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { PreparedReview } from "@oh-my-pi/pi-tui/overlays/review-findings-model";
import { ReviewFindingsOverlay } from "@oh-my-pi/pi-tui/overlays/review-findings-overlay";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setKeybindings, visibleWidth } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const BACKSPACE = "\x7f";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

let darkTheme = await getThemeByName("dark");

function makeReview(): PreparedReview {
	return {
		scope: "src/api",
		overall_correctness: "incorrect",
		explanation: "The pagination loop drops the last page.",
		recommendation: "Fix the loop bound before merging.",
		confidence: 0.82,
		findings: [
			{
				id: "finding-1",
				title: "Off-by-one in pagination",
				body: "The loop uses `<` instead of `<=` for the final page.",
				recommendation: "Use `<=` so the last page renders.",
				priority: 1,
				confidence: 0.9,
				file_path: "src/api/paginate.ts",
				line_start: 12,
				line_end: 18,
			},
			{
				id: "finding-2",
				title: "Unhandled rejection",
				body: "The fetch promise rejection is ignored.",
				recommendation: "Await the promise or attach a catch handler.",
				priority: 2,
				confidence: 0.7,
				file_path: "src/api/client.ts",
				line_start: 40,
				line_end: 40,
			},
			{
				id: "finding-3",
				title: "Stale comment",
				body: "The comment describes removed retry behavior.",
				recommendation: "Update the comment.",
				priority: 3,
				confidence: 0.5,
				file_path: "docs.md",
				line_start: 3,
				line_end: 4,
			},
		],
	};
}

function makeOverlay(review = makeReview(), rows = 30) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();
	const overlay = new ReviewFindingsOverlay(
		review,
		{ theme: darkTheme!, getHeight: () => rows },
		{ onSubmit, onCancel },
	);
	return { overlay, onSubmit, onCancel, review, rows };
}

function renderText(overlay: ReviewFindingsOverlay, width = 100): string {
	return stripVTControlCharacters(overlay.render(width).join("\n"));
}

function type(overlay: ReviewFindingsOverlay, text: string): void {
	for (const char of text) overlay.handleInput(char);
}

/** Open the card for finding `index` (0-based) and enter the comment editor. */
function openEditor(overlay: ReviewFindingsOverlay, index = 0): void {
	for (let i = 0; i < index; i++) overlay.handleInput(DOWN);
	overlay.handleInput(ENTER);
	overlay.handleInput(TAB);
}

describe("ReviewFindingsOverlay", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders the verdict, explanation, recommendation, confidence, counts and finding rows", () => {
		const { overlay } = makeOverlay();
		const out = renderText(overlay);
		expect(out).toContain("Review Findings");
		expect(out).toContain("src/api");
		expect(out).toContain("incorrect");
		expect(out).toContain("The pagination loop drops the last page.");
		expect(out).toContain("Fix the loop bound before merging.");
		expect(out).toContain("0.82");
		expect(out).toContain("P1 1");
		expect(out).toContain("Off-by-one in pagination");
		expect(out).toContain("src/api/paginate.ts:12-18");
		expect(out).toContain("Unhandled rejection");
		expect(out).toContain("src/api/client.ts:40");
	});

	it("marks findings with comments and reports the comment count", () => {
		const { overlay } = makeOverlay();
		openEditor(overlay, 0);
		type(overlay, "see this");
		overlay.handleInput(ENTER);
		overlay.handleInput(ESC); // back to list
		const out = renderText(overlay);
		expect(out).toContain("✎");
		expect(out).toContain("commented");
	});

	it("opens the selected finding's card on Enter and on Space", () => {
		const { overlay } = makeOverlay();
		overlay.handleInput(ENTER);
		const card = renderText(overlay);
		expect(card).toContain("Off-by-one in pagination");
		expect(card).toContain("Evidence");
		expect(card).toContain("for the final page");
		expect(card).toContain("Recommendation");
		expect(card).toContain("0.9");
		expect(card).toContain("src/api/paginate.ts:12-18");

		overlay.handleInput(ESC); // list
		overlay.handleInput(DOWN);
		overlay.handleInput(" ");
		expect(renderText(overlay)).toContain("Unhandled rejection");
	});

	it("steps between findings with left and right inside the card", () => {
		const { overlay } = makeOverlay();
		overlay.handleInput(ENTER);
		overlay.handleInput(RIGHT);
		expect(renderText(overlay)).toContain("Unhandled rejection");
		overlay.handleInput(RIGHT);
		expect(renderText(overlay)).toContain("Stale comment");
		overlay.handleInput(LEFT);
		overlay.handleInput(LEFT);
		expect(renderText(overlay)).toContain("Off-by-one in pagination");
		// Clamped at the first finding.
		overlay.handleInput(LEFT);
		expect(renderText(overlay)).toContain("Off-by-one in pagination");
	});

	it("keeps the submitted comment through submit, a later blur, and navigation away and back", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		openEditor(overlay);
		type(overlay, "Check the concurrent caller before changing this.");
		// Editor clears its buffer before onSubmit; the overlay must take the
		// submitted value into its comment store before leaving editing.
		overlay.handleInput(ENTER);
		// A subsequent blur (the emptied editor losing focus) must not clobber
		// the saved comment; a stray Enter lands in the card view and is inert.
		overlay.handleInput(ENTER);
		overlay.handleInput(ESC); // card -> list at the current finding
		overlay.handleInput(DOWN); // away
		overlay.handleInput(UP); // back
		overlay.handleInput(ENTER); // card again
		overlay.handleInput(TAB); // editor — the comment must be intact
		expect(renderText(overlay)).toContain("Check the concurrent caller before changing this.");
		overlay.handleInput(ESC); // blur commits the preserved comment
		overlay.handleInput(ESC); // list
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "Check the concurrent caller before changing this." });
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("expands a multiline bracketed paste in the comment editor", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		overlay.handleInput("\x1b[200~first line\nsecond line\x1b[201~");
		overlay.handleInput(ENTER);
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "first line\nsecond line" });
	});

	it("removes a comment when the editor is emptied and resubmitted blank", () => {
		const { overlay, onSubmit } = makeOverlay();
		// Comment finding-2; it must survive finding-1's clearing round.
		openEditor(overlay, 1);
		type(overlay, "keep");
		overlay.handleInput(ENTER);
		overlay.handleInput(ESC); // list
		overlay.handleInput(UP);
		openEditor(overlay, 0);
		type(overlay, "temp note");
		overlay.handleInput(ENTER);
		overlay.handleInput(TAB); // editor reseeds from the store
		// Delete the whole prefilled buffer; the final backspace lands while the
		// buffer still has one character, so editing continues. The blank
		// resubmit then expresses removal intent.
		for (let i = 0; i < 9; i++) overlay.handleInput(BACKSPACE);
		overlay.handleInput(ENTER);
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({ "finding-2": "keep" });
	});

	it("retains a stored comment when up/backspace leaves an emptied editor", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		type(overlay, "precious");
		overlay.handleInput(ENTER);
		// Re-enter editing: the buffer reseeds from the store. Delete all of it,
		// then hit the reflex keys on the emptied buffer — they must leave
		// editing without committing the blank, so the comment survives.
		overlay.handleInput(TAB);
		for (let i = 0; i < 8; i++) overlay.handleInput(BACKSPACE);
		overlay.handleInput(UP);
		expect(renderText(overlay)).toContain("✎");
		overlay.handleInput(ESC); // card -> list, comment still retained
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "precious" });
	});

	it("leaves editing on up in an empty editor without storing a comment", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		openEditor(overlay);
		overlay.handleInput(UP);
		const out = renderText(overlay);
		expect(out).not.toContain("enter save");
		overlay.handleInput(ESC); // card -> list
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({});
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("retains the committed draft when Esc returns from the card to the list", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		openEditor(overlay);
		type(overlay, "Draft to be discarded.");
		overlay.handleInput(ENTER);
		expect(renderText(overlay)).toContain("✎");
		overlay.handleInput(ESC); // card -> list
		const list = renderText(overlay);
		expect(list).toContain("✎");
		expect(list).toContain("commented 1");
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "Draft to be discarded." });
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("echoes typed text in the render output before the comment is committed", () => {
		const { overlay } = makeOverlay();
		openEditor(overlay);
		type(overlay, "Check the concurrent caller");
		// Live echo: the editor buffer is not overlay state, so every delegated
		// keystroke must invalidate the memoized render.
		expect(renderText(overlay)).toContain("Check the concurrent caller");
	});

	it("echoes bracketed paste in the render output before commit", () => {
		const { overlay } = makeOverlay();
		openEditor(overlay);
		overlay.handleInput("\x1b[200~pasted evidence\x1b[201~");
		expect(renderText(overlay)).toContain("pasted evidence");
	});

	it("list-level cancellation discards all drafts and fires cancel once", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		openEditor(overlay);
		type(overlay, "draft");
		overlay.handleInput(ENTER); // commit draft
		overlay.handleInput(ESC); // list
		overlay.handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		// Latched: further keys are ignored.
		overlay.handleInput("s");
		overlay.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels from the list on a raw escape byte", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		overlay.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("invokes exactly one callback across repeated completion keys", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		overlay.handleInput("s");
		overlay.handleInput("s");
		overlay.handleInput(ENTER);
		overlay.handleInput(ESC);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits from the card view as well as the list", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		overlay.handleInput(ENTER);
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("never fires callbacks when disposed before completion", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		openEditor(overlay);
		type(overlay, "never saved");
		overlay.dispose();
		overlay.handleInput("s");
		overlay.handleInput(ESC);
		overlay.dispose(); // idempotent
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("stays bounded and sanitized at 100x30 and 48x12 across list, card and editor views", () => {
		const review = makeReview();
		review.findings[0]!.title = "\t\x01broken<title>";
		review.findings[0]!.file_path = `src/${"very/deep/".repeat(20)}file.ts`;
		for (const [width, rows] of [
			[100, 30],
			[48, 12],
		] as const) {
			for (const mode of ["list", "card", "editing"] as const) {
				const { overlay } = makeOverlay(review, rows);
				if (mode !== "list") overlay.handleInput(ENTER);
				if (mode === "editing") overlay.handleInput(TAB);
				const lines = overlay.render(width);
				expect(lines.length).toBeLessThanOrEqual(rows);
				for (const line of lines) {
					const plain = stripVTControlCharacters(line);
					expect(visibleWidth(plain)).toBeLessThanOrEqual(width);
					expect(plain).not.toContain("\t");
					expect(plain).not.toContain("\x01");
				}
			}
		}
	});

	it("keeps every rendered row within the terminal at every render width", () => {
		const { overlay, rows } = makeOverlay(makeReview(), 12);
		for (const width of [20, 48, 80, 100, 200]) {
			const lines = overlay.render(width);
			expect(lines.length).toBeLessThanOrEqual(rows);
			for (const line of lines) {
				expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("returns stable array references while unchanged and never mutates prior output", () => {
		const { overlay } = makeOverlay();
		const first = overlay.render(100);
		const second = overlay.render(100);
		expect(second).toBe(first);
		const snapshot = [...first];
		overlay.handleInput(DOWN); // dirty -> rebuild, prior array untouched
		const third = overlay.render(100);
		expect(third).not.toBe(first);
		expect(first).toEqual(snapshot);
	});

	it("reflows when the viewport height changes", () => {
		const review = makeReview();
		let rows = 30;
		const overlay = new ReviewFindingsOverlay(
			review,
			{ theme: darkTheme!, getHeight: () => rows },
			{
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
			},
		);
		const tall = overlay.render(100).length;
		rows = 12;
		const short = overlay.render(100).length;
		expect(short).toBeLessThanOrEqual(12);
		expect(short).not.toBe(tall);
	});

	it("scrolls a long card body with PgUp/PgDn without leaving the card", () => {
		const review = makeReview();
		review.findings[0] = {
			...review.findings[0]!,
			body: Array.from({ length: 60 }, (_, i) => `evidence row ${i}`).join("\n\n"),
		};
		const { overlay } = makeOverlay(review, 30);
		overlay.handleInput(ENTER);
		const before = renderText(overlay);
		overlay.handleInput("\x1b[6~"); // PgDn
		const after = renderText(overlay);
		expect(after).not.toBe(before);
		expect(after).toContain("evidence row");
		overlay.handleInput(ESC); // back to the list at the current finding
		overlay.handleInput("s");
	});

	it("keeps the row count bounded when location and scope carry newlines and control chars", () => {
		const review = makeReview();
		review.scope = "src/api\nINJECTED ROW\x02more";
		review.findings[0]!.file_path = "src/api\ninjected.ts";
		const { overlay, rows } = makeOverlay(review, 30);
		for (const mode of ["list", "card"] as const) {
			if (mode === "card") overlay.handleInput(ENTER);
			const lines = overlay.render(100);
			expect(lines.length).toBeLessThanOrEqual(rows);
			const out = stripVTControlCharacters(lines.join("\n"));
			// Newlines must be flattened inline, never injected as their own rows.
			if (mode === "list") expect(out).toContain("src/api INJECTED ROWmore");
			expect(out).toContain("src/api injected.ts:12-18");
		}
	});

	it("keeps the recommendation visible on a short list viewport", () => {
		const review = makeReview();
		review.explanation = Array.from({ length: 12 }, (_, i) => `explanation paragraph ${i}`).join(" ");
		const { overlay } = makeOverlay(review, 14);
		const out = renderText(overlay);
		expect(out).toContain("Recommendation");
		expect(out).toContain("Fix the loop bound before merging.");
		const lines = overlay.render(100);
		expect(lines.length).toBeLessThanOrEqual(14);
	});

	it("keeps the recommendation visible when it alone exceeds the budget", () => {
		const review = makeReview();
		review.recommendation = Array.from({ length: 20 }, (_, i) => `recommendation step ${i}`).join(" ");
		const { overlay } = makeOverlay(review, 12);
		const out = renderText(overlay);
		expect(out).toContain("Recommendation");
		expect(out).toContain("recommendation step");
		const lines = overlay.render(100);
		expect(lines.length).toBeLessThanOrEqual(12);
	});

	it("inserts a newline on Shift+Enter and commits the multiline comment", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		type(overlay, "first");
		overlay.handleInput("\x1b[13;2~"); // Shift+Enter
		type(overlay, "second");
		overlay.handleInput(ENTER);
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "first\nsecond" });
	});

	it("enters editing from the card on down", () => {
		const { overlay } = makeOverlay();
		overlay.handleInput(ENTER); // card
		overlay.handleInput(DOWN);
		const out = renderText(overlay);
		expect(out).toContain("enter save");
		expect(out).toContain("comment");
	});

	it("removes the comment when Esc blurs a deliberately emptied editor", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		type(overlay, "temp");
		overlay.handleInput(ENTER);
		overlay.handleInput(TAB); // reseeded with "temp"
		for (let i = 0; i < 4; i++) overlay.handleInput(BACKSPACE);
		overlay.handleInput(ESC); // blur commits the blank -> removal
		overlay.handleInput(ESC); // list
		const out = renderText(overlay);
		expect(out).not.toContain("✎");
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({});
	});

	it("keeps the comment when backspace exits an emptied editor", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		type(overlay, "keep");
		overlay.handleInput(ENTER);
		overlay.handleInput(TAB); // reseeded
		for (let i = 0; i < 4; i++) overlay.handleInput(BACKSPACE); // emptied
		overlay.handleInput(BACKSPACE); // on empty -> exit, no blank commit
		expect(renderText(overlay)).toContain("✎");
		overlay.handleInput(ESC); // list
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "keep" });
	});

	it("routes pasteText into the comment editor while editing and it survives commit", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		overlay.pasteText("pasted comment body");
		expect(renderText(overlay)).toContain("pasted comment body");
		overlay.handleInput(ENTER);
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({ "finding-1": "pasted comment body" });
	});

	it("ignores pasteText outside the comment editor", () => {
		const { overlay, onSubmit, onCancel } = makeOverlay();
		overlay.pasteText("list-level paste");
		expect(renderText(overlay)).not.toContain("list-level paste");
		overlay.handleInput(ENTER); // card
		overlay.pasteText("card-level paste");
		expect(renderText(overlay)).not.toContain("card-level paste");
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({});
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("preserves an expanded multiline paste through Esc and a revisit", () => {
		const { overlay, onSubmit } = makeOverlay();
		openEditor(overlay);
		overlay.pasteText("paste line one\npaste line two\npaste line three");
		// A large paste lives in the editor as a marker; Esc commits its
		// expansion and a revisit must show the expanded text, not the marker.
		overlay.handleInput(ESC);
		overlay.handleInput(TAB);
		const out = renderText(overlay);
		expect(out).toContain("paste line one");
		overlay.handleInput(ESC);
		overlay.handleInput(ESC); // list
		overlay.handleInput("s");
		expect(onSubmit).toHaveBeenCalledWith({
			"finding-1": "paste line one\npaste line two\npaste line three",
		});
	});

	it("scrolls the card body back with PgUp after PgDn", () => {
		const review = makeReview();
		review.findings[0] = {
			...review.findings[0]!,
			body: Array.from({ length: 60 }, (_, i) => `evidence row ${i}`).join("\n\n"),
		};
		const { overlay } = makeOverlay(review, 30);
		overlay.handleInput(ENTER);
		const top = renderText(overlay);
		overlay.handleInput("\x1b[6~"); // PgDn
		const scrolled = renderText(overlay);
		expect(scrolled).not.toBe(top);
		overlay.handleInput("\x1b[5~"); // PgUp
		expect(renderText(overlay)).toBe(top);
	});
});
