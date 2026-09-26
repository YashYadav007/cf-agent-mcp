# Codeforces controller MCP

TypeScript controller for an explicitly authorized Codeforces AI/test-account experiment, exposed to ChatGPT Work through Streamable HTTP. The controller reads contests/statements and the configured account's official profile, manages one account session, registers that account for an eligible Div.1 contest, submits supplied Java 17 source, and tracks verdicts. It does not solve problems, call an LLM/OpenAI/ChatGPT API, watch contests, schedule submissions, or fetch submitted source code.

## Local installation

Node.js **22 or later** is required. Install the locked dependencies and matching Chromium:

```bash
cp .env.example .env
npm ci
npm run browsers:install
npm run typecheck
npm test
npm run build
npm start
```

On Linux outside Docker, install Chromium system dependencies with `npx playwright install --with-deps chromium`. This may require administrator access. `npm run dev` runs the server with TypeScript watch mode. The normal service always launches Chromium headlessly, only when a browser action is needed. Manual session creation uses locally installed stable Google Chrome outside Playwright.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Develop with reloads |
| `npm run typecheck` | Check source, scripts, and tests |
| `npm test` | Unit and HTTP integration tests with mocked upstream behavior; no real registration or submissions |
| `npm run test:browser` | Offline Chromium integration with a mocked submission form; requires installed Chromium |
| `npm run build` | Compile runtime code into `dist/` |
| `npm start` | Run the compiled service |
| `npm run browsers:install` | Install this Playwright version's Chromium |
| `npm run session:create` | Launch normal Chrome with the dedicated Codeforces profile and local CDP port |
| `npm run session:export` | Attach to the already authenticated Chrome session and export storage state |
| `npm run contest:status -- 2269` | Read official registration status without a registration click |
| `npm run account:profile` | Read the configured account's latest official rating/profile |
| `npm run contest:eligible -- 2268` | Read Div.1 policy, official profile, and registration eligibility |
| `npm run contest:register -- 2268` | Attempt one real eligible Div.1 registration and confirm it |

The default listener is `http://127.0.0.1:3000`.

```bash
curl -s http://127.0.0.1:3000/health
# {"status":"ok","service":"cf-agent-mcp"}
```

Health is local liveness only: it does not start Chromium, log in, or contact Codeforces.

## Configuration

Load environment variables through `.env` locally or through the deployment secret manager.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CF_HANDLE` | unset | Experiment account handle. Used to filter API history and verify the browser account. Recommended even with storage state. |
| `CF_PASSWORD` | unset | Codeforces login password; used only when CDP and storage state are absent. |
| `CF_STORAGE_STATE_B64` | unset | Base64-encoded Playwright storage-state JSON; preferred for headless deployment. |
| `CF_BROWSER_CDP_URL` | unset | Optional local loopback CDP endpoint, such as `http://127.0.0.1:9222`. Attaches to the dedicated Chrome profile instead of launching Chromium; takes priority over storage state for browser operations. Leave unset on Cloud Run. |
| `DATA_DIR` | `./data` | Local development metadata directory; Cloud Run uses Supabase. |
| `HOST` | `127.0.0.1` | Listener address. |
| `PORT` | `3000` local, `8080` in production | Listener port; Cloud Run sets `PORT`. |
| `CODEFORCES_TIMEOUT_MS` | `15000` | Per-attempt API/HTTP timeout; range 1000–60000. |
| `ALLOWED_HOSTS` | local SDK defaults | Comma-separated hostnames without ports; required when binding beyond loopback. |
| `SUPABASE_URL` | unset | Supabase project URL; remote mode also needs a server-side key. |
| `SUPABASE_SECRET_KEY` | unset | Preferred server-only `sb_secret_` key; inject through Secret Manager. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Legacy server-only alternative to `SUPABASE_SECRET_KEY`. |
| `AUTH_MODE` | `disabled` | `disabled` on loopback only, `oauth` for remote service. |
| `MCP_AUTH_ISSUER` | unset | HTTPS OAuth issuer URL. |
| `MCP_AUTH_AUDIENCE` | unset | JWT audience expected from the chosen OAuth provider. |
| `MCP_RESOURCE_URL` | unset | Canonical public HTTPS `/mcp` URL used in protected-resource metadata and challenges. |
| `MCP_AUTH_JWKS_URL` | unset | HTTPS JWKS URL for token signature verification. |
| `ALLOW_REAL_SUBMISSIONS` | `false` | Server-only real submission kill switch. |
| `ALLOW_LOCAL_UNAUTHENTICATED_SUBMISSIONS` | `false` | Explicit loopback-only override; also requires real submissions enabled. |
| `CF_ALLOWED_CONTEST_IDS` | unset | Optional extra static restriction. When set, the contest must also have active Supabase authorization. |
| `CF_EXPECTED_HANDLE` | unset | Experiment account handle; required for remote real submissions. |
| `CF_DUPLICATE_WINDOW_SECONDS` | `120` | Identical source retry window, 1–3600 seconds. |

Remote MCP mode requires OAuth, an explicit `ALLOWED_HOSTS` list, and Supabase configuration. The chosen OAuth provider must issue signed JWT access tokens with the configured audience and `cf.read`/`cf.submit` scopes. This repository is the resource server and does not issue tokens or implement an authorization server. Configure a provider that supports OAuth 2.1 authorization-code with PKCE and dynamic client registration or pre-register ChatGPT Work as required by that provider. `/.well-known/oauth-protected-resource/mcp` advertises the authorization server; `/mcp` returns HTTP Bearer challenges and an MCP tool error result containing `_meta["mcp/www_authenticate"]` for missing/insufficient scopes. `tools/list` remains available for discovery and declares the scope on each tool. Read tool calls require `cf.read`; `register_contest` and `submit_solution` require `cf.submit`. `submit_solution` also requires the server safety switch and active Supabase contest authorization. Supabase is used only for storage here. This verifier does not assume Supabase Auth supports these custom scopes. A future Supabase Auth integration would need an explicit permission-claim mapping and server-side enforcement, for example a `cf_permissions` claim inserted by a Custom Access Token Hook.

