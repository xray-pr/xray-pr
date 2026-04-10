import Anthropic from "@anthropic-ai/sdk";
import { FileSummary, Symbol } from "./extract";

export async function generateDiagram(
  apiKey: string,
  fileSummaries: FileSummary[],
  allSymbols: Symbol[],
  filesChanged: number,
  linesAdded: number,
  linesRemoved: number
): Promise<string | null> {
  const relevantFiles = fileSummaries.filter(
    (f) => !f.isTest && (f.symbols.length > 0 || f.linesAdded > 20)
  );

  if (relevantFiles.length === 0) {
    return null;
  }

  const nonTestSymbols = allSymbols.filter(
    (s) => !/^(Test|Benchmark|test_|describe|it\()/i.test(s.name)
  );

  const payload = relevantFiles.map((f) => {
    const fileSymbols = nonTestSymbols.filter((s) => s.file === f.file);
    const added = fileSymbols.filter((s) => s.change === "added");
    const removed = fileSymbols.filter((s) => s.change === "removed");
    const hasConcurrency = fileSymbols.some((s) => s.kind === "concurrency");
    const hasErrors = fileSymbols.some((s) => s.kind === "errors");

    return {
      file: f.file,
      lines_added: f.linesAdded,
      lines_removed: f.linesRemoved,
      is_new: f.isNew,
      has_concurrency: hasConcurrency,
      has_error_changes: hasErrors,
      added_symbols: added.map((s) => `${s.name} (${s.kind})`),
      removed_symbols: removed.map((s) => `${s.name} (${s.kind})`),
    };
  });

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are generating an architecture diagram for a pull request code review. The reviewer is busy and needs to understand the change at a glance.

Generate a Mermaid flowchart showing the architecture of this PR's changes.

Requirements:
- Use graph TD (top-down) layout
- Each node represents a FILE with a rich label showing:
  - Short filename (not full path)
  - Lines changed: +N/-N
  - Key symbols added/modified (show top 3-4, then "..." if more)
- Color-code nodes by RISK level:
  - RED (fill:#f8d7da,stroke:#dc3545) — files with has_concurrency=true (goroutines, mutexes, channels — highest review priority)
  - ORANGE (fill:#fff3cd,stroke:#ffc107) — files with has_error_changes=true (new error paths)
  - GREEN (fill:#d4edda,stroke:#28a745) — new files (is_new=true, no concurrency/error risk)
  - BLUE (fill:#cce5ff,stroke:#0366d6) — modified files (default, lowest risk)
- Draw arrows showing data/dependency flow between files based on the symbols
- Label arrows with the relationship (e.g., "calls", "implements", "configures")
- If a file has both concurrency and errors, use RED (concurrency takes priority)
- Maximum 10 nodes. Group very small files if needed.
- Make it detailed enough that a reviewer can understand the PR without reading any code
- Output ONLY the mermaid code, no explanation

PR summary: ${filesChanged} files changed, +${linesAdded}/-${linesRemoved}

Files and their symbols:
${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const mermaidMatch = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  if (mermaidMatch) {
    return mermaidMatch[1].trim();
  }

  if (text.startsWith("graph") || text.startsWith("flowchart")) {
    return text.trim();
  }

  return null;
}
