/**
 * Framework-independent state for the review findings overlay.
 *
 * Single declaration site for the shared review-findings view/input types.
 * Report and tool modules import these type-only; nothing here may import from
 * coding-agent, the filesystem, Git, prompts, persistence, or tool invocation.
 */

/** Severity of a single finding; 0 is most severe. */
export type ReviewPriority = 0 | 1 | 2 | 3;

/** The review chair's overall verdict on the reviewed scope. */
export type OverallCorrectness = "correct" | "incorrect";

/** Terminal state of the feedback collection round. */
export type FeedbackStatus = "submitted" | "cancelled" | "unavailable" | "not_required";

/** Raw, model-supplied finding (no id, no human feedback). */
export interface ReviewFindingInput {
	title: string;
	body: string;
	recommendation: string;
	priority: ReviewPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Raw, model-supplied final report shape (the `review_findings` tool arguments). */
export interface ReviewFindingsInput {
	scope: string;
	overall_correctness: OverallCorrectness;
	explanation: string;
	recommendation: string;
	confidence: number;
	findings: ReviewFindingInput[];
}

/** Finding with its stable, sort-assigned id. Never model-supplied. */
export interface IdentifiedReviewFinding extends ReviewFindingInput {
	id: string;
}

/** Final report after deterministic preparation (sorting + id assignment). */
export interface PreparedReview extends Omit<ReviewFindingsInput, "findings"> {
	findings: IdentifiedReviewFinding[];
}

/** What the overlay reports back to the tool host. */
export type ReviewFeedbackResult = { status: "submitted"; comments: Record<string, string> } | { status: "cancelled" };

export const REVIEW_PRIORITIES: readonly ReviewPriority[] = [0, 1, 2, 3];

export function priorityLabel(priority: ReviewPriority): string {
	return `P${priority}`;
}

/** Per-priority finding counts, in priority order. */
export function countByPriority(findings: readonly { priority: ReviewPriority }[]): Record<ReviewPriority, number> {
	const counts: Record<ReviewPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
	for (const finding of findings) counts[finding.priority] += 1;
	return counts;
}

/**
 * Per-invocation draft comment store keyed by finding id. Never module-global:
 * each overlay owns one instance, so cancelled or replaced overlays cannot
 * leak drafts into another feedback round.
 */
export class CommentStore {
	readonly #comments = new Map<string, string>();

	/** Store a comment; blank trimmed text removes the comment. True when present afterwards. */
	set(id: string, text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) {
			this.#comments.delete(id);
			return false;
		}
		this.#comments.set(id, trimmed);
		return true;
	}

	get(id: string): string | undefined {
		return this.#comments.get(id);
	}

	has(id: string): boolean {
		return this.#comments.has(id);
	}

	remove(id: string): void {
		this.#comments.delete(id);
	}

	clear(): void {
		this.#comments.clear();
	}

	count(): number {
		return this.#comments.size;
	}

	toRecord(): Record<string, string> {
		return Object.fromEntries(this.#comments);
	}
}

/** Which surface the overlay is showing. */
export type ReviewFindingsView = "list" | "card";

/**
 * List/card/editor transition state: selection index, focused finding, and
 * editing flag. Pure state — rendering and input interpretation stay in the
 * overlay component.
 */
export class ReviewFindingsViewModel {
	#findingCount: number;
	#view: ReviewFindingsView = "list";
	#selectedIndex = 0;
	#openIndex: number | undefined;
	#editing = false;

	constructor(findingCount: number) {
		this.#findingCount = Math.max(0, Math.floor(findingCount));
	}

	get view(): ReviewFindingsView {
		return this.#view;
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	/** Index of the finding shown in the card, or undefined in list view. */
	get openIndex(): number | undefined {
		return this.#openIndex;
	}

	get editing(): boolean {
		return this.#editing;
	}

	get findingCount(): number {
		return this.#findingCount;
	}

	/** Move the list cursor by a clamped delta; true when it moved. */
	moveSelection(delta: number): boolean {
		if (this.#view !== "list" || this.#findingCount === 0) return false;
		const next = Math.max(0, Math.min(this.#selectedIndex + delta, this.#findingCount - 1));
		if (next === this.#selectedIndex) return false;
		this.#selectedIndex = next;
		return true;
	}

	/** Open the selected finding's card. */
	openSelected(): boolean {
		if (this.#view !== "list" || this.#findingCount === 0) return false;
		this.#openIndex = this.#selectedIndex;
		this.#view = "card";
		return true;
	}

	/** Return from the card (and any editing state) to the list at the current finding. */
	closeToSelection(): boolean {
		if (this.#view !== "card") return false;
		this.#editing = false;
		this.#selectedIndex = this.#openIndex ?? this.#selectedIndex;
		this.#openIndex = undefined;
		this.#view = "list";
		return true;
	}

	/** Step between findings inside the card view; leaves editing. */
	stepFinding(delta: number): boolean {
		if (this.#view !== "card" || this.#openIndex === undefined) return false;
		const next = Math.max(0, Math.min(this.#openIndex + delta, this.#findingCount - 1));
		if (next === this.#openIndex) return false;
		this.#openIndex = next;
		this.#editing = false;
		return true;
	}

	/** Focus the multiline comment editor for the open finding. */
	startEditing(): boolean {
		if (this.#view !== "card" || this.#openIndex === undefined || this.#editing) return false;
		this.#editing = true;
		return true;
	}

	/** Leave the comment editor back to the card. */
	exitEditing(): boolean {
		if (!this.#editing) return false;
		this.#editing = false;
		return true;
	}
}