The pinned MCP SDK release does not accept `securitySchemes` in `registerTool`. Tool registrations include the compatibility `_meta.securitySchemes` mirror; the finite `tools/list` response adds the standard top-level `securitySchemes` field. The HTTP integration test checks both representations.

No passwords, cookies, CSRF tokens, storage state, auth headers, or source text are logged or included in health/tool errors. Logs record tool names, contest/problem IDs, submission IDs, verdicts, and sanitized error codes. Source logging is disabled; there is no source-logging option.

## Codeforces authentication

A singleton Chromium connection/context is reused. Browser operations are serialized, with 10-second action and 30-second navigation timeouts. Safe GET navigation has at most two attempts and at least one second between starts. A submission click is never retried.

Authentication priority:

1. If local `CF_BROWSER_CDP_URL` is set, attach to the already-running dedicated Chrome over loopback CDP, reuse its existing context/profile, and verify the logged-in handle. No browser launch, storage-state context, or automatic credential login occurs in this mode. Pages created for operations are closed; the user's Chrome and existing tabs remain open.
2. Otherwise, if `CF_STORAGE_STATE_B64` is set, decode and validate it, initialize the context with it, and verify that the Codeforces header shows a logged-in account.
3. Otherwise, if both `CF_HANDLE` and `CF_PASSWORD` exist, attempt credential login once in that context and verify the resulting session.
4. Otherwise remain unauthenticated. Authenticated actions return `CF_AUTH_REQUIRED`.

An invalid/expired storage state does **not** silently fall back to a password login. An account that differs from `CF_HANDLE` is rejected. Correct the configuration or create a new manual session and restart. A failed credential login is not repeatedly posted; restart after correcting credentials or use a manual session.

CAPTCHA, Turnstile, and interactive verification are never solved or bypassed. Authenticated actions and browser statement fetches return `SESSION_REQUIRES_MANUAL_LOGIN`. `session_status` returns `authenticated:false` with a safe explanatory message. A storage state can expire or be invalidated by Codeforces; authentication is checked again before submitting.

### Generate storage state safely

Run on a local machine with stable Google Chrome and a graphical desktop:

```bash
npm run session:create
# Log in and complete any CAPTCHA manually in the opened Chrome window.
# Once a normal authenticated Codeforces page is visible, in another terminal:
npm run session:export
```

The first command launches the operating system's stable Google Chrome directly with `.auth/codeforces-chrome-profile`, `--remote-debugging-address=127.0.0.1`, and `--remote-debugging-port=9222`. Playwright does not launch or control login. Complete login and any verification yourself. The second command asks for your confirmation, attaches over localhost CDP, reads an already open Codeforces page to verify the handle (including `CF_EXPECTED_HANDLE` when set), and atomically saves `.auth/storage-state.json` with permissions `0600`. It does not navigate, submit credentials, retry a challenge, or close Chrome. If CDP is unavailable, run the first command again. Neither command prints session contents.

Load the value into your shell without displaying it:

```bash
set +x
export CF_STORAGE_STATE_B64="$(node -e 'process.stdout.write(require("node:fs").readFileSync(".auth/storage-state.json").toString("base64"))')"
npm start
```

Upload the value through your platform's secret manager if deploying. Base64 is encoding, not encryption. Do not paste the value into chat, logs, issue reports, or source control. `.env*`, `.auth/`, storage-state/cookie JSON, and generated data are ignored by Git and the Docker build context. Restart the service to apply changed credentials or storage state. The service does not rewrite your supplied storage-state secret.

## MCP transport and tool calls

`POST /mcp` uses the official MCP TypeScript SDK's stateless Streamable HTTP handler. `/mcp` delegates other supported MCP HTTP methods to the SDK. Separate HTTP requests share the process's browser context, API limiter, and submission store. Tool outputs use `structuredContent`; a short text block accompanies successful results. Arrays are wrapped in `{contests:[...]}` or `{problems:[...]}`. Missing upstream values are `null`.

List tools locally:

```bash
curl -N http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Use this envelope for a tool invocation:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"session_status","arguments":{}}}
```

In OAuth mode, use a scoped access token in `Authorization: Bearer <token>`. Do not enable shell tracing. Examples below show the `arguments` and successful `structuredContent`; IDs and results are illustrative.

### session_status

Input: `{}`

```json
{"authenticated":true,"handle":"exampleHandle","method":"storage_state","message":"Authenticated Codeforces session is available."}
```

`method` is `cdp`, `storage_state`, `credentials`, or `none`, including the configured method when authentication failed. No credentials are returned.

### get_contests

Input: `{"gym":false}` (`gym` is optional).

```json
{"contests":[{"id":1234,"name":"Example contest","type":"CF","phase":"BEFORE","frozen":false,"durationSeconds":7200,"startTimeSeconds":1790294400,"relativeTimeSeconds":-600}]}
```

Uses `contest.list`. Upcoming contests appear first in ascending start-time order; other contests follow in descending start-time order.

### get_contest_problems

Input: `{"contestId":4}`

```json
{"problems":[{"contestId":4,"index":"A","name":"Watermelon","type":"PROGRAMMING","points":null,"rating":800,"tags":["brute force","math"]}]}
```

Uses the official `contest.standings` problem list. Unreleased/private problems and Gym standings requiring API authentication can remain inaccessible; browser login does not authenticate official API requests.

### get_problem

Input: `{"contestId":4,"index":"A"}`

```json
{"contestId":4,"index":"A","name":"Watermelon","timeLimit":"1 second","memoryLimit":"64 megabytes","statement":"Clean statement text ...","input":"Input specification ...","output":"Output specification ...","examples":[{"input":"8","output":"YES"}],"note":"Problem note ..."}
```

