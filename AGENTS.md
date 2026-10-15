# AGENTS.md · LabPilot

Read this before changing anything. Each rule exists because the mistake it prevents is easy to make and easy to miss in review.

## Rules
- Tenant data is always filtered by `tenant_id` from the authenticated user. Never from the body, query string or route.
- Learner-owned records (sessions, credentials) also check ownership. Missing, other-tenant and not-yours all return the same 404.
- Request bodies go through `validate(shape)`. Unknown fields are rejected, so a client can never set `tenantId` or `role`.
- Errors are `application/problem+json` via `HttpError(status, code, detail)`. Codes are stable snake_case; the UI branches on them.
- Credits only move through `credit_ledger` rows. Never store a balance column.
- Secrets live in `vault_secrets`; other tables keep a `secret_ref`. Credential reads are audited and sent with `Cache-Control: no-store`.
- SQL is parameterised. String-built SQL fails review.
- Server code reads time from the injected `clock`, never `Date.now()`, so tests can move time.
- UI markup uses the `html` tagged template, which escapes by default. Any `raw()` needs a comment saying why it is safe.

## Definition of done
1. Every acceptance criterion in the spec maps to a test id.
2. The new test fails before the change and passes after it.
3. A new guard gets a matching entry in `FAULTS`, and the mutation check stays at 100%.
4. Migrations are additive and numbered. Never edit an applied one.
5. The PR says what changed, why, how it was tested, and how to roll it back.

## Working in parallel
- One spec per branch and worktree: `git worktree add ../lp-SPEC-014 -b spec/SPEC-014`
- Agents edit only the files listed in the spec's "Files in scope".
- One spec at a time owns the migrations in `core.js`.

## When an agent repeats a mistake
Add a one-line rule above, with the reason.

## Commands
- `npm ci` installs sql.js and Playwright.
- `npm run build` bundles `src/` into `docs/index.html`. Commit the result; CI fails if it is stale.
- `npm test` runs the suite in Node and checks that every fault is caught.
- `npm run e2e` walks every role in Chromium; `npm run test:csp` boots under a strict CSP.
