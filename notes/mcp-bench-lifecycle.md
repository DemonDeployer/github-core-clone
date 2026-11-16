# github-core-clone-01 — MCP / benchmark / lifecycle contract

Source of truth read in full (kit `~/workspace/research_notes/makefun-20261115/kit-github-core-clone/github-core-clone-01-kit/`):
- `sdk/conformance/checks-mcp.ts` (1002 lines, 15 MCP checks)
- `sdk/conformance/mcp-client.ts` (Streamable-HTTP MCP client)
- `sdk/conformance/bench.ts` (877 lines, 4 workloads)
- `sdk/conformance/main.ts` (env runner: `runSuite`, boot/conformance/benchmark/export)
- `sdk/conformance/manifest.ts` (groups, scoring, workloads, T_ref)
- `sdk/conformance/export.ts` (state.json / perf.json writer + never-worse rule)
- `sdk/conformance/wire.ts` (constants, scenario seed, export shapes) — grepped, key sections read
- `sdk/conformance/calibration.json` (T_ref values)
- `RULES.txt`, `competition.yaml` (skimmed for lifecycle/scoring; `model_calls: optional`)
- `starter/main.ts` (reference entry lifecycle)

Kit paths in this file are relative to the kit root above unless stated otherwise.

## 0. Score overview (why MCP + bench matter)

- 120 conformance checks in 7 groups: git 30, repos 15, issues 15, pulls 20, graphql 20, **mcp 15**, protocol 5.
- `score = feature + agent + perf`, 0–1000:
  - feature = `round(600 * passed / 120)`
  - agent = `round(200 * passedMcp / 15)` — the MCP group counts **twice** (once inside feature, once alone as agent).
  - perf = sum over 4 workloads of `round(clamp(25 − 12.5·log2(t_ms / T_ref_ms), 0, 50))`, 0–200.
- Tie-break: `perf_p50_us` ascending, then earlier receipt. Build cost never breaks a tie.
- `working` = 1 only if boot succeeded (registered + `/healthz` twice) AND ≥1 check passed; otherwise 0. It decides no score/place by itself.
- Determinism/replay: `state.json` holds **only pass/fail bits, counts, static perfTiers, working** — no time, port, date, or random id. Final contenders' trials are replayed and the two `state.json` exports must be byte-identical. Timings live only in `perf.json`.
- `model_calls: optional` (competition.yaml harness) — a scripted entry making **no** model calls is legal; no LLM-agent floor applies.

## 1. Endpoints and auth (shared by all surfaces)

- Entry base URL = `http://<peer address from register request>:<registered port>` (env derives it; entry never announces a host, only a port).
- REST prefix `/api/v3`; GraphQL `/api/graphql`; MCP `POST /mcp`; git smart HTTP `/{owner}/{repo}.git`.
- Bearer token: env var `MAKEFUN_SHOP_TOKEN` (wire `TOKEN_ENV`), sent as `Authorization: Bearer <token>` (opaque). A request without it is **401** on every surface. A repository belongs to the login the token names; same repo name under another owner is **404, never 403**.
- Scenario (deterministic, `wire.ts`): seed `SCENARIO_SEED = 0x6a09e667f3bcc909n`, hex `6a09e667f3bcc909`; epoch 2025-01-01T00:00:00Z (`SCENARIO_EPOCH_SEC = 1735689600`). Every name/title/path/blob the suite sends derives from this seed via `buildScenario()` / `scenarioRng(label)` — no `Math.random`, no clock in any pass bit.
- Scenario identities (per task context; **not** literal strings in the files read — they are generated from the seed): viewer login `adaiversen`, stranger `olgabauer`, org `faint-meadow-org`. MCP checks resolve the owner as `GET /api/v3/user` → `login`, falling back to `scenario.viewer.login` if that route refuses.
- MCP setup names use tag = first 8 hex chars of the scenario seed (`6a09e667`): repos `mcp-<tag>-<part>`, branches `mcp-head-<tag>-<part>`, files `mcp-<tag>-<part>-<which>.txt`.

## 2. MCP transport (mcp-client.ts)

Endpoint: `POST <baseUrl>/mcp`. JSON-RPC 2.0 over **Streamable HTTP**. Client is hand-rolled over `fetch`, no SDK.

### 2.1 Two protocol eras — the server may speak either; both are accepted

| | Modern (2026-07-28, preferred) | Legacy (2025-11-25 and earlier) |
|---|---|---|
| Discovery | `server/discover` (mandatory RPC) returns identity + capabilities + `supportedVersions` in one request | No `server/discover`; `initialize` + `notifications/initialized` |
| Session | **No protocol-level session, no GET stream** | Optional `Mcp-Session-Id` header, carried from any response onward; `close()` sends best-effort `DELETE` with `Mcp-Session-Id` (≤1 s) |
| Revision declaration | Every request declares revision in `_meta` (see 2.2) and mirrors it in `MCP-Protocol-Version` header | `initialize` offers revisions newest-first; server echoes the one it chose |

- Preferred revision: `MCP_PREFERRED_REVISION = '2026-07-28'`.
- Legacy revisions offered (newest first): `['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']`. The brief names 2025-06-18 as one that must not be failed.
- `connect()` probes `server/discover` first (id `discover-1`, params `{}`):
  - Result → modern; negotiated revision = `2026-07-28` if in `supportedVersions`, else `supportedVersions[0]`.
  - JSON-RPC `-32601` (Method not found), HTTP 404, or 405 → pre-discover era → legacy handshake fallback.
  - `-32022` UnsupportedProtocolVersionError → retry once with a version named in `error.data.supported` (preferring `2026-07-28`); if the retry also fails, `connect()` throws.
  - Any other modern refusal (auth 401/403, 5xx, `-32020` HeaderMismatch, `-32021`, `-32600`, `-32602`) → reported as-is, **never** smoothed into legacy fallback; `connect()` throws `McpError`.
  - No answer at all (connection refused / timeout) → throws.
