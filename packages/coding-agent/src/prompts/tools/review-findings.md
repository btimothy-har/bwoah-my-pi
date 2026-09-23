Record the one final review after all reviewer tasks finish. The `code-review` skill (`skill://code-review`) owns the review procedure; this tool is its single reporting step — the primary calls it exactly once per review, including when zero findings survive. Reviewer subagents never call this tool.

<instruction>
- `scope` names what was reviewed (branch range, PR, commit, or working changes).
- `overall_correctness` is the verdict for the change as a whole; `explanation` justifies it briefly; `recommendation` tells the user the next step for the change.
- Each finding: `title` and `body` carry the evidence verified against the code, `recommendation` the fix direction, `priority` 0 (blocks release) to 3 (informational), `confidence` 0–1, and a 1-based inclusive `line_start`/`line_end` range in `file_path`.
- Empty `findings` is a valid clean-review result — still call, so the verdict and overall recommendation are recorded.
- The tool sorts findings deterministically and assigns ids; never supply ids or feedback fields.
</instruction>

<output>
- Interactive host: the user reviews findings in a navigator and may comment per finding. Read the returned report reference before continuing and address each submitted comment conversationally. Feedback is advisory: it never grants permission to edit, commit, or publish.
- Non-interactive host (RPC/ACP/headless): the report is saved without feedback; say so instead of claiming collected feedback.
- The user dismissing the navigator is a normal result: findings are saved, comments are discarded. Do not re-run the review.
</output>

<critical>
- Call exactly once, after synthesis — never per finding.
- Report only defects verified against the code; the chair never originates findings.
- If this tool is explicitly disabled, present the findings in conversation without claiming a saved report or collected feedback.
</critical>
