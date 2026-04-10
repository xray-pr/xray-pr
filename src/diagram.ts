import Anthropic from "@anthropic-ai/sdk";
import { FileSummary } from "./extract";

export async function generateDiagram(
  apiKey: string,
  fileSummaries: FileSummary[],
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

  const payload = relevantFiles.map((f) => ({
    file: f.file,
    lines_added: f.linesAdded,
    lines_removed: f.linesRemoved,
    is_new: f.isNew,
    symbols: Object.entries(f.symbolsByKind)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", "),
  }));

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Generate a Mermaid flowchart (graph LR) showing the relationship between these files from a pull request.

Rules:
- Each node is a FILE (not individual symbols)
- Node label format: "filename\\n+N lines\\nN type, N function" (use the symbols data)
- New files use red fill: style NodeId fill:#e74c3c,color:#fff
- Modified files use blue fill: style NodeId fill:#3498db,color:#fff
- Draw arrows showing likely dependency direction based on file names and common patterns (handlers→services→stores, routes→controllers→models, etc.)
- Keep it minimal — only files from the data, do not invent nodes
- Maximum 8 nodes — if more files, group small ones
- Output ONLY the Mermaid code block, nothing else

Files:
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