First tries lightweight HTTP at the official problemset URL, then the contest URL. HTTP errors (including 401/403), verification HTML, missing containers, incomplete content, and parser failures trigger the Playwright fallback after both URLs fail. IDs of 100000 and above use the Gym route. It parses only the statement container, preserving readable TeX, entities, meaningful line breaks, and sample whitespace, while excluding navigation, scripts, sidebars, and footer. MathJax's non-executable original TeX is preserved. There is no OCR; image-only diagrams are represented by their alt text or `[diagram]`, and attachment-only statements are not converted. If both official public URLs are blocked by manual verification, the tool returns `CF_PAGE_FETCH_FAILED`; it never bypasses the challenge.

### get_account_profile

Input: `{}`. This read-only tool requires OAuth `cf.read` and calls the official `user.info` API for the configured experiment account on each invocation. Unrated accounts return `rating:null`; no manually maintained rating is used.

```json
{"handle":"exampleHandle","rating":1900,"maxRating":1950,"rank":"candidate master","maxRank":"candidate master"}
```

Local read-only command:

```bash
npm run account:profile
```

### register_contest

Input schema: `{"contestId":2268}` (positive safe integer; no other fields). This write tool requires OAuth `cf.submit` on `/mcp`. Only upcoming regular Div.1 contests pass the experiment policy. A successful result is:

```json
{"registered":true,"alreadyRegistered":false,"contestId":2268,"handle":"exampleHandle"}
```

If Codeforces already shows the authenticated account as registered, it returns the same result with `alreadyRegistered:true` and makes no registration click. The service checks official `contest.list` metadata, rejects non-Div.1 contests before mutation, verifies `CF_EXPECTED_HANDLE` and/or `CF_HANDLE`, and discovers the registration href by its exact contest ID. It checks `/contests` and an officially linked combined page such as `/contests/2268,2269`, then follows the complete discovered href, including `backUrl` and other query parameters. The link text is not used for selection. If no Register link exists, the canonical registration page is used only for a read-only status check; registration refuses to click. Gym, team, and unofficial registration are unsupported. An unfamiliar form returns `REGISTRATION_FORM_UNAVAILABLE` without clicking. A successful click is confirmed through fresh official page reads. It never changes Supabase `authorized_contests`; the watcher or operator must authorize the contest separately before `submit_solution` can run.

The read-only server-side status command reports `registered`, `not_registered`, `registration_not_open`, `registration_closed`, `verification_required`, `rating_ineligible`, or `unknown`. A Codeforces rating rejection includes its displayed reason. An ordinary redirect or HTTP denial without challenge evidence is `unknown`, not `verification_required`:

```bash
npm run contest:status -- 2269
# Example: {"contestId":2269,"handle":"exampleHandle","status":"not_registered"}
```

The registration command performs a real Codeforces action. Invoke it only for the authorized experiment account and an upcoming Div.1 contest:

```bash
npm run contest:register -- 2268
```

To reuse the dedicated visible Chrome session locally, first run `npm run session:create` and finish login manually. Leave Chrome open, then run:

```bash
CF_BROWSER_CDP_URL=http://127.0.0.1:9222 npm run contest:status -- 2269
CF_BROWSER_CDP_URL=http://127.0.0.1:9222 npm run contest:register -- 2268
```

`contest:status` only navigates and reads. `contest:register` is a real Codeforces action; use it only when you intend to register. If Chrome presents verification, complete it manually in the visible browser and run the read-only status command again. The CLI never closes the user's Chrome. Without `CF_BROWSER_CDP_URL`, both commands retain the headless/storage-state behavior used in deployment.

The command and MCP tool use the same service. Before a click, a verification challenge yields `SESSION_REQUIRES_MANUAL_LOGIN`; a Codeforces rating rejection yields `CONTEST_REGISTRATION_INELIGIBLE`; a non-Div.1 contest yields `CONTEST_DIVISION_NOT_ALLOWED`. Each prevents mutation. After a click, a timeout, challenge, or unconfirmed page yields `REGISTRATION_RESULT_UNCERTAIN`; the click is never retried automatically. Use `contest:status` before any later explicit attempt. Other preflight errors include `CONTEST_NOT_FOUND`, `CONTEST_ALREADY_FINISHED`, `REGISTRATION_NOT_OPEN`, `REGISTRATION_CLOSED`, `CF_AUTH_REQUIRED`, and `ACCOUNT_MISMATCH`. Registration is independent of `ALLOW_REAL_SUBMISSIONS`, which remains the submission kill switch. No contest watcher or automatic registration schedule exists in this repository.

### Div.1 eligibility and four-problem run state

`npm run contest:eligible -- 2268` is read-only. It refreshes the configured account through official `user.info`, checks official contest metadata for an upcoming regular Div.1 round, then checks Codeforces registration status. Local rating is informational: Codeforces' displayed eligibility decision takes precedence. The pure selector rejects Div.2/3/4, Educational, nonregular, and nonupcoming contests. It chooses contest 2268, never sibling 2269, for the combined Round 1124 example. The command does not register or authorize a contest.

`src/contest/run.ts` defines server-side primitives for a future external watcher/Work workflow. It takes the first four distinct official problem indices in order (normally A, B, C, D), never starts a fifth, counts corrections to A as attempts on the same distinct problem, and advances only after an `OK` verdict. Each problem carries a persisted target window: A 10–25, B 30–50, C 55–80, D 85–110 minutes from contest start. These are scheduling targets for an external scheduler; the MCP never waits through a window or schedules a submission.

`cf_contest_runs` stores the run status, problem order, current problem, distinct indices started/completed, attempt counts, verdicts, target windows, timestamps, and a version for conflict detection. Apply `supabase/migrations/20260926142854_cf_contest_runs.sql` before using this optional server-side store. It is accessible only with the server-side Supabase key; there is no public MCP run-state mutation tool. The future watcher still owns the sequence: refresh profile, check registration, register once if eligible, explicitly authorize the contest in `authorized_contests`, use an external start trigger, and mark both run and authorization complete afterward. This phase adds no watcher or Work trigger.

