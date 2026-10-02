# Repository contract audit — 2026-10-02

Status: COMPLETE for the scope below. Static and headless verification only.

- Base: `origin/dev` at `cf3a4fbe`, branched as
  `chore/repo-contract-audit-2026-10-02`.
- Behavior preserved. No model admission rule, routing authority, provider
  fallback, engine execution semantic, recipe promotion criterion, or release
  promotion requirement was changed.
- No model was started or stopped, no controller deployed, no physical R9700
  host touched, no release published or tagged.

## Important: the branch topology found

`origin/main` and `origin/dev` have diverged into two unrelated lineages that
share no commits after their merge base `f1cc60c9` (2026-08-18).

|                             | `origin/main` (`d1abdef9`) | `origin/dev` (`cf3a4fbe`)                 |
| --------------------------- | -------------------------- | ----------------------------------------- |
| HEAD date                   | 2026-09-14                 | 2026-10-02                                |
| Commits ahead of merge base | 19                         | 150                                       |
| PR numbers                  | #427–#461                  | #1–#23                                    |
| Authors                     | `0xSero`                   | `Scott Joyner`, `opencode`, `seroxdesign` |
| Tracked files               | 952                        | 909                                       |

613 files differ. Every file the audit brief named that is absent from `dev`
exists only on `main`: `controller/src/config/request-authority.ts`,
`frontend/src/features/recipes/serve-runtime.ts`, `scripts/dev-watch.sh`,
`docs/engine-registry-plan.md`, `docs/cursor-restructure-plan.md`, and
`docs/research/`.

`dev` differs structurally in the opposite direction:
`frontend/desktop/project.mjs` is a 1954-line pre-bundled file with no generator
and no sources, whereas on `main` the same path is a 90-line dispatcher over nine
readable `frontend/desktop/automation/*.mjs` modules introduced by `c0d224bd`.

**This campaign was executed against `origin/dev`**, per the owner's direction and
`AGENTS.md` ("branch from `dev`"). Sections 3, 4, 5 and 9 therefore audit `dev`'s
actual equivalents rather than the filenames in the brief. Anyone reconciling the
two lineages should re-run the request-authority and runtime-target portions
against `main`, where those files exist.

## 1. Contract authorities

| Concern                           | Authority                                                             | Layer         |
| --------------------------------- | --------------------------------------------------------------------- | ------------- |
| Model identity (engine backends)  | `controller/contracts/system.ts` `EngineBackend`                      | controller    |
| Model identity (recipe backends)  | `controller/contracts/recipes.ts` `Backend`                           | controller    |
| Model capabilities (catalog data) | `controller/contracts/model-index.json` via `model-index.ts`          | controller    |
| Vision capability inference       | `controller/contracts/model-capabilities.ts`                          | controller    |
| Recipe serialization              | `controller/contracts/recipes.ts`                                     | controller    |
| Runtime targets                   | `controller/contracts/system.ts` `RuntimeTarget`                      | controller    |
| Runtime launch parameters         | `controller/contracts/engine-args.ts`                                 | controller    |
| Provider routing                  | `controller/src/services/provider-routing.ts`                         | controller    |
| Request authority                 | `controller/src/modules/proxy/openai-routes.ts` + `compute/bridge.ts` | controller    |
| Agent runtime API                 | `services/agent-runtime/src/http/`                                    | agent-runtime |
| Persisted configuration           | `controller/src/config/persisted-config.ts`                           | controller    |
| Frontend display state            | `frontend/src/lib/types.ts` (re-exports only)                         | frontend      |

### Duplicate authorities found

1. **`Backend` and `EngineBackend`** are the same literal union declared twice, in
   two contract files. `validate-contracts` allowlists both files, so it could not
   detect the split. **Fixed** — the gate now compares them.
2. **`ENGINE_LABEL`** was declared three times: `controller/.../runtime-targets.ts:38`,
   `frontend/src/lib/serve-runtime.ts:3`, and
   `frontend/src/features/recipes/engine-capabilities.ts:143`. **Fixed** — the gate
   now asserts all three agree.
3. **`ENGINE_META`** in `frontend/src/features/settings/runtime-targets.tsx:30` is a
   fourth display-label authority, typed `Record<string, ...>` so a new backend
   would silently render with no label. **Fixed** — typed `Record<EngineBackend, ...>`.
