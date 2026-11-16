# GraphQL contract for the forge — POST /api/graphql

Source (read in full, 2026-11-16): `kit-github-core-clone-01-kit/sdk/conformance/checks-graphql.ts` (1,318 lines, 20 checks) and `graphql-client.ts` (331 lines).
Scope: **only** what those two files require. Anything not asserted by a check is marked as such — do not over-build it, but do not under-build the header-listed surface either (see §9).

Scenario values (`viewer login "adaiversen"`, id 1000, stranger `"olgabauer"`, org `"faint-meadow-org"`) come from the task context / `wire.ts`, **not** from these two files. In the checks, the viewer is always `context.scenario.viewer.login` dynamically, the repo base name is `scenario.repos[0].name`, and all fixture text comes from `scenario.issues / pulls / blobs`. Nothing in these files hard-codes `"adaiversen"`.

---

## 1. Transport (graphql-client.ts)

- **Endpoint:** `POST {baseUrl}/api/graphql` (`GRAPHQL_PATH = '/api/graphql'`; base URL trailing slashes stripped). No GET, no query-in-URL, no persisted queries, no `extensions` sent.
- **Single operation body:** JSON object `{query: string, variables: object}`. `variables` defaults to `{}` when the caller passes none. `operationName` is **never** sent on single requests (even though every document has a named operation in its text — the server must execute a named operation from the `query` string alone).
- **Headers sent on every request:**
  - `accept: application/json`
  - `content-type: application/json`
  - `user-agent: makefun-github-core-clone-env/1`
  - `authorization: Bearer <token>` — **only when a token exists**. `GraphQLClient.withoutToken()` sends **no** `Authorization` header at all (not `Bearer null`, not empty).
- **Response envelope (single op):** JSON object `{data, errors}`. The client reads only those two keys plus HTTP status. `data` may be `null` only where a check expects it (unknown repository, §7). A body with **neither** `data` **nor** `errors` on a 2xx is a parse error.
- **Error entry shape (as read):** `{message: string, path?: (string|number)[], locations?: {line, column}[], extensions?: object}`. Only `message` is ever asserted on.
- **Timeouts:** client default 10,000 ms; per-check timeouts 8,000–15,000 ms (see §8). No check reads a clock for pass/fail.

### Error semantics — the three cases

| Situation | Required wire behaviour |
|---|---|
| Normal success | HTTP **200**, `data` = object, `errors` absent or `[]`. Any non-empty `errors` array = failure, **except** the invalid-field check. |
| GraphQL-level failure (unknown field, bad argument, etc.) | HTTP **200** with a non-empty `errors` array. **Not** an HTTP 4xx/5xx. Only `graphql.invalid-field` expects this. |
| Unauthenticated (no `Authorization` header) | HTTP **401** exactly. Checked with `query ViewerLogin`, no variables. Body content is not asserted. |

`dataOf()` (used by 18 of 20 checks) fails the check on: transport error, unparseable body, HTTP status ≠ 200, any `errors` entry, or `data` not a non-null object.

### Batching (GitHub operation batching)

- **Request:** one HTTP POST whose body is a **JSON array** of operation objects: `[{query, variables?}, …]`. Each entry is `{query, variables: {}}` plus `operationName` **only if the caller supplied one** (the batch check supplies none).
- **Response:** HTTP **200** with a **JSON array of the same length, in the same order**, each entry a normal `{data, errors}` envelope. A single object (non-array) body = parse failure.
- The batch check sends exactly 2 ops: `ViewerLogin` then `Issue_fields` (`__type(name:"Issue")`), and asserts op 1 returns `viewer.login == <viewer>` and op 2 returns a non-empty `Issue.fields` list. No check batches mutations or mixed success/failure ops.

---

## 2. The 18 documents — verbatim

All documents are fixed template strings; nothing is built at run time. Variables are always passed separately (never interpolated into the query text), except the inline literals noted below.

### Q1 — `ViewerLogin`
```graphql
query ViewerLogin {
  viewer {
    login
  }
}
```
No variables.

### Q2 — `RepositoryFields`
```graphql
query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}
```

