# xray

See through AI slop with deterministic architecture PR diff reviews.

## What it does

Posts a comment on every PR with:

1. **One-line summary** of what changed
2. **Architecture diagram** — files as nodes, risk color-coded, dependency arrows
3. **File table** — sorted by risk, linked to the diff

Colors:
- 🔴 concurrency changes (review first)
- 🟠 error path changes
- 🟢 new files
- 🔵 modified

The facts come from git and regex (deterministic). The AI only generates the summary line and diagram layout.

## Quick start

```yaml
name: xray
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  xray-on-pr:
    if: github.event_name == 'pull_request' && github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: kasrakhosravi/xray@v0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

  xray-on-command:
    if: |
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      contains(fromJSON('["OWNER", "MEMBER"]'), github.event.comment.author_association) &&
      contains(github.event.comment.body, '/xray')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head
          fetch-depth: 0
      - uses: kasrakhosravi/xray@v0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github_token` | Yes | — | GitHub token |
| `anthropic_api_key` | No | — | For summary + diagram |
| `base_ref` | No | PR base | Branch to diff against |
| `languages` | No | `auto` | Comma-separated, or `auto` |
| `diagram` | No | `true` | `false` for deterministic-only mode |
| `min_lines` | No | `50` | Skip small PRs |

## Language support

Ships with patterns for Go, TypeScript, Python, Rust, Java, Solidity.

Adding a language = adding one JSON file to `src/patterns/`. No code changes.

Without a pattern file, xray still works — just skips symbol extraction for that language.

## License

MIT