### submit_solution — Java 17 only

Input:

```json
{"contestId":1234,"problemIndex":"A","sourceCode":"<your final locally validated Java 17 source>"}
```

Output:

```json
{"submissionId":123456789,"contestId":1234,"problemIndex":"A","language":"java17","submitted":true,"submittedAt":"2026-09-25T12:00:00.000Z"}
```

This is a real external action. Do not use it as a health check or test call. `ALLOW_REAL_SUBMISSIONS=false` blocks it first. When enabled, contest authorization requires an active, unexpired row in Supabase `authorized_contests`; an optional `CF_ALLOWED_CONTEST_IDS` must also include the contest if configured. Missing/inactive/expired rows return `CONTEST_NOT_AUTHORIZED`; a static mismatch returns `CONTEST_NOT_IN_STATIC_ALLOWLIST`. Authorization is checked again immediately before the single submit click. No `language` argument is accepted; unknown arguments are rejected. The controller reads the form's language options and selects a unique enabled Java/OpenJDK **17** label, using that option's current value. No Codeforces numeric language ID is hard-coded. Missing or ambiguous options produce `JAVA17_NOT_AVAILABLE`.

The source is opaque: only nonempty/class/UTF-8-size checks (maximum 256 KiB) and CRLF/CR-to-LF normalization are applied. No compiling, algorithm rewriting, refactoring, or solving happens in this service.

The flow verifies login, captures existing IDs from the account's **own** contest submissions page, selects the problem and Java 17, fills the editor, persists an attempt record, and clicks Submit **once**. A per-page guard also blocks a second POST to the submission form. It checks the own-submissions table for one new ID with the same contest, problem, and Java 17 language. It does not open submission/source links. Run one controller process for this experiment account, and avoid concurrent submissions from other sessions; otherwise a unique new row may be ambiguous.

After the click begins, any network, capture, or persistence failure becomes `SUBMISSION_STATE_UNCERTAIN` with `retryable:false`. If the ID was observed, the error includes that ID and contest in its safe message. Inspect the account's own submissions page and local `DATA_DIR/attempt-*.json` or Supabase attempt metadata, then use `get_submission_verdict` with the ID and contest. Do not repeat `submit_solution` automatically. Identical contest/problem/source requests within `CF_DUPLICATE_WINDOW_SECONDS` are rejected. Distinct explicit invocations remain separate real attempts. The service never automatically retries a click.

### get_submission_verdict

Input: `{"submissionId":123456789,"contestId":1234}` (`contestId` is optional).

```json
{"id":123456789,"contestId":1234,"problemIndex":"A","programmingLanguage":"Java 17 64bit","verdict":"TESTING","passedTestCount":2,"timeConsumedMillis":31,"memoryConsumedBytes":102400}
```

Looks up local metadata first, checks any supplied contest for consistency, and prefers `contest.status` filtered by `CF_HANDLE` (or the verified session handle). Without a known contest, it uses `user.status` for that handle. It can also fall back to that user's history if the contest endpoint rejects access. An explicit contest allows public lookup even if no handle is configured. Only API metadata is fetched, never source code. There is no global latest-1000 dependency.

History searches page through at most 10,000 records with a 30-second overall budget and stop early once IDs pass the target. For older/inaccessible IDs, provide the correct contest and handle; failure is a structured `SUBMISSION_NOT_FOUND` or `CF_API_ERROR`. Configure `CF_HANDLE`, or call `session_status` first, when using storage state without an explicit handle. This tool reads the current record once; it does not wait for a final verdict.

### wait_for_verdict

Input: `{"submissionId":123456789,"contestId":1234,"timeoutSeconds":60}`. Default timeout is 60 seconds; valid range is 1–120.

```json
{"final":true,"timedOut":false,"submission":{"id":123456789,"contestId":1234,"problemIndex":"A","programmingLanguage":"Java 17 64bit","verdict":"OK","passedTestCount":30,"timeConsumedMillis":62,"memoryConsumedBytes":204800}}
```

Polls every four seconds after the preceding lookup, using the shared official API limiter. `TESTING`, `SUBMITTED`, missing verdicts, and unknown statuses are nonfinal. Known terminal verdicts (including rejected outcomes) stop polling. On deadline it returns `final:false,timedOut:true` and the last known record. If no record became visible, fields are `null` except the ID and any known local contest/problem fields. The deadline cancels API calls, backoff, and rate-limiter waits. It never resubmits.

### Errors and rate limits

Application failures return `isError:true` with:

```json
{"error":{"code":"SESSION_REQUIRES_MANUAL_LOGIN","message":"Codeforces requires manual authentication/verification.","retryable":false}}
```

Other codes include `CF_API_ERROR`, `CF_RATE_LIMITED`, `CF_PAGE_FETCH_FAILED`, `CF_AUTH_REQUIRED`, `SESSION_EXPIRED`, `PROBLEM_NOT_FOUND`, `JAVA17_NOT_AVAILABLE`, `SUBMISSION_FAILED`, `SUBMISSION_STATE_UNCERTAIN`, `SUBMISSION_NOT_FOUND`, `INVALID_INPUT`, `STORAGE_ERROR`, and `BROWSER_UNAVAILABLE`. The SDK rejects schema-invalid inputs before invoking tools. Polling timeouts are ordinary results (`timedOut:true`), not submission errors.

All official API attempts share a process-wide limiter with at least two seconds between starts. Safe GET calls have at most three attempts, bounded timeouts, and backoff respecting Retry-After. Long upstream delays are returned to the caller rather than retried early. Browser GET navigation is paced separately. No login/submission POST is automatically retried. Run a single replica; multiple replicas would need a shared account lock, database, and distributed rate limiter.

