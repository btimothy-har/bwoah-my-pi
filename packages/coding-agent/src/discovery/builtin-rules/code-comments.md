---
alwaysApply: true
---

# Code Comments

Comments explain context that code cannot express. If naming and structure can make the intent clear, prefer clearer code over a comment.

- Never comment what the code already states.
- Never use comments as visual section dividers. Extract a smaller function or module instead.
- Comment why an approach, ordering constraint, workaround, or business rule is necessary only when that reason is not evident from the code. Include a reference for known bugs or external limitations.
- Keep docstrings concise and nonredundant. Omit internal or private docstrings when the signature is self-explanatory.