4. **Engine backend lists** were restated as bare literals in
   `runtime-targets.ts` `BACKENDS` and `engines-section-model.ts` `FALLBACK_ENGINES`.
   **Fixed** — both are asserted against the contract.
5. `RuntimeJobBackend` (`engine-jobs.ts:30`, `EngineBackend | "cuda" | "rocm"`) and
   `RUNTIME_JOB_BACKENDS` (`runtime-routes.ts:24`) restate the same set. Retained:
   the widened platform values are intentional and the route list is a wire
   schema. The gate now asserts no engine backend is omitted from the route list.

## 2. Model index

There is **no generation step**. `controller/contracts/model-index.json` is a
hand-maintained 756-line data file; `model-index.ts:2` re-exports it as
`bundledModelIndexSource`. Nothing in `scripts/`, `.github/`, or `project.mjs`
generates or validates it.

Classification: **HAND_MAINTAINED**, not generated. `shared/model-recommendations.json`
is the same.

Consequences, now enforced where mechanical:

- The bundled index is decoded at module scope by the frontend
  (`frontend/src/lib/api/studio.ts:59`) and per request by the controller
  (`studio/model-index.ts`), so a malformed file fails loudly at both ends.
- An operator override at `<data_dir>/model-index.json` is honored and validated,
  and wins over the bundled copy on a later `updated` date, with ties to the
  controller. Frontend and controller **cannot** disagree on model identity: both
  read the same schema and the same bundled file.
- Content staleness (a model that no longer exists on disk) is not statically
  checkable and remains a human responsibility.

## 3. Runtime-target mapping

| Concept         | Controller                    | Frontend                             | agent-runtime | Wire                               |
| --------------- | ----------------------------- | ------------------------------------ | ------------- | ---------------------------------- |
| Engine backends | `contracts/system.ts`         | `lib/types.ts` re-export             | n/a           | `RuntimeTarget.backend`            |
| Target kinds    | `RuntimeKind`                 | `ServeRuntimeKind` (+`managed_venv`) | n/a           | `RuntimeTarget.kind`               |
| Target sources  | `RuntimeTarget.source`        | not modeled                          | n/a           | `RuntimeTarget.source`             |
| Display name    | `ENGINE_LABEL`                | `ENGINE_LABEL`, `ENGINE_META`        | n/a           | `RuntimeTarget.label`              |
| Selection       | `selected_runtime_target_ids` | client-side                          | n/a           | `POST /runtime/targets/:id/select` |

No enum/value mismatch, no conflicting default, and no runtime name accepted by one
layer and rejected by another was found. `ServeRuntimeKind` adds `managed_venv`,
which maps onto a controller `venv` target — a deliberate vocabulary difference,
not drift.

`POST /runtime/targets/:targetId/select` has no in-repo caller because selection is
persisted from `selectRuntimeTarget`. It is a documented public endpoint, so it is
retained.

## 4. Request authority

No `controller/src/config/request-authority.ts` exists on `dev`; that module is
`main`-only. On `dev` the authority lives in two places:

- `compute/bridge.ts:308` `resolveInferenceTarget` — an explicitly named model
  wins; with exactly one warm instance and no name match it falls back (the
  documented single-model contract); with **more than one** warm instance it
  returns `ambiguous: true` and serves nothing.
- `proxy/openai-routes.ts:292` — `strict_openai_models` rejects an unmanaged model
  for the default provider, and `openai-routes.ts:274` returns 503
  `model_not_running` when a named model is not served by any running instance.

This campaign changed neither file, and touched nothing either file imports. No
implicit fallback was introduced, no explicit model selection bypassed, no request
redirected, no provider access widened, no unknown model admitted, and no strict
behavior relaxed. `strict_openai_models` still defaults to false and still gates
only the default provider, which is unchanged behavior.

`AGENTS.md` forbids writing test code, so no authority test was added. The
invariant is instead asserted statically by the existing `validate-contracts` gate.

## 5. Install and deploy findings

Fixed in this campaign:

- **Blank API key reused** (`scripts/install-controller.sh`). Presence of
  `LOCAL_STUDIO_API_KEY` was treated as a usable key, but `.env.example:15` ships
  it blank and copying that file is the documented first step. The installer then
  started a controller that cannot authenticate and emitted `"api_key":""`,
  which `parseDeployMarker` rejects — the desktop Deploy flow reported
  "Installer exited with code 0" on a successful install. Now reused only when
  non-empty, and a blank entry is rewritten in place so the file cannot end up
  with two values for one key. Verified for blank, populated, absent and repeated
  runs.
