---
name: pull-request
description: "Draft and publish pull requests reviewers can act on: short, grounded in the author's intent, and backed by real evidence. Apply to any explicit request to draft, open, update, or mark ready a PR; incidental discussion of an existing PR is not enough."
---

# Pull requests

A PR says what the diff cannot: why the change exists, what a reviewer must know, and evidence that it works. Reviewers read the diff for everything else.

<critical>
- NEVER invent the reason for a change, a decision's rationale, or a validation result. Missing intent → interview the author. Missing evidence → say it was not run.
- NEVER push, create, edit, or change the ready state of a PR without explicit authorization. A bare or drafting request produces text only.
- NEVER merge, close, review, or approve. Review feedback is outside this workflow.
</critical>

## Scope

- Bare invocation, preparation, or title/body drafting → draft and present; no GitHub mutation.
- Explicit request to update an existing PR's title or body → that edit only; no pushes or state changes.
- Explicit request to create, open, or publish → draft, confirm, then follow Publish.

## 1. Gather

- **The change:** the committed branch against its merge base (`git log`, `git diff --stat`, `git diff`). Uncommitted changes are not part of the PR; ask if they belong.
- **The evidence:** checks actually run for this change — in this session or reported by the author — with their output. Run what the repository expects when nothing has been run.
- **The intent:** why this change, why now, where it came from (issue, incident, request, thread), decisions and rejected alternatives, risk, what is deliberately left out, follow-ups. Source it from the conversation, linked issues, and commit messages.
- **The template:** the repository's PR template (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/`, `docs/`, or the repository root). Present → follow it. Absent → use the default below.
- **Conventions:** title and body conventions from repository instructions, contributing guidance, and recent merged PRs.

## 2. Interview the author

Intent missing or thin → ask before drafting. Use `ask` with one batch of at most three focused questions, for example:

- What prompted this change, and why now?
- Is there anything a reviewer must know — risk, rollout order, downstream consumers?
- Is anything deliberately left out, or planned as a follow-up?

NEVER fill a gap with a plausible guess. The author declines → omit that content. No interactive channel → draft with `[author: …]` markers where intent is missing, report them, and NEVER publish a draft that still contains a marker.

## 3. Write

**Title:** follow the repository convention. None → one imperative line naming the changed artifact, plus the reason when it is not obvious.

**Body:**

- Open with where the change came from and why, in one or two sentences. NEVER restate the title.
- Describe what changed in behavior terms, grouped by concern. Leave file-level detail to the diff.
- Add only context a reviewer needs and cannot get from the diff: decisions and why, honest uncertainty, risk and rollout order, affected consumers, known gaps, follow-ups, questions for a named reviewer.
- Evidence: each check gets a one-line verdict in visible text ("0 row differences against production", "59/59 tests pass"), followed by the command and trimmed output, collapsed in `<details>` where the host renders it. Explain failures and unexpected differences. State what was not tested.

**Length:** target roughly 50–150 words of visible prose (excluding collapsed evidence). A small mechanical change needs fewer. Length follows risk and uncertainty, not diff size: spend words on decisions, gates, and evidence verdicts, never on narration.

**Voice:** plain first person, as the author. Add an AI-authorship disclosure only when repository rules require it.

**Cut:**

- Restating the diff: file lists, commit lists, line-by-line walkthroughs.
- Process narration: how the work was done, iterations, what the agent tried.
- Generic claims: "improves maintainability", "more robust", "clean implementation".
- Unbacked assurances: "verified locally", "works as expected", "no regressions" without the output.
- Template boilerplate: instruction text, empty sections, repeated "N/A". Delete what does not apply, or replace it with one line.
- Decorative structure: bold-label bullet lists, em-dash chains, arrows, extra headings on a small PR.
- Secrets, credentials, private tokens, PII, and unnecessary production data.

**Default template** (no repository template):

````markdown
## Summary

[One or two sentences: where this came from and why. Then what changed, in behavior terms.]

[Only if needed: decisions, risk, rollout order, known gaps, follow-ups.]

## Validation

[One-line verdict per check.]

<details>
<summary>[Check name]</summary>

```
[command and trimmed output]
```

</details>
````

## 4. Confirm

Present the title and body to the author. The author owns the PR; apply their edits before anything is published.

## 5. Publish

Only on an explicit publication request.

- **Destination:** the branch's push remote from Git configuration or explicit GitHub CLI evidence. NEVER select a fork parent from repository metadata or assume `origin`. Pass the resolved repository explicitly to every GitHub operation.
- **Base:** an existing PR's base, unless a change is requested. New PR → the explicitly supplied base, else the verified default branch of the destination.
- **Stop and ask** when the destination or base is ambiguous, the branch is the default branch, relevant changes are uncommitted, or publishing would rewrite remote history.
- **Confirm** the exact repository, base, head, title, and body before creating or editing, unless the author already authorized those exact values.
- **Push** only the current branch, with an ordinary push. NEVER force-push.
- **Existing PR** → update it instead of creating a duplicate; preserve its draft/ready state. Edit title/body with `gh pr edit --repo <resolved>`.
- **New PR** → `github` `pr_create` with `draft: true`.
- **CI:** watch with `github` `run_watch`. Report failures with the evidence; fix them only within the authorized scope.
- **Ready:** only on an explicit interactive choice, recommending leaving it as a draft. No interactive channel → leave it as a draft and report that marking ready needs confirmation. Mark ready with `gh pr ready --repo <resolved>`.

Report: PR URL and state, branch and base, whether anything was pushed, checks run with results, and open questions.

<critical>
- NEVER invent intent or evidence; interview the author or state what was not run.
- NEVER publish, push, edit, or mark ready without explicit authorization.
- NEVER merge, close, review, or approve.
</critical>
