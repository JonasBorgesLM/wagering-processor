# Releasing

1. Branch `release/vX.Y.Z` from `develop`, and set the version in `package.json`.
2. Confirm that CI passes and the mandatory suite ran on that branch.
3. Update the status lines in `README.md` and `ARCHITECTURE.md`, which must say what the code does now.
4. Open a PR into `main`. The merge needs the owner's authorization.
5. Tag `main`, then merge `main` back into `develop`.

**A pushed tag is never moved.** A bad release is fixed by the next version.

**Going public is a separate step, done by the owner** after the first release. Before it: read the history for secrets, enable private vulnerability reporting, and confirm the README status is true.

Once public, the storage schema and the HTTP and event contracts are what callers depend on, so a breaking change there needs `!` and a major version.