## Submission metadata

`DATA_DIR/submissions.json` contains only:

```json
[{"submissionId":123456789,"contestId":1234,"problemIndex":"A","language":"java17","submittedAt":"2026-09-25T12:00:00.000Z"}]
```

Writes use serialized read-modify-write, a synced temporary file, and atomic rename with `0600` file permissions. Nonexistent/empty storage works; malformed existing data is reported rather than erased. Separate `attempt-<uuid>.json` files record `prepared`, `confirmed`, or `uncertain` attempts without source or session material. A crash can leave `prepared` even if the upstream submission happened; reconcile manually before another invocation. There is no automatic attempt recovery/resubmission.

`SubmissionStore` has `FileSubmissionStore` for local metadata and `SupabaseSubmissionStore` for persistent metadata and contest authorization. Configure `SUPABASE_URL` with `SUPABASE_SECRET_KEY` (preferred) or the legacy `SUPABASE_SERVICE_ROLE_KEY` to select Supabase; remote binding requires a server-side key. A URL alone is allowed locally and uses file storage. A `sb_publishable_` key is rejected for private access. Apply both SQL migrations in `supabase/migrations/` before enabling writes. They create metadata, attempt, and `authorized_contests` tables, enable RLS, revoke anonymous/authenticated access, and grant only service-role access. They store no source code, passwords, cookies, or CSRF tokens. A database function uses a transaction lock to reserve a fingerprint within the duplicate window. Local files are ephemeral on Cloud Run and are never the production source of truth. The local file store never authorizes a real contest, so local submission tests must use mocked authorization or a configured Supabase store.

### Dynamic contest authorization

`authorized_contests` contains `contest_id`, `status` (`active`, `completed`, `blocked`), `authorized_at`, optional `expires_at`, `source`, and timestamps. A contest is authorized only while its row is `active` and its expiry is absent or in the future. A missing row, completed row, blocked row, or expired row blocks `submit_solution`. If the Supabase query fails, the storage error blocks submission. `ALLOW_REAL_SUBMISSIONS` remains the global kill switch. An unset `CF_ALLOWED_CONTEST_IDS` does not restrict an active database contest; a configured list adds an extra restriction. There is no MCP tool to authorize contests.

The following server-side commands use the Supabase secret from the local ignored `.env` (or inherited environment). They change only the authorization table and never submit to Codeforces:

```bash
npm run contest:authorize -- 4
npm run contest:complete -- 4
npm run contest:block -- 4
```

To set an expiry, pass a future ISO timestamp after the ID, for example `npm run contest:authorize -- 4 2026-10-01T00:00:00Z`. The script marks its changes with `source=manual`; a future watcher can call the same store methods with its own source. Run the migration before using these commands. Keep the server-only key out of shell history, logs, and client applications.

## Submission pacing policy

The experiment is 120 minutes and targets four Accepted problems. The pure helpers in `src/pacing/policy.ts` expose:

| Slot | Window from contest start |
| --- | --- |
| 1 | 10–25 minutes |
| 2 | 30–50 minutes |
| 3 | 55–80 minutes |
| 4 | 85–110 minutes |

`getSubmissionWindow(slot)` returns a window. `evaluateSubmissionTiming({contestStartTime,slot,now})` accepts Dates, ISO strings, or epoch **milliseconds**. Multiply a Codeforces `startTimeSeconds` value by 1000 first.

```ts
evaluateSubmissionTiming({
  contestStartTime: '2026-09-25T12:00:00Z',
  slot: 1,
  now: '2026-09-25T12:05:00Z'
});
// { allowedNow:false, windowStart:'2026-09-25T12:10:00.000Z',
//   windowEnd:'2026-09-25T12:25:00.000Z', waitMilliseconds:300000,
//   status:'BEFORE_WINDOW' }
```

Before the window, future orchestration may schedule later. Inside the inclusive window, submission is allowed immediately. After the window, `allowedNow:true`, `waitMilliseconds:0`, and `AFTER_WINDOW` prioritize correctness without adding delay. These helpers do not schedule, sleep, keep MCP calls open, or enforce timing inside `submit_solution`.

Prefer one real submission per problem. The future solver must compile and test samples locally first. A later orchestration layer may decide whether a rejected submission merits another attempt; this controller never fixes or resubmits automatically. Every real attempt requires a distinct explicit `submit_solution` invocation, so four successful first attempts can produce exactly four submissions.

## Agent solution-generation policy

This policy is for the future ChatGPT Work solving agent. It is not a server-side transformation.

All solutions must use **Java 17**. For each problem, the solving agent must:

1. Derive the algorithm independently from the problem statement.
2. Never inspect, fetch, imitate, copy, transform, or use other contestants' submitted source code.
3. Produce a correct initial implementation.
4. Perform one clean refactoring pass before final validation.
5. Compile and run the provided samples locally.
6. Submit only the final validated implementation.

The refactoring pass must preserve the algorithm and complexity, keep normal competitive-programming Java simple, remove dead code and unnecessary abstraction, avoid excessive comments, use helper methods only where useful, use concise but understandable variable names, and avoid fixed unnecessary boilerplate. It must not perform meaningless or random transformations. Its purpose is independent, maintainable generation, not imitation of other contestants.

## Google Cloud Run deployment

The image uses the official Playwright Node image `mcr.microsoft.com/playwright:v1.63.0-noble`, matching the exact package version. Chromium and its Linux dependencies are included. The service launches headlessly as `pwuser`, binds `0.0.0.0`, uses Cloud Run's `PORT` (default 8080 in production), and stops accepting writes on SIGTERM/SIGINT before closing Chromium. No X11 desktop is needed. The container does not add unsafe Chromium flags. Cloud Run's 1 GiB memory allocation is the initial browser budget; tune only after observing memory usage.

