/**
 * Transcript renderer for the native `review_findings` tool: summary/status,
 * overall recommendation, finding counts, and the saved report reference — or
 * a save-failure view whose recovery JSON only appears when expanded.
 *
 * Renders never reread artifacts and never reopen the findings overlay; both
 * live and replay paths render the persisted details alone. Call args are
 * untrusted (partially streamed, model-mangled) and are normalized before use.
 */
import type { ToolRenderer } from "./renderer";

import type { OutputMeta } from "./output-meta";
import type { RenderResultOptions } from "./renderer";
import { type Component, Ellipsis, Markdown, Text } from "../index";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import { outputBlockContentWidth, renderStatusLine } from "../render";
import { framedToolCard, type ToolCardSection } from "../render/tool-card";
import {
	formatErrorMessage,
	formatMeta,
	formatTitle,
	PREVIEW_LIMITS,
	sanitizeCarriageReturns,
} from "../render/render-utils";
import { replaceTabs, truncateToWidth } from "../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	type FeedbackStatus,
	type OverallCorrectness,
	priorityLabel,
	REVIEW_PRIORITIES,
	type ReviewPriority,
} from "../overlays/review-findings-model";

/** Details for a successfully delivered (or deliberately not-saved) review report. */
export interface ReviewSavedDetails {
	status: "saved";
	scope: string;
	overallCorrectness: OverallCorrectness;
	explanation: string;
	recommendation: string;
	overallConfidence: number;
	findingCount: number;
	counts: Record<ReviewPriority, number>;
	commentedCount: number;
	feedbackStatus: FeedbackStatus;
	reviewRef: string;
	storage: "artifact" | "blob";
}

/** Details returned when the report could not be persisted; `recoveryJson` is
 *  the complete serialized report so nothing is lost beyond the transcript. */
export interface ReviewSaveFailureDetails {
	status: "save_failed";
	error: string;
	recoveryJson: string;
	meta: OutputMeta;
}

export type ReviewToolDetails = ReviewSavedDetails | ReviewSaveFailureDetails;

const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
	submitted: "feedback submitted",
	cancelled: "feedback cancelled",
	unavailable: "feedback unavailable",
	not_required: "no findings required",
};

interface ReviewRenderArgs {
	scope?: string;
	findings?: unknown[];
}

/** Strip the `\r` runs degenerate models inject, plus ANSI/controls and tabs. */
function sanitizeDisplay(text: string): string {
	return replaceTabs(sanitizeText(sanitizeCarriageReturns(text)));
}

/** Single-line variant for headers/locations: whitespace runs (incl. newlines) collapse to one space. */
function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplay(text).replace(/\s+/g, " ").trim();
}

/** Tolerate partially streamed or mangled call args. */
function normalizeRenderArgs(raw: unknown): ReviewRenderArgs {
	if (!raw || typeof raw !== "object") return {};
	const args = raw as Partial<ReviewRenderArgs>;
	return {
		scope: typeof args.scope === "string" ? sanitizeDisplayLine(args.scope) : undefined,
		findings: Array.isArray(args.findings) ? args.findings : undefined,
	};
}

function normalizeCounts(raw: unknown): Record<ReviewPriority, number> {
	const counts: Record<ReviewPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
	if (raw && typeof raw === "object") {
		for (const priority of REVIEW_PRIORITIES) {
			const value = (raw as Record<string, unknown>)[String(priority)];
			if (typeof value === "number" && Number.isFinite(value)) counts[priority] = value;
		}
	}
	return counts;
}

function normalizeOverallCorrectness(raw: unknown): OverallCorrectness {
	return raw === "incorrect" ? "incorrect" : "correct";
}

function countsLine(counts: Record<ReviewPriority, number>): string {
	return REVIEW_PRIORITIES.map(priority => `${priorityLabel(priority)} ${counts[priority]}`).join(" · ");
}

/** Render the recovery JSON for a failed save, line-sanitized for display. */
function renderRecoveryJsonLines(uiTheme: Theme, recoveryJson: string, width: number): string[] {
	return recoveryJson
		.split("\n")
		.slice(0, PREVIEW_LIMITS.EXPANDED_LINES * 10)
		.map(line => truncateToWidth(uiTheme.fg("muted", sanitizeDisplay(line)), Math.max(1, width), Ellipsis.Unicode));
}

