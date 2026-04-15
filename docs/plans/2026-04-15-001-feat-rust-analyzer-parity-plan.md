---
title: "feat: Bring Rust to analyzer parity with Go"
type: feat
status: active
date: 2026-04-15
---

# feat: Bring Rust to analyzer parity with Go

## Overview

Expand Rust support in xray so Rust PRs get the same quality of diagram annotations, risk coloring, and "Static analysis findings" section that Go PRs currently enjoy. Two tracks: fill out `src/patterns/rust.json` to match Go's eleven symbol kinds, and add a clippy-based analyzer at `src/analyzers/rust.ts`.

## Problem Frame

xray currently treats Rust as a second-class language:

- `src/patterns/rust.json` defines 6 symbol kinds; `src/patterns/go.json` defines 11. The five missing kinds (`unsafe_ops`, `external_calls`, `http_handlers`, `context_lifecycle`, `resource_mgmt`) are the ones that drive risk coloring in `src/diagram.ts` and the Risk column in `src/comment.ts`. Rust PRs therefore never get red/orange coloring for things like unsafe blocks or reqwest calls.
- `src/analyze.ts` registers only Go and Python analyzers. Rust PRs surface no findings in the "Static analysis" section of the PR comment, so reviewers get no structured signal about panics, unwraps, race conditions, or obvious bugs.

## Requirements Trace

- R1. A Rust PR with an `unsafe` block, an external HTTP call (reqwest/hyper), or a new axum handler receives the same diagram coloring treatment a Go PR with the equivalent risk would.
- R2. A Rust PR surfaces clippy findings in the same `<details>` block that Go PRs use for golangci-lint findings, with HIGH / MEDIUM / LOW severities mapped consistently.
- R3. When a repo has no `Cargo.toml`, the Rust analyzer is a no-op (no toolchain install, no meaningful time cost).
- R4. Adding the analyzer does not change behavior for Go, Python, or other languages.

## Scope Boundaries

- **Not** adding `cargo audit`, `cargo-geiger`, or `cargo-deny`. Single-tool parity (clippy) mirrors how Python uses only bandit and keeps install cost bounded.
- **Not** introducing new `symbol.kind` values. New Rust patterns slot into the existing Go-shaped kinds so `src/diagram.ts` and `src/comment.ts` don't need touching.
- **Not** adding unit-test infrastructure. The Go and Python analyzers have none; matching their posture keeps this change narrow.

### Deferred to Separate Tasks

- `cargo audit` integration for supply-chain findings: separate PR once clippy parity is in place.
- `Swatinem/rust-cache` guidance in the README: follow-up doc PR after we measure real-world CI cost on a meaningful crate.

## Context & Research

### Relevant Code and Patterns

- `src/analyzers/go.ts` — the pattern to follow. Clippy analyzer should mirror: `tryExec` pattern, install-or-skip, JSON parse, severity mapping, per-rule caps.
- `src/analyzers/python.ts` — the minimal-shape version. Useful when deciding how much install robustness clippy needs.
- `src/patterns/go.json` — the 11-kind reference.
- `src/analyze.ts` — the `ANALYZERS` map to register into.
- `src/diagram.ts` lines 64-88 — the hardcoded kind sets (`RISK_KINDS`, `has_concurrency`, etc.). Reusing existing kinds is what makes this change low-blast-radius.
- `src/comment.ts` lines 20-30 — `HIGH_RISK_KINDS`, `MEDIUM_RISK_KINDS`, `INFO_KINDS` sets; also `isGenericSymbol` (Go-biased today).
- `src/extract.ts` `detectLanguages` and `loadPatterns` — no changes needed; they already pick up any new kind added to `rust.json`.
- `ARCHITECTURE.md` — the "extract deterministically, render with AI" boundary the plan must preserve.

### Institutional Learnings

None applicable — no `docs/solutions/` in this repo.

### External References

