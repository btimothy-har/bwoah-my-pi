import { prompt } from "@oh-my-pi/pi-utils";
import annotationsTemplate from "./prompts/annotations.md" with { type: "text" };
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import type { CodeReviewAnnotation, ReviewDiffFile } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { getReviewDiffPreview } from "./diff";
import type { ReadonlySessionManager } from "../../../../session/session-manager";
import type { ResolvedReviewTarget } from "./target";

const LARGE_DIFF_CHARACTER_LIMIT = 50_000;
const LARGE_DIFF_FILE_LIMIT = 20;

export interface FormatCodeReviewAnnotationsOptions {
	forReviewer: boolean;
	supplementalInstructions?: string;
}

type RenderedAnnotation = CodeReviewAnnotation & {
	pathLabel: string;
	lineLabel?: string;
	isLine: boolean;
};

interface ReviewPromptFile {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	ext: string;
	hunksPreview: string;
}

function formatPathLabel(annotation: CodeReviewAnnotation): string {
	return annotation.occurrence > 1 ? `${annotation.path} (${annotation.occurrence})` : annotation.path;
}

function formatLineLabel(annotation: Extract<CodeReviewAnnotation, { scope: "line" }>): string {
	if (annotation.oldLine !== undefined && annotation.newLine !== undefined) {
		return `old ${annotation.oldLine}, new ${annotation.newLine}`;
	}
	if (annotation.newLine !== undefined) return `new ${annotation.newLine}`;
	if (annotation.oldLine !== undefined) return `old ${annotation.oldLine}`;
	return "hunk";
}

function renderReviewPromptFile(file: ReviewDiffFile, previewLines: number): ReviewPromptFile {
	return {
		path: file.path,
		linesAdded: file.linesAdded,
		linesRemoved: file.linesRemoved,
		ext: file.path.match(/\.([^.]+)$/)?.[1] ?? "",
		hunksPreview: previewLines > 0 ? getReviewDiffPreview(file.rawDiff, previewLines) : "",
	};
}

/** Formats exact annotations for a reviewer prompt or editor paste. */
export function formatCodeReviewAnnotations(
	annotations: readonly CodeReviewAnnotation[],
	options: FormatCodeReviewAnnotationsOptions,
): string | undefined {
	const supplementalInstructions = options.supplementalInstructions?.trim();
	if (annotations.length === 0 && !supplementalInstructions) return undefined;
	const renderedAnnotations: RenderedAnnotation[] = annotations.map(annotation =>
		annotation.scope === "line"
			? {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					lineLabel: formatLineLabel(annotation),
					isLine: true,
				}
			: {
					...annotation,
					pathLabel: formatPathLabel(annotation),
					isLine: false,
				},
	);
	return prompt.render(annotationsTemplate, {
		forReviewer: options.forReviewer,
		annotations: renderedAnnotations,
		supplementalInstructions,
	});
}

/** Renders a review request from one frozen target snapshot. */
export function buildReviewPrompt(target: ResolvedReviewTarget, additionalInstructions?: string): string {
	const skipDiff =
		target.rawDiff.length > LARGE_DIFF_CHARACTER_LIMIT || target.snapshot.files.length > LARGE_DIFF_FILE_LIMIT;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / target.snapshot.files.length)) : 0;
	const files = target.snapshot.files.map(file => renderReviewPromptFile(file, linesPerFile));
	return prompt.render(reviewRequestTemplate, {
		mode: target.mode,
		files,
		excluded: target.snapshot.excluded,
		totalAdded: target.snapshot.totalAdded,
		totalRemoved: target.snapshot.totalRemoved,
		skipDiff,
		linesPerFile,
		rawDiff: target.rawDiff.trim(),
		scope: target.scope,
		fullDiffRef: target.fullDiffRef,
		diffInstruction: target.diffInstruction,
		contextInstruction: target.contextInstruction,
		additionalInstructions: additionalInstructions?.trim(),
	});
}

/**
 * Persist the complete acquired diff for large reviewable inputs so the chair
 * and every reviewer read the SAME frozen bytes, even after the working tree
 * or session changes. Inline-sized targets need no extra write; an existing
 * reference is reused. Storage ownership must be verified by the caller before
 * and after this await — a replacement session never receives this snapshot.
 */
export async function persistReviewDiffSnapshot(
	target: ResolvedReviewTarget,
	sessionManager: ReadonlySessionManager,
): Promise<ResolvedReviewTarget> {
	if (target.fullDiffRef) return target;
	if (!target.rawDiff.trim()) return target;
	if (target.rawDiff.length <= LARGE_DIFF_CHARACTER_LIMIT && target.snapshot.files.length <= LARGE_DIFF_FILE_LIMIT) {
		return target;
	}
	// Capture the concrete store synchronously: `getArtifactManager()` selects
	// storage from the CURRENT session file, so a later newSession() must not
	// re-route this save into a replacement session's bucket. A host without
	// either facility cannot snapshot: return the target unchanged and let the
	// reviewers fall back to the pinned diffInstruction (absent storage is a
	// capability boundary, not a save failure).
	const artifactManager = sessionManager.getArtifactManager?.() ?? null;
	if (!artifactManager && !sessionManager.putBlob) return target;
	try {
		if (artifactManager) {
			const id = await artifactManager.save(target.rawDiff, "code-review-diff");
			return { ...target, fullDiffRef: `artifact://${id}` };
		}
		const blob = await sessionManager.putBlob(Buffer.from(target.rawDiff, "utf8"), { extension: "diff" });
		return { ...target, fullDiffRef: blob.displayPath };
	} catch (error) {
		throw new Error(
			`Failed to persist the review diff snapshot: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
