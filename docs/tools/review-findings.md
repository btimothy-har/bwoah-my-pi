# review_findings

> Presents the review chair's one final code review, optionally collects per-finding user feedback in a native fullscreen overlay, and always persists a readable report artifact.

## Source
- Entry: `packages/coding-agent/src/tools/review-findings.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/review-findings.md`
- Key collaborators:
  - `packages/coding-agent/src/review/report.ts` — strict `reviewFindingsSchema`, `prepareReview` (path normalization, deterministic sort, id assignment), `buildReviewArtifact` (schema_version 2 artifact)
  - `packages/tui/src/overlays/review-findings-overlay.ts` — fullscreen findings list/card/comment-editor overlay component
  - `packages/tui/src/overlays/review-findings-model.ts` — shared view/input types and comment store
  - `packages/tui/src/tools/review-findings.ts` — transcript renderer and `ReviewToolDetails` union
  - `packages/coding-agent/src/capability/fs.ts` — `findRepoRoot` for path normalization

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | `string` | Yes | What was reviewed: branch range, PR, commit, or working changes. |
| `overall_correctness` | `'correct' \| 'incorrect'` | Yes | Verdict on the reviewed change as a whole. |
| `explanation` | `string` | Yes | One or two sentences justifying the overall verdict. |
| `recommendation` | `string` | Yes | What the user should do next with the change; required even with zero findings. |
| `confidence` | `number` | Yes | Confidence in the overall verdict, 0–1. |
| `findings` | `Finding[]` | Yes | Final findings after chair validation and deduplication. Empty array is valid (clean review). |

### `Finding`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Concise issue title. |
| `body` | `string` | Yes | Evidence and impact; no remediation (that belongs in `recommendation`). |
| `recommendation` | `string` | Yes | The chair's recommended action for this finding. |
| `priority` | `0 \| 1 \| 2 \| 3` | Yes | 0 blocks release/operations; 3 informational. |
| `confidence` | `number` | Yes | 0–1 confidence the finding is a real problem. |
| `file_path` | `string` | Yes | Repository-relative path; absolute paths inside the repository are normalized to relative POSIX form. Out-of-repo and relative remote-PR locations are preserved. |
| `line_start` | `number` | Yes | 1-based inclusive first line; integer ≥ 1. |
| `line_end` | `number` | Yes | 1-based inclusive last line; integer ≥ 1 and ≥ `line_start` (schema narrow rejects reversed ranges by title/path). |

Finding `id`s and user feedback are never model-supplied: the tool assigns ids after sorting, and only the overlay supplies feedback.

## Outputs
- Single-shot result; no streaming updates.
- Success `content[0].text` is a short instruction to read the returned reference (`Read artifact://<id> before continuing.`; blob paths are JSON-quoted).
- Success `details` is `ReviewSavedDetails`: `{ status: "saved", scope, overallCorrectness, explanation, recommendation, overallConfidence, findingCount, counts (per-priority), commentedCount, feedbackStatus, reviewRef, storage: "artifact" | "blob" }`.
- Owned persistence failure returns `isError: true` with explanatory text plus the complete report JSON, and `ReviewSaveFailureDetails`: `{ status: "save_failed", error, recoveryJson (the complete serialized report, lossless), meta: { artifactError: "write" } }`. The `artifactError` meta suppresses the shared output wrapper's extra artifact-save attempt for the oversized error text. No retry, no fabricated `artifact://` reference.
- `reviewRef` semantics: `artifact://<id>` when a captured `ArtifactManager` exists; otherwise a content-addressed blob `displayPath` from `sessionManager.putBlob`. Both are readable via the normal read path.

