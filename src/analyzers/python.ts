import * as exec from "@actions/exec";
import * as core from "@actions/core";
import { Finding } from "../analyze";

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

export async function analyzePython(changedFiles: string[]): Promise<Finding[]> {
  const pyFiles = changedFiles.filter(
    (f) => f.endsWith(".py") && !f.includes("test_") && !f.endsWith("_test.py")
  );
  if (pyFiles.length === 0) return [];

  core.info("Installing bandit...");
  const installResult = await tryExec("pip", ["install", "bandit", "-q"]);
  if (!installResult.ok) {
    core.warning("Failed to install bandit, skipping Python analysis");
    return [];
  }

  core.info(`Running bandit on ${pyFiles.length} files...`);
  const result = await tryExec("bandit", ["-f", "json", "-q", ...pyFiles]);

  if (!result.output) return [];

  return parseBanditOutput(result.output);
}

function parseBanditOutput(output: string): Finding[] {
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