- Clippy stable JSON output: `cargo clippy --message-format=json` emits cargo diagnostic JSON (one message per line, `reason: "compiler-message"`).
- Clippy lint groups: `correctness` (deny-by-default), `suspicious`, `complexity`, `perf`, `style`, `pedantic`, `nursery`, `cargo`.
- Clippy lint catalog: https://rust-lang.github.io/rust-clippy/master/
- Cargo external-tools diagnostic schema: https://doc.rust-lang.org/cargo/reference/external-tools.html

## Key Technical Decisions

- **Reuse existing kind names instead of inventing Rust-specific ones.** Rust `unsafe` goes under `unsafe_ops`; reqwest/hyper/sqlx/tonic go under `external_calls`; axum/actix handlers go under `http_handlers`; async cancellation (`CancellationToken`, `tokio::timeout`, `JoinHandle::abort`) goes under `context_lifecycle`; RAII-adjacent signals (`impl Drop`, `?`, `File::open/create`, `Mutex::lock`) go under `resource_mgmt`.
  **Why:** `src/diagram.ts` and `src/comment.ts` have those kind strings baked in; any new kind would need changes in both files and in the Mermaid prompt. Reusing kinds gets Rust full risk treatment for free and keeps the blast radius small.
  **How to apply:** When writing regex for `rust.json`, always map to one of the 11 existing Go kinds; never invent a `rust_specific_kind` string.

- **Curated clippy lint set rather than `clippy::all` or `clippy::pedantic`.** Enable the `correctness` group and selected sharp-edge lints (`unwrap_used`, `expect_used`, `panic`, `await_holding_lock`, `arithmetic_side_effects`, `indexing_slicing`, `mem_forget`).
  **Why:** `clippy::all` surfaces enough style noise to drown real findings; `clippy::pedantic` has too many false alarms on typical crates. Matches the curated approach used in `src/analyzers/go.ts` (13 linters picked from ~100 available).

- **Severity map follows Go's shape.** HIGH: `correctness`, `unwrap_used`, `expect_used`, `panic`, `mem_forget`, `await_holding_lock`, `await_holding_refcell_ref`. MEDIUM: `suspicious`, `perf`, `arithmetic_side_effects`, `indexing_slicing`. LOW: `complexity`, everything else.
  **Why:** mirrors the `gosec`/`nilaway` = HIGH, `staticcheck`/`gocritic` = MEDIUM split in `src/analyzers/go.ts`, so reviewers see the same severity calibration across languages.

- **Cap results per rule in the parser, not via clippy config.** Clippy has no `max-same-issues` equivalent.
  **Why:** one noisy lint (e.g. `unwrap_used` in a legacy crate) must not blow up the PR comment. Go caps at 2/10 via golangci-lint config; we replicate the intent in parser code.

- **Skip entirely when `Cargo.toml` is absent at repo root.** Detected via `fs.existsSync`.
  **Why:** many monorepos have `.rs` files in examples or docs without a Cargo project; installing `rustup` just to no-op would waste 30-60s per PR and pollute logs. Addresses R3.

- **Normalize clippy's absolute paths to repo-relative in the parser.**
  **Why:** `src/comment.ts` lines 300 and `src/diagram.ts` line 105 match findings to diff files with `endsWith`. Clippy emits paths like `/home/runner/work/repo/repo/crates/foo/src/lib.rs`; diff paths are `crates/foo/src/lib.rs`. Without normalization, findings exist but never attach to a file row, silently breaking the integration.

- **Run `cargo clippy --workspace --no-deps --all-targets`.**
  **Why:** `--workspace` covers multi-crate layouts; `--no-deps` avoids linting third-party code (faster, fewer false signals); `--all-targets` includes examples/tests where real bugs often hide.

## Open Questions

### Resolved During Planning

- _Which Rust ecosystem analyzer to use?_ → clippy only, per user choice (option 2 of Clippy-focused + full pattern expansion). `cargo audit` / `cargo-geiger` deferred.
- _Introduce new symbol kinds for Rust-specific risk signals?_ → No. Reuse Go's kinds (see Key Technical Decisions).
- _Execution posture?_ → Match existing Go/Python analyzers: no unit tests, manual smoke-test against a representative Rust PR before merging.
- _Handle `cargo check` vs full build?_ → Use `cargo clippy` directly; it runs a type-check pass which is all we need. No separate `cargo build` invocation.

