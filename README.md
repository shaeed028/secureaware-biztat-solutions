# SecureAware - Biztat Solutions

SecureAware is an information security policy awareness and compliance management system for Biztat Solutions, built for SLIIT IE3072 (Information Security Policy and Management). The repository is split by contribution branch while sharing the same secure foundation.

## Branches

- `main`: shared secure foundation plus all merged modules (the version to demo and deploy).
- `sanduni`: Member 2 - Policy Management, Assignment and Acknowledgement.
- `chanuka`: Member 3 - Security Training, Quiz and Assessment.
- `shaeed028`: Member 4 - Compliance dashboard and reporting.

## Run

Requires Node.js 22.13 or later. Install the pinned dependencies first; local development uses the built-in SQLite database unless `DATABASE_URL` is set.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4000`. The database is created in `data/secureaware.sqlite` on first start, with the eight Biztat policies and six training courses. Local development seeds fictional demo accounts and activity; set `SECUREAWARE_DEMO_DATA=off` to skip the sample activity. `POLICY_MIN_READ_SCALE=0.2` shortens the minimum policy reading time for live demos.

## Test

```bash
npm run build
npm test
```

## Deploy to Render

The included `render.yaml` configures a free Node web service for an academic demonstration. In Render, create a new Blueprint from this repository and apply the `secureaware` service.

The service runs the build and test commands before starting. Render supplies `PORT`, and the service binds to `0.0.0.0` in production. Free Render services use an ephemeral filesystem, so SQLite data can reset after a restart, spin-down or redeployment. Production does not seed demo users or sample activity by default. Set `SECUREAWARE_DEMO_DATA=on` only for an isolated demonstration; known seeded passwords are rejected in production when this setting is not enabled. Demo records are seeded again when a new database is created with that opt-in enabled.

## Deploy to Vercel with Supabase PostgreSQL

`vercel.json` routes every `/api/*` request through one Node Function. The frontend is served from `public/`. Vercel now requires a PostgreSQL connection and will refuse to start without it; sessions, users and progress are stored in Supabase rather than a disposable Function instance.

In Supabase, open **Connect → Transaction pooler**. In Vercel project settings, add its full connection string as a secret environment variable named `DATABASE_URL` for Production (and Preview if needed). Keep the password out of Git and chat. The pooler URL uses port `6543`; do not use the direct `db.<project-ref>.supabase.co:5432` URL for Vercel. Remove any old `SECUREAWARE_IN_MEMORY` environment variable in Vercel. Redeploy after saving environment variables. The first startup creates the schema and fictional seed records; the previous in-memory Vercel data cannot be recovered. Local development still defaults to SQLite. The `backup` and `restore` scripts are SQLite-only and are not PostgreSQL backup tools.

For this academic demo, the database connection requires encryption but does not verify the server certificate unless `SUPABASE_DB_CA_CERT` is set. For verified TLS, download the project's root certificate from **Supabase → Database Settings → SSL Configuration** and put its PEM text in the Vercel secret environment variable `SUPABASE_DB_CA_CERT` (literal line breaks or `\n` both work). Verified TLS is required when `SECUREAWARE_DEMO_DATA` is not `on`.

`SECUREAWARE_DEMO_DATA=on` is configured in `vercel.json` for the academic prototype. This enables the published fictional demo credentials; remove the setting before storing real data or opening the site to real users.

## Educational Use and Readiness

The sign-in screen warns users not to enter real learner or sensitive personal data until the institution approves the privacy, access, retention and hosting arrangements. Administrators can provision local accounts in-app; institutional identity-provider integration is not included, and the prototype is not certified for regulatory compliance. Obtain the institution's privacy, safeguarding and security review before using real learner data.

## Development Seed Accounts

These fictional accounts are seeded only outside production by default. Production seeding requires `SECUREAWARE_DEMO_DATA=on`.

| Role | Username | Password | Department |
| --- | --- | --- | --- |
| Employee | `employee.demo` | `EmployeePass!2026` | Finance |
| Employee | `dev.demo` | `DeveloperPass!2026` | Development |
| Employee | `consultant.demo` | `ConsultantPass!2026` | Consulting |
| Department Manager | `manager.demo` | `ManagerPass!2026` | Finance |
| Department Manager | `manager.consulting` | `ConsultManagerPass!2026` | Consulting |
| Security/HR Admin | `security.admin` | `AdminPass!2026` | Information Security |
| System Admin | `system.admin` | `SystemPass!2026` | IT |

## User management

Security/HR Admin and System Admin can open **Administration → User management** to search and filter accounts, create users, edit roles and departments, activate or deactivate access, and reset temporary passwords. Security/HR Admin can manage Employee and Department Manager accounts; only System Admin can manage privileged accounts or assign administrator roles. Access changes revoke the affected user's sessions, self-deactivation and removal of the last System Admin are blocked, and every administrative action is audited.

## Compliance dashboard (branch `shaeed028`)

For Department Managers (own department only) and administrators:

- Live dashboard: overall compliance (average of policy acknowledgement, training completion and quiz pass rates), a 7-point trend over 30, 60 or 90 days, an employee risk donut, a department breakdown, overdue policy and training items with *Send reminder*, and recent activity for admins.
- Reports: executive summary, policy acknowledgement, training and quiz, and employee risk review, each with a formula-safe CSV export.
- Mark all notifications as read.

Originally built on its own server with fixed figures; on `main` it is a module (`server/modules/compliance`, `public/js/compliance`) that reads the policy and training data and runs behind the same session, CSRF and role checks.

## Policy module (branch `sanduni`)

For employees (every role):

- My policies inbox with Action required, Overdue, Acknowledged and All company policies tabs, search and category filter.
- Policy reader with a table of contents, reading progress, a "What changed" callout and print/PDF.
- Acknowledgement that unlocks only after the server confirms the reader reached the end. It needs an attestation and the typed full name, and gives a printable receipt with the SHA-256 of the exact text.
- Questions to the policy owner (answers shared anonymously) and time-limited exception requests.
- Privacy notice and a downloadable personal acknowledgement record.

For reviewers: a review queue to approve or request changes. Reviewers from at least two groups (for example IT and Management) must approve, and an author can never approve their own version.

For Department Managers: team policy compliance (own department only) with *Send reminder*.

For Security/HR Admin and System Admin:

- Policy library, markdown editor with live preview, and Create new version (minor or major, with or without re-acknowledgement).
- Immutable published versions (409 on edit), version history and side-by-side or inline comparison.
- Assignments to departments, roles or users with a recipient preview; only published policies can be assigned.
- Compliance by policy, department and person, evidence table and formula-safe CSV export.
- Review calendar (ISO/IEC 27001 A 5.1), questions and exceptions queues, and a standards alignment page.

Eight researched Biztat policies are seeded, including the Acceptable Use Policy v1.0 → v1.1, a Password Policy based on NIST SP 800-63B-4, a Data Classification Policy with the current PDPA status, and a BYOD policy waiting for approval.

See [docs/POLICY_MODULE.md](docs/POLICY_MODULE.md), [docs/VIVA_NOTES_sanduni.md](docs/VIVA_NOTES_sanduni.md), [docs/TESTING.md](docs/TESTING.md) and [docs/DEMO_SCRIPT_POLICY.md](docs/DEMO_SCRIPT_POLICY.md).

## Training module (branch `chanuka`)

For learners (every role):

- Course catalogue with cover art, progress rings, status and due-date badges, search, filters and tabs.
- Course landing pages with learning objectives, cited statistics, lesson outline and quiz rules.
- Lesson reader with callouts, key takeaways, sources and an interactive exercise in every course.
- Quizzes unlocked only when the server confirms every lesson is complete. Questions are drawn at random and marked on the server, with attempt limits, a cooldown and rate limiting.
- Results with explanations and links to the lessons to revisit. The correct option is never revealed.
- Printable certificates and a privacy-preserving verification page.
- My learning dashboard with a downloadable personal training record (CSV).

For Department Managers: a team training view (own department only) with a *Send reminder* action.

For Security/HR Admin and System Admin:

- Course builder with markdown preview and a question bank. Course versions are bumped on question changes.
- Assignments with a recipient preview.
- Training Needs Matrix with automatic role-based assignment.
- Evidence reports with a formula-safe CSV export.
- Research basis page.

Security highlights:

- Identity always comes from the server-side session.
- RBAC and object-level checks run on the server.
- CSRF protection on every state change.
- Answer correctness never leaves the server.
- Parameterised SQL and a strict CSP with no `innerHTML`.
- Every action is audited with the real actor.
- 3-year data retention.

See [docs/TRAINING_MODULE.md](docs/TRAINING_MODULE.md), [docs/VIVA_NOTES_chanuka.md](docs/VIVA_NOTES_chanuka.md), [docs/TESTING.md](docs/TESTING.md) and [docs/DEMO_SCRIPT_TRAINING.md](docs/DEMO_SCRIPT_TRAINING.md).

## Architecture

```text
Browser (ES modules, hash router, DOM builder - no innerHTML)
   |  HttpOnly SameSite=Strict session cookie + X-CSRF-Token header
Node HTTP server (server/index.js)
   |  Auth, sessions, CSRF, RBAC, audit, notifications, CSV, password policy
   |  Module discovery: server/modules/<name>/index.js
Feature modules (server/modules/compliance/, policy/, training/, users/)
   |
SQLite locally (node:sqlite); Supabase PostgreSQL on Vercel (parameterised queries)
```

## ER Overview

```text
users -> sessions, audit_events, notifications
policies -> policy_versions -> policy_reviews, policy_read_events, policy_acknowledgements, policy_questions
policies -> policy_assignments, policy_exceptions
users -> lesson_progress -> training_lessons -> training_courses
users -> quiz_attempts -> quiz_answers, certificates
training_courses -> training_questions -> training_options
training_courses -> training_assignments, training_role_requirements (Training Needs Matrix)
```

## Backup and Restore

```bash
npm run backup
npm run restore -- data/backups/<backup-file>.sqlite
```
