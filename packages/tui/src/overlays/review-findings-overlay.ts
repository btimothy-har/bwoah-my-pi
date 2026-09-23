/**
 * Fullscreen review-findings overlay: the per-finding feedback workflow for the
 * native `review_findings` tool. One mounted component drives the findings
 * list, the selected finding card, and the multiline comment editor.
 *
 * The overlay owns no session, filesystem, or tool logic — it renders a
 * {@link PreparedReview}, collects draft comments in a per-invocation
 * {@link CommentStore}, and reports one submitted/cancelled outcome through
 * its callbacks.
 */
import {
	type Component,
	Editor,
	Ellipsis,
	Markdown,
	matchesKey,
	replaceTabs,
	ScrollView,
	Text,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import {
	CommentStore,
	countByPriority,
	type IdentifiedReviewFinding,
	priorityLabel,
	type PreparedReview,
	type ReviewPriority,
	ReviewFindingsViewModel,
} from "./review-findings-model";
import { sanitizeCarriageReturns } from "../render/render-utils";
import { getEditorTheme, getMarkdownTheme, type Theme } from "../theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";

/** Title shown in the overlay's top border. */
const OVERLAY_TITLE = "Review Findings";
/** Minimum card-body rows kept visible even on short terminals. */
const MIN_BODY_ROWS = 3;
/** Maximum rows the comment editor occupies while editing. */
const MAX_EDITOR_ROWS = 6;
/** Minimum rows reserved for the comment editor while editing. */
const MIN_EDITOR_ROWS = 2;

/** Model-supplied text is untrusted: strip controls/ANSI, normalize CR runs, expand tabs. */
function sanitizeModelText(text: string): string {
	return replaceTabs(sanitizeText(sanitizeCarriageReturns(text)));
}

/** Single-line variant: a newline or control char in a path/scope must never inject TUI rows. */
function sanitizeModelSingleLine(text: string): string {
	return sanitizeModelText(text).replace(/\s+/g, " ").trim();
}

/** Priority severity color, most severe first. */
function priorityColor(priority: ReviewPriority, uiTheme: Theme): (text: string) => string {
	switch (priority) {
		case 0:
			return t => uiTheme.fg("error", t);
		case 1:
			return t => uiTheme.fg("warning", t);
		case 2:
			return t => uiTheme.fg("accent", t);
		case 3:
			return t => uiTheme.fg("muted", t);
	}
}

/** Human location for a finding: `path:12` or `path:12-40`, as one display line. */
function findingLocation(finding: IdentifiedReviewFinding): string {
	const file = sanitizeModelSingleLine(finding.file_path) || "(no path)";
	return finding.line_start === finding.line_end
		? `${file}:${finding.line_start}`
		: `${file}:${finding.line_start}-${finding.line_end}`;
}

export interface ReviewFindingsOverlayOptions {
	theme: Theme;
	/** Current viewport height; re-queried every render so resizes reflow. */
	getHeight: () => number;
}

export interface ReviewFindingsOverlayCallbacks {
	onSubmit: (comments: Record<string, string>) => void;
	onCancel: () => void;
}

export class ReviewFindingsOverlay implements Component {
	#theme: Theme;
	#getHeight: () => number;
	#onSubmit: ReviewFindingsOverlayCallbacks["onSubmit"] | undefined;
	#onCancel: ReviewFindingsOverlayCallbacks["onCancel"] | undefined;

	#review: PreparedReview;
	#state: ReviewFindingsViewModel;
	#comments = new CommentStore();

	#mdTheme = getMarkdownTheme();
	/** Per-finding markdown components for evidence and recommendation. */
	#findingMarkdown = new Map<string, { body: Markdown; recommendation: Markdown }>();
	#scrollView: ScrollView;
	#editor: Editor;

	/** Once an outcome fires, the overlay latches and ignores all further input. */
	#completed = false;
	#disposed = false;
	#cancelled = false;

	// Render-array stability: the overlay caches its last output and only
	// rebuilds after a state change or a geometry change.
	#dirty = true;
	#renderCache: { width: number; rows: number; output: readonly string[] } | undefined;

	constructor(
		review: PreparedReview,
		options: ReviewFindingsOverlayOptions,
		callbacks: ReviewFindingsOverlayCallbacks,
	) {
		this.#review = review;
		this.#theme = options.theme;
		this.#getHeight = options.getHeight;
		this.#onSubmit = callbacks.onSubmit;
		this.#onCancel = callbacks.onCancel;
		this.#state = new ReviewFindingsViewModel(review.findings.length);
		this.#scrollView = new ScrollView([], {
			height: MIN_BODY_ROWS,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: t => this.#theme.fg("dim", t), thumb: t => this.#theme.fg("accent", t) },
		});
		this.#editor = new Editor(getEditorTheme());
		this.#editor.setBorderVisible(false);
		this.#editor.setPromptGutter("> ");
		this.#editor.setMaxHeight(MAX_EDITOR_ROWS);
		this.#editor.setScrollbarVisible(true);
		// Editor clears its buffer BEFORE calling onSubmit. Write the submitted
		// value into the store first, then exit editing: a later blur on a
		// non-editing state must never overwrite the saved comment with the
		// now-empty buffer. Guarding on `editing` implements the blur half.
		this.#editor.onSubmit = value => {
			const index = this.#state.openIndex;
			if (index === undefined || !this.#state.editing) return;
			this.#comments.set(this.#review.findings[index]!.id, value);
			this.#state.exitEditing();
			this.#touch();
		};
	}

	#touch(): void {
		this.#dirty = true;
	}

	invalidate(): void {
		this.#touch();
		this.#editor.invalidate();
		for (const entry of this.#findingMarkdown.values()) {
			entry.body.invalidate();
			entry.recommendation.invalidate();
		}
	}

	dispose(): void {
		this.#disposed = true;
		// Release children and callbacks without invoking submit/cancel.
		this.#editor.onSubmit = undefined;
		this.#onSubmit = undefined;
		this.#onCancel = undefined;
		this.#findingMarkdown.clear();
	}

	handleInput(data: string): void {
		if (this.#disposed || this.#completed) return;
		if (this.#state.editing) {
			this.#handleEditingInput(data);
			return;
		}
		if (this.#state.view === "card") {
			this.#handleCardInput(data);
			return;
		}
		this.#handleListInput(data);
	}

	/** Route an enhanced/bracketed paste transport into the comment editor; inert otherwise. */
	pasteText(text: string): void {
		if (this.#disposed || this.#completed || !this.#state.editing) return;
		this.#editor.pasteText(text);
		this.#touch();
	}

	#isCancelKey(data: string): boolean {
		return matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc");
	}

	#isEnterKey(data: string): boolean {
		return matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n";
	}

	#isSubmitKey(data: string): boolean {
		return matchesKey(data, "s") || matchesKey(data, "shift+s");
	}

	#handleListInput(data: string): void {
		if (this.#isSubmitKey(data)) {
			this.#submit();
			return;
		}
		if (this.#isCancelKey(data)) {
			this.#cancel();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#state.moveSelection(-1)) this.#touch();
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#state.moveSelection(1)) this.#touch();
			return;
		}
		if (this.#isEnterKey(data) || matchesKey(data, "space")) {
			if (this.#state.openSelected()) {
				this.#scrollView.scrollToTop();
				this.#touch();
			}
		}
	}

	#handleCardInput(data: string): void {
		if (this.#isSubmitKey(data)) {
			this.#submit();
			return;
		}
		if (this.#isCancelKey(data)) {
			// Esc in the card returns to the list at the current finding; only the
			// list-level cancel discards the round.
			if (this.#state.closeToSelection()) this.#touch();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#state.stepFinding(-1)) {
				this.#scrollView.scrollToTop();
				this.#touch();
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.#state.stepFinding(1)) {
				this.#scrollView.scrollToTop();
				this.#touch();
			}
			return;
		}
		if (matchesKey(data, "tab") || data === "\t" || matchesSelectDown(data)) {
			this.#beginEditing();
			return;
		}
		// PgUp/PgDn/Home/End and Shift+Arrow page the finding body.
		if (this.#scrollView.handleScrollKey(data)) this.#touch();
	}

	#handleEditingInput(data: string): void {
		// Esc blurs: it commits the expanded buffer — a blank commit removes the
		// comment — and the editing guard makes a later blur on a non-editing
		// state unable to overwrite the saved comment. Consumed here so it can
		// never reach card navigation or list cancellation.
		if (this.#isCancelKey(data)) {
			this.#commitEditorText();
			return;
		}
		// Up/backspace on an empty buffer leave editing WITHOUT committing: an
		// untouched empty editor must never erase a stored comment (a blank
		// removal is expressed by deleting the text and pressing Enter). This is
		// the one destructive path a reflex arrow/backspace could otherwise hit.
		if (
			this.#editor.getExpandedText().length === 0 &&
			(matchesKey(data, "up") || matchesKey(data, "backspace") || data === "\x7f" || data === "\x08")
		) {
			this.#state.exitEditing();
			this.#touch();
			return;
		}
		// While editing, everything else — including paste, Shift+Enter newlines,
		// and Enter submits — routes only to the Editor. Enter fires the editor's
		// onSubmit, which saves the comment and exits editing. Every delegated
		// keystroke marks the overlay dirty: the editor buffer is not overlay
		// state, so without this the memoized render would echo nothing until
		// the next commit.
		this.#editor.handleInput(data);
		this.#touch();
	}

	/** Commit the editor's expanded text for the open finding, then leave editing. */
	#commitEditorText(): void {
		const index = this.#state.openIndex;
		if (index !== undefined && this.#state.editing) {
			this.#comments.set(this.#review.findings[index]!.id, this.#editor.getExpandedText());
		}
		this.#state.exitEditing();
		this.#touch();
	}

	#beginEditing(): void {
		const index = this.#state.openIndex;
		if (index === undefined || !this.#state.startEditing()) return;
		// Seed the buffer with the stored comment (if any) so committing the
		// untouched editor cannot erase it and clearing the buffer expresses
		// removal intent.
		this.#editor.setText(this.#comments.get(this.#review.findings[index]!.id) ?? "");
		this.#touch();
	}

	#submit(): void {
		if (this.#completed || this.#disposed) return;
		this.#completed = true;
		this.#state.exitEditing();
		this.#touch();
		const onSubmit = this.#onSubmit;
		this.#onSubmit = undefined;
		this.#onCancel = undefined;
		onSubmit?.(this.#comments.toRecord());
	}

	#cancel(): void {
		if (this.#completed || this.#disposed) return;
		this.#completed = true;
		this.#cancelled = true;
		this.#state.exitEditing();
		this.#touch();
		const onCancel = this.#onCancel;
		this.#onSubmit = undefined;
		this.#onCancel = undefined;
		onCancel?.();
	}

	#findingMarkdownFor(finding: IdentifiedReviewFinding): { body: Markdown; recommendation: Markdown } {
		let entry = this.#findingMarkdown.get(finding.id);
		if (!entry) {
			entry = {
				body: new Markdown(sanitizeModelText(finding.body), 0, 0, this.#mdTheme),
				recommendation: new Markdown(sanitizeModelText(finding.recommendation), 0, 0, this.#mdTheme),
			};
			this.#findingMarkdown.set(finding.id, entry);
		}
		return entry;
	}

	/**
	 * Summary lines for the list view: the fixed verdict head, then explanation
	 * and recommendation wrapped inline ("Recommendation …", "Explanation …").
	 * Inline labels keep each field visible even when the caller's budget
	 * leaves a single shared row: the recommendation reserves at least half of
	 * it, and the total never exceeds `maxLines`.
	 */
	#renderSummaryLines(width: number, maxLines: number): string[] {
		const review = this.#review;
		const uiTheme = this.#theme;
		const verdictColor = review.overall_correctness === "correct" ? "success" : "error";
		const counts = countByPriority(review.findings);
		const countsText = `P0 ${counts[0]} · P1 ${counts[1]} · P2 ${counts[2]} · P3 ${counts[3]}`;
		const commented = this.#comments.count();
		const lines = [
			`${uiTheme.fg("dim", "Scope")} ${truncateToWidth(sanitizeModelSingleLine(review.scope), Math.max(1, width - 8), Ellipsis.Unicode)}`,
			`${uiTheme.fg("dim", "Verdict")} ${uiTheme.bold(uiTheme.fg(verdictColor, review.overall_correctness))}  ${uiTheme.fg("dim", "confidence")} ${review.confidence}  ${uiTheme.fg("dim", "findings")} ${review.findings.length}  ${uiTheme.fg("dim", "commented")} ${commented}`,
			`${uiTheme.fg("dim", countsText)}`,
		];
		const sharedRows = maxLines - lines.length;
		if (sharedRows <= 0) return lines;
		const explanationRows = review.explanation.trim()
			? new Text(`${uiTheme.fg("dim", "Explanation")} ${sanitizeModelText(review.explanation)}`, 0, 0).render(width)
			: [];
		const recommendationRows = review.recommendation.trim()
			? new Text(`${uiTheme.fg("dim", "Recommendation")} ${sanitizeModelText(review.recommendation)}`, 0, 0).render(
					width,
				)
			: [];
		const recBudget = recommendationRows.length > 0 ? Math.max(1, Math.ceil(sharedRows / 2)) : 0;
		const recShown = recommendationRows.slice(0, recBudget);
		lines.push(...recShown);
		lines.push(...explanationRows.slice(0, Math.max(0, sharedRows - recShown.length)));
		return lines;
	}

	/** Windowed finding rows for the list view; returns rows plus the selected row position. */
	#renderListRows(width: number, slots: number): { lines: string[]; selectedPos: number } {
		const uiTheme = this.#theme;
		const findings = this.#review.findings;
		const rendered = findings.map((finding, i) => {
			const selected = i === this.#state.selectedIndex;
			const cursor = selected ? `${uiTheme.nav.cursor} ` : "  ";
			const priority = priorityColor(finding.priority, uiTheme)(priorityLabel(finding.priority));
			const title = sanitizeModelText(finding.title).replace(/\s+/g, " ").trim() || "(untitled)";
			const location = uiTheme.fg("dim", findingLocation(finding));
			const marker = this.#comments.has(finding.id) ? uiTheme.fg("accent", " ✎") : "";
			return {
				selected,
				line: `${cursor}${priority} ${truncateToWidth(title, Math.max(1, width - visibleWidth(cursor) - 4 - visibleWidth(location) - visibleWidth(marker)), Ellipsis.Unicode)} ${location}${marker}`,
			};
		});
		const selectedRow = rendered.findIndex(entry => entry.selected);
		let start = 0;
		if (rendered.length > slots) {
			start = Math.max(0, Math.min(Math.max(0, selectedRow - Math.floor(slots / 2)), rendered.length - slots));
		}
		const lines: string[] = [];
		for (let r = 0; r < Math.min(slots, rendered.length - start); r++) {
			const entry = rendered[start + r]!;
			lines.push(entry.selected ? uiTheme.bg("selectedBg", entry.line) : entry.line);
		}
		return { lines, selectedPos: selectedRow - start };
	}

	/** Card body lines for the open finding (evidence, recommendation, comment status). */
	#renderCardLines(width: number): string[] {
		const index = this.#state.openIndex;
		if (index === undefined) return [];
		const finding = this.#review.findings[index]!;
		const uiTheme = this.#theme;
		const md = this.#findingMarkdownFor(finding);
		const lines: string[] = [
			`${uiTheme.fg("dim", priorityLabel(finding.priority))} ${uiTheme.fg("dim", "confidence")} ${finding.confidence}  ${uiTheme.fg("dim", findingLocation(finding))}`,
		];
		if (finding.body.trim()) {
			lines.push(uiTheme.fg("dim", "Evidence"));
			lines.push(...md.body.render(width));
		}
		if (finding.recommendation.trim()) {
			lines.push(uiTheme.fg("dim", "Recommendation"));
			lines.push(...md.recommendation.render(width));
		}
		const comment = this.#comments.get(finding.id);
		if (this.#state.editing) {
			lines.push(uiTheme.fg("dim", "Comment (enter save · shift+enter newline · esc done)"));
		} else if (comment !== undefined) {
			const preview = comment.split("\n")[0] ?? "";
			lines.push(
				`${uiTheme.fg("accent", "✎")} ${truncateToWidth(replaceTabs(sanitizeText(preview)), Math.max(1, width - 3), Ellipsis.Unicode)}`,
			);
		} else {
			lines.push(uiTheme.fg("dim", "No comment yet — tab to add one"));
		}
		return lines;
	}

	#footerLines(width: number): string {
		const uiTheme = this.#theme;
		let help: string;
		if (this.#state.editing) {
			help = "enter save · shift+enter newline · esc done";
		} else if (this.#state.view === "card") {
			help = "←→ findings · pgup/pgdn scroll · tab/down comment · s submit feedback · esc back";
		} else {
			help = "↑↓ select · enter/space open · s submit feedback · esc cancel";
		}
		return truncateToWidth(uiTheme.fg("dim", help), Math.max(1, width), Ellipsis.Unicode);
	}

	render(width: number): readonly string[] {
		const rows = this.#getHeight();
		if (!this.#dirty && this.#renderCache && this.#renderCache.width === width && this.#renderCache.rows === rows) {
			return this.#renderCache.output;
		}

		const uiTheme = this.#theme;
		const innerWidth = Math.max(1, width - 4);
		const completedLines = this.#completed
			? [
					uiTheme.bold(
						uiTheme.fg(
							this.#cancelled ? "warning" : "success",
							this.#cancelled ? "Feedback cancelled" : "Feedback submitted",
						),
					),
				]
			: [];
		const completed = completedLines.length;
		const isEditing = this.#state.view === "card" && this.#state.editing;

		// Height budget. Every branch pushes exactly: top border + completed rows
		// + view body + footer divider + footer help + bottom border, so the
		// total stays bounded by `rows`.
		// Card: body = title(1) + divider(1) + scroll(R) [+ hint(1) + editor(E)].
		// List: body = label(1) + divider(1) + summary(S) + divider(1) + rows(L).
		const editorRows = isEditing ? Math.min(MAX_EDITOR_ROWS, Math.max(MIN_EDITOR_ROWS, rows - 10 - completed)) : 0;
		const scrollRows = isEditing
			? Math.max(MIN_BODY_ROWS, rows - 7 - completed - editorRows)
			: Math.max(MIN_BODY_ROWS, rows - 6 - completed);

		const out: string[] = [];
		out.push(topBorder(width, OVERLAY_TITLE));
		for (const line of completedLines) out.push(row(line, width));

		if (this.#state.view === "card") {
			const openIndex = this.#state.openIndex ?? 0;
			const finding = this.#review.findings[openIndex];
			const title = finding
				? truncateToWidth(
						sanitizeModelText(finding.title).replace(/\s+/g, " ").trim() || "(untitled)",
						innerWidth,
						Ellipsis.Unicode,
					)
				: "";
			out.push(row(uiTheme.bold(uiTheme.fg("accent", title)), width));
			out.push(divider(width));

			const cardLines = this.#renderCardLines(innerWidth);
			this.#scrollView.setLines(cardLines);
			this.#scrollView.setHeight(scrollRows);
			for (const line of this.#scrollView.render(innerWidth)) out.push(row(line, width));

			if (isEditing) {
				out.push(row(uiTheme.fg("dim", "comment"), width));
				this.#editor.setMaxHeight(editorRows);
				this.#editor.focused = true;
				for (const line of this.#editor.render(innerWidth)) out.push(row(line, width));
			}
		} else {
			out.push(row(uiTheme.bold(uiTheme.fg("accent", "Findings")), width));
			out.push(divider(width));
			// Keep the verdict/counts head of the summary visible even on short
			// terminals: cap it so at least one finding row still fits. List body
			// = label(1) + divider(1) + summary(S) + divider(1) + rows(L), so
			// S + L = rows - 7 - completed. The summary renderer shares the
			// explanation/recommendation budget so the recommendation survives.
			const maxSummaryLines = Math.max(3, rows - 7 - completed - 1);
			const summaryLines = this.#renderSummaryLines(innerWidth, maxSummaryLines);
			for (const line of summaryLines) out.push(row(line, width));
			out.push(divider(width));
			const listSlots = Math.max(1, rows - 7 - completed - summaryLines.length);
			const { lines } = this.#renderListRows(innerWidth, listSlots);
			for (const line of lines) out.push(row(line, width));
		}

		out.push(divider(width));
		out.push(row(this.#footerLines(width), width));
		out.push(bottomBorder(width));

		this.#dirty = false;
		this.#renderCache = { width, rows, output: out };
		return out;
	}
}