- **Installers were unparsed by CI.** `ci.yml` ran `bash -n` over four shell
  scripts but neither shipped installer. Added.

Found, not changed (each needs a product decision):

- Both installers and the desktop deploy default to the `sybil-solutions` org
  while the git remote is `scottjoyner`. This must be one atomic change, because
  `release.yml:80` asserts `owner: sybil-solutions` against
  `app-update.yml` and `update-manager.ts`. Fixing one file alone breaks release.
- `install-controller.sh:64` runs plain `bun install` where CI and `project.mjs`
  use `--frozen-lockfile`.
- `git pull --ff-only || log ...` swallows upgrade failure and keeps serving stale
  code while reporting success.
- Port-scoped systemd unit names leak: changing `LOCAL_STUDIO_PORT` leaves the
  previous unit enabled.
- `hostname -I` is GNU-only but reachable from the macOS branch, so the published
  controller URL can degrade to `$(hostname)` when `LOCAL_STUDIO_HOST` is
  `0.0.0.0`, which is the default.
- `.env` writes and the launchd plist are world-readable; the controller bearer
  token is written at default umask.
- `install-desktop-app.sh` `SIGTERM`s whatever listens on :3000/:8081 and detaches
  every `/Volumes/*Local Studio*`, with no PID-to-name verification.
- `services/agent-runtime/systemd/local-studio-agent-runtime.service` has
  unsubstituted `@APP_DIR@`/`@NODE@` and no installer; the runtime is actually
  forked as a child process. `README.md:206` correctly says it is not installed
  automatically. Two source comments still describe it as a live deployment path.

## 6. CI and release

- CI proves: conventional commits, shared-contract ownership and (now) engine
  contract parity, barrel/structure rules, installer and script syntax, four
  script contract self-tests, the System-One verifier harnesses, controller
  typecheck/lint/knip/jscpd/depcheck/standards, agent-runtime build plus its one
  test, the frontend quality gate including the **full production build** and
  standalone-pruning assertions, desktop packaging with `afterPack` verification,
  TruffleHog, CodeQL, and dependency review.
- `npm run check` is **not** the CI gate set. It runs `audit-layout`, which no
  workflow invokes; it omits commit-message, installer-syntax, script-contract,
  System-One, desktop-package, secret-scanning, CodeQL and dependency-review steps.
- Branch/head provenance is strong: release pins `github.event.workflow_run.head_sha`,
  all three release jobs run `assert-release-main` against live `git ls-remote`,
  artifact names embed the SHA, and `stage-release` verifies version and commit
  inside the asar and writes a sha256 manifest per asset.
- Release consumes state CI never produces: the `sign` job runs
  `npm ci --ignore-scripts` with no Bun — an install mode and job shape CI never
  reproduces — and it alone produces the `dmg`, `zip` and blockmaps, since CI only
  runs `electron-builder --dir`. Signing, notarization, stapling and
  `refreshUpdateMetadata` have no CI coverage.
- The release version is derived by `sed`-parsing `semantic-release --dry-run`
  stdout; a wording change yields an empty version and every downstream step
  silently no-ops via `if: version != ''` instead of failing.
- `release.config.cjs` has no `@semantic-release/npm` or `@semantic-release/git`, so
  no `package.json` version is ever bumped; all manifests stay at `2.1.0` while
  releases advance. `validate-package` checks that five manifests agree, and
  `shared/package.json` is intentionally excluded at `0.0.0`.
- `maintenance.yml` cannot write to source: it holds `contents: read` and calls
  only the labels API, `gh pr create`, and `gh pr edit`. It does rewrite an
  existing dev→main PR title on every run, and it opens that PR unconditionally
  weekly.
- CI pins third-party actions by mutable tag while `release.yml` pins every action
  to a full 40-character SHA. Supply-chain posture is materially weaker in CI.

## 7. Dead code

Removed (each verified as exactly one occurrence in the tree — its own
declaration — and confirmed unreachable by any dynamic loading):

