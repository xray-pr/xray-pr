import * as exec from "@actions/exec";
import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Finding } from "../analyze";

const LINTERS = [
  // security
  "gosec",          // hardcoded creds, SQL injection, weak crypto, command injection
  // error handling
  "errcheck",       // unchecked error return values
  "nilerr",         // returning nil when err != nil (swallowed errors)
  "wrapcheck",      // errors returned without wrapping (untraceable in production)
  // resource leaks
  "bodyclose",      // HTTP response body not closed (connection leak)
  "sqlclosecheck",  // SQL rows/statements not closed (DB pool exhaustion)
  // context propagation
  "contextcheck",   // non-inherited context (cancellation won't propagate)
  "noctx",          // HTTP requests without context (can't timeout/cancel)
  // nil safety
  "nilaway",        // nil pointer dereferences across package boundaries
  // correctness
  "staticcheck",    // 150+ checks: dead code, deprecated APIs, incorrect sync, impossible conditions
  "gocritic",       // 108 checks: suspicious appends, off-by-one, nil returns, duplicate branches
  "exhaustive",     // missing cases in enum switch statements
  // observability
  "spancheck",      // OpenTelemetry span not ended or error not recorded
].join(",");

async function tryExec(cmd: string, args: string[]): Promise<{ output: string; ok: boolean }> {
  let output = "";
  try {
    await exec.exec(cmd, args, {
      listeners: { stdout: (data) => (output += data.toString()) },
      silent: true,
      ignoreReturnCode: true,
    });
    return { output, ok: true };
  } catch {
    return { output: "", ok: false };
  }
}

export async function analyzeGo(changedFiles: string[]): Promise<Finding[]> {
  const goFiles = changedFiles.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  if (goFiles.length === 0) return [];

  core.info("Installing golangci-lint...");
  const installResult = await tryExec("go", [
    "install",
    "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest",
  ]);
  if (!installResult.ok) {
    core.warning("Failed to install golangci-lint, skipping Go analysis");
    return [];
  }

  const configPath = path.join(os.tmpdir(), ".golangci-xray.yml");
  fs.writeFileSync(configPath, `
linters:
  enable-only:
    - gosec
    - errcheck
    - nilerr
    - wrapcheck
    - bodyclose
    - sqlclosecheck
    - contextcheck
    - noctx
    - nilaway
    - staticcheck
    - gocritic
    - exhaustive
    - spancheck
  settings:
    gosec:
      excludes:
        - G115
    gocritic:
      enabled-tags:
        - diagnostic
    exhaustive:
      default-signifies-exhaustive: true
    wrapcheck:
      ignore-sigregexps:
        - "fmt\\.Errorf"
issues:
  max-issues-per-linter: 10
  max-same-issues: 2
`);

  const dirs = new Set(goFiles.map((f) => "./" + path.dirname(f) + "/..."));

  core.info(`Running golangci-lint (13 linters) on ${dirs.size} packages...`);
  const result = await tryExec("golangci-lint", [
    "run",
    "--config", configPath,
    "--out-format", "json",
    "--timeout", "180s",
    "--new=false",
    ...Array.from(dirs),
  ]);

  if (!result.output) return [];

  return parseGolangciOutput(result.output);
}

function parseGolangciOutput(output: string): Finding[] {
  try {
    const data = JSON.parse(output);
    if (!data.Issues || !Array.isArray(data.Issues)) return [];

    return data.Issues.map((issue: {
      Pos: { Filename: string; Line: number };
      Severity: string;
      Text: string;
      FromLinter: string;
    }) => {
      const linter = issue.FromLinter || "unknown";
      const severity = mapSeverity(linter, issue.Severity);

      return {
        file: issue.Pos.Filename,
        line: issue.Pos.Line,
        severity,
        message: issue.Text,
        rule: linter,
      };
    });
  } catch {
    return [];
  }
}

function mapSeverity(linter: string, _raw: string): "HIGH" | "MEDIUM" | "LOW" {
  switch (linter) {
    // HIGH: security, nil panics, resource leaks
    case "gosec":         return "HIGH";
    case "nilaway":       return "HIGH";
    case "bodyclose":     return "HIGH";
    case "sqlclosecheck": return "HIGH";
    case "nilerr":        return "HIGH";
    case "spancheck":     return "HIGH";
    // MEDIUM: correctness, context, error handling
    case "staticcheck":   return "MEDIUM";
    case "gocritic":      return "MEDIUM";
    case "errcheck":      return "MEDIUM";
    case "contextcheck":  return "MEDIUM";
    case "noctx":         return "MEDIUM";
    case "exhaustive":    return "MEDIUM";
    case "wrapcheck":     return "LOW";
    default:              return "LOW";
  }
}
