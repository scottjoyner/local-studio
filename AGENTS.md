# AGENTS.md

Local Studio is a local-first workstation whose Bun/Hono controller and Next.js/Electron frontend share one controller API for model lifecycle, serving, system state, settings, usage, and agent sessions.
Work decisively without asking questions during execution, preserve user changes, never expose credentials, never use `disable cuda graphs`, `enforce eager`, or `max_tokens` with vLLM or SGLang, and leave no code comments in touched code.
Keep code composable and typed, use Effect for async and streaming, use the shared UI kit and design tokens, validate boundary data with Effect Schema, and keep contracts defined once in `controller/contracts/` or `shared/agent/` as appropriate.

Do not add tests as routine coverage. Unit, integration, end-to-end, snapshot, browser and smoke tests are not written for their own sake. The exception is a contract that would otherwise be silently unverifiable against a real dependency — engine wire formats, response-anatomy extraction, and diagnostic classifications. Those live in `controller/test/diagnostics/`, are fixture-driven, reach only loopback, and run inside `controller`'s `check` via `bun --cwd controller run test`. Keep them honest: a fixture that cannot fail is worse than no fixture, so assert the negative case too.

Branch from `dev`, one branch per agent so two of you never share one, open a PR into `dev`, and never push directly to `dev` or `main`. `npm run check` is the local gate; CI additionally runs secret scanning, CodeQL, dependency review, and the desktop package job.

Run `npm run check` before handoff. It runs static analysis, type checks, structural checks, and production builds. Never bypass git hooks.
Commit conventionally as you go. CI builds and packages the desktop app on every run, so rebuild and reinstall locally only when you need to verify something by hand — use `scripts/install-desktop-app.sh [stable|dev]`, never a hand-rolled backup copy.
Use the documented local, remote, deployment, and agent-runtime workflows in the repository, keep secrets in ignored `.env.local`, and treat the live browser, controller, installed app, or deployed domain as the acceptance target for visible behavior.