Prerequisites: Google Cloud SDK, billing-enabled project, Cloud Run/Cloud Build/Artifact Registry/Secret Manager APIs enabled, an Artifact Registry Docker repository, both SQL migrations applied in Supabase, an OAuth provider configured to issue JWT access tokens for the canonical MCP resource URL, and a manually created Codeforces AI/test-account storage state. Grant the Cloud Run runtime service account Secret Manager Secret Accessor for the two secrets. Store `CF_STORAGE_STATE_B64` and the server-only `SUPABASE_SECRET_KEY` in Secret Manager; never place them in command history, the container image, or repository. The storage state is decoded only in process memory on cold start; it is not written to disk. If Codeforces presents a challenge or the state expires, run the headed helper locally again, update the secret, and redeploy. `/health` never contacts Codeforces or Supabase.

Build locally when Docker is available:

```bash
docker build -t cf-agent-mcp .
```

The deployment helper uses **1 CPU, 1 GiB, minimum 0 instances, maximum 1 instance, concurrency 1, request timeout 300 seconds**. It defaults to real submissions disabled. Bootstrap mode serves only `/health`; `/mcp` returns 503, so there is no public write path before OAuth is configured. Configure these nonsecret variables in the shell:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
export GCP_PROJECT_ID=YOUR_PROJECT_ID
export GCP_REGION=YOUR_REGION
export CLOUD_RUN_SERVICE=cf-agent-mcp
export ARTIFACT_REGISTRY_REPO=YOUR_REPO
export CLOUD_RUN_BOOTSTRAP=true
./scripts/deploy-cloud-run.sh
export SERVICE_URL="$(gcloud run services describe "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format='value(status.url)')"
curl -s "$SERVICE_URL/health"
```

The bootstrap deployment requires no OAuth audience, hostname, Codeforces state, or Supabase key. Its only operational route is `/health`. Obtain the generated HTTPS URL, then configure the provider and final deployment. `MCP_RESOURCE_URL` is the public resource URL; `MCP_AUTH_AUDIENCE` is the JWT audience, which may be the same URL or a provider-specific identifier. `ALLOWED_HOSTS` controls HTTP Host validation separately; the helper derives it from `MCP_RESOURCE_URL` unless explicitly set.

```bash
unset CLOUD_RUN_BOOTSTRAP
export MCP_RESOURCE_URL="$SERVICE_URL/mcp"
export MCP_AUTH_ISSUER=https://YOUR_OAUTH_ISSUER
export MCP_AUTH_AUDIENCE="$MCP_RESOURCE_URL"
export MCP_AUTH_JWKS_URL=https://YOUR_OAUTH_ISSUER/YOUR_JWKS_PATH
export SUPABASE_URL=https://YOUR_PROJECT.supabase.co
export CF_STORAGE_STATE_SECRET_NAME=cf-storage-state-b64
export SUPABASE_SECRET_NAME=cf-supabase-secret
export CF_HANDLE=YOUR_TEST_ACCOUNT
export CF_EXPECTED_HANDLE=YOUR_TEST_ACCOUNT
./scripts/deploy-cloud-run.sh
```

The helper references existing Secret Manager secrets, never embeds their values. `SUPABASE_SECRET_NAME` selects the preferred `SUPABASE_SECRET_KEY` binding; `SUPABASE_SERVICE_ROLE_SECRET_NAME` remains available for a legacy service-role secret.

If using a legacy service-role key locally, leave `SUPABASE_SECRET_NAME` unset and set `SUPABASE_SERVICE_ROLE_SECRET_NAME` instead. Once that Google Cloud secret exists, add its value from the ignored `.env` without printing it:

```bash
unset SUPABASE_SECRET_NAME
export SUPABASE_SERVICE_ROLE_SECRET_NAME=cf-supabase-service-role
node --import dotenv/config -e 'process.stdout.write(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "")' | gcloud secrets versions add "$SUPABASE_SERVICE_ROLE_SECRET_NAME" --project "$GCP_PROJECT_ID" --data-file=-
```

For local storage-state creation and base64 encoding without printing it, run:

```bash
npm run session:create
# After completing login in Chrome:
npm run session:export
set +x
export CF_STORAGE_STATE_B64="$(node -e 'process.stdout.write(require("node:fs").readFileSync(".auth/storage-state.json").toString("base64"))')"
# After creating the Secret Manager secret once, add a version without printing its value:
node -e 'process.stdout.write(require("node:fs").readFileSync(".auth/storage-state.json").toString("base64"))' | gcloud secrets versions add "$CF_STORAGE_STATE_SECRET_NAME" --project "$GCP_PROJECT_ID" --data-file=-
```

Add the encoded value to Secret Manager using an input file or stdin, avoiding terminal output. Provision the Supabase server-only secret key separately through the Google Cloud console or a protected input file. Apply both `20260926073434_cf_submission_metadata.sql` and `20260926130925_authorized_contests.sql` from `supabase/migrations/` before enabling writes. Grant the Cloud Run runtime identity `roles/secretmanager.secretAccessor` on those secrets.

With a Supabase project you control, apply pending migrations through the pinned CLI (review both SQL files first):

```bash
npm exec --yes --package=supabase@2.118.0 -- supabase login
npm exec --yes --package=supabase@2.118.0 -- supabase link --project-ref YOUR_PROJECT_REF
npm exec --yes --package=supabase@2.118.0 -- supabase db push --linked --skip-vault --dry-run
npm exec --yes --package=supabase@2.118.0 -- supabase db push --linked --skip-vault
```

Equivalent manual commands, using the same configured shell variables and an image built with Cloud Build:

```bash
IMAGE="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REGISTRY_REPO/$CLOUD_RUN_SERVICE:manual"
gcloud builds submit --project "$GCP_PROJECT_ID" --tag "$IMAGE" .
gcloud run deploy "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
  --image "$IMAGE" --allow-unauthenticated --port 8080 --cpu 1 --memory 1Gi \
  --min-instances 0 --max-instances 1 --concurrency 1 --timeout 300 \
  --set-env-vars "AUTH_MODE=oauth,ALLOW_REAL_SUBMISSIONS=false,SUPABASE_URL=$SUPABASE_URL,MCP_RESOURCE_URL=$MCP_RESOURCE_URL,MCP_AUTH_ISSUER=$MCP_AUTH_ISSUER,MCP_AUTH_AUDIENCE=$MCP_AUTH_AUDIENCE,MCP_AUTH_JWKS_URL=$MCP_AUTH_JWKS_URL,ALLOWED_HOSTS=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$MCP_RESOURCE_URL")" \
  --set-secrets "CF_STORAGE_STATE_B64=$CF_STORAGE_STATE_SECRET_NAME:latest,SUPABASE_SECRET_KEY=$SUPABASE_SECRET_NAME:latest"
