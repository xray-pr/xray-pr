import * as exec from "@actions/exec";
import * as core from "@actions/core";

export interface Finding {
  file: string;
  line: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  rule: string;
}

interface AnalyzerConfig {
  install: string;
  run: (files: string[]) => string[];
  parse: (output: string) => Finding[];
}

function parseGosecJson(output: string): Finding[] {
  try {
    const data = JSON.parse(output);
    if (!data.Issues) return [];
    return data.Issues.map((issue: {
      file: string;
      line: string;
      severity: string;
      details: string;
      rule_id: string;
    }) => ({
      file: issue.file,
      line: parseInt(issue.line, 10),
      severity: issue.severity === "HIGH" ? "HIGH" as const :
        issue.severity === "MEDIUM" ? "MEDIUM" as const : "LOW" as const,
      message: issue.details,
      rule: issue.rule_id,
    }));
  } catch {
    return [];
  }
}

function parseBanditJson(output: string): Finding[] {
  try {
    const data = JSON.parse(output);
    if (!data.results) return [];
    return data.results.map((r: {
      filename: string;
      line_number: number;
      issue_severity: string;
      issue_text: string;
      test_id: string;
    }) => ({
      file: r.filename,
      line: r.line_number,
      severity: r.issue_severity === "HIGH" ? "HIGH" as const :
        r.issue_severity === "MEDIUM" ? "MEDIUM" as const : "LOW" as const,
      message: r.issue_text,
      rule: r.test_id,
    }));
  } catch {
    return [];
  }
}

const ANALYZERS: Record<string, AnalyzerConfig> = {
  go: {
    install: "go install github.com/securego/gosec/v2/cmd/gosec@latest",
    run: (files) => ["gosec", "-fmt=json", "-quiet", "-exclude-dir=vendor", ...files],
    parse: parseGosecJson,
  },
  python: {
    install: "pip install bandit -q",
    run: (files) => ["bandit", "-f", "json", "-q", ...files],
    parse: parseBanditJson,
  },
};

async function tryExec(cmd: string, args: string[]): Promise<{ output: string; ok: boolean }> {
  let output = "";
  let errOutput = "";
  try {
    await exec.exec(cmd, args, {
      listeners: {
        stdout: (data) => (output += data.toString()),
        stderr: (data) => (errOutput += data.toString()),
      },
      silent: true,
      ignoreReturnCode: true,
    });
    return { output: output || errOutput, ok: true };
  } catch {
    return { output: "", ok: false };
  }
}

export async function runAnalyzers(
  languages: Set<string>,
  changedFiles: string[]
): Promise<Finding[]> {
  const allFindings: Finding[] = [];

  for (const lang of languages) {
    const config = ANALYZERS[lang];
    if (!config) continue;

    core.info(`Installing ${lang} analyzer...`);
    const installParts = config.install.split(" ");
    const installResult = await tryExec(installParts[0], installParts.slice(1));
    if (!installResult.ok) {
      core.warning(`Failed to install ${lang} analyzer, skipping`);
      continue;
    }

    const langFiles = changedFiles.filter((f) => {
      if (lang === "go") return f.endsWith(".go") && !f.endsWith("_test.go");
      if (lang === "python") return f.endsWith(".py") && !f.includes("test_") && !f.endsWith("_test.py");
      return false;
    });

    if (langFiles.length === 0) continue;

    core.info(`Running ${lang} analyzer on ${langFiles.length} files...`);
    const runArgs = config.run(langFiles);
    const result = await tryExec(runArgs[0], runArgs.slice(1));

    if (result.output) {
      const findings = config.parse(result.output);
      allFindings.push(...findings);
      core.info(`${lang} analyzer: ${findings.length} findings`);
    }
  }

  return allFindings;
}

export function summarizeFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return [];

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const existing = byFile.get(f.file) || [];
    existing.push(f);
    byFile.set(f.file, existing);
  }

  const lines: string[] = [];
  for (const [file, fileFindings] of byFile) {
    const high = fileFindings.filter((f) => f.severity === "HIGH").length;
    const medium = fileFindings.filter((f) => f.severity === "MEDIUM").length;
    const shortFile = file.split("/").pop() || file;
    const parts: string[] = [];
    if (high > 0) parts.push(`${high} high`);
    if (medium > 0) parts.push(`${medium} medium`);
    lines.push(`${shortFile}: ${parts.join(", ")}`);
  }

  return lines;
}
