# REST + Git contract — github-core-clone-01 conformance suite

Source files read in full (read-only task; nothing else modified):
- `sdk/conformance/checks-rest.ts` (1250 lines: header contract summary lines 1–57, helpers/fixtures lines ~330–520, check bodies lines 520–1249)
- `sdk/conformance/git-client.ts` (2144 lines, read in full)
- `sdk/conformance/rest-client.ts` (read as supporting plumbing for auth, headers, `Link` parsing, shape semantics — the checks delegate to it)

Scope note: this note covers **only** what those files assert. Which git
capabilities the server *must* advertise (v2 vs v0, `side-band-64k`,
`report-status`, `shallow`, `filter`, …) is **not** stated here — that lives
in `checks-git.ts`, which was out of scope for this task. `git-client.ts`
only shows what the client *does* when a capability is advertised and what
it throws when a requested feature is missing. See §7 Ambiguities.

Scenario (given, not re-derived): viewer login `adaiversen` (id 1000),
stranger `olgabauer` (1002), org `faint-meadow-org`. Bearer token is the
opaque `MAKEFUN_SHOP_TOKEN`. REST prefix `/api/v3`. All seeded names, paths,
blobs, messages, titles come from `wire.ts` (`restScenarioOf`); two runs send
byte-identical requests in the same order.

---

## 0. Global rules (apply to every REST reply)

- **Auth:** `Authorization: Bearer <token>`; no token = unauthenticated.
  Client default `Accept: application/vnd.github+json`; `Content-Type:
  application/json` on every request carrying a body. Per-call timeout
  5000 ms in `RestClient`, clamped to 1000–5000 ms by the check harness
  (`clientSet`). Redirects are followed by the REST client; git requests use
  `redirect: 'error'`.
- **`expectJsonResponse` (every check):** exact status (never a range — an
  expectation names one status or an explicit list), content type must be
  JSON, body must parse as JSON, body must match the stated shape, and the
  body must not be HTML (`text/html` content type, or a body starting with
  `<`, fails). Transport failure / timeout surfaces as status `0` and fails.
- **JSON content type** (`isJsonContentType`): `application/json`,
  `application/vnd.github+json`, or any `application/*+json`, with an
  optional `;charset=…` parameter. Anything else fails.
- **Errors:** `{"message": string}` with a **non-empty** string
  (`messageShape`). 4xx bodies are `{"message": string, ...}`.
- **Request id:** every reply must carry a **non-empty**
  `X-GitHub-Request-Id` header (see `protocol.request-id`).
- **Content type:** every reply must be `application/json`, never HTML (see
  `protocol.content-type-json`).
