# Architecture

## Design principle

**Extract deterministically, render with AI.**

The trust boundary is explicit: everything before the AI call is grep/git (deterministic, auditable). The AI's only job is layout — turning a structured symbol list into a Mermaid diagram. If the AI hallucinates, the deterministic sections are still correct.

## Pipeline

```
PR opened / updated
        │
        ▼
┌─────────────────┐
│  1. Git Extract  │  git diff, git diff --stat, git diff --name-only
│                  │  Pure git. No parsing. No dependencies.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. Detect Lang  │  Map file extensions → language pattern files
│                  │  Unknown extensions → skip symbol extraction
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. Extract      │  Grep diff lines against language patterns:
│     Symbols      │  - new/removed types, interfaces, structs
│                  │  - new/removed functions
│                  │  - new errors
│                  │  - new concurrency primitives
│                  │  - new config surfaces
│                  │  Output: structured JSON, not text
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. Classify     │  Every added/removed line classified as:
│     Lines        │  - logic (default)
│                  │  - test (matches test pattern or test file)
│                  │  - types/config (matches type/config pattern)
│                  │  - docs/other (md, yaml, txt, etc.)
│                  │  Output: counts + percentages
└────────┬────────┘
         │
         ├──── diagram: false ──→ skip to step 6
         │
         ▼
┌─────────────────┐
│  5. Diagram      │  Send structured JSON to Claude:
│     (AI)         │  - list of new symbols with kinds
│                  │  - list of modified symbols
│                  │  - list of removed symbols
│                  │  - file groupings
│                  │  Prompt: generate Mermaid LR flowchart
│                  │  showing dependency flow between symbols.
│                  │  No opinions. No risk assessment.
│                  │
│                  │  This is the ONLY step that uses AI.
│                  │  Input is structured data, not raw diff.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  6. Comment      │  Compose markdown from steps 3-5.
│                  │  Post or update sticky PR comment.
│                  │  Uses marocchino/sticky-pull-request-comment
│                  │  so repeated pushes update, not spam.
└─────────────────┘
```

## File structure

```
xray/
├── action.yml                 # GitHub Action metadata + inputs/outputs
├── src/
│   ├── index.ts               # Entrypoint — orchestrates the pipeline
│   ├── extract.ts             # Step 1+3: git diff parsing, regex extraction
│   ├── classify.ts            # Step 4: line classification
│   ├── diagram.ts             # Step 5: Claude API → Mermaid
│   ├── comment.ts             # Step 6: markdown composition + post
│   └── patterns/              # Language-specific regex patterns
│       ├── go.json
│       ├── typescript.json
│       ├── python.json
│       ├── rust.json
│       └── java.json
├── dist/                      # ncc-compiled bundle (committed, runs in Action)
├── package.json
├── tsconfig.json
└── README.md
```

## Pattern files

Each language has a JSON file defining regex patterns for symbol extraction. All patterns run against `git diff` output (lines starting with `+` or `-`).

```json
{
  "extensions": [".go"],
  "types":       "^\\+.*type\\s+(\\w+)\\s+(interface|struct)\\s*\\{",
  "functions":   "^\\+.*func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?(\\w+)\\(",
  "errors":      "^\\+.*(Err[A-Z]\\w+|=\\s*errors\\.New|=\\s*fmt\\.Errorf)",
  "tests":       "^\\+.*(func\\s+Test|t\\.Run)",
  "config":      "^\\+.*type\\s+\\w+Config\\s+struct",
  "concurrency": "^\\+.*(go\\s+func|go\\s+\\w|sync\\.(Mutex|RWMutex|WaitGroup)|make\\(chan\\s)"
}
```

Adding a new language = adding one JSON file. No code changes needed.

Patterns are intentionally simple (regex, not AST). This means:
- They can miss multi-line declarations
- They may have false positives on comments
- But they are fast, portable, and easy to audit

If a pattern is wrong, you can see exactly why by reading one regex. No black box.

## AI boundary

The Claude API call in step 5 receives:

```json
{
  "added": [
    { "name": "SubscriptionManager", "kind": "interface", "file": "erpc/subscription_manager.go" },
    { "name": "WsJsonRpcClient", "kind": "struct", "file": "clients/ws_json_rpc_client.go" }
  ],
  "modified": [
    { "name": "ServeHTTP", "kind": "function", "file": "erpc/http_server.go" }
  ],
  "removed": [],
  "files_changed": 17,
  "lines_added": 3613,
  "lines_removed": 33
}
```

It does NOT receive:
- Raw source code
- Full diff
- File contents
- Anything beyond the symbol-level summary

The prompt instructs Claude to output only a Mermaid diagram. No prose, no opinions, no review.

## Cost

One Claude API call per PR update. Input is a small JSON payload (~500 tokens). Output is a Mermaid diagram (~200 tokens). Estimated cost: **~$0.01 per PR**.

With `diagram: false`, cost is $0.
