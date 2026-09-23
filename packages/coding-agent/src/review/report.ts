/**
 * Report domain for the native review workflow.
 *
 * Single module for the strict model-facing parameter schema, deterministic
 * finding preparation (path normalization, sort, id assignment), and the
 * canonical schema_version 2 artifact. Shared view/input types are declared
 * once in the pi-tui findings model and imported type-only from there; this
 * module must not import TUI components, sessions, or persistence.
 */
import * as path from "node:path";
import { type as arkType } from "@oh-my-pi/omptype";
import type {
	FeedbackStatus,
	IdentifiedReviewFinding,
	OverallCorrectness,
	PreparedReview,
	ReviewFindingInput,
	ReviewFindingsInput,
} from "@oh-my-pi/pi-tui/overlays/review-findings-model";

/** Per-finding user feedback recorded by the findings overlay. */
export interface ReviewFindingFeedback {
	comment: string | null;
}

/** An artifact finding: the identified finding plus its user feedback. */
export interface ReviewArtifactFinding extends IdentifiedReviewFinding {
	feedback: ReviewFindingFeedback;
}

/**
 * Canonical persisted review artifact. Carries no timestamps or run-specific
 * data so the artifact is reproducible from its inputs.
 */
export interface ReviewArtifactV2 {
	schema_version: 2;
	scope: string;
	overall_correctness: OverallCorrectness;
	explanation: string;
	recommendation: string;
	confidence: number;
	feedback_status: FeedbackStatus;
	findings: ReviewArtifactFinding[];
}

const findingSchema = arkType({
	title: arkType("string > 0").describe("Concise issue title, ideally at most 80 characters."),
	body: arkType("string > 0").describe(
		"Detailed evidence identifying the issue and explaining its impact. Do not include remediation; put the recommended action in recommendation.",
	),
	recommendation: arkType("string > 0").describe(
		"The review chair's concise recommended action for resolving this finding.",
	),
	priority: arkType("0 | 1 | 2 | 3").describe(
		"Severity: 0 blocks release or operations, 1 is high and should be fixed next cycle, 2 is medium and should be fixed eventually, 3 is informational and nice to have.",
	),
	confidence: arkType("0 <= number <= 1").describe(
		"Confidence that this finding identifies a real problem, from 0 to 1.",
	),
	file_path: arkType("string > 0").describe(
		"Repository-relative path of the file containing the finding; absolute paths inside the reviewed repository are accepted and normalized.",
	),
	line_start: arkType("number.integer >= 1").describe("First line of the finding's line range (1-based, inclusive)."),
	line_end: arkType("number.integer >= 1").describe(
		"Last line of the finding's line range (1-based, inclusive); must be >= line_start.",
	),
	"+": "reject",
});

/**
 * Strict model-facing parameter schema. Unknown fields are rejected at every
 * object level; finding ids and user feedback have no schema fields at all —
 * the tool assigns ids after sorting and only the overlay supplies feedback.
 */
export const reviewFindingsSchema = arkType({
	scope: arkType("string > 0").describe(
		"What was reviewed, e.g. the branch range, PR, commit, or working changes the findings cover.",
	),
	overall_correctness: arkType("'correct' | 'incorrect'").describe(
		"Whether the reviewed change is correct overall: 'correct' or 'incorrect'.",
	),
	explanation: arkType("string > 0").describe("One or two sentences explaining why the overall verdict applies."),
	recommendation: arkType("string > 0").describe(
		"What the user should do next with the reviewed change. Provide actionable guidance even when there are no findings.",
	),
	confidence: arkType("0 <= number <= 1").describe("Confidence in the overall correctness verdict, from 0 to 1."),
	findings: findingSchema
		.array()
		.describe(
			"Final findings after validating them against the code, discarding false positives, and semantically deduplicating shared root causes. Pass an empty array when none remain; the tool sorts findings and assigns ids.",
		),
	"+": "reject",
}).narrow((review, ctx) => {
	const reversed = review.findings.find(item => item.line_end < item.line_start);
	return (
		reversed === undefined ||
		ctx.mustBe(
			`finding ${JSON.stringify(reversed.title)} in ${reversed.file_path} to use a line_end greater than or equal to line_start`,
		)
	);
});

/** Normalize an in-repository absolute path to a repository-relative POSIX path; preserve other inputs. */
function repositoryRelativePath(filePath: string, repositoryRoot: string | null): string {
	if (!repositoryRoot || !path.isAbsolute(filePath)) return filePath;
	const normalized = path.relative(repositoryRoot, filePath);
	if (
		normalized === "" ||
		normalized === ".." ||
		normalized.startsWith(`..${path.sep}`) ||
		path.isAbsolute(normalized)
	) {
		return filePath;
	}
	return normalized.split(path.sep).join("/");
}

function compareFindings(left: ReviewFindingInput, right: ReviewFindingInput): number {
	if (left.priority !== right.priority) return left.priority - right.priority;
	if (left.file_path !== right.file_path) return left.file_path < right.file_path ? -1 : 1;
	if (left.line_start !== right.line_start) return left.line_start - right.line_start;
	if (left.line_end !== right.line_end) return left.line_end - right.line_end;
	if (left.title !== right.title) return left.title < right.title ? -1 : 1;
	return 0;
}

/**
 * Normalize finding paths against the repository root FIRST (so equivalent
 * absolute/relative inputs sort identically), then sort deterministically
 * (priority, file_path, line_start, line_end, title) and assign sequential
 * ids (`finding-1`, `finding-2`, ...) in sorted order. This ordering
 * stabilizes UI/comment association, not semantic deduplication — dedupe is
 * the review chair's job. The input is not mutated.
 */
export function prepareReview(input: ReviewFindingsInput, repositoryRoot: string | null): PreparedReview {
	const normalized = input.findings.map((finding): ReviewFindingInput => ({
		...finding,
		file_path: repositoryRelativePath(finding.file_path, repositoryRoot),
	}));
	const findings = [...normalized]
		.sort(compareFindings)
		.map((finding, index): IdentifiedReviewFinding => ({ ...finding, id: `finding-${index + 1}` }));
	return {
		scope: input.scope,
		overall_correctness: input.overall_correctness,
		explanation: input.explanation,
		recommendation: input.recommendation,
		confidence: input.confidence,
		findings,
	};
}

/**
 * Build the canonical schema_version 2 artifact. Only comments belonging to
 * prepared finding ids enter the artifact; any outcome other than
 * "submitted" discards comments entirely (findings keep null feedback).
 */
export function buildReviewArtifact(
	prepared: PreparedReview,
	status: FeedbackStatus,
	comments: Readonly<Record<string, string>> = {},
): ReviewArtifactV2 {
	const appliedComments = status === "submitted" ? comments : {};
	const findings: ReviewArtifactFinding[] = prepared.findings.map(finding => ({
		...finding,
		feedback: { comment: appliedComments[finding.id] ?? null },
	}));
	return {
		schema_version: 2,
		scope: prepared.scope,
		overall_correctness: prepared.overall_correctness,
		explanation: prepared.explanation,
		recommendation: prepared.recommendation,
		confidence: prepared.confidence,
		feedback_status: status,
		findings,
	};
}
