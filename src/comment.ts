import * as core from "@actions/core";
import * as crypto from "crypto";
import * as github from "@actions/github";
import { Symbol, FileSummary } from "./extract";
import { Classification } from "./classify";
import { Finding } from "./analyze";

const COMMENT_HEADER = "<!-- xray-arch-diff -->";

function hashPath(filePath: string): string {
  return crypto.createHash("sha256").update(filePath).digest("hex");
}

const GENERIC_SYMBOL_NAMES = new Set([
  "go func", "go", "sync.Mutex", "sync.RWMutex", "sync.WaitGroup",
  "sync.Once", "sync.Cond", "sync.Map", "make(chan", "makeChan",
  "fmt.Errorf", "errors.New", "select",
]);

const HIGH_RISK_KINDS = new Set([
  "concurrency", "unsafe_ops", "external_calls",
]);

const MEDIUM_RISK_KINDS = new Set([
  "http_handlers",
]);

const INFO_KINDS = new Set([
  "errors", "context_lifecycle", "resource_mgmt",
]);

function isTestSymbol(s: Symbol): boolean {
  return /^(Test|Benchmark|test_|describe|it\(|setUp|tearDown)/i.test(s.name);
}

// Generic-name detector shared across Go and Rust. A "generic" name is a
// language or library primitive (e.g. `go func`, `tokio::spawn`, `File::open`)
// that should count toward the kind's signal but should not be listed as a
// named identifier in risk tooltips or the "Key changes" column. Keep the
// branches ordered by kind so new languages plug in without touching Go rules.
function isGenericSymbol(s: Symbol): boolean {
  if (s.kind === "concurrency") {
    return GENERIC_SYMBOL_NAMES.has(s.name) ||
      // Go
      /^(go\s|sync\.|make\(chan|select\s|<-\s*chan)/.test(s.name) ||
      // Rust
      /^(Arc[<:]|Mutex[<:]|RwLock[<:]|tokio::spawn|std::thread::spawn|channel\()/.test(s.name);
  }
  if (s.kind === "context_lifecycle") {
    return /^(context\.|ctx\.)/.test(s.name) ||
      // Rust
      /^(CancellationToken|tokio::(select!|(time::)?timeout)|JoinHandle|\.abort\(\)|futures::select!)/.test(s.name);
  }
  if (s.kind === "resource_mgmt") {
    return /^(defer\s|os\.|sql\.)/.test(s.name) ||
      // Rust
      /^(impl Drop|File::(open|create)|\.(lock|read|write)\(\)|drop\()/.test(s.name);
  }
  if (s.kind === "errors") {
    // Library primitives that aren't named identifiers.
    // Go: `errors.New(`, `fmt.Errorf(`. Rust: `thiserror`, `anyhow`.
    return /^(thiserror|anyhow|errors\.New|fmt\.Errorf)/.test(s.name);
  }
  return false;
}

function isGenericConcurrency(s: Symbol): boolean {
  return isGenericSymbol(s);
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
  diagram: string | null,
  prFilesUrl: string,
  summaryLine: string,
  findings: Finding[]
): string {
  const sections: string[] = [COMMENT_HEADER];

  if (summaryLine) {
    sections.push(`**${summaryLine}**`);
    sections.push("");
  }

  if (diagram) {
    sections.push("```mermaid");
    sections.push(diagram);
    sections.push("```");
    sections.push("");
  }

  const nonTestFiles = fileSummaries.filter((f) => !f.isTest);
  const relevantFiles = nonTestFiles.filter(
    (f) => f.symbols.length > 0 || f.linesAdded > 20
  );

  if (relevantFiles.length > 0) {
    interface FileRow {
      icon: string;
      riskLevel: number;
      fileLink: string;
      lines: string;
      keyChanges: string;
      risk: string;
    }

    const rows: FileRow[] = [];

    for (const f of relevantFiles) {
      const hasHigh = f.symbols.some((s) => HIGH_RISK_KINDS.has(s.kind));
      const hasMedium = f.symbols.some((s) => MEDIUM_RISK_KINDS.has(s.kind));
      const hasInfo = f.symbols.some((s) => INFO_KINDS.has(s.kind));

      let icon = "🔵";
      let risk = "";
      let riskLevel = 0;

      const riskParts: string[] = [];

      const countByKind = (kind: string) => f.symbols.filter((s) => s.kind === kind).length;
      const namedByKind = (kind: string) => f.symbols
        .filter((s) => s.kind === kind && s.change === "added" && !isGenericSymbol(s))
        .slice(0, 2)
        .map((s) => s.name);

      if (hasHigh) {
        icon = "🔴";
        riskLevel = 3;
        const concCount = countByKind("concurrency");
        const unsafeCount = countByKind("unsafe_ops");
        if (concCount > 0) riskParts.push(`${concCount} concurrency`);
        if (unsafeCount > 0) riskParts.push(`${unsafeCount} unsafe`);
      }

      if (hasMedium) {
        if (!hasHigh) { icon = "🟠"; riskLevel = 2; }
        const errNames = namedByKind("errors");
        const httpCount = countByKind("http_handlers");
        const extCount = countByKind("external_calls");
        if (errNames.length > 0) riskParts.push(errNames.join(", "));
        else if (countByKind("errors") > 0) riskParts.push("error paths");
        if (httpCount > 0) riskParts.push(`${httpCount} HTTP handler${httpCount > 1 ? "s" : ""}`);
        if (extCount > 0) riskParts.push(`${extCount} external call${extCount > 1 ? "s" : ""}`);
      }

      if (hasInfo && !hasHigh && !hasMedium) {
        if (f.isNew) { icon = "🟢"; riskLevel = 1; }
        else { riskLevel = 1; }
        const ctxCount = countByKind("context_lifecycle");
        const resCount = countByKind("resource_mgmt");
        if (ctxCount > 0) riskParts.push(`${ctxCount} context`);
        if (resCount > 0) riskParts.push(`${resCount} resource`);
      }

      if (!hasHigh && !hasMedium && !hasInfo && f.isNew) {
        icon = "🟢";
      }

      risk = riskParts.length > 0 ? `⚠ ${riskParts.join(", ")}` : "";

      const nonTestNonGeneric = f.symbols.filter(
        (s) => !isTestSymbol(s) && !isGenericSymbol(s) &&
          !HIGH_RISK_KINDS.has(s.kind) && !MEDIUM_RISK_KINDS.has(s.kind) &&
          !INFO_KINDS.has(s.kind) && s.change === "added"
      );
      const keyNames = nonTestNonGeneric.slice(0, 3).map((s) => `\`${s.name}\``);
      if (keyNames.length < nonTestNonGeneric.length) keyNames.push("...");

      const fileFindings = findings.filter((fd) => f.file.endsWith(fd.file) || fd.file.endsWith(f.file));
      const highFindings = fileFindings.filter((fd) => fd.severity === "HIGH").length;
      const medFindings = fileFindings.filter((fd) => fd.severity === "MEDIUM").length;

      if (highFindings > 0) {
        if (riskLevel < 3) { icon = "🔴"; riskLevel = 3; }
        riskParts.push(`${highFindings} high severity`);
        risk = `⚠ ${riskParts.join(", ")}`;
      } else if (medFindings > 0) {
        if (riskLevel < 2) { icon = "🟠"; riskLevel = 2; }
        riskParts.push(`${medFindings} medium severity`);
        risk = `⚠ ${riskParts.join(", ")}`;
      }

      const shortFile = f.file.split("/").pop() || f.file;
      const fileLink = prFilesUrl
        ? `[${shortFile}](${prFilesUrl}#diff-${hashPath(f.file)})`
        : shortFile;

      rows.push({
        icon,
        riskLevel,
        fileLink,
        lines: `\`+${f.linesAdded}/-${f.linesRemoved}\``,
        keyChanges: keyNames.join(", ") || "—",
        risk,
      });
    }

    rows.sort((a, b) => b.riskLevel - a.riskLevel);

    sections.push("| | File | Lines | Key changes | Risk |");
    sections.push("|:---:|:---|:---:|:---|:---|");

    for (const r of rows) {
      sections.push(
        `| ${r.icon} | ${r.fileLink} | ${r.lines} | ${r.keyChanges} | ${r.risk} |`
      );
    }

    const testFiles = fileSummaries.filter((f) => f.isTest);
    if (testFiles.length > 0) {
      const testLines = testFiles.reduce((sum, f) => sum + f.linesAdded, 0);
      sections.push(`| | _${testFiles.length} test files_ | \`+${testLines}\` | | |`);
    }

    sections.push("");
  }

  if (findings.length > 0) {
    const high = findings.filter((f) => f.severity === "HIGH");
    const medium = findings.filter((f) => f.severity === "MEDIUM");
    sections.push("<details><summary>Static analysis findings");
    if (high.length > 0) sections[sections.length - 1] += ` — ${high.length} high, ${medium.length} medium`;
    sections[sections.length - 1] += "</summary>";
    sections.push("");
    for (const f of [...high, ...medium].slice(0, 10)) {
      const shortFile = f.file.split("/").pop() || f.file;
      sections.push(`- **${f.severity}** \`${shortFile}:${f.line}\` ${f.message} (\`${f.rule}\`)`);
    }
    if (findings.length > 10) {
      sections.push(`- _...and ${findings.length - 10} more_`);
    }
    sections.push("");
    sections.push("</details>");
    sections.push("");
  }

  sections.push(
    "<sub>[xray](https://github.com/kasrakhosravi/xray) — see through AI slop with deterministic architecture PR diff reviews</sub>"
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