### Deferred to Implementation

- _Exact clippy lint list._ The curated set above is a strong starting point but may need tuning after one or two real PRs. Expect one follow-up commit adjusting `-W` / `-D` / `-A` flags.
- _Whether to run `--workspace` unconditionally or scope to crates touched by the diff._ Start with `--workspace` for simplicity; optimize only if CI-time regression is observed.
- _How to handle clippy exiting non-zero when the project doesn't compile._ First pass: parse whatever JSON arrived on stdout (clippy streams per-crate messages), return what we got, log a warning. Revisit if real PRs surface a better fallback.
- _Whether to exclude `examples/` or `benches/` from results._ Defer until we see what real output looks like.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Data flow when a PR contains Rust files:

```
extract()  ──▶  extraction.languages includes "rust"
                extraction.changedFiles includes .rs paths
                        │
                        ▼
                runAnalyzers(languages, changedFiles)       [src/analyze.ts]
                        │
                        ├─▶ analyzeGo(...)                  [existing, unchanged]
                        │
                        └─▶ analyzeRust(changedFiles)       [src/analyzers/rust.ts — NEW]
                                │
                                ├─ filter .rs, skip tests
                                ├─ fs.existsSync("Cargo.toml")  ─── absent ──▶ return []
                                ├─ tryExec("rustup", ["component","add","clippy"])
                                ├─ tryExec("cargo", [
                                │     "clippy","--workspace","--no-deps","--all-targets",
                                │     "--message-format=json","--",
                                │     "-W","clippy::correctness",
                                │     "-W","clippy::suspicious","-W","clippy::perf",
                                │     "-W","clippy::complexity",
                                │     "-W","clippy::unwrap_used","-W","clippy::expect_used",
                                │     "-W","clippy::panic","-W","clippy::mem_forget",
                                │     "-W","clippy::await_holding_lock",
                                │     "-W","clippy::await_holding_refcell_ref",
                                │     "-W","clippy::arithmetic_side_effects",
                                │     "-W","clippy::indexing_slicing",
                                │     "-A","clippy::too_many_arguments"])
                                ├─ parse NDJSON: keep reason=="compiler-message"
                                │                && message.code.code starts with "clippy::"
                                ├─ normalize spans[0].file_name → repo-relative
                                ├─ severity map by rule code
                                └─ dedupe (file,line,rule) + cap 10/rule
                                        │
                                        ▼
                                Finding[] ──▶ generateDiagram + composeComment
                                              (unchanged — consumes existing Finding shape)
```

The new symbol patterns in `rust.json` travel a parallel, already-wired path through `src/extract.ts` → `src/diagram.ts`/`src/comment.ts`. No changes needed to the extraction pipeline itself.

## Implementation Units

- [ ] **Unit 1: Expand `src/patterns/rust.json` to match Go's 11 kinds**

**Goal:** Give Rust PRs the same symbol signal that Go PRs get, so `src/diagram.ts` risk coloring and `src/comment.ts` Risk column activate on Rust diffs.

**Requirements:** R1, R4

**Dependencies:** None.

**Files:**
- Modify: `src/patterns/rust.json`

**Approach:**
- Add five new kinds with Rust-idiomatic regex, keeping names identical to Go's so downstream consumers don't need changes:
  - `unsafe_ops`: `unsafe\s*\{`, `unsafe\s+fn`, `unsafe\s+(impl|trait)`, `transmute`, `from_raw_parts`, `\bptr::`, `extern\s+"C"`, `#\[no_mangle\]`
  - `external_calls`: `reqwest::`, `hyper::(Client|Request)`, `tonic::`, `TcpStream::connect`, `UdpSocket::`, `sqlx::`, `redis::`, `awc::`
  - `http_handlers`: axum handler signatures (`async\s+fn.*->.*(impl\s+IntoResponse|Response|Json<)`), `#\[(get|post|put|delete|patch)\]`, warp filter builders
  - `context_lifecycle`: `CancellationToken`, `tokio::select!`, `tokio::(time::)?timeout`, `JoinHandle`, `\.abort\(\)`, `tokio::spawn`, `futures::select!`
  - `resource_mgmt`: `impl\s+Drop\s+for`, `File::(open|create)`, `Mutex::lock`, `RwLock::(read|write)`, manual `drop\(`