| Symbol                                                                                    | Superseded by                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `getUnknownVllmExtraArgKeys`, `looksLikeNotesKey` (`controller/contracts/engine-args.ts`) | lost last caller in `51ae5a28`              |
| `isKnownVllmExtraArgKey`, `KNOWN_VLLM_EXTRA_ARG_KEYS`, `VLLM_EXPERIMENTAL_PREFIXES`       | orphaned by the above                       |
| `automationSummaryLimit`                                                                  | `MAX_SUMMARY_CHARS`, used inline            |
| `saveConnectors`                                                                          | `upsertConnectors`                          |
| `completeGoogleAuthorization`                                                             | `completeGoogleAuthorizationWithActivation` |
| `clearGoogleAuthorizationCache`                                                           | no caller                                   |
| `McpToolAnnotations`                                                                      | `McpToolInfo`                               |
| `discoverPlugins`                                                                         | `discoverPluginBundles`                     |
| `closePtySessionByOwner`                                                                  | Electron-side `closePtyByOwner`             |
| `appendSystemOneAdvisoryPrompt`                                                           | `consumeSystemOneAdvisoryPrompt`            |

Retained, with reasons:

- **`frontend/desktop/resources/pi-extensions/goal.ts`** — DEPRECATED. Its
  `goalSystemPromptSection` is a near-verbatim duplicate of
  `services/agent-runtime/src/goal-prompt.ts:51`, kept in sync by hand. It has no
  resolver and no importer, but it is inside a directory electron-builder ships
  wholesale, so removal is a packaging decision rather than a hygiene one.
- **`GET /api/bootstrap` and `GET /api/health`** (frontend route handlers) — no
  in-repo caller. Not removed: an app may be probed externally.
- **`core.healthPoll`** — reachable from the API client surface but never called.
- **`sanitizedPythonEnvironment`, `isolatedPythonModuleInvocation`,
  `SYSTEM_ONE_TRUSTED_KEYS_SCHEMA`, `SYSTEM_ONE_TRUSTED_KEY_ROLES`** — the
  `export` keyword is unused, but each is used inside its own module. Removing the
  keyword alone risks breaking a later importer for no gain.
- **Five orphaned agent-runtime test files** — `inkling-thinking-levels`,
  `plugin-resources`, `session-env-injections`, `session-paging`, `session-usage`.
  Only `system-one-signature.test.ts` runs in CI; the rest are outside the
  tsconfig `include`. All six pass locally. Not removed, because deleting tests is
  not a hygiene call this campaign should make unilaterally.
- **`ControllerRpc`** (`frontend/src/lib/api/core.ts:34`) — a hand-written stand-in
  for the inferred controller route type covering only `recipes` and `studio.rigs`.
  A silent-drift hazard rather than dead code.

Classified UNKNOWN, not deleted: the six controller `/compute/*` and
`GET /v1/models/:modelId` routes are published in `GET /api/spec`, so external
callers are unknowable from this repository.

## 8. Headless-test safety

The only test CI executes, `services/agent-runtime/test/system-one-signature.test.ts`,
uses `node:crypto`, `mkdtempSync`, and `tmpdir` only. It needs no GUI session, no
browser, no desktop app, no controller, no network provider and no accelerator.
No test in this campaign's scope starts a server or opens a socket.

The new parity checks are pure text analysis of committed files: no network, no
filesystem mutation, no process spawn, no hardware. They run in the existing
`gates` job on `ubuntu-latest` with Node only, and were run here to prove both the
pass and the failure path.

## 9. Documentation

Classified and now marked in place; research history was not rewritten.

| Document                                                               | Status                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `README.md`, `AGENTS.md`, `controller/README.md`, `frontend/README.md` | CURRENT_OPERATOR / CURRENT_DEVELOPER                 |
| `docs/r9700-ternary-bonsai2.md`                                        | CURRENT_OPERATOR (validation lane)                   |
| `docs/r9700-bonsai-registry-handoff.md`                                | CURRENT_OPERATOR                                     |
| `docs/r9700-bonsai-omarchy-package.md`                                 | CURRENT_OPERATOR                                     |
| `docs/system-one-advisory.md`                                          | CURRENT_OPERATOR reference                           |
| `docs/models-catalog.md`                                               | CURRENT_DEVELOPER (Models page UI, not catalog data) |
| `docs/session-performance.md`                                          | RESEARCH / historical ledger                         |
| `docs/realtime-mobile-contract.md`                                     | SUPERSEDED / inert                                   |