## Flow
1. `ReviewFindingsTool.createIf()` returns the tool unless `session.taskDepth > 0`; subagents never present final reviews. UI availability is intentionally not consulted at construction so headless reviews still persist. Depth is re-checked in `execute()`.
2. `execute()` requires `context.sessionManager`; missing → `ToolError`.
3. Before the first await it captures the session id, execution cwd, and current artifact manager (`session.getArtifactManager?.() ?? context.sessionManager.getArtifactManager()`). The captured manager is used for persistence; a replacement conversation's manager is never resolved after awaiting the UI.
4. A per-call `AbortController` is combined with the supplied signal via `AbortSignal.any` and aborted by `registerSessionChangeCallback`/`registerDisposeCallback` (unregistered in `finally`). `checkOwnership` (throwIfAborted + `session.isDisposed?.()` + captured id/cwd match) runs at entry, before the UI, before saving, after saving, and before any success/error return — SDK teardown sets disposal state before callbacks fire, so disposal state is polled directly.
5. `findRepoRoot(capturedCwd)` resolves the repository root; `prepareReview` normalizes paths, sorts by priority, file_path, line_start, line_end, title, and assigns `finding-1…n`.
6. Outcome matrix:
   - Zero findings: never opens UI; `feedback_status: "not_required"`.
   - Findings + `context.hasUI` + `context.ui.supportsCustomComponents === true`: mounts `ReviewFindingsOverlay` through `context.ui.custom<ReviewFeedbackResult>` with `{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true }, signal }` and `getHeight: () => tui.terminal.rows`; `submitted` keeps comments, `cancelled` discards drafts.
   - Findings without custom-component capability (RPC/ACP/print/absent UI, including `hasUI: true` hosts that cannot mount components): never calls `custom()`; `feedback_status: "unavailable"` with null comments.
7. User Esc is not tool cancellation: the report persists with `feedback_status: "cancelled"` and null comments, and the tool returns normally (no `context.abort()` path).
8. The v2 artifact is serialized once and saved via the captured manager (`save(json, "code-review")`) or `putBlob` fallback; a second ownership check guards before and after the save.
9. On success the tool returns the `ReviewSavedDetails` summary; the primary reads the reference and addresses submitted comments conversationally. Feedback is advisory and never grants editing/publishing permission.

## Modes / Variants
- Interactive TUI: fullscreen findings list → finding card → multiline comment editor; comments keyed by assigned finding id.
- Headless / unsupported host: fully persisted noninteractive report; findings retained, comments null.
- Clean review: `not_required` artifact with the overall recommendation and empty findings.

## Side Effects
- User-visible prompts / interactive UI
  - Opens the native findings overlay via `context.ui.custom(...)` when the host advertises `supportsCustomComponents`.
- Session state
  - Writes one artifact (`<id>.code-review.log`) through the captured `ArtifactManager`, or one blob through `sessionManager.putBlob`.
  - Registers per-call session-change/dispose callbacks; unregisters them in `finally`.
- Background work / cancellation
  - Aborts the in-flight modal await on tool abort, session change, or disposal via the combined `AbortSignal`.

## Limits & Caps
- Unknown fields rejected at both object levels (`"+": "reject"`); strings nonempty; lines integer ≥ 1 with `line_end ≥ line_start`; priorities 0–3; confidences 0–1.
- `concurrency = "exclusive"`: the overlay is a single shared TUI surface; concurrent final presentations would clobber focus.
- `loadMode = "essential"`; approval tier `read`.
- Artifacts keep the `code-review` label and schema_version 2 with no timestamps; comments for unknown ids never enter the artifact.
- The renderer tolerates partial streamed arguments and never re-opens the overlay during replay.

## Errors
- Execution in a child session (taskDepth > 0): throws `ToolError`.
- Missing session manager: throws `ToolError`.
- Tool abort / session change / disposal at any phase boundary: throws `ToolAbortError`; no report is saved or delivered into a replacement session.
- Persistence failure while still owning the session: returns `isError: true` with `ReviewSaveFailureDetails` (lossless `recoveryJson`, `meta.artifactError: "write"`); no retry.
- Modal rejection on abort is converted to `ToolAbortError`; other host errors propagate.
- Schema violations (forged ids/feedback fields, reversed ranges, invalid bounds) fail validation before execution and never open UI.

## Notes
- Sorting stabilizes UI/comment association, not semantic deduplication; dedup belongs to the review chair.
- The tool never resolves a replacement conversation's artifact manager after awaiting the overlay; an already-started disk save finishes only in the captured old manager.
- If the tool is explicitly disabled, the review chair presents findings in conversation without claiming a saved report.