```

`--allow-unauthenticated` lets ChatGPT reach OAuth discovery; the application enforces Bearer authentication on tool calls. Do not replace it with Cloud Run IAM authentication for this connection. The deployment helper defaults `ALLOW_REAL_SUBMISSIONS=false`; setting that environment variable to `true` is an explicit operator action. Remote real-submission startup requires OAuth, Supabase, `CF_EXPECTED_HANDLE`, and Codeforces authentication material. The actual session, expected account, and active Supabase contest authorization are checked at submission time. `CF_ALLOWED_CONTEST_IDS` is optional and adds a static restriction when set.

### Safe rollout

1. Bootstrap the health-only service and obtain its canonical HTTPS URL.
2. Configure the OAuth provider for that resource and redeploy with `AUTH_MODE=oauth`, persistent Supabase storage, and `ALLOW_REAL_SUBMISSIONS=false`.
3. Connect the HTTPS `/mcp` URL to ChatGPT Work, then test `session_status`, `get_contests`, `get_contest_problems`, and `get_problem` with `cf.read`.
4. Create/refresh the Codeforces storage state locally, update its Secret Manager value, and redeploy.
5. Verify `session_status.handle` matches `CF_EXPECTED_HANDLE`.
6. For an upcoming controlled contest, check registration status and register once if open. After Codeforces confirms registration, apply the `authorized_contests` migration and authorize that contest using the server-side command. Leave `CF_ALLOWED_CONTEST_IDS` unset for dynamic authorization, or set it for an extra static restriction.
7. After OAuth `cf.submit`, the account check, active database authorization, and storage migrations are confirmed, change Cloud Run `ALLOW_REAL_SUBMISSIONS=true` through an explicit service configuration update. The deployment helper defaults it to false unless explicitly configured.
8. Explicitly invoke `submit_solution` once with a locally validated Java 17 program. Inspect the returned ID and verdict. No automated test or deploy script submits to Codeforces.

`GET /health` returns `{ "status":"ok", "service":"cf-agent-mcp" }` without starting Chromium or querying upstream services. A failed or expired Codeforces session affects authenticated browser operations, not liveness. The pacing helpers only calculate time windows; they do not schedule work.

## Connect to ChatGPT Work

Add the deployed HTTPS `/mcp` resource URL in ChatGPT Work's MCP/plugin settings after configuring your OAuth provider. The server advertises protected resource metadata, tool scopes, and Bearer challenges. The provider handles authorization and token issuance; this service validates JWT signatures, issuer, audience, expiry, and scopes through its HTTPS JWKS URL. The write tool requires `cf.submit`, and `ALLOW_REAL_SUBMISSIONS` remains off through smoke testing. See [OpenAI's MCP authentication guide](https://developers.openai.com/plugins/build/auth) and [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for the current ChatGPT UI and provider requirements.

## Verification scope

Automated tests mock Codeforces and browser behavior. The optional `test:browser` script also runs the real Playwright form adapter in offline Chromium with every request fulfilled or aborted by mocks. They cover Java selection, source validation, at-most-one click, uncertain outcomes, durable metadata, authentication priority/status, HTML fallback, math/sample preservation, verdict normalization/lookup/polling, pacing boundaries, safe errors, API retries, cancellation, and MCP/health transport. No test makes a real Codeforces submission. A successful test suite cannot guarantee a future Codeforces page layout or session will remain valid; manual session setup and an explicitly authorized real tool invocation are separate steps.

## Autonomous experiment reconciliation

The optional watcher runs one short pass and exits. It uses fresh official `contest.list` and `user.info` data to select an upcoming regular Div.1 contest. Div.2, Div.3, Div.4, Educational, Gym, unrated, practice, test, mirror, and combined Div.1 + Div.2 events are excluded. Codeforces registration status is the final authority. An upcoming contest with no exact validated Register link and form stays `WAITING_FOR_REGISTRATION`; the next scheduled pass checks again. `registration_not_open`, `registration_closed`, and `unknown` are treated as temporary availability results while the contest is still upcoming. A redirect to a page for another contest cannot supply a registration result for the selected contest. The watcher never opens a registration form for a sibling contest. Only an explicit rating rejection or a permanent policy failure blocks the run; an actual security challenge sets `NEEDS_MANUAL_AUTH`.

The watcher persists each run in `cf_contest_runs` and its first four official problem indices in `cf_contest_run_problems`. It uses a version check and a short run lease so concurrent invocations cannot both act on the same run. It records the state before an external mutation. Registration is clicked at most once in an invocation; a crash or uncertain response leads to a read-only status reconciliation before another controlled attempt. Confirmed registration activates authorization on the next pass, then the watcher waits for the official start time and persists the first four official problem indices. A previously `BLOCKED` run such as 2273 reopens to `WAITING_FOR_REGISTRATION` only when its recorded block was temporary, the contest is still upcoming strict Div.1, and the official profile and authenticated browser still match the configured account. Permanent blocks stay closed. Submission remains an explicit MCP action performed by Work. For orchestrated runs, the Supabase reservation function permits only the four selected indices and at most one prepared or confirmed attempt per problem. An uncertain attempt occupies that slot. The global `ALLOW_REAL_SUBMISSIONS` switch and dynamic `authorized_contests` check remain required.

The four target windows, measured from official contest start, are P1 10–25, P2 30–50, P3 55–80, and P4 85–110 minutes. They are persisted as UTC timestamps. The watcher emits one deterministic GitHub branch, `.work-runs/<contestId>/pN.json` file, and PR per due problem. It checks for an existing PR first and resumes partially created branches/files; it never retries a mutating GitHub request after an uncertain network result in the same pass. P2 cannot trigger until P1 has a terminal verdict or has been marked missed. A missed window is recorded explicitly. The external scheduler invokes the next pass; no process sleeps through a contest.

When a genuine Codeforces challenge appears during an authenticated operation, the run records `NEEDS_MANUAL_AUTH`, a pending operation, a safe reason code, and timestamps. Each later pass checks the existing session read-only, including the expected handle. For a pending submission it also opens a temporary page at the official submit URL to confirm the challenge is gone, without interacting with the form. If verification still appears or the account is wrong, the state stays blocked. After an operator completes the challenge in the already open dedicated Chrome profile, or refreshes the legitimate storage-state secret for a later process, the next pass resumes automatically from persisted state. It **first reads official registration status or account submissions**. A registered contest is accepted without another click; a not-registered result returns to the ready state and ends that pass. An unavailable interface returns to waiting unless a previous registration mutation is still uncertain. A confirmed submission ID is reused; no local attempt means the MCP mutation was not reached; a prepared or uncertain attempt without a provable ID stays `SUBMISSION_RESULT_UNCERTAIN`. No CAPTCHA, Turnstile, or Cloudflare interaction is automated. CDP mode keeps the operator's Chrome browser externally owned and open.

The watcher reads only its own submission metadata and official account status, checking contest ID, problem index, and author handle. It never reads another contestant's source. After four terminal problem states it completes the Supabase contest authorization, then checks official `contest.ratingChanges` and `user.rating` for the specific contest/account for up to 72 hours. It does not infer a rating change from an unrelated future contest.

### Local operator commands

Apply the new `20260926145600_cf_orchestrator.sql` migration only after reviewing it. The commands below are **not** executed by this repository's tests or build:

```bash
npm exec --yes --package=supabase@2.118.0 -- supabase link --project-ref YOUR_PROJECT_REF
npm exec --yes --package=supabase@2.118.0 -- supabase db push --linked --skip-vault --dry-run
npm exec --yes --package=supabase@2.118.0 -- supabase db push --linked --skip-vault
```

Set `SUPABASE_URL`, a server-only `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, `EXPERIMENT_HANDLE`, matching `CF_EXPECTED_HANDLE`, and `CF_STORAGE_STATE_B64`. Local manual Chrome attachment can use `CF_BROWSER_CDP_URL=http://127.0.0.1:9222` instead. Set `GITHUB_TRIGGER_REPO=owner/repo` and a scoped `GITHUB_TRIGGER_TOKEN` before the first problem window that will create a real Work PR. Discovery, registration, waiting, authentication recovery, and dry-run do not require GitHub credentials; a due trigger without them returns `TRIGGER_CONFIG_ERROR`. A due dry-run reports `wouldTriggerGithub` without contacting GitHub. `EXPERIMENT_ENABLED=false` is the default and makes `orchestrator:once` a no-op. The optional `PROBLEM_N_EARLIEST_MINUTE` and `PROBLEM_N_LATEST_MINUTE` settings override the four nonoverlapping defaults. `EXPERIMENT_PROBLEMS` must remain `4` and `EXPERIMENT_LANGUAGE` must remain `JAVA_17`.

