import { LLMProvider } from "./llm";
import { FileSummary, Symbol } from "./extract";
import { Finding } from "./analyze";

function sanitize(name: string): string {
  return name.replace(/[(){}[\]<>"]/g, "").trim();
}

export async function generateSummaryLine(
  llm: LLMProvider,
  fileSummaries: FileSummary[],
  allSymbols: Symbol[],
  filesChanged: number,
  linesAdded: number,
  linesRemoved: number
): Promise<string> {
  const nonTestSymbols = allSymbols.filter(
    (s) => !/^(Test|Benchmark|test_|describe|it\()/i.test(s.name)
  );
  const added = nonTestSymbols
    .filter((s) => s.change === "added")
    .slice(0, 20)
    .map((s) => `${sanitize(s.name)} (${s.kind})`);
  const files = fileSummaries
    .filter((f) => !f.isTest)
    .map((f) => f.file.split("/").pop())
    .join(", ");

  const text = await llm.generate(
    `Summarize this pull request in ONE short sentence (max 15 words). Be specific about what changed, not generic. No filler words.

Files: ${files}
Key symbols added: ${added.join(", ")}
${filesChanged} files, +${linesAdded}/-${linesRemoved}

Output ONLY the sentence, nothing else.`,
    100
  );

  return text.trim();
}

export async function generateDiagram(
  llm: LLMProvider,
  fileSummaries: FileSummary[],
  allSymbols: Symbol[],
  filesChanged: number,
  linesAdded: number,
  linesRemoved: number,
  findings: Finding[] = []
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

  const RISK_KINDS = new Set(["concurrency", "unsafe_ops", "errors", "http_handlers", "external_calls"]);

  const payload = relevantFiles.map((f) => {
    const fileSymbols = nonTestSymbols.filter((s) => s.file === f.file);
    const added = fileSymbols.filter((s) => s.change === "added");
    const hasConcurrency = fileSymbols.some((s) => s.kind === "concurrency");
    const hasUnsafe = fileSymbols.some((s) => s.kind === "unsafe_ops");
    const hasErrors = fileSymbols.some((s) => s.kind === "errors");
    const hasHttpHandlers = fileSymbols.some((s) => s.kind === "http_handlers");
    const hasExternalCalls = fileSymbols.some((s) => s.kind === "external_calls");

    const riskItems: string[] = [];
    const seenRisk = new Set<string>();
    for (const s of added) {
      if (RISK_KINDS.has(s.kind)) {
        const name = sanitize(s.name);
        if (!seenRisk.has(name) && name.length > 1) {
          riskItems.push(name);
          seenRisk.add(name);
        }
      }
    }

    const keySymbols = added
      .filter((s) => !RISK_KINDS.has(s.kind) && s.kind !== "tests" && s.kind !== "context_lifecycle" && s.kind !== "resource_mgmt")
      .slice(0, 5)
      .map((s) => `${sanitize(s.name)} - ${s.kind}`);

    return {
      file: f.file,
      lines_added: f.linesAdded,
      lines_removed: f.linesRemoved,
      is_new: f.isNew,
      has_concurrency: hasConcurrency,
      has_unsafe: hasUnsafe,
      has_error_changes: hasErrors,
      has_http_handlers: hasHttpHandlers,
      has_external_calls: hasExternalCalls,
      risk_items: riskItems.slice(0, 5),
      key_symbols: keySymbols,
      analyzer_findings: findings
        .filter((fd) => f.file.endsWith(fd.file) || fd.file.endsWith(f.file))
        .slice(0, 3)
        .map((fd) => `${fd.severity}: ${fd.message} [${fd.rule}]`),
    };
  });

  const text = await llm.generate(
    `Generate a Mermaid diagram for a pull request code review.

STRUCTURE — two types of nodes:
1. FILE NODES — one per file, labeled with just "filename +N/-N"
2. RISK NODES — small warning badges that branch off from file nodes, showing specific risky changes

LAYOUT:
- Use graph TD
- File nodes are the main flow: show dependency/call direction between files with labeled arrows
- Risk nodes attach to their parent file with dotted arrows, positioned to the side
- DEDUPLICATE risk items: if the same name appears in multiple files, create ONE risk node and connect it to all relevant files
- Maximum 4-5 risk nodes total — group similar ones (e.g. multiple error types into one "error paths" node)
- If a file has analyzer_findings, include the most severe one as a risk node (these come from static analysis tools like gosec, errcheck, bandit)

STYLING (pick highest applicable):
- RED: has_concurrency=true OR has_unsafe=true OR has_external_calls=true (highest risk — scaling, blocking, safety)
- ORANGE: has_http_handlers=true (new attack surface)
- GREEN: is_new=true with no red/orange flags
- BLUE: everything else (including files that only define error types — error definitions are not risky by themselves)
- All risk badge nodes: use class "risk"

SCALING AWARENESS:
- If a file has has_external_calls=true, add a risk node about potential scaling/timeout concerns (e.g. "WARN: outbound HTTP in hot path — no timeout/circuit breaker visible")
- External HTTP calls in auth or handler code are the highest review priority — they block on every request

CLASS DEFINITIONS — include these exactly (colors work in both light and dark mode):
classDef red fill:#dc3545,stroke:#a71d2a,color:#fff,stroke-width:2px
classDef orange fill:#e67e22,stroke:#bf6516,color:#fff,stroke-width:2px
classDef green fill:#28a745,stroke:#1e7e34,color:#fff,stroke-width:2px
classDef blue fill:#0366d6,stroke:#024ea4,color:#fff,stroke-width:2px
classDef risk fill:#ff6b6b,stroke:#c92a2a,color:#fff,font-size:11px,stroke-width:1px

CRITICAL SYNTAX RULES:
- ALL node labels MUST use quoted strings: A["label here"]
- NO parentheses, braces, angle brackets, or emoji inside quotes — text only
- Risk node labels: use format r1["WARN: description"] — no emoji, no special chars
- File node labels MUST include key function names from key_symbols:
  Format: "filename +N/-N\nFuncOne, FuncTwo, FuncThree"
  Show up to 3 function/type names per node. Use \n for line break.
- Dotted arrows from risk to file: r1 -.-> A
- EVERY arrow MUST have a label describing the relationship: -->|"calls"| or -->|"implements"| or -->|"configures"| etc.
- Use graph TD with generous spacing — prefer readability over compactness

PR summary: ${filesChanged} files changed, +${linesAdded}/-${linesRemoved}

Files and their symbols:
${JSON.stringify(payload, null, 2)}

Output ONLY the mermaid code. No explanation.`,
    2048
  );

  const mermaidMatch = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  if (mermaidMatch) {
    return mermaidMatch[1].trim();
  }

  if (text.startsWith("graph") || text.startsWith("flowchart")) {
    return text.trim();
  }

  return null;
}