- Legacy handshake: `initialize` (id `initialize-1`, params `{protocolVersion: <offered>, capabilities: {}, clientInfo: {name: 'makefun-github-core-clone-env', version: '1.0.0'}}`, **no** `MCP-Protocol-Version` header on this request) — tries revisions in order, but **breaks out of the loop unless the error is `-32602`** (i.e. only an invalid-params error triggers trying the next older revision). On success: `notifications/initialized` notification (no id), then connection settles with `protocolVersion` = server's echo if it is a valid `YYYY-MM-DD` revision, else the offered one. If neither era works, `connect()` throws with evidence from both probes.
- `connect()` is idempotent (settled connection or first failure is cached).

### 2.2 Every request: `_meta`, headers, body

Request body (JSON-RPC 2.0):
```json
{"jsonrpc": "2.0", "id": <number|string>, "method": "<method>",
 "params": { ...method params...,
   "_meta": {
     "io.modelcontextprotocol/protocolVersion": "<negotiated revision>",
     "io.modelcontextprotocol/clientInfo": {"name": "makefun-github-core-clone-env", "version": "1.0.0"},
     "io.modelcontextprotocol/clientCapabilities": {},
     "protocolVersion": "<negotiated revision>"
   }}}
```
- `_meta` is added to **every** request (never overwriting an explicit `_meta` key the caller set); note the duplicate plain `protocolVersion` key — "an older server may look for that spelling".
- Default JSON-RPC ids: auto-incrementing integers starting at 1 (`nextId`), except `discover-1` and `initialize-1` (strings) and caller-supplied ids (concurrent-calls check uses string ids, see §3.12).
- Headers on every POST:
  - `Accept: application/json, text/event-stream`
  - `Content-Type: application/json`
  - `MCP-Protocol-Version: <negotiated revision>` (omitted only for legacy `initialize` / `notifications/initialized`, via `omitProtocolVersionHeader`)
  - `Mcp-Method: <method>` (mirrored header the 2026-07-28 transport requires)
  - `Mcp-Name: <tool name>` on `tools/call` only (value-encoded, see below)
  - `Mcp-Session-Id: <session>` when one was handed out (legacy)
  - `Authorization: Bearer <token>` when a token is configured (omitted when `omitAuth: true`)
  - `Mcp-Param-<header>` for tool parameters annotated `x-mcp-header` in the tool's inputSchema (see §2.5)
- Response handling: the client **never throws for an HTTP status** — every answer is an `McpHttpResponse` `{status, ok (2xx), headers, contentType (lowercased), bodyText (exact, SSE framing included), json (parsed JSON body, null for SSE), rpc (the JSON-RPC response carried), sse (bool)}` and the checks judge it. It throws only on: no answer (connection refused → `McpError`), per-call timeout (`McpTimeoutError`), or the check's abort signal firing (`McpError`).
- **Per-request timeout: `MCP_DEFAULT_TIMEOUT_MS = 3000` ms.** Each MCP check caps its own budget at this (`requestTimeoutOf`: `min(ctx.timeoutMs, 3000)`). A request must answer inside 3 s (RULES.txt states this too).
- SSE answers: `Content-Type: text/event-stream` → client reads the stream until the JSON-RPC response whose `id` equals the request's `expectedId` arrives (notifications/comment lines skipped; the response is the last `data:` frame per the transport); then cancels the reader. A plain-JSON answer may also be a JSON **array** — the client takes the first element that looks like a JSON-RPC response (`id` present + `result` or `error`). Either `application/json` or `text/event-stream` is acceptable as a response.
- Notifications (`notify`): JSON-RPC object with **no `id`**; answer is the HTTP response; a lost notification is no error.

### 2.3 JSON-RPC error codes used

| Code | Meaning / where required |
|---|---|
| `-32700` | Parse error — body that is not JSON → **HTTP 400** + `-32700` (modern); legacy (pre-2026-07-28) servers may answer **HTTP 200** + `-32700` and still pass (see §3.10) |
| `-32601` | Method not found — how a pre-discover server answers `server/discover`; also an acceptable answer for an unknown tool |
| `-32602` | Invalid params — acceptable answer for an unknown tool; acceptable answer for a `tools/call` missing required arguments |
| `-32600` | Invalid request (listed as a modern-refusal code in `connect()`) |
| `-32022` | `UnsupportedProtocolVersionError` (2026-07-28); versions it supports in `error.data.supported` |
| `-32021` | Listed as a modern-refusal code in `connect()` (name not given in the client) |
| `-32020` | `MCP_HEADER_MISMATCH` (2026-07-28) |

### 2.4 `server/discover` result shape (`DiscoverResult`)

The client accepts `serverInfo` from **either** `result._meta['io.modelcontextprotocol/serverInfo']` (checked first, the 2026-07-28 location) **or** a loose top-level `result.serverInfo`. Fields read:
- `supportedVersions`: array; only entries matching `/^\d{4}-\d{2}-\d{2}$/` count (`revisionsOf`). Must be **non-empty** for the modern pass.
- `capabilities`: record; `capabilities.tools` must be present (for `initialize`).
- `serverInfo`: `{name, version}` — both must be non-empty strings (for `initialize`).
- Optional: `resultType`, `instructions`, `_meta`.

### 2.5 `x-mcp-header` parameter mirroring

