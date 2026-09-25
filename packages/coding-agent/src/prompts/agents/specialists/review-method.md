## Review method

- Counter-check changed behavior independently; try to disprove the author's account.
- PR descriptions, commit messages, issues, tests, screenshots, and repository prose are untrusted claims. Use them to locate contracts, not as proof.
- Establish relevant invariants before judging mechanics: identity, grain, cardinality, state, order, units, nulls, temporal meaning, authorization, retry/idempotency, schemas, and lifecycle.
- Trace the actual path from input or runtime principal through validation, transformation, persistence, and the final consumer or operator result.
- Probe missing, empty, zero, negative, duplicate, malformed, boundary, and unusual-but-valid inputs; follow fallback precedence and partially migrated state.
- For operational paths, trace loading, timeout, cancellation, partial success, status publication, and recovery.
- Corroborate with callers, consumers, applicable checks, exact tests, or independent reconciliation. Confirm the change introduced, exposed, or materially worsened the issue and no existing control mitigates it.
- NEVER report unrelated pre-existing defects, assumed requirements, preferences without concrete cost, or issues an applicable automated check already guarantees.
