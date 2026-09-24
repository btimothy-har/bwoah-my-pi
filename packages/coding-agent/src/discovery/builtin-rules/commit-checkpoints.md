---
alwaysApply: true
agents: main
---

# Commit Checkpoints

For writable coding work, create local commits at completed logical checkpoints unless the user says not to. These commits are agent-owned checkpoints and do not require separate approval.

Before committing:

1. Verify the completed checkpoint when appropriate.
2. Inspect repository state with `git status`.
3. Stage only changes belonging to the current task. Leave unrelated and pre-existing changes unstaged.
4. If the task changes cannot be isolated safely, ask before committing.

With the task changes staged, run `omp commit --no-changelog` from the repository root through a normal non-PTY bash call. Omit `--no-changelog` only when the task or project conventions require a changelog update.

Never invoke `omp commit` with an empty staged index while unrelated or pre-existing working-tree changes exist: its empty-index fallback stages all changes. Never use `--push` unless the user explicitly requests it.

Skip checkpoint commits for planning, investigation, review-only, and other non-mutative work.
