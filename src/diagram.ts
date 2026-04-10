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

    return {
      file: f.file,
      lines_added: f.linesAdded,
      lines_removed: f.linesRemoved,
      is_new: f.isNew,
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
  - Key symbols added/modified (abbreviated if many — show top 3-4, then "..." if more)
- New files: style with fill:#d4edda,stroke:#28a745 (green)
- Modified files: style with fill:#cce5ff,stroke:#0366d6 (blue)
- Draw arrows showing data/dependency flow between files based on the symbols (e.g., a handler file calls a store file, a subscription manager uses a client)
- Label arrows with the relationship when it's clear (e.g., "calls", "implements", "configures", "subscribes")
- If there are error types, show them as a separate small node connected to where they originate
- If there are concurrency primitives (goroutines, mutexes, channels), annotate the node with a ⚡ prefix
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