### Q3 — `Issue_fields` (gh feature-detection probe)
```graphql
query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```
Note the **alias `Issue:`** — the response key is `Issue`, not `__type`. `includeDeprecated: true` argument must be accepted.

### Q4 — `PullRequestAndRepositoryFields` (two probes, one document)
```graphql
query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

### Q5 — `SearchType_enumValues`
```graphql
query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}
```

### Q6 — `OpenIssues`
```graphql
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}
```
Inline enum list `states: [OPEN]` and inline input object `orderBy: {field: CREATED_AT, direction: DESC}` — the server must parse inline enums and inline input objects, not only variables.

### Q7 — `IssueByNumber`
```graphql
query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}
```

### M1 — `IssueCreate`
```graphql
mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}
```
Variables: `{input: {repositoryId, title, body}}`.

### M2 — `IssueClose`
```graphql
mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}
```
Variables: `{input: {issueId}}` — `issueId` is the **global id** read back via `IssueByNumber`.

### Q8 — `PullRequests`
```graphql
query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}
```

### Q9 — `PullRequestFiles`
```graphql
query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}
```

### Q10 — `PullRequestId` (minimal read for a mutation input)
```graphql
query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}
```

### M3 — `PullRequestCreate`
```graphql
mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}
```
Variables: `{input: {repositoryId, baseRefName, headRefName, title}}` (no `body` in the input — the mutation takes no body).

### M4 — `MergePullRequest`
```graphql
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}
```
Variables: `{input: {pullRequestId, mergeMethod: "SQUASH"}}`.

### M5 — `AddComment`
```graphql
mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}
```
Variables: `{input: {subjectId, body}}` — `subjectId` is the issue's **global id** read via `IssueByNumber`.

### Q11 — `ViewerInvalidField`
```graphql
query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}
```

### Q12 — `NodeRepository`
```graphql
query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}
```
Requires `Query.node`, the `Node` interface (or equivalent), and an **inline fragment** `... on Repository`.

### Q13 — `IssuesPage`
```graphql
query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```
`$after` is nullable (`String`, not `String!`); the first page passes `after: null` explicitly. The server must accept an explicit JSON `null` variable.

---

## 3. Per-check assertions (20 checks, in table order)

| # | Slug / timeout | What is asserted (exact) |
|---|---|---|
| 1 | `viewer-login` / 8 s | `viewer.login` is a non-empty string **equal to the token owner's login** (`scenario.viewer.login`). |
| 2 | `repository-fields` / 10 s | On the fixture repo: `repository.id` == id read when the fixture was built; `databaseId` == fixture databaseId (positive int); `name` == fixture repo name; `owner.login` == viewer; `viewerPermission` ∈ {`ADMIN`,`MAINTAIN`,`WRITE`,`TRIAGE`,`READ`} (any one passes — the check does **not** demand `ADMIN`); `hasIssuesEnabled` === `true` (exactly, not truthy). `defaultBranchRef.name` == default branch **only when the git adapter is installed** (`branchesAvailable`); otherwise that sub-assertion is skipped. |
| 3 | `introspection-issue` / 8 s | `Issue.fields` (via alias `Issue`) is non-empty and its `name`s include **all of** `id, number, title, state, body`. |
| 4 | `introspection-types` / 10 s | Two requests. (a) `PullRequest.fields` non-empty, includes `id, number, headRefName, baseRefName, mergeable, state, merged, files`. (b) `Repository.fields` non-empty, includes `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`. (c) `SearchType.enumValues` non-empty and includes `ISSUE`. |
| 5 | `issues-open-order` / 12 s | `issues(first: 10, states: [OPEN], orderBy CREATED_AT DESC).nodes`: non-empty; ≤ 10 nodes; every node `state` === `OPEN`; every node has a string `title` and non-empty string `id`; `number` is a positive int; numbers are in **non-increasing order** (check fails only if a later number is *greater* than the previous — strictly decreasing is the practical meaning since numbers are unique); the fixture **closed** issue must **not** appear; **all 3** fixture open issues must appear. Extra open issues (e.g. the one check 7 creates) are **tolerated**. |
| 6 | `issue-by-number` / 10 s | `repository.issue(number: <first open fixture #>)`: `number` matches; `state` === `OPEN`; `title` === exactly `"<titlePrefix> open 1"`; `body` === exactly the seeded body (`scenario.issues[0].body`); `id` non-empty string. |
| 7 | `create-issue` / 12 s | `createIssue.issue.number` positive int; `.id` non-empty. **Cross-surface:** `GET /api/v3/repos/{o}/{r}/issues/{number}` must return 200 with same `number`, same `title`, `state` == `"open"` (lowercase REST form). |
| 8 | `close-issue` / 12 s | Issue first created over REST, global id fetched via `IssueByNumber`. `closeIssue.issue.number` matches; `.state` === `CLOSED`. (`.id` is requested but **not** asserted here.) **Cross-surface:** REST GET shows `state` == `"closed"`. |
| 9 | `pull-requests-list` / 15 s | `pullRequests(first: 5).nodes`: ≤ 5 nodes; contains the fixture PR (created over REST from `pulls[0].head`); that node has `headRefName` == `pulls[0].head`, `baseRefName` == default branch, `state` === `OPEN`, `mergeable` ∈ {`MERGEABLE`,`CONFLICTING`,`UNKNOWN`} (any one passes). |
| 10 | `pull-request-files` / 12 s | `pullRequest(number: <fixture PR #>).number` matches; `files(first: 10).nodes[].path` includes `blobs[0].path`. Nodes with empty/non-string `path` are ignored when collecting. |
| 11 | `create-pull-request` / 15 s | Input head = `pulls[1].head`, base = default branch. `createPullRequest.pullRequest.number` positive int; `.id` non-empty; `.state` === `OPEN`; `.headRefName` / `.baseRefName` match input. **Cross-surface:** REST `GET /pulls/{n}` has `head.ref` == head branch, `base.ref` == base branch. |
| 12 | `merge-pull-request` / 15 s | Fixture PR from `pulls[2].head` (REST), global id via `PullRequestId`. Mutation input `mergeMethod: "SQUASH"`. GraphQL: `mergePullRequest.pullRequest.merged` === `true`. **GraphQL `state` is requested but NOT asserted in this check.** **Cross-surface:** REST `GET /pulls/{n}` has `merged` === `true` **and** `state` == `"closed"`. |
| 13 | `add-comment` / 12 s | Issue created over REST, global id via `IssueByNumber`. `addComment.commentEdge.node.body` === exactly the seeded comment body (`scenario.issues[1].body`); `.id` non-empty string. **Cross-surface:** REST `GET /issues/{n}/comments` (200, array) contains an entry whose `body` equals the comment. |
| 14 | `invalid-field` / 8 s | HTTP status must be **200**; body parseable; `errors` non-empty; **at least one error `message` contains the substring `noSuchFieldOnViewer`**. `data` content is not asserted (may be null/partial). This is the **only** check that tolerates an `errors` array. |
| 15 | `unauthenticated` / 8 s | No-`Authorization` client, `ViewerLogin`: HTTP status must be **401** exactly. Body not asserted. |
| 16 | `node-repository` / 10 s | `node(id: <repo global id>)`: `node.id` === the input id; inline-fragment fields `name` == fixture repo name; `nameWithOwner` === `"<viewer>/<repo>"`. |
| 17 | `unknown-repository` / 8 s | `RepositoryFields` with `name = "<base>-graphql-missing"`, owner = viewer: `data.repository` === **`null`** exactly, with **no errors** (goes through `dataOf`, so HTTP 200 + empty errors required). |
| 18 | `batched-operations` / 10 s | Batched `[ViewerLogin, Issue_fields]`: HTTP 200; response array length **exactly 2**; entry [0] `viewer.login` == viewer; entry [1] `Issue.fields` non-empty. Order matters. |
| 19 | `global-id-stability` / 12 s | Two `RepositoryFields` reads return the **same** non-empty `id`, and it must **not** equal `String(databaseId)`. Two `IssueByNumber` reads (first open issue) return the **same** non-empty `id`, and it must **not** equal `String(number)`. |
| 20 | `issues-pagination` / 12 s | Separate repo with exactly **7** issues, `first: 5`. Page 1 (`after: null`): exactly **5** nodes; `pageInfo.hasNextPage` === `true`; `pageInfo.endCursor` non-empty string. Page 2 (`after: <page-1 endCursor>`): exactly **2** nodes; `hasNextPage` === `false`. Across both pages: **7 distinct** issue numbers, no duplicates, every number in the fixture set. **Order within/across pages is NOT asserted** — only counts, distinctness, and set membership. |

---

## 4. Fields asserted per type (consolidated)

- **Query:** `viewer`, `repository(owner:, name:)`, `node(id:)`, `__type(name:)` (with aliases).
- **User** (`viewer`, `Repository.owner`): `login` only.
- **Repository:** `id`, `databaseId`, `name`, `nameWithOwner` (only via `node` inline fragment), `owner {login}`, `defaultBranchRef {name}`, `viewerPermission`, `hasIssuesEnabled`, `issue(number: Int!)`, `issues(first:, states:, orderBy:, after:)`, `pullRequests(first:)`, `pullRequest(number:)`.
- **Issue:** `id`, `number`, `title`, `state`, `body`.
- **IssueConnection:** `nodes`, `pageInfo {hasNextPage, endCursor}`. (`edges` / `totalCount` are never requested — not required.)
- **PullRequest:** `id`, `number`, `state`, `merged`, `headRefName`, `baseRefName`, `mergeable`, `files(first:)`.
- **PullRequestConnection:** `nodes` only.
- **PullRequestChangedFile** (`files.nodes`): `path` only.
- **Node:** `id` + `... on Repository {name, nameWithOwner}`.
- **__Type:** `fields(includeDeprecated: Boolean)` → each `name`; `enumValues(includeDeprecated: Boolean)` → each `name`.
- **Mutations / payloads:**
  - `createIssue(input: CreateIssueInput {repositoryId, title, body})` → `issue {number, id}`
  - `closeIssue(input: CloseIssueInput {issueId})` → `issue {number, id, state}`
  - `createPullRequest(input: CreatePullRequestInput {repositoryId, baseRefName, headRefName, title})` → `pullRequest {number, id, state, headRefName, baseRefName}`
  - `mergePullRequest(input: MergePullRequestInput {pullRequestId, mergeMethod})` → `pullRequest {number, merged, state}` — `SQUASH` must be accepted
  - `addComment(input: AddCommentInput {subjectId, body})` → `commentEdge {node {id, body}}`

### Enums — asserted vs. header-listed only

- **Asserted by a check:** `IssueState` `OPEN`/`CLOSED` (filter + `state` values); `MergeableState` `MERGEABLE`/`CONFLICTING`/`UNKNOWN` (any accepted for `mergeable`); `RepositoryPermission` `ADMIN`/`MAINTAIN`/`WRITE`/`TRIAGE`/`READ` (any accepted for `viewerPermission`); `SearchType` must list `ISSUE` in `enumValues`; `PullRequestMergeMethod` `SQUASH` must be accepted as input.
- **Listed in the file header's schema surface but NOT asserted by any check in these files:** `IssueOrderField` `CREATED_AT`/`UPDATED_AT`/`COMMENTS` (only `CREATED_AT` is ever sent; `UPDATED_AT`/`COMMENTS` never exercised), `OrderDirection` `ASC`/`DESC` (only `DESC` sent), `PullRequestState` `OPEN`/`CLOSED`/`MERGED` (only `OPEN` asserted as a GraphQL value; `MERGED` never asserted — the merge check asserts `merged: true` + REST `state: "closed"` instead), `MergeMethod` `MERGE`/`REBASE` (never sent), `SearchType` values other than `ISSUE` (header says `ISSUE/...` — the `...` is unspecified). Implement them anyway per the header; the checks will not catch their absence except where noted.

---

## 5. Global (Relay) ids — node-id rules

**There is NO base64 requirement and NO `Type:id` format requirement anywhere in these two files.** The checks never decode an id, never check a prefix, never check for `:` or `=` characters. What is actually asserted:

1. Every `id` returned must be a **non-empty string**.
2. **Stable across repeated reads** — same repo / same issue returns the identical `id` on a second read (check 19).
3. **Opaque, not the plain numeric key** — repo `id` ≠ `String(databaseId)`; issue `id` ≠ `String(issue number)` (check 19). A plain `"123"` fails; `"repo-123"`, `"R_123"`, or base64(`"Repository:123"`) all pass this test.
4. **Round-trip through `node(id:)`** — feeding a repo's `id` back into `node(id:)` must return that repo with the same `id`, `name`, `nameWithOwner` (check 16).
5. **Usable as mutation input** — the `id` read from `IssueByNumber` must be accepted as `CloseIssueInput.issueId` and `AddCommentInput.subjectId`; the `id` from `PullRequestId` must be accepted as `MergePullRequestInput.pullRequestId`; the repo `id` from `RepositoryFields` must be accepted as `CreateIssueInput.repositoryId` / `CreatePullRequestInput.repositoryId`.
6. **Cross-surface identity** — the repo `id`/`databaseId` pair from the GraphQL read in `buildRepo` is the canonical pair every later check compares against, so GraphQL ids must agree with the REST-created repo (REST `POST /user/repos` → GraphQL read of the same repo).
7. Comment ids: only non-empty string asserted (check 13); no stability / node round-trip check for comments.

**Ambiguity (explicit):** the file header calls ids "global (Relay) id" but no check verifies Relay-style base64 encoding, so an implementer is free to choose any stable opaque string format. Do not assume the grader decodes base64.

---

## 6. Cursor pagination rules

- `issues(first: Int, after: String)` — `after` is nullable; first page is called with `after: null` (explicit JSON null, not omitted).
- Page 1 of 7 items with `first: 5` → exactly 5 nodes, `hasNextPage: true`, `endCursor`: non-empty string.
- Page 2 with `after` = page-1 `endCursor`, `first: 5` → exactly 2 nodes, `hasNextPage: false`.
- Cursor **format is unspecified** — any non-empty string that, when passed back as `after`, yields the remaining items passes. No base64/offset decoding is verified.
- No ordering assertion on paged results; no `hasPreviousPage` / `startCursor` / `edges` / `totalCount` requested.
- `first` is honoured as a cap elsewhere too: open-issues list ≤ 10 for `first: 10`; PR list ≤ 5 for `first: 5`; PR files `first: 10` (only inclusion of one path is asserted, not the count).

---

## 7. Fixture setup — what the forge must already support via REST/git

Checks run on a **fresh, empty forge** and seed their own fixtures through the entry's own surfaces. A fixture that cannot be built is that check's failure, not a crash. Fixtures are **memoised per harness** (one harness per `baseUrl + scenario.seed`): the repo is built once and reused by all checks that need it; issues/PRs/pages are built lazily on first use.

Derived names (all functions of `scenario.repos[0]`):

| Fixture | Name / value |
|---|---|
| Main repo | `"<repos[0].name>-graphql"` |
| Pagination repo | `"<repos[0].name>-graphql-pages"` |
| Unknown repo (check 17) | `"<repos[0].name>-graphql-missing"` |
| Base branch | `repos[0].defaultBranch` |
| Head branches | `pulls[0].head`, `pulls[1].head`, `pulls[2].head` — must be three **distinct** values; scenario must supply ≥ 3 pulls, ≥ 2 blobs, ≥ 2 issue templates, ≥ 1 repo |
| Title prefix / body | `issues[0].title` / `issues[0].body` |
| Comment body | `issues[1].body` |
| Changed file path | `blobs[0].path`; base-branch file path `blobs[1].path` |
| Pagination | `pageSize = 5`, `pageCount = 7` |

Build steps the checks perform (forge must make each step work):

1. **Repo:** `POST /api/v3/user/repos {name, private: repos[0].private ?? false, description: repos[0].description ?? "graphql checks"}` — accepts 201 / 200 / 422 / 409; then `GET /api/v3/repos/{viewer}/{name}` must be 200; then a GraphQL `RepositoryFields` read yields the canonical `id` + `databaseId`.
2. **Base branch (only if git adapter installed):** git push, root commit (no `from`): branch = default branch, path = `blobs[1].path`, content `"# <repo>\n\n<body>\n"`, message `"fixture: first commit on <branch>"`. Without a git adapter, `defaultBranchRef` is not asserted, but the four PR checks fail with "no git fixture provider" — the other 16 still run.
3. **Head branches:** three git pushes, each `from` = base branch: `pulls[0].head` adds `blobs[0].path` (content `"<body>\n"`); `pulls[1].head` adds `blobs[0].path + ".create"`; `pulls[2].head` adds `blobs[0].path + ".merge"`.
4. **Issues:** `POST /api/v3/repos/{o}/{r}/issues {title, body}` (expects 201) × 3 open titled `"<prefix> open 1/2/3"`, then 1 more titled `"<prefix> closed"` followed by `PATCH /issues/{n} {state: "closed"}` (expects 200).
5. **PR fixtures:** `POST /api/v3/repos/{o}/{r}/pulls {title, body, head: <branch>, base: <defaultBranch>}` (expects 201). On **422** (already exists) the check falls back to `GET /pulls?state=all` and reuses the open PR whose `head.ref` == branch. PR titles: `"<prefix> fixture pull request"` (head 0), `"<prefix> merge pull request"` (head 2); the create-PR check uses head 1 with title `"<prefix> created over graphql"`.
6. **Pagination repo:** `POST /user/repos {name: "<base>-graphql-pages", private: false}` (201/200/422/409), then 7× `POST /issues {title: "<prefix> page 1..7", body}` (201 each).
7. **Mutation inputs are always read back first** — no check invents an id: `createIssue`/`createPullRequest` use the repo id from the GraphQL repo read; `closeIssue`/`addComment` use the issue id from `IssueByNumber`; `mergePullRequest` uses the PR id from `PullRequestId`.

**Cross-surface consistency is load-bearing:** every mutation check re-reads the result over REST immediately (same run, no delay): GraphQL and REST must share one store, with REST `state` lowercase (`"open"`/`"closed"`), REST `merged: true` + `state: "closed"` after a squash merge, REST `head.ref`/`base.ref` matching the PR branches, and REST comment lists containing the GraphQL-added comment. There is no eventual-consistency allowance in the checks.

---

## 8. Per-check timeouts (for the forge builder's awareness, not a wire contract)

`viewer-login` 8 s; `repository-fields` 10 s; `introspection-issue` 8 s; `introspection-types` 10 s; `issues-open-order` 12 s; `issue-by-number` 10 s; `create-issue` 12 s; `close-issue` 12 s; `pull-requests-list` 15 s; `pull-request-files` 12 s; `create-pull-request` 15 s; `merge-pull-request` 15 s; `add-comment` 12 s; `invalid-field` 8 s; `unauthenticated` 8 s; `node-repository` 10 s; `unknown-repository` 8 s; `batched-operations` 10 s; `global-id-stability` 12 s; `issues-pagination` 12 s. Any check throwing is converted to a failed verdict with the exception message as the detail — a 500 / crash is a fail, not a skip.

## 9. What the checks do NOT require (do not mistake for requirements)

- No `search`, `organization`, `user(login:)`, `rateLimit`, `__schema` query — never sent.
- No `edges`/`cursor` per-node fields, no `totalCount`, no `hasPreviousPage`/`startCursor`.
- No `assignees`, `labels`, `comments`, `author`, `createdAt`/`updatedAt`, `url`, `resourcePath` on any type — never requested.
- No `Issue.comments`, `PullRequest.reviews/commits/mergeable` beyond the `mergeable` string, no `Repository.issues` `totalCount`.
- No mutation other than the five listed; no `updateIssue`, `deleteIssue`, `addReaction`, `createRepository`, etc.
- No `viewerPermission` value beyond set-membership; no `hasIssuesEnabled: false` case; no non-owner / stranger-permission case (the stranger `"olgabauer"` is context, not exercised here).
- No authz distinction beyond authenticated-vs-not: no check sends a wrong/expired token or a second user's token to GraphQL.
- Introspection beyond the three `__type` probes: no `__schema`, no field `args`/`type`/`description` reads, no `possibleTypes` — only `fields {name}` and `enumValues {name}` with `includeDeprecated: true`.
- The `mergePullRequest` GraphQL `state` value is never asserted (only `merged: true`); the `closeIssue` GraphQL `id` value is never asserted beyond being requested.
- Error `path`/`locations`/`extensions` are parsed but never asserted; only the invalid-field `message` substring matters.