If a tool's `inputSchema.properties[<param>]` is a record with a non-empty string `x-mcp-header` value, and the call supplies that parameter, the client sends `Mcp-Param-<header>: <encoded value>`. Encoding: plain visible-ASCII value as-is; otherwise `=?base64?<base64 of UTF-8 bytes>?=`. Primitive conversion: string as-is; finite number via `String(n)`; boolean `true`/`false`; anything else is skipped (no header). Only tools previously seen via `tools/list` are mirrored (client caches `toolsByName`).

## 3. The 15 MCP checks (checks-mcp.ts, run in order, one at a time)

Check ids are `mcp.<slug>`. Each check gets its own `McpClient` (fresh per check), its own timeout (≤3 s/request), its own abort signal; a throwing check fails with its message, never crashes the suite. Setup for the stateful checks goes through **REST** (`/api/v3`, same token, same per-request timeout, `User-Agent: makefun-github-core-clone-env`, `redirect: 'manual'`); a broken REST route fails the MCP check with route + status named.

### 3.1 `mcp.initialize`
`client.connect()` (either era). Pass iff `serverInfo.name` and `serverInfo.version` are non-empty strings AND `capabilities.tools` is present (a record — `isRecord(info.capabilities.tools)`; note: an empty `{}` tools object passes this check, since only presence is tested). Fail detail names era + revision.

### 3.2 `mcp.server-discover`
After `connect()`:
- Modern era: pass iff `supportedVersions` is non-empty; detail lists them + negotiated revision.
- Legacy era: **passes unconditionally** ("pre-discover revision") — the refusal may be HTTP 404, JSON-RPC `-32601`, or any other refusal, **provided the initialize handshake then worked** (which `connect()` proved). Detail names how it refused (`HTTP 404`, or `HTTP <status>, JSON-RPC <code>`, or `no answer`).

### 3.3 `mcp.tools-list`
After `connect()`, `tools/list` (follows `nextCursor` pagination, max 10 pages). Pass iff **≥6 tools** AND all six canonical tools are present. Tool matching (`findTool`): exact canonical/alias match first, then a tool whose **normalized** name (lowercase, all non-alphanumerics removed) **ends with** the normalized canonical/alias (so a server prefix such as `github__create_issue` matches; suffix match is case-insensitive via normalization).

Required tools and aliases (`MCP_REQUIRED_TOOLS`, `MCP_TOOL_ALIASES`):

| Canonical | Aliases |
|---|---|
| `create_repo` | `create_repository`, `repo_create`, `repos_create`, `repository_create` |
| `get_repo` | `get_repository`, `repo_get`, `repos_get`, `repository_get` |
| `create_issue` | `issue_create`, `issues_create` |
| `list_issues` | `issues_list`, `issue_list` |
| `create_pull_request` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` |
| `merge_pull_request` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` |

### 3.4 `mcp.tool-schemas`
Every tool returned by `tools/list` must have a **non-empty `description`** (string, non-blank) and an **`inputSchema` that is a record with `type === 'object'`**. (Note: `inputSchema` itself must be an object; a missing `properties` is not itself failed here — but see §3.5 mapping. Fail detail lists up to 4 bad tools + count of the rest.)

### 3.5 Argument mapping — how the suite calls your tools (`mapArguments`)

The suite sends the documented argument names, but **maps each onto your schema's nearest property name**: it builds a normalized-name index of your `inputSchema.properties` and, for each semantic argument, tries its synonyms in order (normalized comparison). If your schema has **no `properties` object at all**, the semantic arguments are sent verbatim and nothing is "missing".

Synonym lists (`ARGUMENT_SYNONYMS`, tried in listed order):

| Semantic | Property names tried (normalized) |
|---|---|
| `owner` | `owner`, `owner_login`, `org`, `organization`, `organisation`, `user`, `user_login`, `login`, `account`, `namespace`, `owner_name` |
| `repo` | `repo`, `repository`, `repository_name`, `repo_name`, `repo_slug`, `project`, `project_name` |
| `repo_full_name` | `full_name`, `repo_full_name`, `repository_full_name`, `fullName` |
| `title` | `title`, `issue_title`, `pr_title`, `pull_request_title`, `subject` |
| `body` | `body`, `issue_body`, `description`, `content`, `text`, `comment` |
| `head` | `head`, `head_ref`, `head_branch`, `pull_request_head`, `pr_head`, `source`, `source_ref`, `source_branch`, `from`, `from_branch`, `branch` |
| `base` | `base`, `base_ref`, `base_branch`, `pull_request_base`, `pr_base`, `target`, `target_ref`, `target_branch`, `into`, `into_branch` |
| `pull_number` | `pull_number`, `pull_request_number`, `pr_number`, `number`, `issue_number`, `index` |
| `name` | `name`, `repo`, `repository`, `repository_name`, `repo_name` |
| `description` | `description`, `about`, `summary`, `body` |
| `private` | `private`, `is_private` |
| `state` | `state`, `status` |

