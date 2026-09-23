/**
 * Native review findings tool: the primary agent's one final review
 * presentation. Validates the synthesized report, optionally mounts the
 * native findings overlay for per-finding user feedback, and always persists
 * a schema_version 2 review artifact (artifact:// reference, or blob fallback)
 * for the primary to read back. Session ownership is captured before the
 * first await so a session change/disposal can never deliver the report into
 * a replacement conversation.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ReviewToolDetails } from "@oh-my-pi/pi-tui/tools/review-findings";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ReviewFindingsOverlay } from "@oh-my-pi/pi-tui/overlays/review-findings-overlay";
import {
	countByPriority,
	type FeedbackStatus,
	type ReviewFeedbackResult,
	type ReviewFindingsInput,
} from "@oh-my-pi/pi-tui/overlays/review-findings-model";
import { prompt } from "@oh-my-pi/pi-utils";
import { findRepoRoot } from "../capability/fs";
import reviewFindingsDescription from "../prompts/tools/review-findings.md" with { type: "text" };
import { buildReviewArtifact, prepareReview, reviewFindingsSchema } from "../review/report";
import type { ToolSession } from ".";
import { ToolAbortError, throwIfAborted } from "./tool-errors";

export class ReviewFindingsTool implements AgentTool<typeof reviewFindingsSchema, ReviewToolDetails> {
	readonly name = "review_findings";
	readonly label = "Review findings";
	readonly approval = "read" as const;
	readonly strict = true;
	// The findings overlay is a single exclusive TUI surface; two concurrent
	// final presentations would steal focus and orphan one report.
	readonly concurrency = "exclusive" as const;
	readonly loadMode = "essential" as const;
	readonly summary = "Present the final synthesized code review and collect user feedback";
	readonly description: string;
	readonly parameters = reviewFindingsSchema;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(reviewFindingsDescription);
	}

	static createIf(session: ToolSession): ReviewFindingsTool | null {
		// Subagents never present final reviews. UI availability is intentionally
		// NOT consulted here: headless reviews must still construct the tool so
		// the report persists.
		return (session.taskDepth ?? 0) > 0 ? null : new ReviewFindingsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ReviewFindingsInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReviewToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ReviewToolDetails>> {
		if ((this.session.taskDepth ?? 0) > 0) {
			throw new ToolError("review_findings must only run in the primary session");
		}
		const sessionManager = context?.sessionManager;
		if (!sessionManager) {
			throw new ToolError("review_findings requires a session manager to persist the review report");
		}

		// Capture ownership before the first await. Never resolve a replacement
		// conversation's artifact manager after awaiting the overlay: a save that
		// already started may finish in the captured old manager only.
		const capturedSessionId = sessionManager.getSessionId();
		const capturedCwd = sessionManager.getCwd();
		const capturedArtifacts = this.session.getArtifactManager?.() ?? sessionManager.getArtifactManager();

		// Ownership loss is signaled two ways: SDK teardown sets disposal state
		// before it fires callbacks, so `isDisposed` is checked directly at every
		// phase boundary, and the callbacks abort this controller for the
		// in-flight await.
		const ownership = new AbortController();
		const combinedSignal = AbortSignal.any([ownership.signal, ...(signal ? [signal] : [])]);
		const abortForOwnershipLoss = () =>
			ownership.abort(new DOMException("Session changed during review", "AbortError"));
		const unregisters: Array<() => void> = [];
		const unregisterSessionChange = this.session.registerSessionChangeCallback?.(abortForOwnershipLoss);
		if (typeof unregisterSessionChange === "function") unregisters.push(unregisterSessionChange);
		const unregisterDispose = this.session.registerDisposeCallback?.(abortForOwnershipLoss);
		if (typeof unregisterDispose === "function") unregisters.push(unregisterDispose);

		try {
			const checkOwnership = (phase: string): void => {
				throwIfAborted(combinedSignal);
				if (this.session.isDisposed?.()) {
					throw new ToolAbortError(`Review abandoned: session was disposed ${phase}`);
				}
				if (sessionManager.getSessionId() !== capturedSessionId || sessionManager.getCwd() !== capturedCwd) {
					throw new ToolAbortError(`Review abandoned: session changed ${phase}`);
				}
			};

			checkOwnership("at entry");

			const repositoryRoot = await findRepoRoot(capturedCwd);
			const prepared = prepareReview(params, repositoryRoot);

			let feedbackStatus: FeedbackStatus;
			let comments: Record<string, string> = {};
			if (prepared.findings.length === 0) {
				feedbackStatus = "not_required";
			} else if (context?.hasUI === true && context.ui?.supportsCustomComponents === true) {
				const ui = context.ui;
				checkOwnership("before presenting findings");
				let result: ReviewFeedbackResult;
				try {
					result = await ui.custom<ReviewFeedbackResult>(
						(tui, theme, _keybindings, done) =>
							new ReviewFindingsOverlay(
								prepared,
								{ theme, getHeight: () => tui.terminal.rows },
								{
									onSubmit: submitted => done({ status: "submitted", comments: submitted }),
									onCancel: () => done({ status: "cancelled" }),
								},
							),
						{
							overlay: true,
							overlayOptions: {
								anchor: "bottom-center",
								width: "100%",
								maxHeight: "100%",
								margin: 0,
								fullscreen: true,
							},
							signal: combinedSignal,
						},
					);
				} catch (error) {
					// A real host rejects the modal on abort; surface it as a tool abort.
					throwIfAborted(combinedSignal);
					throw error;
				}
				feedbackStatus = result.status;
				if (result.status === "submitted") comments = result.comments;
			} else {
				// Host cannot mount native components (RPC, ACP, print, absent UI).
				// Findings stay fully persisted; feedback is simply unavailable.
				feedbackStatus = "unavailable";
			}

			checkOwnership("before saving the review report");
			const artifact = buildReviewArtifact(prepared, feedbackStatus, comments);
			const reportJson = JSON.stringify(artifact, null, 2);

			let reviewRef: string;
			let storage: "artifact" | "blob";
			try {
				if (capturedArtifacts) {
					const artifactId = await capturedArtifacts.save(reportJson, "code-review");
					reviewRef = `artifact://${artifactId}`;
					storage = "artifact";
				} else {
					const blob = await sessionManager.putBlob(Buffer.from(reportJson), { extension: "json" });
					reviewRef = blob.displayPath;
					storage = "blob";
				}
			} catch (error) {
				// Ownership may have been lost while the save was failing; never
				// emit recovery content into a replacement session.
				checkOwnership("while saving the review report");
				const message = error instanceof Error ? error.message : String(error);
				// meta.artifactError tells the shared output wrapper the capture of
				// THIS result already failed, suppressing its extra artifact-save
				// attempt for the oversized error text.
				const details: ReviewToolDetails = {
					status: "save_failed",
					error: message,
					recoveryJson: reportJson,
					meta: { artifactError: "write" } satisfies OutputMeta,
				};
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text:
								`Failed to persist the review report: ${message}. ` +
								"The complete report follows; treat it as the authoritative review record and do not re-run the review.\n\n" +
								reportJson,
						},
					],
					details,
				};
			}

			checkOwnership("after saving the review report");
			const commentedCount = artifact.findings.filter(finding => finding.feedback.comment !== null).length;
			const details: ReviewToolDetails = {
				status: "saved",
				scope: artifact.scope,
				overallCorrectness: artifact.overall_correctness,
				explanation: artifact.explanation,
				recommendation: artifact.recommendation,
				overallConfidence: artifact.confidence,
				findingCount: artifact.findings.length,
				counts: countByPriority(artifact.findings),
				commentedCount,
				feedbackStatus,
				reviewRef,
				storage,
			};
			// Blob paths may contain spaces; quote them so the reference stays one token.
			const reference = storage === "blob" ? JSON.stringify(reviewRef) : reviewRef;
			return {
				content: [{ type: "text" as const, text: `Read ${reference} before continuing.` }],
				details,
			};
		} finally {
			for (const unregister of unregisters) unregister();
		}
	}
}
