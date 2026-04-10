import * as core from "@actions/core";
import * as github from "@actions/github";
import { Symbol, FileSummary } from "./extract";
import { Classification, formatClassification } from "./classify";

const COMMENT_HEADER = "<!-- xray-arch-diff -->";

const GENERIC_SYMBOL_NAMES = new Set([
  "go func", "go", "sync.Mutex", "sync.RWMutex", "sync.WaitGroup",
  "sync.Once", "make(chan", "makeChan", "fmt.Errorf", "errors.New",
]);

function isTestSymbol(s: Symbol): boolean {
  return /^(Test|Benchmark|test_|describe|it\(|setUp|tearDown)/i.test(s.name);
}

function isGenericConcurrency(s: Symbol): boolean {
  if (s.kind !== "concurrency") return false;
  return GENERIC_SYMBOL_NAMES.has(s.name) ||
    /^(go\s|sync\.|make\(chan)/.test(s.name);
}

function formatStructuralChanges(symbols: Symbol[], fileSummaries: FileSummary[]): string {
  const nonTestSymbols = symbols.filter((s) => !isTestSymbol(s));
  const added = nonTestSymbols.filter((s) => s.change === "added");
  const removed = nonTestSymbols.filter((s) => s.change === "removed");

  if (added.length === 0 && removed.length === 0) {
    return "_No structural symbol changes detected._";
  }

  const seen = new Set<string>();
  const namedAdded: Symbol[] = [];
  const namedModified: Symbol[] = [];
  const namedRemoved: Symbol[] = [];
  const concurrencyAdded: Record<string, number> = {};
  const concurrencyRemoved: Record<string, number> = {};

  for (const s of added) {
    if (isGenericConcurrency(s)) {
      const key = s.name.replace(/\s+/g, " ").trim();
      concurrencyAdded[key] = (concurrencyAdded[key] || 0) + 1;
      continue;
    }
    if (removed.some((r) => r.name === s.name && r.kind === s.kind)) {
      if (!seen.has(`${s.name}:${s.kind}`)) {
        namedModified.push(s);
        seen.add(`${s.name}:${s.kind}`);
      }
    } else {
      if (!seen.has(`${s.name}:${s.kind}:added`)) {
        namedAdded.push(s);
        seen.add(`${s.name}:${s.kind}:added`);
      }
    }
  }

  for (const s of removed) {
    if (isGenericConcurrency(s)) {
      const key = s.name.replace(/\s+/g, " ").trim();
      concurrencyRemoved[key] = (concurrencyRemoved[key] || 0) + 1;
      continue;
    }
    if (!added.some((a) => a.name === s.name && a.kind === s.kind)) {
      if (!seen.has(`${s.name}:${s.kind}:removed`)) {
        namedRemoved.push(s);
        seen.add(`${s.name}:${s.kind}:removed`);
      }
    }
  }

  const lines: string[] = [];

  for (const s of namedAdded) {
    lines.push(`+ ${s.name.padEnd(35)} (new ${s.kind})`);
  }
  for (const s of namedModified) {
    lines.push(`~ ${s.name.padEnd(35)} (modified ${s.kind})`);
  }
  for (const s of namedRemoved) {
    lines.push(`- ${s.name.padEnd(35)} (removed ${s.kind})`);
  }

  const concAddedParts: string[] = [];
  for (const [name, count] of Object.entries(concurrencyAdded)) {
    concAddedParts.push(`${count}x ${name}`);
  }
  const concRemovedParts: string[] = [];
  for (const [name, count] of Object.entries(concurrencyRemoved)) {
    concRemovedParts.push(`${count}x ${name}`);
  }

  if (concAddedParts.length > 0) {
    lines.push("");
    lines.push(`+ concurrency: ${concAddedParts.join(", ")}`);
  }
  if (concRemovedParts.length > 0) {
    lines.push(`- concurrency: ${concRemovedParts.join(", ")}`);
  }

  const testSymbols = symbols.filter((s) => isTestSymbol(s) && s.change === "added");
  if (testSymbols.length > 0) {
    lines.push("");
    lines.push(`+ ${testSymbols.length} test functions added`);
  }

  return lines.join("\n");
}

function formatFileRanking(fileSummaries: FileSummary[]): string {
  const nonTest = fileSummaries.filter((f) => !f.isTest && (f.symbols.length > 0 || f.linesAdded > 20));
  const testFiles = fileSummaries.filter((f) => f.isTest);

  if (nonTest.length === 0 && testFiles.length === 0) return "";

  const lines: string[] = [];
  let rank = 1;

  for (const f of nonTest) {
    const nonGenericSymbols = f.symbols.filter((s) => !isGenericConcurrency(s) && !isTestSymbol(s));
    const concCount = f.symbols.filter((s) => s.kind === "concurrency").length;

    const parts: string[] = [];
    if (nonGenericSymbols.length > 0) {
      const kindCounts: Record<string, number> = {};
      for (const s of nonGenericSymbols) {
        kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
      }
      parts.push(...Object.entries(kindCounts).map(([k, v]) => `${v} ${k}`));
    }
    if (concCount > 0) {
      parts.push(`${concCount} concurrency`);
    }

    const label = f.isNew ? " (new)" : "";
    const detail = parts.length > 0 ? `, ${parts.join(", ")}` : "";
    lines.push(
      `${String(rank).padStart(2)}. ${f.file}${label}  — +${f.linesAdded}/-${f.linesRemoved}${detail}`
    );
    rank++;
  }

  if (testFiles.length > 0) {
    const totalTestLines = testFiles.reduce((sum, f) => sum + f.linesAdded, 0);
    lines.push(
      `${String(rank).padStart(2)}. ${testFiles.length} test file${testFiles.length > 1 ? "s" : ""}  — +${totalTestLines} lines`
    );
  }

  return lines.join("\n");
}

function formatFilesSummary(
  newFiles: string[],
  deletedFiles: string[],
  totalChanged: number
): string {
  const parts: string[] = [`**${totalChanged}** files changed`];
  if (newFiles.length > 0) parts.push(`**${newFiles.length}** new`);
  if (deletedFiles.length > 0) parts.push(`**${deletedFiles.length}** deleted`);
  return parts.join(" · ");
}

export function composeComment(
  classification: Classification,
  symbols: Symbol[],
  fileSummaries: FileSummary[],
  newFiles: string[],
  deletedFiles: string[],
  totalFiles: number,
  linesAdded: number,
  linesRemoved: number,
  diagram: string | null
): string {
  const sections: string[] = [COMMENT_HEADER];

  if (diagram) {
    sections.push("```mermaid");
    sections.push(diagram);
    sections.push("```");
    sections.push("");
  }

  sections.push("🔴 concurrency changes (review first) · 🟠 error path changes · 🟢 new files · 🔵 modified files");
  sections.push("");
  sections.push(
    "<sub>[xray](https://github.com/kasrakhosravi/xray) — see through AI slop</sub>"
  );

  return sections.join("\n");
}

export async function postComment(
  token: string,
  body: string
): Promise<void> {
  const octokit = github.getOctokit(token);
  const ctx = github.context;

  const prNumber =
    ctx.payload.pull_request?.number ?? ctx.payload.issue?.number;
  if (!prNumber) {
    core.warning("Could not determine PR number. Skipping comment.");
    return;
  }

  const repo = ctx.repo;

  const { data: comments } = await octokit.rest.issues.listComments({
    ...repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (c) => c.body?.includes(COMMENT_HEADER)
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number: prNumber,
      body,
    });
  }
}