```bash
npm run orchestrator:status                 # read-only Supabase state
npm run orchestrator:status -- 2273         # one run
npm run orchestrator:dry-run                # read-only candidate/state inspection
EXPERIMENT_ENABLED=true npm run orchestrator:once       # one mutating reconciliation pass
EXPERIMENT_ENABLED=true npm run orchestrator:contest -- 2273
```

The last two commands can register a contest, activate authorization, and create a GitHub PR when the corresponding state and time window permit. They never submit source code themselves. Leave `ALLOW_REAL_SUBMISSIONS=false` until an explicitly approved real Work submission test. The GitHub Actions workflow `.github/workflows/codeforces-orchestrator.yml` runs every five minutes and supports manual dispatch. Configure repository variables `EXPERIMENT_ENABLED`, `EXPERIMENT_HANDLE`, `SUPABASE_URL`, `GITHUB_TRIGGER_REPO`; configure secrets `CF_STORAGE_STATE_B64`, `SUPABASE_SECRET_KEY`, `GITHUB_TRIGGER_TOKEN`. Its token must have permission to create branches, contents, and PRs in the trigger repository. The migration and credentials are prerequisites; the workflow does not apply migrations or deploy Cloud Run.

### ChatGPT Work PR task contract

Each PR's JSON file supplies `runId`, `contestId`, `problemOrdinal`, `problemIndex`, expected `handle`, and `Java 17`. Work should call MCP `get_problem`, derive an independent algorithm from the official statement, inspect constraints and edge cases, compile and test the Java 17 source with official examples, perform the documented clean refactoring pass, and call `submit_solution` exactly once with the final source. Work then reads the returned submission ID and calls `wait_for_verdict` or `get_submission_verdict`, reporting `{contestId, problemIndex, submissionId, verdict, language}`. Work must not inspect editorials, blogs, solution databases, or competitors' source. The controller accepts only its persisted submission metadata plus Codeforces' own account submission record as evidence; PR text alone cannot advance the run. If an action is uncertain or manual verification is required, Work must stop rather than retry the mutation.