Special cases:
- If no property matches `repo` but a `full_name`-family property exists, the suite fills it with `"owner/repo"`.
- **Unfillable required property = check failure, not a guessed call**: if `inputSchema.required` lists a property the suite has no value for, the call is **not made** and the check fails naming the property (`the <tool> inputSchema requires <props>, which the suite has no value for`). So: keep `required` to properties the suite can fill (see the per-tool argument lists below), or make extra properties optional. **Do not add required properties outside the documented sets** (e.g. a required `token`, `branch` on create_issue, etc. will fail that tool's checks).
- Documented argument contract (github-mcp-server's names):
  - `create_repo {name, description?, private?}`
  - `get_repo {owner, repo}`
  - `create_issue {owner, repo, title, body?}`
  - `list_issues {owner, repo, state?}`
  - `create_pull_request {owner, repo, title, head, base}` — note: the suite **also sends `body`** for create_pull_request (see §3.7), mapped via the `body` synonyms.
  - `merge_pull_request {owner, repo, pull_number}`

### 3.6 Tool-result reading (`resultText` / `resultJson`)

How the suite interprets a `tools/call` result:
- `resultText`: concatenates `content[]` blocks where `block.type === 'text'` (string `text`), plus `JSON.stringify(result.structuredContent)` if present. Non-text blocks are ignored.
- `resultJson`: `structuredContent` first if present; else `JSON.parse` of the whole text; else the outermost `{...}` or `[...]` substring of the text, parsed. Returns null if nothing parses.
- `numberFrom(value, keys)`: reads an integer `number`/`pull_number`/`id` field (number, or all-digit string).
- A call is a failure if: JSON-RPC `error` present, **or** `toolResult.isError === true` (the tool-error text, first 300 chars, is the fail detail). `callFailure` wording: `tools/call <name> -> JSON-RPC <code>: <msg>` / `-> isError: <text>`.

### 3.7 `mcp.create-issue`
Setup (REST): create repo `mcp-<tag>-issue-create` (private, description `github-core-clone-01 MCP setup`) via `POST /api/v3/user/repos`; owner = `GET /api/v3/user` login. Call `create_issue {owner, repo, title: scenario.issues[0].title, body: scenario.issues[0].body}`. Pass iff `GET /api/v3/repos/{owner}/{repo}/issues?state=all&per_page=100` lists an issue with the **same title** (exact string match). (The issue number is not checked here.)

### 3.8 `mcp.list-issues`
Setup (REST): create repo `mcp-<tag>-issue-list`; create an issue via REST `POST .../issues {title: scenario.issues[1].title, body}` (must be 2xx; its `number` is recorded if numeric). Call `list_issues {owner, repo, state: 'open'}`. Pass iff the tool result's text **contains the issue title** OR matches `"number": <n>` (regex `"number"\s*:\s*<n>(?!\d)` — i.e. the number must appear as a JSON number field, not as part of a longer number). Either match suffices.

### 3.9 `mcp.create-pull-request`
Setup (REST): create repo `mcp-<tag>-pr-create`; then `preparePullRequest`:
1. `PUT .../contents/<basePath> {message, content: <base64 blob 0>}` on the default branch (creates base commit; must be 2xx).
2. Create head branch `mcp-head-<tag>-pr-create`: try `POST .../git/refs {ref: 'refs/heads/<head>', sha: <baseSha>}`; if that fails, `PUT .../contents/<headPath> {message, content: <base64 blob 1>, branch: <head>}` — whichever creates the ref. Then write one more file on the head branch (so head is one commit ahead of base).
3. Base = repo's `default_branch` (from create response or a `GET` of the repo; default `'main'` if unknown).
Call `create_pull_request {owner, repo, title: scenario.pulls[0].title, body: scenario.pulls[0].body, head: <head>, base: <base>}`. Pass iff REST can read the PR back — by number from the tool result (`number`/`pull_number`/`pull_request_number` fields) via `GET .../pulls/{n}`, else by scanning `GET .../pulls?state=all&per_page=100` for matching title or head — **and** `refOf(pull.head) === <head>` and `refOf(pull.base) === <base>`, where `refOf` reads `head.ref`, else `head.branch`, else the last `:`-segment of `head.label`, else the string itself.

### 3.10 `mcp.merge-pull-request`
Setup (REST): create repo `mcp-<tag>-pr-merge`, same `preparePullRequest` as §3.9; create the PR via REST `POST .../pulls {title: scenario.pulls[1].title, head, base}` (must be 2xx, must return a numeric `number`). Call `merge_pull_request {owner, repo, pull_number: <n>}`. Pass iff `GET .../pulls/{n}` returns a record with **`merged === true`** (boolean true; `state` is reported in the pass detail but not asserted beyond that).

### 3.11 `mcp.unknown-tool`
Call `tools/call` with name `mcp_no_such_tool_<tag>` and `arguments: {}` (via raw `client.request`, not `callTool`). Pass iff:
- HTTP status is **not 500**, AND
- JSON-RPC error code is **`-32602` or `-32601`**.
Any other code fails; a successful `result` (no error) fails. (Note: the check does not require a particular HTTP status other than ≠500 — e.g. HTTP 200 with a JSON-RPC error passes, as does 4xx.)

### 3.12 `mcp.parse-error`
After `connect()`, `postRaw` sends the exact truncated body `{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"` (unterminated JSON) with `methodHeader: 'tools/list'`, `expectedId: 424242`. Pass iff JSON-RPC error code is **`-32700`** AND:
- HTTP **400** (modern), OR
- HTTP **200** **and** era is `legacy` ("the pre-2026-07-28 transport status").
Anything else fails (wrong code, or 400 without `-32700`, or 200 in the modern era).

### 3.13 `mcp.missing-arguments`
Call `create_issue` with **empty arguments `{}`** (`allowMissing: true` — the call is made despite unfillable required properties). Pass iff the answer is either:
- JSON-RPC error `-32602`, OR
- tool result with `isError: true`.
Any other JSON-RPC error code fails; a successful non-error result fails. (Note: if `create_issue` has **no** required properties, the empty call may succeed — that fails this check. Keep `title` (and `owner`/`repo`) required, or validate arguments server-side and return `isError: true` / `-32602` when required ones are absent.)

### 3.14 `mcp.concurrent-calls`
Setup (REST): create two repos `mcp-<tag>-concurrent-left` and `mcp-<tag>-concurrent-right`. Resolve `get_repo` via `findTool` (fail if absent) and map `{owner, repo}` args for each. Fire **both** `tools/call get_repo` requests concurrently via `Promise.all`, with explicit string ids `concurrent-left-<tag>` and `concurrent-right-<tag>`. Pass iff:
- each answer's `matchedId` (the `id` the response carried) equals the id that request sent, AND
- neither answer has a JSON-RPC error, AND
- the left answer's result text contains the left repo name, and the right answer's text contains the right repo name.
Implication: the server must handle concurrent requests independently (no shared mutable per-connection response state, no id mix-up), and `get_repo`'s result text must name the repo (title or text must include the repo name string).

### 3.15 `mcp.tools-list-idempotent`
Two consecutive `tools/list` calls. Pass iff the two returned tools arrays are **byte-identical**: same length AND `JSON.stringify(first) === JSON.stringify(second)`. Implication: tool order, descriptions, schemas must be fully deterministic — no timestamps, no random ids, no map-iteration-order variation, no per-call mutation. (Note: comparison is on the **parsed** tools arrays re-serialized by the client, so key order inside each tool object does not matter, but array order and all values do.)

### 3.16 `mcp.rest-parity`
1. Call `create_repo {owner, name: 'mcp-<tag>-parity', description: scenario.repos[0].description, private: true}`. Note: `owner` is sent but the documented `create_repo` contract is `{name, description?, private?}` — the suite maps `owner` only if your schema has an owner-family property; the repo is created under the token's login regardless.
2. Read the tool result's `full_name` if present (`owner/repo`); use it to set owner/repo for the REST reads.
3. `GET /api/v3/repos/{owner}/{repo}` twice: pass requires HTTP 200 both times, a present `id`, and **`id` identical across the two reads** (string-compared).
4. Call `create_issue {owner, repo, title: scenario.issues[2].title, body}`; get its number from the tool result, else by scanning `GET .../issues?state=all&per_page=100` for the title.
5. `GET /api/v3/repos/{owner}/{repo}/issues/{number}` twice: pass requires HTTP 200, a present `id` identical across reads, and `title` exactly equal to the created title.
Implication: MCP-created objects must be the **same store objects** as REST serves, with **stable server-assigned ids** (numeric or string — compared as strings) that never change across reads.

### 3.17 `mcp.auth-required`
After `connect()` + `listTools()` (failures tolerated → empty list), resolve the `create_issue` tool name if listed, else use canonical `create_issue`. Call it with `{owner: 'no-auth', repo: 'no-auth-<tag>', title, body}` and **`omitAuth: true`** (no `Authorization` header). Pass iff HTTP status is exactly **401**. (Auth must be decided **before** tool existence/validation — the refusal must be 401 even for a nonexistent repo/tool name. Note: this call goes through the already-connected client; the server must not treat the earlier authenticated `connect()` as a session that bypasses auth on later unauthenticated requests — in the modern era there is no session, so each request is auth-checked independently.)

## 4. Benchmark (bench.ts + manifest.ts)

### 4.1 Structure

- 4 workloads, run in order `push, clone, read, write` (manifest `BENCH_WORKLOAD_NAMES`), each: `BENCH_WARMUP_OPS = 5` untimed warm-up ops, then `BENCH_ROUNDS = 3` timed rounds; a workload's time = **median round** (nearest-rank percentile: `p50 = sorted[ceil(0.5·n) − 1]`; `p99` = largest of the 3 rounds). Round times rounded to 0.001 ms. Clock: monotonic `performance.now()`.
- Setup (repo creation, clone history, read workload's issue) happens **inside the workload's budget but outside every timed round**. All payloads are built **before** timing starts (no hashing/deflating timed).
- Per-workload budget: `budgetMs = 60_000` ms each. Phase budget: `BENCH_PHASE_BUDGET_MS = 240_000` ms total (also capped by the env's internal deadline). A workload gets `min(60 s, phase remaining, env deadline remaining)`; a timer aborts in-flight requests at the deadline; every op checks the clock before starting. A workload that throws, or does not complete **all** rounds inside budget, earns **0 points** and stops early — but rounds completed before the failure are still recorded in `rounds`; its `p50_ms`/`p99_ms` are the sentinel `FAILED_P50_MS = 1_000_000_000` (1e9), never a measured number.
- A workload that never ran (phase deadline fell first / trial aborted) is likewise sentinel + 0 points + an `error` string.
- `runBenchmark` never throws for anything the entry does; it throws only for caller mistakes (no base URL, unknown workload name).

### 4.2 The four workloads, exactly

All repos are owned by `scenario.viewer.login` (the token's login). Each workload **deletes then re-creates** its repo first (via REST `DELETE /api/v3/repos/{owner}/{repo}` — 404 when absent is normal — then `createRepo`; a 422 "already exists" from create is accepted), so a re-run starts clean.

| Workload | Repo | Ops/round | What one op is | Setup (untimed) |
|---|---|---|---|---|
| `push` | `bench-push` | 200 sequential | One receive-pack exchange (advertisement + command list + pack) creating one new commit on `refs/heads/main`. Each commit's tree holds one file `bench-data.txt` with a fresh **1 KiB** (1024 B) seeded blob. Pack carries only the 3 objects the server lacks (blob, tree, commit). First op: `oldOid = 0000…0` (ZERO_OID, branch creation); later ops chain from the previous commit. Commit timestamps: fixed epoch `1700000000 + index`. An op fails the workload unless the report-status says `unpackOk` and names the ref with `ok`. | All `5 + 3·200 = 605` payloads (command + pack) pre-built before timing. |
| `clone` | `bench-clone` | 50 **concurrent** (`Promise.all`) | One shallow clone, `depth: 1`, `singleBranch: true`, `parse: false` — pack checksum verified, objects **not** parsed. Fails the workload unless `checksumOk === true`, `packBytes > 0`, `refs.length > 0`. | History built once: **200 commits** on `refs/heads/main`, each replacing `history.txt` with a fresh 512 B blob, pushed in **one** push carrying all 600 objects (200× blob+tree+commit). |
| `read` | `bench-read` | 2000 sequential | `GET /api/v3/repos/{owner}/{repo}/issues/{number}` — must be HTTP 200 with a JSON object body. All 2000 on **one warm keep-alive connection** (the same `RestClient`, undici pool reuses the socket). | One issue created via REST `POST .../issues` (must be **201**); its numeric `number` is the read target for every op. |
| `write` | `bench-write` | 200 sequential | `POST /api/v3/repos/{owner}/{repo}/issues` with a pre-built `{title: '<template> [bench <i>]', body}` — must be **201**. | All `5 + 3·200 = 605` titles pre-built. |

### 4.3 Scoring

- T_ref (house reference forge's calibrated medians, `calibration.json`, measured 2026-11-14 on the production cluster; `manifest.ts T_REF_MS`):

| Workload | T_ref (ms) |
|---|---|
| push | **1640.82** |
| clone | **266.941** |
| read | **2759.715** |
| write | **348.965** |

- Per-workload points: `points = round(clamp(25 − 12.5·log2(p50_ms / T_ref_ms), 0, 50))`. At `t = T_ref` → 25; half T_ref → 38 (37.5 rounds to 38); double → 13 (12.5 rounds to 13); quarter or less → 50. A T_ref of 0 (uncalibrated) → workload runs and is measured but earns 0 points, `calibrated: false`, error line `uncalibrated: T_ref is 0, so the workload earns 0 points until calibration fills it`. (Current kit **is** calibrated — all four T_ref > 0.)
- `perf.json` tiers: `tier = floor(points / 12.5)`, clamped 0..4.
- `perf_p50_us` (tie-break) = `round(1000 · geometric mean of the p50_ms of the workloads that DID measure)`; each time floored at 0.001 ms (1 µs) so a 0 ms round cannot make the mean 0. **Sentinel 1e9 p50s never enter the mean.** If **no** workload measured, `perf_p50_us = 1_000_000_000` (the scorer's largest accepted integer — never 0, which would sort first).
- `points_total` = sum of the four workloads' points (0–200). Points are **recomputed from p50 + T_ref** when `perf.json` is assembled (`perfFileOf`/`finishWorkload`), so a caller cannot hand in unearned points.
- Reference forge at its own T_refs scores 100/200 perf; its measured `perf_p50_us` across the three calibration runs was 712790–900674 (median 805899).

### 4.4 What the bench implies for the forge (performance-critical paths)

- Push path: receive-pack must accept a pack with exactly 3 new objects and fast-forward `refs/heads/main` 605 times in a row (5 warm-up + 600 timed), sequentially, each round of 200 timed as one wall interval. Any per-push fixed cost (fsync, re-indexing the whole repo, re-reading all objects) is multiplied 605×.
- Clone path: 50 concurrent depth-1 clones of a 200-commit repo; server must serve the pack (or a depth-1 cut of it) 150× total (5 warm-up + 150 timed) with correct pack checksum; object parsing is the client's work, not timed — but the server still has to produce the pack bytes fast under 50-way concurrency.
- Read path: 6000 sequential single-issue GETs (5 warm-up + 6000 timed) on one keep-alive socket — per-request overhead (routing, JSON serialization, auth) dominates; keep-alive must actually be kept alive (no `Connection: close`, no per-request socket teardown).
- Write path: 600 sequential issue creations, each a 201 with a fresh number.

## 5. Lifecycle — what the ENTRY must do (main.ts runSuite + wire.ts + starter/main.ts)

The entry is a **server**, not an agent: it makes **no model calls** (none required; `model_calls: optional`).

### 5.1 Env side (for context — the env does this, not the entry)

- Env listens on `MAKEFUN_ENV_HOST` (default `0.0.0.0` in a container, `127.0.0.1` under the process driver) at `MAKEFUN_ENV_PORT` (default **8080** when unset; 0 picks a free port), `reusePort: false`. Writes `<stateDir>/ready` (body `{"schema":"github-core-clone-01/ready/v1","host":…,"port":…}` + newline) once bound; harness waits for it. Also writes `<stateDir>/calls.ndjson` **empty** at start (the env makes no model calls; a pass without this file faults `env` — the entry does not write it).
- `MAKEFUN_STATE_DIR` env var names the state dir (default `/state` in a container). Env vars the entry sees in a trial: `MAKEFUN_ENV_URL` (= `http://store:8080`, the env origin), `MAKEFUN_SHOP_TOKEN`, `MAKEFUN_TRIAL_SEED`, `MAKEFUN_TRIAL_NOW`, plus the gateway vars (irrelevant — no model calls). Pod limits: 2 CPUs, 1024 MB, 256 processes, **900 s wall budget** (`TRIAL_WALL_BUDGET_SEC = 900`); the suite shares those totals, so leave it room.

### 5.2 Entry lifecycle (the contract the forge must satisfy)

1. **Bind an ephemeral port**: `listen(0)` — kernel picks the port. **Never bind 8080** (the env owns it). Entry runs as `node /bot/main.ts` (Node 22) or `python3 /bot/main.py` (Python 3.13), repo root, stdlib + vendored source only, no install step, no git binary, no network beyond the suite.
2. **Register**: `POST $MAKEFUN_ENV_URL/register` with JSON body exactly `{"port": <N>}` (N integer 1..65535; body ≤ 65,536 bytes). Answers: **200** first register accepted; **409** a second register (first entry stays the one dialled — the process keeps waiting like any other); **400** bad JSON / bad port; **405** wrong method. The env records the **peer address the request came from** + N as the entry base URL and dials it from then on. Starter retries register forever (30 s per-request timeout, exponential backoff 250 ms → 2 s cap); 400/405 are fatal, network/other errors retried.
3. **Boot check** (must complete within `BOOT_BUDGET_MS = 20_000` ms from the env's ready-file read-back — the env waits for the first register within that budget, then health-checks): the env calls `GET <base>/healthz` **twice** within `HEALTHZ_BUDGET_MS = 10_000` ms; both must answer **200** (any body; the env discards it). `HEALTHZ_ATTEMPTS = 2`. If no register arrives before the boot budget, or healthz does not answer twice: **boot failure** — every check 0, `working` 0, fixed note `no entry registered before the boot deadline`, `/done` true at once. A program that exits/crashes/never registers before the boot budget scores 0. A trial still running at its 900 s wall is stopped and scores 0 on every column.
4. **Conformance phase**: env runs all 120 checks in registration order — git (30), repos (15), issues (15), pulls (20), graphql (20), mcp (15), protocol (5) — **one at a time**, each with its own timeout and abort signal. Per-check timeout: default `CHECK_TIMEOUT_MS = 15_000` ms, clamped to `CHECK_TIMEOUT_MIN_MS = 5_000` .. `CHECK_TIMEOUT_MAX_MS = 15_000`, and further clamped to the phase remainder. A timed-out check is recorded 0 with detail `deadline`; the rest still run (1 s drain grace for the abandoned promise). Phase budget: `CONFORMANCE_BUDGET_MS = 240_000` ms. At the phase/internal deadline, pending checks are recorded 0 with `deadline`.
5. **Benchmark phase**: the four workloads (§4). Phase budget: `BENCHMARK_BUDGET_MS = 240_000` ms.
6. **Export + `/done`**: as soon as the export is written, `GET $MAKEFUN_ENV_URL/done` answers `{"done": true}` (before that, `{"done": false}`, answered **at once, never held** — within `DONE_ANSWER_DEADLINE_MS = 1_000` ms; the entry polls, it does not long-hold: starter polls with 30 s request timeout and exponential backoff 250 ms → 2 s, i.e. `DONE_POLL_INTERVAL_MS = 250`, `DONE_POLL_MAX_MS = 2_000` per wire.ts). **On `{"done": true}` the entry exits 0** (`ENTRY_EXIT_OK = 0`). The env keeps serving until SIGTERM (which rewrites the export only if not worse, and exits 0). Internal deadline = trial start + wall budget − `DEADLINE_MARGIN_MS = 90_000` ms (i.e. 900 s − 90 s = **810 s** after env start by default; `MAKEFUN_TRIAL_WALL_BUDGET_SEC` overrides the wall for a local run). At the internal deadline the export is written, `/done` is answered, and the process exits after a 5 s grace (`DEADLINE_EXIT_GRACE_MS = 5_000`) if the harness has not SIGTERMed it. Export phase budget: `EXPORT_BUDGET_MS = 30_000` ms.
7. **SIGTERM/SIGINT**: env installs handlers for the whole life; a signal before the listener is ready writes the boot-failure export and exits 0; a signal later aborts the trial, writes the export (never-worse rule), closes the listener, exits 0. The entry should likewise exit cleanly on SIGTERM (the harness SIGTERMs the env afterwards; the entry is expected to have already exited on `/done`).

### 5.3 Export files — WHO writes them (answered explicitly)

**The ENV writes both export files. The entry writes neither and must not touch them.**

- Location: `<stateDir>/export/state.json` and `<stateDir>/export/perf.json`, where `stateDir = $MAKEFUN_STATE_DIR` (default `/state`). Canonical JSON: keys sorted at every depth, one trailing newline (`canonicalJsonLine`). Written synchronously and atomically (temp file beside it, written + fsynced, then renamed).
- The entry has **no file to produce** under `MAKEFUN_STATE_DIR`, no exit code beyond 0 on `/done`, and no other end-of-trial signal. Its only end-of-trial duties are: keep serving until `/done` is true, then exit 0. (The starter's `main.ts` is exactly this: bind → register → poll `/done` → close server → exit 0.)
- `state.json` (`wire.ts StateFile`, `STATE_VERSION = 1`):
  ```json
  {"version": 1, "working": 0|1, "checks": {"git.…": 0|1, …120 ids…},
   "counts": {"total": 120, "passed": N, "byGroup": {"git": {"total":30,"passed":n}, …}},
   "perfTiers": {"push": 0, "clone": 0, "read": 0, "write": 0}, "notes": ["…"] }
  ```
  `perfTiers` in state.json is the **static** all-0 table (`STATIC_PERF_TIERS`) — the measured tiers live only in perf.json, so replays compare byte-identical. `notes` holds fixed causes only (e.g. the boot-failure note). A suite short of the manifest pads missing ids as `<group>.missing-<n>` with bit 0 so `counts.total` stays 120. `working = 1` iff boot ok and ≥1 check passed.
- `perf.json` (`wire.ts PerfFile`, `PERF_VERSION = 1`):
  ```json
  {"version": 1, "calibrated": true|false,
   "workloads": [{"name": "push"|"clone"|"read"|"write", "rounds": [ms, …],
                  "p50_ms": <median or 1e9>, "p99_ms": <max of 3 or 1e9>,
                  "ops": 200|50|2000|200, "points": 0..50, "error": "…" /* only when 0 */}],
   "tiers": {"push": 0..4, …}, "points": {"push": 0..50, …},
   "perf_p50_us": <int, or 1e9 when nothing measured>, "points_total": 0..200,
   "notes": ["…fixed lines…"]}
  ```
  A trial with no benchmark at all (boot failure) writes `failedPerfFile('no entry registered before the boot deadline')`: all four workloads sentinel 1e9, 0 points, `perf_p50_us` 1e9 — **never** `emptyPerfFile`'s 0 (a 0 would sort first on the tie-break).
- **Never-worse rule** (`export.ts`): an export on disk is replaced only if the new one is not worse — state: a run that works beats one that does not; among equal `working`, more passed checks wins; equal state is rewritten (same bytes). Perf: new `points_total >=` existing. So a completed run survives a later boot failure/abort in the same state dir. State is written **before** perf (a run cut between the two never pairs a new perf with an older state).
- Boot-failure export: every check 0, `working` 0, `counts` zeroed per group, note `no entry registered before the boot deadline`; perf = sentinel file above.

## 6. Ambiguities / things NOT pinned down by the files read

1. **Scenario logins/org are seed-derived, not literal.** `adaiversen` / `olgabauer` / `faint-meadow-org` do not appear as literals in `wire.ts` (grep found nothing); they are produced by the seeded generator (`buildScenario`, `scenarioRng`). The MCP checks never hard-code them — they resolve the owner from `GET /api/v3/user`. Trust the task-context values for planning, but the forge must not hard-code them either; derive ownership from the token.
2. **`server/discover` result shape is loose.** The client accepts `serverInfo` from `_meta['io.modelcontextprotocol/serverInfo']` OR top-level `serverInfo`, and `capabilities`/`supportedVersions` top-level. Safest: put `serverInfo`, `capabilities`, and `supportedVersions` **all top-level** AND mirror `serverInfo` under `_meta['io.modelcontextprotocol/serverInfo']`.
3. **Legacy parse-error status.** Modern = HTTP 400 + `-32700`; legacy = HTTP 200 + `-32700` also passes. If the server speaks modern `server/discover`, it must use 400. A server that answers 200 + `-32700` while also answering `server/discover` **fails** `mcp.parse-error`.
4. **Unknown-tool HTTP status is under-specified.** Only "never HTTP 500" is asserted; 200/400/404 with `-32602`/`-32601` all pass. Any of those is safe.
5. **`tools/list` pagination.** The client follows `nextCursor` (max 10 pages) and concatenates; a single page with no `nextCursor` is the simple path. If paginating, the byte-identical check (§3.15) compares the **concatenated** list, so pagination must be stable too.
6. **REST details the MCP checks depend on** (from `checks-mcp.ts` setup code, not from the MCP section of RULES.txt): `POST /api/v3/user/repos` must return the created repo incl. `default_branch`; `PUT .../contents/{path}` must return a `commit.sha` (used as base sha) and honour `branch`; `POST .../git/refs` is the preferred branch-creation route (contents-with-`branch` is the fallback); `GET .../git/refs/heads/{branch}` **or** `GET .../branches/{branch}` must answer 200 with a sha (ref object `{object:{sha}}`, or `{sha}`, or `{commit:{sha}}` — all three shapes are read); issue/PR list endpoints must accept `?state=all&per_page=100` and return either a bare array or `{issues:[…]}` / `{pulls:[…]}` / `{items:[…]}`.
7. **Check-timeout vs MCP 3 s budget.** A check's own timeout is up to 15 s, but each individual MCP request is capped at 3 s by the client (`min(ctx.timeoutMs, 3000)`). A single slow MCP request (>3 s) fails that check even though the check budget is larger.
8. **Calibration note.** `calibration.json` warns the T_refs were measured in the **split** layout (separate entry/env pods) while production grades on the **`pod`** layout (entry+env in one pod); per-container limits are the same and a cross-check found no consistent shape penalty, but a production-`pod` baseline re-measurement was recommended before escrow locks. T_refs as shipped are the ones scored against.
9. **RULES.txt vs checks.** RULES.txt itself says the transcript checks changed since it was written and "where the Transcript gate section here differs from them, those checks apply" — the same caveat applies in spirit to the wire sections: the **code in `sdk/conformance/` is the authority** where RULES.txt and the code differ (e.g. RULES.txt's prose "a body that is not JSON answers HTTP 400 with -32700 (200 with -32700 from a server that predates 2026-07-28)" matches the code; the code's legacy-handshake retry rule — break unless `-32602` — appears only in code).
10. **`create_repo` owner argument.** The suite sends `owner` in the `create_repo` call (from the REST-resolved login), but the documented contract is `{name, description?, private?}`. If your schema has no owner-family property, `owner` is silently dropped — fine. If it has one, it is filled with the token's login. Either way the repo must be created under the token's login.
11. **`/done` polling cadence is the entry's choice** within the wire constants (first wait 250 ms, exponential to 2 s max, 30 s request timeout in the starter). The env answers each poll at once; there is no server-push/long-hold to implement.
12. **No `GET /mcp` stream is required.** Modern era: "no GET stream: each POST is answered by one JSON body or one request-scoped SSE stream". The client only ever POSTs (plus a best-effort `DELETE` on legacy close). A `GET /mcp` handler is not exercised.