export const reviewFindingsToolRenderer = {
	mergeCallAndResult: true,

	renderCall(args: ReviewRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Review findings", uiTheme);
		const normalized = normalizeRenderArgs(args);
		const meta: string[] = [];
		if (normalized.scope) meta.push(normalized.scope);
		if (normalized.findings) meta.push(`${normalized.findings.length} findings`);
		const header = `${label}${formatMeta(meta, uiTheme)}`;
		return framedToolCard(uiTheme, () => ({
			header,
			sections: [],
			phase: "pending",
			borderColor: "borderMuted",
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReviewToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const mdTheme = getMarkdownTheme();
		const md = (text: string, width: number) =>
			new Markdown(sanitizeDisplay(text), 1, 0, mdTheme, { color: t => uiTheme.fg("accent", t) }).render(
				Math.max(1, outputBlockContentWidth(width) + 1),
			);

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? sanitizeDisplay(txt.text) : "";
			const header = renderStatusLine({ icon: "warning", title: "Review findings" }, uiTheme);
			return new Text(`${header}${fallback ? `\n${uiTheme.fg("dim", fallback)}` : ""}`, 0, 0);
		}

		// Save failure: never shows a report reference. The recovery JSON is the
		// complete report; it appears only when the card is expanded.
		if (details.status === "save_failed") {
			const header = renderStatusLine({ icon: "error", title: "Review findings", meta: ["save failed"] }, uiTheme);
			return framedToolCard(uiTheme, ({ width }) => {
				const sections: ToolCardSection[] = [{ content: [formatErrorMessage(details.error, uiTheme)] }];
				if (options.expanded) {
					sections.push({
						label: uiTheme.fg("dim", "Report JSON (not persisted — recovery copy)"),
						content: renderRecoveryJsonLines(uiTheme, details.recoveryJson, width),
					});
				} else {
					sections.push({ content: [uiTheme.fg("dim", "Expand for the unpersisted report JSON.")] });
				}
				return { header, sections, phase: "error", borderColor: "error" };
			});
		}

		const scope = sanitizeDisplayLine(details.scope);
		const feedbackStatus: FeedbackStatus = details.feedbackStatus ?? "unavailable";
		const overallCorrectness = normalizeOverallCorrectness(details.overallCorrectness);
		const verdictColor = overallCorrectness === "correct" ? "success" : "error";
		const counts = normalizeCounts(details.counts);
		const header = renderStatusLine(
			{
				icon: feedbackStatus === "submitted" ? "success" : feedbackStatus === "not_required" ? "info" : "warning",
				title: "Review findings",
				meta: [scope, FEEDBACK_STATUS_LABEL[feedbackStatus] ?? feedbackStatus, details.storage],
			},
			uiTheme,
		);
		return framedToolCard(uiTheme, ({ width }) => {
			const bodyLines: string[] = [
				`${uiTheme.fg("dim", "Verdict")} ${uiTheme.bold(uiTheme.fg(verdictColor, overallCorrectness))}  ${uiTheme.fg("dim", "confidence")} ${details.overallConfidence}  ${uiTheme.fg("dim", "findings")} ${details.findingCount}  ${uiTheme.fg("dim", "commented")} ${details.commentedCount}`,
			];
			if (details.explanation) bodyLines.push(...md(details.explanation, width));
			if (details.recommendation) {
				bodyLines.push(uiTheme.fg("dim", "Recommendation"), ...md(details.recommendation, width));
			}
			bodyLines.push(uiTheme.fg("dim", countsLine(counts)));
			// The reference is only meaningful for a persisted report.
			if (details.reviewRef) {
				bodyLines.push(
					`${uiTheme.fg("dim", "report")} ${truncateToWidth(details.reviewRef, Math.max(1, width - 10), Ellipsis.Unicode)}`,
				);
			}
			return {
				header,
				sections: [{ content: bodyLines }],
				phase: feedbackStatus === "submitted" ? "success" : "warning",
				borderColor: "borderMuted",
			};
		});
	},

	activitySummary(args: ReviewRenderArgs): { label: string; detail?: string } {
		const normalized = normalizeRenderArgs(args);
		return { label: "Review findings", detail: normalized.scope };
	},
} satisfies ToolRenderer<ReviewRenderArgs, ReviewToolDetails>;
