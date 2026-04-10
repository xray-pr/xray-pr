import Anthropic from "@anthropic-ai/sdk";
import { Symbol } from "./extract";

export async function generateDiagram(
  apiKey: string,
  symbols: Symbol[],
  filesChanged: number,
  linesAdded: number,
  linesRemoved: number
): Promise<string | null> {
  const added = symbols.filter((s) => s.change === "added");
  const removed = symbols.filter((s) => s.change === "removed");

  if (added.length === 0 && removed.length === 0) {
    return null;
  }

  const payload = {
    added: added.map((s) => ({ name: s.name, kind: s.kind, file: s.file })),
    removed: removed.map((s) => ({ name: s.name, kind: s.kind, file: s.file })),
    files_changed: filesChanged,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Generate a Mermaid flowchart (graph LR) showing the dependency flow between these symbols from a pull request.

Rules:
- Show how new symbols connect to each other based on file grouping and naming conventions
- Use red fill for new symbols, gray for modified/existing context
- Keep it minimal — only show symbols from the data, do not invent nodes
- Output ONLY the Mermaid code block, nothing else — no explanation, no prose

Data:
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