Corrected, because these are current docs stating things that are false:

- `README.md` and `controller/README.md` both diagrammed a `modules/audio` STT/TTS
  subsystem. It was deleted; `controller/src/modules` holds only `compute`,
  `engines`, `models`, `proxy`, `studio`, `system`, and no audio, transcription or
  speech route exists anywhere.
- `frontend/README.md` pointed at the deleted `src/lib/backend-config.ts`, claimed
  `/recipes` and `/discover` redirect into Configure when both redirect to
  `/models`, and listed speech under integrations.
- `AGENTS.md` named `docs/workflow.md` as the single source of truth for branches
  and releases; it was removed in `690e133e` and the guidance is now inline.

Six of the seven files in `docs/` had no inbound link. `README.md` gained a
Documentation index grouping them by status.

## 10. Validation

Run on Node 22.14.0, Bun 1.4.2, npm 10.9.2. Note `doctor()` requires Node

> =22.19.0, so `npm run setup` and therefore `npm run check` were not run as a
> single command; each gate it invokes was run directly instead.

| Gate                                                                                                                       | Result                                        |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `validate-contracts` (incl. new parity checks)                                                                             | pass — 4 backends, 3 label sites in agreement |
| `validate-structure`                                                                                                       | pass                                          |
| `audit-layout`                                                                                                             | pass — 23 tracked scripts, 3 executables      |
| `controller` typecheck / lint / knip / jscpd / depcheck / standards                                                        | pass — 0 clones, 0 findings                   |
| `agent-runtime` build + `bun test`                                                                                         | pass — 9 tests                                |
| `frontend` quality (lint, 3 typechecks, cycles, UI structure, knip, jscpd, depcheck, production build, standalone asserts) | pass                                          |
| installer `bash -n`                                                                                                        | pass                                          |
| drift detection (4 injected fault classes)                                                                                 | each correctly failed, each reverted          |

Not run, and not substitutable: physical R9700 / Ternary Bonsai 2 acceptance.
Nothing in this campaign is evidence about hardware behavior.

## 11. Recommended next cleanup

1. Reconcile the `main` / `dev` lineage split, or record deliberately that `main`
   is abandoned. Everything above is only valid for `dev`.
2. Restore readable sources for `frontend/desktop/project.mjs`, or retire the
   `automation/*.mjs` promise in `AGENTS.md`. A 1954-line bundle with no
   generator is unreviewable, and the audit added to it directly.
3. Add the parity checks for the remaining restatements: `RuntimeJobBackend` vs
   `RUNTIME_JOB_BACKENDS`, and `ServeRuntimeKind` vs `RuntimeKind`.
4. Wire `audit-layout` into a workflow so the repo's own automation-layout
   invariant is CI-verified.
5. Fail loudly when the release version parse yields empty, instead of skipping.
6. Decide the org rename as one atomic change, or drop the `sybil-solutions`
   defaults entirely.
7. Either run the five orphaned agent-runtime test files in CI or delete them.
8. Align `npm run check` with the CI gate set, or document the difference in
   `AGENTS.md`.

## Report

**Exact head SHA at time of writing:** `411adf2caf177e9d040cdf664ab6cae2ec76795c`
plus the commit adding this document.

**Changed files:** 25 across four commits —
`.github/workflows/ci.yml`, `AGENTS.md`, `README.md`, `controller/README.md`,
`controller/contracts/engine-args.ts`, `frontend/README.md`,
`frontend/desktop/project.mjs`, `frontend/src/features/settings/engines-section-model.ts`,
`frontend/src/features/settings/engines-section.tsx`,
`frontend/src/features/settings/runtime-targets.tsx`,
`scripts/install-controller.sh`, `services/agent-runtime/src/automations-store.ts`,
`services/agent-runtime/src/connectors-service.ts`,
`services/agent-runtime/src/google-account.ts`,
`services/agent-runtime/src/mcp-client.ts`,
`services/agent-runtime/src/plugin-discovery.ts`,
`services/agent-runtime/src/pty-service.ts`,
`services/agent-runtime/src/system-one-advisory.ts`, eight files under `docs/`,
and this document.

**Hardware-dependent acceptance still outstanding:** all of it. R9700 / Ternary
Bonsai 2 validation, GPU routing, live model launches, and System-One end-to-end
runs are untouched by this campaign and remain unverified.
