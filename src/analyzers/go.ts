import * as exec from "@actions/exec";
import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Finding } from "../analyze";

const LINTERS = [
  "gosec",          // security: hardcoded creds, SQL injection, weak crypto
  "errcheck",       // unchecked error return values
  "bodyclose",      // HTTP response body not closed
  "contextcheck",   // non-inherited context usage
  "noctx",          // HTTP requests without context
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
    - bodyclose
    - contextcheck
    - noctx
  settings:
    gosec:
      excludes:
        - G115
issues:
  max-issues-per-linter: 20
  max-same-issues: 3
`);

  const dirs = new Set(goFiles.map((f) => "./" + path.dirname(f) + "/..."));

  core.info(`Running golangci-lint (${LINTERS}) on ${dirs.size} packages...`);
  const result = await tryExec("golangci-lint", [
    "run",
    "--config", configPath,
    "--out-format", "json",
    "--timeout", "120s",
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

function mapSeverity(linter: string, raw: string): "HIGH" | "MEDIUM" | "LOW" {
  if (linter === "gosec") return raw === "HIGH" ? "HIGH" : "MEDIUM";
  if (linter === "errcheck") return "MEDIUM";
  if (linter === "bodyclose") return "HIGH";
  if (linter === "contextcheck") return "MEDIUM";
  if (linter === "noctx") return "MEDIUM";
  return "LOW";
}
