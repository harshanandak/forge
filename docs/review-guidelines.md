# Review guidelines

These findings recurred on at least 2 PRs; check every diff against them.

1. Keep absolute install, checkout, user, and device paths out of errors, reports, logs, and serialized diagnostics; normalize spellings and redact the full path including spaces and punctuation.
   Bad: embed the raw install root in an `unavailable()` reason.
   Safe: scrub raw and normalized roots with `[install path]`.
2. Validate the canonical filesystem object you will use, then use that same object or handle; fail closed or report incomplete when mutation, rotation, or deletion can intervene.
   Bad: check one path spelling then open a re-resolved spelling.
   Safe: open once through a no-follow validated helper and reuse the handle.
3. Redact full sensitive spans before broader destructive substitutions, then verify after normalization; never let a partial match consume a secret introducer or hide an adjacent secret.
   Bad: replace paths first, then run label redaction on the damaged text.
   Safe: collect secret and path spans first, then mask without overlap.
4. Never treat a broad pre-await read as authority after an await: capture exact IDs before async work, or re-read inside the serialization gate. Never make a terminal decision from a write that is still pending; settle it, or wait in the gate.
   Bad: post text, then mark every owed reply as answered.
   Safe: capture owed IDs first, then mark only those IDs when confirmed.
5. In a check that needs git metadata, a missing `.git` or a failed git probe is INCOMPLETE or FAIL, never PASS. In a source checkout, never turn a failed git probe into a clean identity such as `unknown`.
   Bad: report PASS from a lint run on a copy without `.git`, or catch a failed `git rev-parse` in a checkout and return `unknown`.
   Safe: return INCOMPLETE when the check needs metadata that is missing, and throw with the probe output when a checkout probe fails.
6. Classify a local persistence failure separately from the remote write outcome; once delivery or commit may have happened, preserve the outcome and return the committed identifier or receipt with a precise persistence warning.
   Bad: report `CHAT_UNAVAILABLE` with no item ID after the journal write fails.
   Safe: return the receipt with the item ID plus a persistence warning.
7. Never make a change pass by exempting the artifact, file, or case it introduces; satisfy the invariant, narrow the exception to a pre-existing reviewed case, or change the invariant openly in its own reviewed change.
   Bad: add a new file alongside an exemption for that same file.
   Safe: keep the change within the guard and leave the guard unchanged.

Evidence: see issue forge-1971.
