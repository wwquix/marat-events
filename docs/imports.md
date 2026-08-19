# Audience imports

## Supported flow

The protected CSV flow accepts a header plus 1–5,000 data rows and a maximum file size of 2 MB. It normalizes supported fields, builds a non-authoritative preview, identifies trusted-identifier conflicts and requires explicit review before an atomic SQL commit.

Trusted identity channels are email, phone, Instagram and LinkedIn. A name match never merges records. Review actions are:

- reuse an offered canonical person;
- create a new person when no active row or current person owns the trusted identifier;
- exclude the row.

Committed imported contacts retain `consent_status=unknown` and `contactability_status=unknown`. Import provenance is not consent.

## Completeness and hosted API limits

The import preview loads rows and review records in deterministic exact-count ranges of at most 1,000. The admin UI pages the complete result in 500-row screens, so review rows through row 5,000 remain reachable. Loading fails closed on count drift, premature empty pages, total overruns or a mismatch between loaded rows and the batch's recorded row count.

The SQL commit:

- takes the audience-import advisory lock;
- locks the batch;
- rejects unresolved reviews;
- revalidates current trusted-identifier owners;
- rejects batch-wide plans that assign one trusted identifier to different owners;
- creates/reuses people, writes contacts and marks rows committed in one transaction;
- fails the committed transition unless actual row count matches the batch record and all rows are final;
- returns `already_committed` without duplicating data on a retry.

Committed batches/history, preview source fields and resolved review decisions are protected from later mutation. Review resolution and commit use the same global advisory lock before acquiring row/batch locks, eliminating their previous lock-order inversion.

## Known unresolved risks

These are production-hardening items, not theoretical guarantees:

1. Preview persistence is multiple Data API operations: batch insert, 250-row chunks, then review chunks. It is not one database transaction.
2. Failure cleanup deletes the parent batch, but the cleanup result is currently ignored. A failed cleanup could leave a partial preview batch. The SQL commit now detects the row-count mismatch and refuses to commit it, but the orphan still needs operator visibility/cleanup.
3. The full real audience has not been imported and reviewed in staging on this branch.

Before operational real-data import, move preview creation into one transactional server-side RPC (or equivalent atomic ingestion) and make cleanup failure visible to operators. SQL row-count equality, history immutability and review/commit lock serialization are already enforced and must remain covered by regression tests.

## Safe staging verification

Use invented data only:

1. Upload rows for a new person, deterministic reuse, conflicting identifiers, duplicate-in-file identifiers and an invalid record.
2. Verify the preview creates no canonical person/contact rows.
3. Navigate every UI page, including rows after 1,000 and the final row of a 5,000-row fixture.
4. Resolve candidate reuse, safe new-person and exclude paths.
5. Create a new conflicting current identity after preview and verify commit fails with zero partial canonical writes.
6. Test batch-wide ownership: reuse A + reuse B for one identifier must fail; reuse A + reuse A must remain idempotent.
7. Commit the valid batch and retry the same commit.
8. Confirm provenance and unknown consent/contactability on imported contacts.
9. Simulate an insert failure during preview and verify no orphan/partial batch remains.
10. Run a concurrent review-resolution/commit exercise and confirm the shared advisory lock serializes it without deadlock.

## Operator recovery

If preview creation reports a database error:

- do not upload the same real file repeatedly;
- check for a preview batch with the same source label/time;
- inspect its recorded row count versus actual row/review counts using read-only queries;
- discard only a confirmed preview batch through the protected UI;
- retain evidence if cleanup failed.

If commit is blocked, do not edit decisions or canonical people directly in SQL. Resolve the reported identity conflict, re-open the protected preview and retry the idempotent commit. A partial/count-mismatched batch now fails closed; quarantine it and create a fresh preview only after the root cause is fixed.