- **No rate-limit headers required** (explicitly: "no X-RateLimit-* header is
  required").
- **Shape semantics (`checkShape`):** `shapes.object({...})` requires every
  listed property to be present and correctly typed, but **extra properties
  are allowed** (rejected only when `allowExtra === false`, which no check
  here uses). So returning extra fields is safe; omitting a listed field is
  not. `shapes.string({oneOf:[...]})` asserts exact equality;
  `shapes.string({pattern: SHA40})` asserts the regex.
- **SHA:** `SHA40 = /^[0-9a-f]{40}$/i`; `shaShape()` = non-empty string
  matching it. Comparisons in the checks are case-insensitive
  (`lower()` on both sides) unless noted.
- **Path building (`apiPath`):** segments are percent-encoded per `/`-separated
  piece, so a file path like `docs/readme.md` keeps its `/`s:
  `apiPath('repos', owner, repo, 'contents', 'docs/readme.md')` →
  `/api/v3/repos/<owner>/<repo>/contents/docs/readme.md`.
- **Base64:** standard alphabet, UTF-8 bytes. Decoding strips
  `[\r\n\t ]` first (GitHub-style wrapped base64 is accepted on read).

---

## 1. Shared shapes and fixtures

### 1.1 Shapes

| Shape | Fields |
|---|---|
| `messageShape` | `{message: string (non-empty)}` |
| `labelShape` | `{name: string (non-empty)}` |
| `issueShape` | `{number: int ≥ 1, title: string, body: string, state: "open" \| "closed", labels: [{name: string (non-empty)}]}` — `labels` is an array of `labelShape` |
| `pullShape` | `{number: int ≥ 1, state: "open" \| "closed", title: string, body: string, head: {ref: string (non-empty), sha: sha40}, base: {ref: string (non-empty), sha: sha40}}` |
| `pullFileShape` | `{filename: string (non-empty), status: string (non-empty), additions: int ≥ 0, deletions: int ≥ 0, changes: int ≥ 0}` |
| `contentCommitShape` | `{content: {sha: sha40, encoding: "base64"}, commit: {sha: sha40}}` |
| File content entry (GET contents) | `{type: "file", encoding: "base64", content: string, sha: sha40, size: int ≥ 0}` |
| Directory entry (GET contents on a dir) | `{type: "file" \| "dir", name: string (non-empty), path: string (non-empty), sha: sha40}` |
| Branch entry | `{name: string (non-empty), commit: {sha: sha40}}` |
| Commit list entry | `{sha: sha40, commit: {message: string}}` |
| Comment | `{id: int ≥ 1, body: string}` |

### 1.2 Fixtures (how every check sets up state — the server must support these flows)

- **`prepareRepo(set, id, {private?, description?, filePath?, content?})`:**
  1. `POST /api/v3/user/repos` `{name: "<repoPrefix>-<slug(id)>" (≤100 chars), private: <default true>, description: <scenario.description>}` → **201** `{name: == name, private: boolean}`.
  2. `PUT /contents/<filePath>` with the scenario file (see §2.5) → **201** — **an unborn repository must accept a contents PUT** (no prior commit / no `git/refs` needed first).
  3. `GET /api/v3/repos/<owner>/<name>` → **200** `{default_branch: string (non-empty)}`.
  Returns `{owner, name, path: "/api/v3/repos/<owner>/<name>", defaultBranch, initialCommitSha}`.
- **`putContent(set, repo, {filePath, content, message, branch?, sha?})`:** `PUT /api/v3/repos/<owner>/<name>/contents/<filePath>` with JSON body `{message, content: base64(content)}` plus `branch` and/or `sha` only when supplied. Unasserted by itself; callers pick the expected status.
- **`getContent(set, repo, filePath, ref?)`:** `GET .../contents/<filePath>[?ref=<ref>]` → **200**, file-entry shape above.
- **`createBranch(set, repo, branch, sha)`:** `POST <repo.path>/git/refs` `{ref: "refs/heads/<branch>", sha}` → **201** `{ref: == "refs/heads/<branch>", object: {sha: sha40}}`.
- **`commitOnBranch(set, repo, {branch, filePath, content, message, update?})`:** if `update === true`, first `GET` contents on that branch to fetch the current blob sha, then `PUT /contents/<filePath>` with `{message, content: base64, branch, sha}` → expected status **[200, 201]**; otherwise (new file on the branch) `PUT` with `{message, content: base64, branch}` (no `sha`) → **201**.
- **`prepareIssueRepo(set, id)`:** `prepareRepo`, then `POST <repo.path>/labels` `{name: <scenario.label>, color: "ededed"}` → **201** `labelShape`. Returns `{repo, label}`.
- **`preparePull(set, id, files?)`:** `prepareRepo`; create head branch `"<branchName>-<slug(id)>"` at `initialCommitSha`; commit one file per entry in `files` (default: one file, path = `variantPath(filePath, slug(id))`, content = `fileContentAlt`) on the head branch; `POST <repo.path>/pulls` `{head, base: <defaultBranch>, title: <pullTitle>, body: <pullBody>}` → **201** `pullShape`. Returns `{repo, head, base: <defaultBranch>, number, headCommitSha (tip after the last commit), changedPaths}`.
  - `variantPath(path, suffix)`: inserts `-<suffix>` before the extension, e.g. `docs/readme.md` + `alt` → `docs/readme-alt.md`; no extension → `docs/readme-alt`.
- **`secondBranchPull(set, repo, id)`:** head branch `"<branchName>-<slug(id)>-b"` from `initialCommitSha`, one commit (variant path `…-<slug(id)>-b`, content `fileContentAlt`), then a PR. Returns its number.
- **`createIssue(set, repo, {title, body, labels?})`:** `POST <repo.path>/issues` → **201** `issueShape`.
- **`listIssues(set, repo, query)`:** `GET <repo.path>/issues?<query>` → **200** array of `issueShape`.
- **`setIssueState(set, repo, number, state)`:** `PATCH <repo.path>/issues/<number>` `{state}` → **200** `{number: int ≥ 1, state: oneOf [<state>]}` (only `number` + `state` asserted in the shape).
- **`createPull(set, repo, {head, base, title, body})`:** `POST <repo.path>/pulls` → **201** `pullShape`.
- **`mergePull(set, repo, number)`:** `PUT <repo.path>/pulls/<number>/merge` `{merge_method: "squash"}` — **note: every merge in the suite is a squash merge**. Callers assert the status/body.
- **`mergedPull(set, id)`:** `preparePull`, then `mergePull` → **200** `{merged: boolean, sha: sha40, message: string}`, and `merged === true`. Returns `{fixture, mergeSha}`.

---

## 2. Repos group — 15 checks

### `repos.root` — GET /api/v3/
- `GET /api/v3/` → **200**, JSON, loose object (any object; no required fields).
- Header `x-oauth-scopes` must be **present** (value not asserted).

### `repos.meta` — GET /api/v3/meta
- `GET /api/v3/meta` → **200** `{"installed_version": string (non-empty)}`.

### `repos.create` — POST /user/repos + GET round-trip
- `POST /api/v3/user/repos` `{name, private: true, description: <scenario.description>}` → **201** `{name: == <name>, private: boolean}`; additionally `body.private === true` is asserted separately (fail if not `true`).
- `GET /api/v3/repos/<owner>/<name>` → **200** `{name: string, private: boolean, default_branch: string (non-empty)}`; `name` and `private === true` asserted again.
- Second `GET` of the same repo → **200** `{default_branch: string (non-empty)}`; **`default_branch` must be identical across the two reads** (stability asserted; the value itself is not prescribed — any non-empty string).

### `repos.not-found` — GET missing repo
- `GET /api/v3/repos/<owner>/<repoPrefix>-never-created` → **404** `messageShape`.

### `repos.patch` — PATCH repo description
- Setup: `prepareRepo('repos-patch')`.
- `PATCH <repo.path>` `{description: <descriptionAlt>}` → **200** `{description: == <descriptionAlt>}`.
- `GET <repo.path>` → **200** `{description: == <descriptionAlt>}` (persisted).

### `repos.delete` — DELETE repo
- Setup: `prepareRepo('repos-delete')`.
- `DELETE <repo.path>` (no body) → **204** (status only; no body asserted).
- `GET <repo.path>` afterwards → **404** `messageShape`.

### `repos.pagination` — GET /user/repos, Link rel="next" (runs FIRST)
- Creates the 30 seeded repos (`scenario.repos`, names from `paginationRepos`): for each, `POST /api/v3/user/repos` `{name, private: true, description}` → **201** accepted, **or 422 accepted** (comment: "A 422 means an earlier group already created this seeded repository … accept it as long as the repository is there to be listed"); any other status fails. Each is then verified present via `GET /api/v3/repos/<owner>/<name>` → **200** `{name: == <name>}`.
- Walk: start at `GET /api/v3/user/repos?per_page=10` (absolute URL built by the client), then follow `Link` header `rel="next"`:
  - Each page → **200**, array of `{name: string (non-empty)}`; **≤ 10 items per page** with `per_page=10` (fail if more).
  - `Link` header format: GitHub style `<url>; rel="next"` (parsed by regex `/<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/` over comma-separated parts; relations `next|prev|first|last`). **Every `next` URL must stay on the entry's origin** (same scheme+host+port as the base URL) — fail otherwise.
  - Walk ends when there is no `rel="next"`; **must end within 20 pages**.
  - **No repository name may repeat** across pages (unique count == total count).
  - **All 30 seeded names must appear** somewhere in the walk.
  - **At least 3 pages** must be served for 30 repos at `per_page=10` (i.e. do not return everything on 1–2 pages; honour `per_page`).
  - Note: other checks' repos created before this check runs would also be listed — the check only requires the 30 to be reachable; it runs first precisely so the count stays tight.

### `repos.branches` — GET /branches
- Setup: `prepareRepo('repos-branches')`; create branch `"<branchName>-branches"` at `initialCommitSha` via `POST /git/refs` (see §1.2).
- `GET <repo.path>/branches` → **200**, array of `{name: string (non-empty), commit: {sha: sha40}}`.
- List **must include** the created branch **and** the default branch.
- The created branch's `commit.sha` (case-insensitive) **must equal `initialCommitSha`**.

### `repos.commits` — GET /commits?sha=… vs default
- Setup: `prepareRepo('repos-commits')`; create branch `"<branchName>-commits"` at `initialCommitSha`; commit one file on it (variant path `…-commits`, content `fileContentAlt`, message `"<commitMessage> (commits)"`).
- `GET <repo.path>/commits?sha=<branch>` → **200**, array of `{sha: sha40, commit: {message: string}}`.
  - Must contain the new commit's sha (case-insensitive).
  - That entry's `commit.message` must equal `"<commitMessage> (commits)"` exactly.
- `GET <repo.path>/commits` (no query) → **200**, array of `{sha: sha40}`.
  - Must **NOT** contain the branch-only commit sha (before any merge, the default branch must not list it).

### `repos.unauthorized` — no token
- Setup: `prepareRepo('repos-unauthorized', {private: true})`.
- `GET <repo.path>` with the **anonymous** client (no `Authorization` header) → **401** `messageShape`.

### `repos.foreign-token` — same name under another owner
- Create repo `<repoPrefix>-repos-foreign` as the viewer (`POST /user/repos`, private) → **201**; owner read `GET /api/v3/repos/<owner>/<name>` → **200** `{name: == <name>}`.
- `GET /api/v3/repos/<otherOwner>/<name>` (same name under `olgabauer`) with the viewer's token → **404** `messageShape` — **never 403**.

### `repos.contents-create` — PUT then GET file
- Setup: `prepareRepo('repos-contents-create')`.
- `PUT /contents/<variantPath(filePath, "created")>` `{message: <commitMessage>, content: base64(fileContentAlt)}` → **201** `contentCommitShape` (`content: {sha, encoding: "base64"}`, `commit: {sha}`).
- `GET /contents/<same path>` → **200** file-entry shape:
  - `b64decode(content)` **must equal** `fileContentAlt` exactly.
  - `sha` (case-insensitive) **must equal the PUT's `content.sha`** — i.e. the GET sha is the **blob/content sha**, not the commit sha.
  - `size` **must equal `Buffer.byteLength(fileContentAlt, 'utf8')`** (byte length, not character length).

### `repos.contents-directory` — GET contents on a directory
- Setup: `prepareRepo('repos-contents-dir', {filePath: "<dirPath>/seed.txt"})` — the repo's seed file is inside the directory.
- `PUT /contents/<dirPath>/one.txt` and `PUT /contents/<dirPath>/two.txt` (content `fileContentAlt`, messages `"<commitMessage> (one.txt)"` / `"… (two.txt)"`) → each **201** `contentCommitShape`.
- `GET /api/v3/repos/<owner>/<name>/contents/<dirPath>` → **200**, **array** (not an object) of directory entries `{type: "file" | "dir", name: non-empty, path: non-empty, sha: sha40}`.
- The listed `name`s must include **`one.txt`, `two.txt`, and `seed.txt`**.

### `repos.contents-stale-sha` — PUT update, then stale sha → 409
- Setup: `prepareRepo('repos-contents-stale')`.
- `GET` the seed file → current `{sha}`.
- `PUT /contents/<filePath>` `{message, content: base64(fileContentAlt), sha: <current sha>}` → expected status **[200, 201]** (either accepted), `contentCommitShape`; the returned `content.sha` **must differ** from the old sha (case-insensitive).
- `PUT /contents/<filePath>` `{message, content: base64(fileContent), sha: <old/current-before-update sha>}` → **409** `messageShape`.

### `repos.contents-delete` — DELETE file
- Setup: `prepareRepo('repos-contents-delete')`.
- `GET` the seed file → `{sha}`.
- `DELETE /contents/<filePath>` with JSON body `{message: <commitMessage>, sha: <entry.sha>}` → **200** `{commit: {sha: sha40}}`.
- `GET /contents/<filePath>` afterwards → **404** `messageShape`.

---

## 3. Issues group — 15 checks

Setup for all: `prepareIssueRepo` = fresh repo + `POST /labels {name: <label>, color: "ededed"}` → **201** `{name: non-empty}`. (Only `name` is asserted on the label response; `color` is sent but not checked.)

### `issues.create`
- `POST <repo.path>/issues` `{title: <issueTitle>, body: <issueBody>, labels: [<label>]}` → **201** `issueShape`; `state` **must be `"open"`**.

### `issues.create-title-body`
- Same POST without `labels` → **201**; `title` must equal `issueTitle` exactly; `body` must equal `issueBody` exactly.

### `issues.create-labels`
- POST with `labels: [<label>]` → **201**; the response `labels[].name` list **must include** `<label>`.

### `issues.numbers-increment`
- Create two issues (`"<issueTitle> 1"`, `"<issueTitle> 2"`) in the same repo → second `number` **must equal first `number` + 1** (per-repo sequential numbering, starting anywhere ≥ 1).

### `issues.list-open`
- Create one open issue and one issue then closed via `PATCH {state: "closed"}` → **200** (see `setIssueState`).
- `GET <repo.path>/issues?state=open&per_page=100` → **200** array of `issueShape`; must list the open issue; **every** listed issue must have `state === "open"`.

### `issues.list-open-excludes-closed`
- Create one issue, close it, then `GET .../issues?state=open&per_page=100` → **200**; the closed issue's number **must not** appear.

### `issues.list-sort-asc`
- Create three issues (`a`, `b`, `c` suffixes) in order.
- `GET .../issues?state=open&sort=created&direction=asc&per_page=100` → **200**; all three numbers present; their positions must be strictly increasing `pos(a) < pos(b) < pos(c)`.

### `issues.list-sort-desc`
- Same setup; `GET ...?state=open&sort=created&direction=desc&per_page=100` → **200**; positions strictly `pos(c) < pos(b) < pos(a)` (newest first).

### `issues.list-shape`
- Create one issue; `GET .../issues?state=open&per_page=10` → **200**; list must be **non-empty**; every item must match `issueShape` exactly (re-checked per item).

### `issues.get-one`
- `GET <repo.path>/issues/<number>` → **200** `issueShape`; `number`, `title`, `body` must all equal the created issue's values exactly.

### `issues.patch-close`
- `PATCH <repo.path>/issues/<number>` `{state: "closed"}` → **200** `{number: int ≥ 1, state: oneOf ["closed"]}`; `state` must be `"closed"`.

### `issues.patch-close-persists`
- Close as above, then `GET <repo.path>/issues/<number>` → **200** `issueShape`; `state` must still be `"closed"`.

### `issues.comment-create`
- `POST <repo.path>/issues/<number>/comments` `{body: <commentBody>}` → **201** `{id: int ≥ 1, body: == <commentBody>}`.

### `issues.comments-list`
- Post a comment as above → **201**, capture its `id`.
- `GET <repo.path>/issues/<number>/comments` → **200**, array of `{id: int ≥ 1, body: string}`; must contain an entry with that `id` **and** `body == <commentBody>`.

### `issues.bad-label`
- `POST <repo.path>/issues` `{title, body, labels: ["<label>-not-a-label"]}` (a label that was never created) → **422** `messageShape`.

---

## 4. Pulls group — 20 checks

Setup for most: `preparePull` (§1.2) — repo + head branch one commit ahead of default + open PR (`POST /pulls {head, base: <defaultBranch>, title: <pullTitle>, body: <pullBody>}` → **201** `pullShape`).

### `pulls.create`
- `GET <repo.path>/pulls/<number>` → **200** `pullShape`; `state === "open"`; `head.ref === <head branch name>`; `base.ref === <defaultBranch>`.

### `pulls.create-body`
- Same GET; `title === <pullTitle>` and `body === <pullBody>` exactly.

### `pulls.create-head-sha`
- Same GET; `head.sha` (case-insensitive) **must equal `headCommitSha`** (the head branch tip after the fixture commit).

### `pulls.create-base-sha`
- Same GET; `base.sha` (case-insensitive) **must equal `initialCommitSha`** (the base branch tip at PR creation).

### `pulls.get-one`
- `GET <repo.path>/pulls/<number>` → **200** `pullShape`; `number` and `title` must equal the fixture's.

### `pulls.files-list`
- `GET <repo.path>/pulls/<number>/files` → **200**, array of `pullFileShape`.
- Must list the fixture's changed path (`changedPaths[0]`); its `status` must be one of **`"added"`, `"modified"`, `"changed"`**; its `additions` must be **≥ 1**.

### `pulls.files-shape`
- Same GET; list must be **non-empty**; every item re-checked against `pullFileShape`.

### `pulls.files-multiple`
- Fixture with **two** files (`variantPath(filePath, "multi-a")` with `fileContentAlt`, `variantPath(filePath, "multi-b")` with `fileContent`, two commits on the head branch).
- `GET .../pulls/<number>/files` → **200**; the `filename` list must include **both** paths.

### `pulls.merge-status`
- `PUT <repo.path>/pulls/<number>/merge` `{merge_method: "squash"}` → **200** (status only).

### `pulls.merge-body`
- Same merge → **200** `{merged: boolean, sha: sha40, message: string}`; `merged === true`; the `sha` must match `SHA40` (40 hex chars). This is the merge commit sha used by the checks below.

### `pulls.merge-closes`
- After merge, `GET <repo.path>/pulls/<number>` → **200** `{state: oneOf ["closed"], merged: boolean, merged_at: string (non-empty)}`; `merged === true`. (Shape asserts only those three fields; `number`/`title` etc. are not re-asserted here.)

### `pulls.merge-commit-on-default`
- After merge, `GET <repo.path>/commits?sha=<base (defaultBranch)>` → **200** array of `{sha: sha40}`; must contain the **merge commit sha** (case-insensitive).

### `pulls.merge-content-on-default`
- After merge, `GET <repo.path>/contents/<changedPath>?ref=<base>` → **200** file entry; `b64decode(content)` **must equal `fileContentAlt`** — i.e. the squash-merged content must be visible on the default branch at that path. (The fixture's head commit wrote `fileContentAlt` to that path.)

### `pulls.merge-commit-sha`
- After merge, `GET <repo.path>/pulls/<number>` → **200** `{merge_commit_sha: sha40}`; it (case-insensitive) **must equal the merge sha** returned by the merge call.

### `pulls.merge-unknown`
- `PUT <repo.path>/pulls/999999999/merge` `{merge_method: "squash"}` on a repo with no such PR → **404** `messageShape`.

### `pulls.merge-conflict`
- Repo with two branches from `initialCommitSha`: `<branchName>-conflict-a` and `<branchName>-conflict-b`. Both commit to the **same** `filePath` with **different** contents (`"<fileContentAlt> (a)"` vs `"<fileContentAlt> (b)"`, `update: true` so the blob sha is sent). Two PRs, one per branch, same base.
- Merge the first PR → **200**.
- Merge the second PR → **405** `messageShape` (conflict; note: 405, not 409).

### `pulls.list-state-all`
- One merged PR + one open PR (via `secondBranchPull`) in the same repo.
- `GET <repo.path>/pulls?state=all&per_page=100` → **200** array of `pullShape`; the `number` list must include **both** PR numbers.

### `pulls.list-default-open`
- Same setup (one merged, one open).
- `GET <repo.path>/pulls?per_page=100` (**no `state` param**) → **200** array of `pullShape`; must **NOT** list the merged PR number; **must** list the open PR number. (Default state is open-only.)

### `pulls.list-shape`
- `GET <repo.path>/pulls?state=all&per_page=10` → **200**; list **non-empty**; every item matches `pullShape`.

### `pulls.get-unknown`
- `GET <repo.path>/pulls/999999999` → **404** `messageShape`.

---

## 5. Protocol group — REST share (5 of the manifest's 10)

### `protocol.content-type-json`
Six calls, each must return a **non-`0` status**, a JSON content type, and no HTML:
1. `GET /api/v3/`
2. `GET /api/v3/meta`
3. `GET <repo.path>` (existing repo)
4. `GET <repo.path>/issues`
5. `GET /api/v3/no-such-route-content-type` (unknown route)
6. `GET <repo.path>` **without a token** (anonymous)

### `protocol.unknown-route-json-404`
- `GET /api/v3/no-such-route/<repoPrefix>` → **404** `messageShape`, and not HTML.

### `protocol.malformed-body-400`
- `POST /api/v3/user/repos` with **raw body** `{"name":` (truncated JSON) and header `Content-Type: application/json` → **400** `messageShape`.

### `protocol.request-id`
Four calls, each must return a **non-`0` status** and a **non-empty** `X-GitHub-Request-Id` header:
1. `GET /api/v3/`
2. `GET <repo.path>`
3. `GET /api/v3/no-such-route-request-id` (unknown route)
4. `GET <repo.path>` **without a token**

### `protocol.error-message`
- `GET` a missing repo → **404** `messageShape`.
- `GET` a private repo without a token → **401** `messageShape`.
- `POST` an issue with the unknown label (`<label>-not-a-label`) → **422** `messageShape`.

---

## 6. Git wire contract (from `git-client.ts`)

### 6.1 Transport, paths, pkt-line codec

- **Repo path:** `/<owner>/<repo>.git`; owner and repo must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` and repo must not end in `.git`.
- **HTTP:** `User-Agent: makefun-git-client/1.0`; `Authorization: Bearer <token>` when a token is set; `redirect: 'error'`; per-call timeout default **8000 ms** (`DEFAULT_GIT_TIMEOUT_MS`).
- **pkt-line:** each packet is 4 ASCII hex length bytes (length **including** the 4 header bytes) + payload. Control packets: `0000` flush, `0001` delim, `0002` response-end; `0003` is invalid; max packet **65520** bytes total / **65516** payload (`PKT_LINE_MAX` / `PKT_LINE_MAX_PAYLOAD`). A malformed header, a length over the max, or a truncated stream throws (`GitProtocolError`); trailing bytes after `finish()` are an error. The decoder also supports a **raw fallback**: if the next 4 bytes are not hex, the rest is treated as unframed bytes (v0 fetch without sideband).
- **Object ids:** only lowercase 40-hex SHA-1 is accepted (`isObjectId`: `/^[0-9a-f]{40}$/`). Object format is `sha1` only — a server advertising any other `object-format` makes the client throw.
- **Object hashing:** SHA-1 over `"<type> <size>\0" + bytes`. Types: `commit` 1, `tree` 2, `blob` 3, `tag` 4. Tree entries are `<mode> <name>\0<20-byte oid>`, sorted in git order (a directory compares as if its name ended in `/`); modes are octal strings (`100644`, `40000`, `160000` gitlink — skipped in reachability walks). Commit bytes: `tree …`, `parent …` (0+), `author …`, `committer …`, blank line, message. The client's own generated commits/tags use identity `Conformance <conformance@make.fun>`, timestamp `1700000000`, timezone `+0000` (deterministic bytes).
- **Packfile read:** must start `PACK`, version **2 or 3 only**, then BE32 object count, then entries, then a 20-byte trailer = SHA-1 of all preceding bytes. Entry header is a type/size varint; type codes 1 commit, 2 tree, 3 blob, 4 tag, **6 OFS_DELTA, 7 REF_DELTA**. Each entry's zlib stream must inflate to exactly its declared size; stray bytes before the trailer are an error; delta cycles are an error; a REF_DELTA base must be in the pack or supplied by the caller (`haveObjects`) — otherwise the read throws. **A pack whose trailer does not match its bytes throws** (`pack-checksum`); the client never accepts a corrupt pack.
- **Packfile write (client pushes):** plain objects only, **no deltas**; header `PACK` + version 2 + BE32 count; each object = type/size varint + zlib-deflated bytes; trailer = SHA-1 of everything before it. Object order is the caller's; git does not require a particular order.

### 6.2 info/refs + advertisement parsing

- **Request:** `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack` (or `git-receive-pack`), `Accept: */*`.
  - For `git-upload-pack` with protocol preference `auto` or `2`: header `Git-Protocol: version=2` is sent. For `git-receive-pack`, or preference `0`: **no** `Git-Protocol` header.
  - Non-200: `infoRefs` returns `{status, contentType, packets: [], bodySnippet}` without throwing (checks use this to prove a missing repo is 404 and the server stays healthy); `advertisement()` throws `GitHttpError` on non-200.
  - On 200, content type must contain `application/x-<service>-advertisement` (e.g. `application/x-git-upload-pack-advertisement`); otherwise the client throws.
- **Service preamble:** an optional first pkt-line `# service=<service>` is detected and skipped.
- **v2 advertisement:** first line exactly `version 2` (or starting `version 2 `). Remaining lines are capability lines, `key=value` or bare `key`. If `object-format` is present and is not `sha1`, the client throws.
- **v0 advertisement:** lines `<oid> <ref>`, with capabilities after a NUL on the **first** line only, space-separated `key=value` / bare `key` tokens.
  - Peeled tags: a line `<oid> <ref>^{}` attaches `peeled: <oid>` to the base ref.
  - The empty repo's pseudo-ref `capabilities^{}` is **skipped** (not a real ref).
  - A ref with the all-zero oid (`000…0`) is marked `unborn: true`.
  - `HEAD`'s symref target comes from the capability `symref=HEAD:<target>` (e.g. `symref=HEAD:refs/heads/main`); `headSymref` is that target, else `null`.
  - A line with no space, or a non-SHA-1 oid, throws.

### 6.3 ls-refs

- **v2:** `POST /<owner>/<repo>.git/git-upload-pack`, `Content-Type: application/x-git-upload-pack-request`, `Accept: application/x-git-upload-pack-result`, `Git-Protocol: version=2`. Body is pkt-lines:
  ```
  command=ls-refs\n
  agent=makefun-git-client/1.0\n        (only if server advertised `agent`)
  object-format=sha1\n                  (only if server advertised `object-format`)
  <delim 0001>
  peel\n                                (default on; off only if caller passes peel:false)
  symrefs\n                             (default on)
  unborn\n                              (only if the `ls-refs` capability value contains `unborn`)
  ref-prefix <prefix>\n                 (one per requested prefix)
  <flush 0000>
  ```
  Response lines: `<oid> <ref> [symref-target:<target>] [peeled:<oid>]`, or `unborn <ref> …`. First token must be a valid oid or the literal `unborn`; a line with no ref name throws. `headSymref` = the `HEAD` entry's `symref-target`, else `null`.
- **v0:** ls-refs is just the advertisement's ref list, **filtered client-side** by prefix. The server does **not** get a `ref-prefix` in v0 — `rawRefs` (pre-filter) is returned so checks can prove server-side prefix filtering only in v2.

### 6.4 fetch — protocol v2

- Advertisement first; if `wants` is empty, **no fetch request is sent** (empty result returned).
- **Pre-flight client-side requirements** (throw before any request): `depth` requires the `fetch` capability value to include `shallow`; `filter` requires it to include `filter`.
- **Request** (`POST .../git-upload-pack`, same content types as ls-refs, `Git-Protocol: version=2`), pkt-lines in this order:
  ```
  command=fetch\n
  agent=makefun-git-client/1.0\n        (only if advertised `agent`)
  object-format=sha1\n                  (only if advertised `object-format`)
  <delim>
  thin-pack\n                           (default on; off only if thinPack:false)
  no-progress\n                         (default on; off only if noProgress:false)
  ofs-delta\n                           (always)
  filter <filter>\n                     (only if set)
  want <oid>\n                          (each want, deduplicated, in order)
  have <oid>\n                          (each have)
  shallow <oid>\n                       (each shallow boundary)
  deepen <n>\n                          (only if depth set)
  deepen-since <unix-seconds>\n         (only if set)
  deepen-not <ref>\n                    (each)
  done\n                                (default on; off only if done:false)
  <flush>
  ```
- **Response parsing:** sections are announced by a bare line naming the section, terminated by delim/flush:
  - `acknowledgments\n` — lines `NAK`, `ready`, or `ACK <oid>` (anything else throws).
  - `shallow-info\n` — lines `shallow <oid>` / `unshallow <oid>` (anything else throws).
  - `wanted-refs\n` — lines `<oid> <ref>` (oid must be valid SHA-1).
  - `packfile\n` — **sideband packets**: first byte is the band: `1` = pack bytes, `2` = progress text, `3` = server error (throws `sideband-error`); any other band throws. An **empty packfile section (zero sideband packets) throws**.
  - `packfile-uris\n` — section name recognised; its contents are not consumed by this parser (any packet inside it falls through to the generic "unexpected packet" throw — see Ambiguities).
  - Any other section name throws (`fetch-section`).
- After the stream: pack bytes (band 1) are concatenated; trailer checksum verified (mismatch throws); if `parse !== false`, the pack is read (deltas resolved against `haveObjects` for thin packs) and every object's SHA-1 recomputed. Result fields: `protocol: 2, pack, packBytes, checksumOk, objects, deltaCount, shallow[], unshallow[], acks[], nak, ready, wantedRefs[{oid, ref}], progress`.

### 6.5 fetch — protocol v0

- **Pre-flight:** the server **must advertise `side-band-64k`** or the client throws before sending (`'v0 server does not advertise side-band-64k, so a fetch cannot be framed'`). `depth` requires the `shallow` capability.
- **Request** (`POST .../git-upload-pack`, `Content-Type: application/x-git-upload-pack-request`, `Accept: application/x-git-upload-pack-result`, **no** `Git-Protocol` header), pkt-lines in **two sections**:
  ```
  want <oid> <features>\n               (FIRST want only carries the feature list)
  want <oid>\n                          (further wants, bare)
  shallow <oid>\n                       (each shallow boundary)
  deepen <n>\n                          (only if depth set)
  deepen-since <unix-seconds>\n
  deepen-not <ref>\n
  <flush>                               (end of section 1)
  have <oid>\n                          (each have)
  done\n                                (default on)
  <flush>                               (end of section 2)
  ```
  Feature list on the first `want` (space-joined, in this order): `side-band-64k`, then `multi_ack_detailed` if advertised else `multi_ack` if advertised, then `thin-pack` if `thinPack !== false` **and** advertised, then `no-progress` (default on), then `ofs-delta` if advertised. (A single-section request is a protocol error — the client comment notes upload-pack would answer "expected to get object ID, not 'done'" — so the server must read the flush-delimited sections.)
- **Response parsing:** every pkt-line is either a sideband packet (first byte 1/2/3, as in v2) or a bare line: `shallow <oid>`, `unshallow <oid>`, `NAK`, `ACK <oid…>` (note: v0 `ACK` lines keep the remainder after `ACK ` verbatim, including any `continue`/`common` suffix). An empty packet or any other line throws (`fetch-v0`). No `ready`/`wanted-refs` in v0 (`ready` is always `false`, `wantedRefs` always `[]`).
- Pack checksum verification and parsing are identical to v2.

### 6.6 clone (client-side orchestration)

- Advertisement first. v0: refs = advertisement refs. v2: `lsRefs` with `peel: true, symrefs: true`.
- **Wants:** with `depth` or `singleBranch`: only the HEAD symref target's tip (falling back to the first `refs/heads/*`); if no tip and no depth, all `refs/heads/*`. Otherwise: **every** `refs/heads/*` and `refs/tags/*` with a non-zero oid.
- **Empty repo** (no wants): no fetch is sent; result is empty objects, `pack: null`, `checksumOk: true`.
- Otherwise one `fetch` with `{wants, depth, parse}`; result carries `protocol, refs, head (symref target), objects, pack, packBytes, checksumOk, deltaCount, shallow[], progress`.

### 6.7 push (receive-pack)

- **Advertisement first, and it must be v0:** `advertisement(owner, repo, 'git-receive-pack')`; if the server answers v2 the client throws (`'receive-pack must advertise protocol v0'`). No `Git-Protocol` header is sent for receive-pack.
- **Capabilities the client echoes** (on the first command line, after a NUL, space-joined, in this order): `report-status-v2` if advertised, else `report-status` if advertised; `side-band-64k` if advertised; `ofs-delta` if advertised; `agent=makefun-git-client/1.0` if `agent` advertised. (If the server advertises neither report-status variant, no report capability is sent — the client still parses whatever comes back, but see §6.8.)
- **Request:** `POST /<owner>/<repo>.git/git-receive-pack`, `Content-Type: application/x-git-receive-pack-request`, `Accept: application/x-git-receive-pack-result`. Body = pkt-lines of the command list, then the packfile bytes appended directly (no framing between the flush and the pack):
  ```
  <old-oid> <new-oid> <ref>\0<capabilities>\n     (first command only, if any capabilities)
  <old-oid> <new-oid> <ref>\n                      (further commands)
  <flush>
  <packfile bytes>                                  (see below)
  ```
  - `oldOid`/`newOid` may be the all-zero oid (`000…0`) for create/delete. Ref must start with `refs/`, be ≤ 200 chars, contain no whitespace/control chars — otherwise the client throws before sending.
  - **A command list that creates or updates any ref always carries a pack, even an empty one** (the client builds an empty pack with `writePack([])` when no objects are supplied — "real git's receive-pack reports 'unpacker error' for a bare command list"). A **delete-only** command list carries **no pack at all**.
  - Caller-supplied `options.objects` / `options.pack` override the built pack.
- **Response:** HTTP must be **200** with content type containing `application/x-git-receive-pack-result` (else `GitHttpError`). Body parsing:
  - With `side-band-64k`: pkt-lines, first byte = band (`1` report bytes, `2` progress, `3` error → throws). Band-1 bytes are concatenated into the report stream.
  - Without sideband: the pkt-line payloads themselves are the report stream.
- **A rejection is returned, never thrown:** an `ng` line for a ref yields `report.refs[].ok === false` with its reason; the exchange itself is HTTP 200.

### 6.8 push report-status parsing (`parsePushReport`)

- The report stream is pkt-framed if it starts with 4 hex digits (decoded as pkt-lines, data payloads joined); otherwise it is read as raw text.
- Lines (each `\n`-terminated, trailing `\r` stripped):
  - `unpack ok` → `unpackOk: true`; `unpack <anything-else>` → `unpackOk: false`, `unpackDetail: <that text>`.
  - `ok <ref>` → `{ref, ok: true, reason: "", options: {}}`.
  - `ng <ref> <reason>` → `{ref, ok: false, reason}`. **The `ng` line must contain a space after the ref** (a bare `ng <ref>` with no reason throws `push-report`).
  - `option <key>[ <value>]` → attached to the **most recent** ref entry's `options` map (report-status-v2); an `option` line with no preceding ref throws.
  - Any other line throws (`push-report`).
  - **A report with no `unpack` line at all throws** (`'report-status has no unpack line'`). An empty report (zero bytes) returns `report: null` (no throw).
- Non-fast-forward / any other refusal is therefore expected to surface as `unpack ok` + `ng <ref> <reason>` (the exact reason string is the server's; the client only requires the `ng <ref> <reason>` shape).

### 6.9 Other git-client entry points

- `createRepo(owner, name)`: `POST /api/v3/user/repos` `{name, description: "git conformance for <owner>/<name>", private: true, auto_init: false}` → **201 or 200** accepted; **422 with a body matching /already exists/i** accepted (idempotent re-run); anything else throws `GitHttpError`.
- `repoExists(owner, repo)`: true iff `infoRefs` for `git-upload-pack` returns 200.
- `postRaw(owner, repo, service, body)`: POSTs a raw body to `/<owner>/<repo>.git/<service>` with the service request/result content types, returns `{status, contentType, bodySnippet}` without validating — used by checks to hand the server a malformed pkt-line and then prove the server still serves a healthy clone afterwards.
- `infoRefs` / `advertisement` / `lsRefs` / `fetch` / `clone` / `push` all take an `AbortSignal` and a per-call timeout (default 8000 ms); a timeout throws `GitProtocolError` (`timeout`), an abort throws (`aborted`).

---

## 7. Ambiguities and things NOT asserted by the files read

1. **REST — `default_branch` value:** only non-empty + stable across reads. Any name (e.g. `main`, `master`) passes.
2. **REST — repo create response:** the header summary says `201 {name, private, default_branch, ...}`, but the code asserts only `name` + `private` on POST; `default_branch` is asserted only on the subsequent GET. Extra fields are allowed everywhere.
3. **REST — contents PUT status on update:** create expects exactly **201**; update paths accept **[200, 201]** (`repos.contents-stale-sha`, `commitOnBranch` with `update: true`). A server returning 200 for a create, or 201 for an update, is not distinguished except in the create-only checks.
4. **REST — contents PUT on a non-existent path/branch, missing `sha` on update, missing `message`/`content`, invalid base64:** no check in this file exercises these; behaviour is unspecified here.
5. **REST — DELETE contents:** the body `{message, sha}` is sent; whether the server must validate `sha` (stale-sha delete → 409?) is not checked. Response asserts only `{commit: {sha}}`.
6. **REST — labels:** `POST /labels` sends `color: "ededed"` but only `name` is asserted on the response. No check lists labels, deletes a label, or checks label colour persistence.
7. **REST — issues:** `PATCH /issues/{n}` is only exercised with `{state}`; title/body/label edits, and `GET /issues` with no `state` (default filter), `sort` other than `created`, `direction` without `sort`, and pagination of issues are not checked here. Issue `labels` on GET-one are shape-checked (array of `{name}`) but the label-attachment content is only asserted on create.
8. **REST — pulls:** the merge `message` string content is not asserted (any string). `merged_at` format is not asserted (any non-empty string). `merge_commit_sha` is asserted only after a merge. Whether a PR can be closed without merging, reopened, or merged twice, and what `PUT /merge` returns for an already-merged PR, are not checked. `pulls.list` ordering is not asserted.
9. **REST — commits/branches listing:** ordering and pagination (`per_page`, `Link`) are not asserted for `/branches` or `/commits`; only membership/content. `GET /commits` with `sha` naming a non-existent ref is not checked.
10. **REST — directory listing:** entry `sha` semantics for directories (tree sha vs blob sha) are not asserted beyond "matches SHA40"; `type` for a sub-directory entry is only required to be `"file"` or `"dir"`.
11. **REST — `GET /api/v3/`:** only a loose object + `x-oauth-scopes` presence. No field (e.g. `current_user_url`) is asserted.
12. **REST — `GET /api/v3/meta`:** only `installed_version` non-empty; its value is not prescribed.
13. **Git — required capabilities:** `git-client.ts` alone does **not** say which capabilities the server must advertise. It throws if `side-band-64k` is missing for a v0 fetch, if `shallow` is missing when `depth` is requested, and if `filter` is missing when a filter is requested — but whether the suite ever requests v2, depth, or filter, and whether the server must offer v2 at all, lives in `checks-git.ts` (not read). Do not infer a mandatory capability list from this file alone.
14. **Git — v2 `packfile-uris`:** the section name is recognised, but any packet inside it hits the generic "unexpected packet" throw in `parseV2Fetch` — the client effectively cannot consume a `packfile-uris` response. Whether the suite ever triggers it is a `checks-git.ts` question.
15. **Git — push refusal wording:** the client accepts any `ng <ref> <reason>` string; the exact reason text for non-fast-forward (e.g. `non-fast-forward`) is not asserted in this file. Likewise, whether the server must send `report-status`/`report-status-v2` at all is not stated here — but a missing `unpack` line throws, and an empty report yields `report: null`, so a server that sends no report-status would fail any check that reads `report.unpackOk`/`report.refs` (in `checks-git.ts`).
16. **Git — advertisement for a missing repo:** `infoRefs` is designed to surface the raw status (expected 404 by the checks); the exact status/body for a missing repo on the git side is asserted in `checks-git.ts`, not here.
17. **Git — `ls-refs` `ref-prefix`:** in v2 the client sends the prefixes and also filters client-side (`keep()`), so a server that ignores `ref-prefix` and returns everything would still pass `lsRefs` — but `rawRefs` is returned precisely so a check can prove server-side filtering. Whether any check does so is in `checks-git.ts`.