- Preserve the existing 6 kinds exactly.
- Keep `test_file_pattern` as-is — it already covers `tests/` directories and `_test.rs`.
- Follow the `^[+-].*…` prefix convention from `src/patterns/go.json` so patterns run against diff lines.

**Patterns to follow:**
- `src/patterns/go.json` — structure, regex verbosity, `^[+-]` prefix convention.

**Test scenarios:**
- Happy path: a Rust PR adding an `unsafe { ... }` block produces a symbol with kind `unsafe_ops`. Downstream in `src/diagram.ts`, this flips `has_unsafe: true`, which triggers the RED classification.
- Happy path: a Rust PR adding `let client = reqwest::Client::new();` produces an `external_calls` symbol. The Mermaid prompt's "outbound HTTP in hot path" risk node fires.
- Happy path: a Rust PR adding `async fn handler() -> impl IntoResponse` produces an `http_handlers` symbol → ORANGE coloring.
- Happy path: a Rust PR adding `tokio::spawn(async { … })` produces a `context_lifecycle` symbol (generic, filtered from "Key changes" by Unit 2's genericness logic but still counted as a signal).
- Edge case: a Rust PR touching only a `tests/foo.rs` file produces no non-test symbols (test file pattern still filters correctly).
- Edge case: `unsafe` inside a string literal or comment matches as a false positive. Accepted per `ARCHITECTURE.md`'s stated trade-off ("may have false positives on comments").

**Verification:**
- `JSON.parse(fs.readFileSync("src/patterns/rust.json"))` succeeds.
- Running the full `extract()` pipeline against a hand-crafted diff containing one line from each of the five new kinds produces exactly one symbol per kind with the expected `kind` string.

---

- [ ] **Unit 2: Teach `isGenericSymbol` about Rust generic names in the new kinds**

**Goal:** Prevent the PR comment's "Key changes" column from being flooded with generic symbol names (e.g., `reqwest::`, `tokio::spawn`, `File::open`), the way Go's `isGenericSymbol` filters `sync.Mutex`, `context.`, `defer`, etc.

**Requirements:** R4

**Dependencies:** Unit 1 (the new kinds don't produce symbols until Unit 1 ships).

**Files:**
- Modify: `src/comment.ts`

**Approach:**
- Extend `isGenericSymbol` so that when `s.kind` is `context_lifecycle`, `resource_mgmt`, or `external_calls`, Rust-idiomatic generic names (`tokio::spawn`, `tokio::select`, `CancellationToken`, `File::open`, `Mutex::lock`, `reqwest::Client`, bare crate-qualified calls like `reqwest::get`) are treated as generic — just like `go func` and `sync.Mutex` are for Go.
- Keep the existing Go-specific patterns working. The function should be a superset, not a replacement.
- Add a short inline comment explaining that the function is intentionally cross-language so the Go bias doesn't get re-introduced in future edits.

**Patterns to follow:**
- `src/comment.ts` current `isGenericSymbol` implementation — reuse its per-kind switch structure.

**Test scenarios:**
- Happy path: `reqwest::Client::new` (kind `external_calls`) is classified as generic → excluded from "Key changes" but the count still drives the risk coloring and the `⚠ 1 external call` tag.
- Happy path: a named handler function `submit_order` under `http_handlers` is NOT classified as generic and DOES appear in "Key changes."
- Edge case: Go's existing generic filters (`go func`, `sync.Mutex`, `defer .Close`, `context.`, `ctx.`) behave identically to before. Regression-check against `src/comment.ts` current tests (none exist) via manual fixture.

**Verification:**
- Running on a Go-only PR produces a byte-identical comment to `main` for a representative fixture (modulo incidental whitespace from rebuild).

---

- [ ] **Unit 3: Add `src/analyzers/rust.ts` (clippy-based analyzer)**

**Goal:** Produce `Finding[]` from clippy diagnostics for Rust PRs, mirroring the shape and robustness of `analyzeGo`.

**Requirements:** R2, R3

**Dependencies:** None (analyzer output flows through `Finding`, not `Symbol` — so it is independent of Unit 1).

**Files:**
- Create: `src/analyzers/rust.ts`
- Test: n/a (matching Go/Python analyzers; manual smoke-test only)

**Approach:**
- Follow the `analyzeGo` skeleton: `tryExec` wrapper, bail-on-failure returning `[]`, severity-mapping switch, cap-per-rule in the parser.
- **Short-circuit on no `Cargo.toml`** via `fs.existsSync` at repo root. Return `[]` immediately — no toolchain install, no log noise beyond a single info line.
- **Install clippy component if absent**: `rustup component add clippy`. If `rustup` itself is missing (rare on GitHub-hosted runners, common on some self-hosted), log a warning and return `[]`.
- **Invoke clippy** with the curated flag list from High-Level Technical Design. Wrap with a 240s timeout — longer than Go's 180s because clippy does a type-check compile.
- **Parse NDJSON** line-by-line. For each line:
  - `JSON.parse` safely; skip malformed lines.
  - Keep only entries where `reason === "compiler-message"` AND `message.code?.code?.startsWith("clippy::")`.
  - Pick the primary span: `message.spans.find(s => s.is_primary) ?? message.spans[0]`.
  - Normalize `spans[].file_name` via `path.relative(process.cwd(), filename)`. If the path is already relative, leave it alone.
  - Map severity via the rule → severity table from Key Technical Decisions.
  - Emit `{ file, line, severity, message: msg.message, rule: msg.code.code }`.
- **Dedupe** by `(file, line, rule)` tuple.
- **Cap** to 10 findings per rule (matching Go's `max-same-issues: 2` / `max-issues-per-linter: 10` intent — we apply the looser cap in parser code rather than via clippy config since clippy has no such flag).

**Patterns to follow:**
- `src/analyzers/go.ts` — structure, `tryExec` pattern, severity switch layout, per-rule cap intent, graceful-degradation on tool install failure.

**Test scenarios:**
- Happy path: a Rust file introducing `.unwrap()` produces one HIGH finding with `rule == "clippy::unwrap_used"` and correct file/line.
- Happy path: a file with `.await` holding a `std::sync::Mutex` guard produces a HIGH `clippy::await_holding_lock` finding.
- Happy path: integer overflow risk in `a + b` for user-controlled values produces a MEDIUM `clippy::arithmetic_side_effects` finding (when the lint fires; it is context-sensitive).
- Edge case: repo has no `Cargo.toml` → analyzer returns `[]` within <200ms; no `rustup` or `cargo` invocations in logs.
- Edge case: `cargo clippy` exits non-zero because the crate has compile errors → analyzer parses whatever messages clippy emitted before the error and returns those; never throws.
- Edge case: one noisy lint produces 300 instances of `clippy::unwrap_used` → parser caps to 10 and returns them.
- Edge case: clippy emits absolute paths (`/home/runner/work/repo/repo/crates/foo/src/lib.rs`) → normalization produces `crates/foo/src/lib.rs`, and the `endsWith` match in `src/comment.ts` / `src/diagram.ts` successfully attaches the finding to the file row.
- Edge case: clippy diagnostic has no spans (rare but possible for top-level lints) → skip the finding rather than emitting `file: ""`, `line: 0`.
- Integration: run against a small fixture repo with one deliberate `.unwrap()` → the resulting PR comment shows the finding under "Static analysis findings" with HIGH severity, and the file's row in the Risk column shows `⚠ 1 high severity`.

**Verification:**
- Manual smoke test on a small Rust repo PR shows the findings block populated with expected clippy rules, severities, and repo-relative file paths.

---

- [ ] **Unit 4: Register the Rust analyzer in `src/analyze.ts`**

**Goal:** Wire the new analyzer into the dispatcher so `runAnalyzers` invokes it when Rust is in the detected language set.

**Requirements:** R2

**Dependencies:** Unit 3.

**Files:**
- Modify: `src/analyze.ts`

**Approach:**
- Import `analyzeRust` from `./analyzers/rust`.
- Add `rust: analyzeRust` to the `ANALYZERS` map. That is the entire change — the dispatcher loop already iterates `languages` and skips unknown keys, and `src/extract.ts` `detectLanguages` already puts `"rust"` in the set when `.rs` files are changed.

**Patterns to follow:**
- `src/analyze.ts` current `go` and `python` map entries.

**Test scenarios:**
- Happy path: a PR touching only `.rs` files produces exactly one `Running rust analyzer...` info log line.
- Edge case: a mixed Go + Rust PR runs both analyzers; findings from both appear in the resulting `allFindings`, interleaved correctly in the comment's severity-ordered list.
- Edge case: if `analyzeRust` throws, the existing `try/catch` in `runAnalyzers` logs a warning and continues — Go findings still appear.

**Verification:**
- `grep -n analyzeRust src/analyze.ts` shows both the import and the map registration.

---

- [ ] **Unit 5: Rebuild `dist/` and smoke-test end-to-end**

**Goal:** Produce a committed `dist/index.js` containing the new analyzer so the action runs correctly when consumed via `uses: xray-pr/xray-pr@main` or any pinned version.

**Requirements:** R1, R2, R4

**Dependencies:** Units 1-4.

**Files:**
- Modify: `dist/index.js`, `dist/index.js.map`, `dist/licenses.txt` (all regenerated by `npm run build`)

**Approach:**
- Run `npm run typecheck` first to confirm zero TS errors.
- Run `npm run build` (ncc). Commit the regenerated `dist/` in a separate commit from the src changes, matching the pattern of `2a28019 feat: expand Go analysis to 13 linters` — this makes review easier.
- Smoke-test end-to-end in two modes:
  1. **Rust mode**: a throwaway Rust repo PR that exercises every new pattern (unsafe block, reqwest call, axum handler, CancellationToken, `File::open`) and every HIGH clippy rule (`.unwrap()`, `.await` holding lock).
  2. **Go regression mode**: a Go-only PR to confirm no regression — comment should be byte-identical to pre-change output modulo trivial rebuild differences.

**Patterns to follow:**
- Recent commits `2a28019 feat: expand Go analysis to 13 linters` and `f001826 feat: cheaper default models + prompt caching` — both include `dist/` rebuild and both use separate commits for src vs dist.

**Test scenarios:**
- Happy path: Rust smoke-test PR produces a comment with colored diagram (red for `unsafe`/`external_calls` files, orange for `http_handlers`), Risk column populated, and a "Static analysis findings" details block with clippy rules.
- Happy path: Go smoke-test PR produces a comment with the same risk coloring, Risk column contents, and findings block as pre-change `main`.
- Edge case: a repo containing both `.go` and `.rs` files produces a single comment with findings from both analyzers interleaved by severity in the comment's `[...high, ...medium]` order.
- Edge case: a repo with `.rs` files but no `Cargo.toml` (e.g., examples pasted into a markdown repo) produces no `rustup` install logs and no findings from the Rust analyzer.

**Verification:**
- `grep -c analyzeRust dist/index.js` returns at least 1.
- `grep clippy::unwrap_used dist/index.js` matches (confirms curated flag list got bundled).
- `npm run typecheck` exits 0.
- Both smoke-test comments match expected shape by eye.

## System-Wide Impact

- **Interaction graph:** `src/extract.ts` (patterns path) and `src/analyze.ts` (analyzer path) are the only producers affected. All consumers (`src/diagram.ts`, `src/comment.ts`) read via the existing `Symbol` / `Finding` shapes; no API changes.
- **Error propagation:** `runAnalyzers` already `try/catch`es per analyzer. Rust failures are logged as warnings and don't fail the Action. Matches Go/Python behavior.
- **State lifecycle risks:** None. Analyzer is stateless per invocation. Toolchain install is idempotent.
- **API surface parity:** `Finding` shape unchanged. `Symbol.kind` strings unchanged — this is the deliberate load-bearing decision that keeps `src/diagram.ts` and `src/comment.ts` untouched.
- **Integration coverage:** The critical cross-layer scenario — pattern `kind` → `diagram.ts` risk flag → Mermaid red coloring — is exactly what reusing Go's kinds buys us. Validated manually in Unit 5 smoke-test.
- **Unchanged invariants:** The "extract deterministically, render with AI" boundary in `ARCHITECTURE.md` is preserved — clippy runs deterministically before the AI call. `Finding[]` still flows only through the already-audited path in `src/diagram.ts` and `src/comment.ts`. The `README.md` promise that "adding a language = one regex pattern file + one optional analyzer" is reinforced, not contradicted.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Clippy runtime on large workspaces pushes action past default GitHub runner timeouts | 240s exec timeout; if exceeded, parse whatever was emitted on stdout and return. Suggest `Swatinem/rust-cache` in a follow-up README update. |
| Clippy emits hundreds of `clippy::unwrap_used` findings on legacy crates | Per-rule cap of 10 in the parser (Key Technical Decisions). |
| Curated lint list is too aggressive (noisy) or too permissive (misses real bugs) | Expect tuning in one or two follow-up commits after real-PR exposure — called out in Deferred Questions. Start conservative: correctness + sharp-edge lints only. |
| Rust toolchain not installed on self-hosted runners | `tryExec` + `rustup component add clippy` pattern: on failure, log warning and return `[]`. No Action failure. Matches Go's `go install golangci-lint` graceful-degradation pattern. |
| `dist/` rebuild produces incidental changes that get reviewed as unrelated | Commit `dist/` in its own commit in the PR, matching `2a28019` and `f001826`. |
| Clippy's JSON format changes in a future Rust release | Low — format stable since Rust 1.x. If it regresses, parser returns `[]` and logs a warning; Action continues. |
| A Rust PR also contains Python/Go changes; analyzers serialize and compound runtime | Existing dispatcher runs analyzers sequentially (`for (const lang of languages)`). Live with it; parallelizing analyzers is a separate optimization not in scope. |
| Absolute-path normalization breaks on Windows runners | Accept as out-of-scope — the action already assumes Linux (`go install`, `pip install`); README usage examples all say `runs-on: ubuntu-latest`. |

## Documentation / Operational Notes

- **Not updating README as part of this plan.** The language badge list already shows Rust. A follow-up doc PR can mention `Swatinem/rust-cache` for Rust users once we measure CI cost.
- **No new action inputs.** Rust analysis auto-activates on detection of `.rs` files + `Cargo.toml`, matching Go's auto-activation.

## Sources & References

- Related code:
  - `src/analyzers/go.ts` (pattern for new analyzer)
  - `src/analyzers/python.ts` (minimal-shape reference)
  - `src/patterns/go.json` (11-kind reference)
  - `src/patterns/rust.json` (current 6-kind state)
  - `src/analyze.ts` (dispatcher)
  - `src/diagram.ts` lines 64-88 (risk-kind consumers)
  - `src/comment.ts` lines 14-48 (risk-kind consumers, `isGenericSymbol`)
  - `ARCHITECTURE.md` (design boundary this plan preserves)
- Related commits: `2a28019 feat: expand Go analysis to 13 linters` — precedent for curated-lint + dist-rebuild pattern; `f001826 feat: cheaper default models + prompt caching` — precedent for separating src and dist commits.
- External docs:
  - Clippy lint catalog: https://rust-lang.github.io/rust-clippy/master/
  - Cargo diagnostic JSON: https://doc.rust-lang.org/cargo/reference/external-tools.html
