import Anthropic from "@anthropic-ai/sdk";
import { FileSummary, Symbol } from "./extract";

function sanitize(name: string): string {
  return name.replace(/[(){}[\]<>"]/g, "").trim();
}

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
    const hasConcurrency = fileSymbols.some((s) => s.kind === "concurrency");
    const hasErrors = fileSymbols.some((s) => s.kind === "errors");

    const riskItems: string[] = [];
    for (const s of added) {
      if (s.kind === "concurrency" || s.kind === "errors") {
        riskItems.push(sanitize(s.name));
      }
    }

    const keySymbols = added
      .filter((s) => s.kind !== "concurrency" && s.kind !== "errors" && s.kind !== "tests")
      .slice(0, 5)
      .map((s) => `${sanitize(s.name)} - ${s.kind}`);

    return {
      file: f.file,
      lines_added: f.linesAdded,
      lines_removed: f.linesRemoved,
      is_new: f.isNew,
      has_concurrency: hasConcurrency,
      has_error_changes: hasErrors,
      risk_items: riskItems,
      key_symbols: keySymbols,
    };
  });

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Generate a Mermaid diagram for a pull request code review.

STRUCTURE — two types of nodes:
1. FILE NODES — one per file, labeled with just "filename +N/-N"
2. RISK NODES — small warning badges that branch off from file nodes, showing specific risky changes

LAYOUT:
- Use graph TD
- File nodes are the main flow: show dependency/call direction between files with labeled arrows
- Risk nodes attach to their parent file with dotted arrows, positioned to the side
- Each risk_item from the data becomes its own small risk node with a warning icon

STYLING:
- File nodes with has_concurrency=true: use class "red" 
- File nodes with has_error_changes=true but no concurrency: use class "orange"
- New files with no risk: use class "green"
- Modified files with no risk: use class "blue"
- All risk nodes: use class "risk"

CLASS DEFINITIONS — include these exactly:
classDef red fill:#f8d7da,stroke:#dc3545,stroke-width:2px
classDef orange fill:#fff3cd,stroke:#ffc107,stroke-width:2px
classDef green fill:#d4edda,stroke:#28a745,stroke-width:2px
classDef blue fill:#cce5ff,stroke:#0366d6,stroke-width:2px
classDef risk fill:#ff6b6b,stroke:#c92a2a,color:#fff,font-size:11px,stroke-width:1px

CRITICAL SYNTAX RULES:
- ALL node labels MUST use quoted strings: A["label here"]
- NO parentheses, braces, or angle brackets inside quotes
- Risk node labels: use format r1["warning text"]
- Keep file node labels short: just filename and +N/-N
- Dotted arrows from risk to file: r1 -.-> A

Files and their data:
${JSON.stringify(payload, null, 2)}

Output ONLY the mermaid code. No explanation.`,
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
