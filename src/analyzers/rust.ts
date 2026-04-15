import * as exec from "@actions/exec";
import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { Finding } from "../analyze";

// Clippy lint set. Deny-by-default `correctness` is kept as deny so it
// surfaces as error-level (mapped to HIGH). The rest are warn-level and
// are either mapped to HIGH via HIGH_WARN_RULES (panics, lock/memory
// hazards) or default to MEDIUM.
const CLIPPY_FLAGS: string[] = [
  "-D", "clippy::correctness",
  "-W", "clippy::suspicious",
  "-W", "clippy::perf",
  "-W", "clippy::complexity",
  "-W", "clippy::unwrap_used",
  "-W", "clippy::expect_used",
  "-W", "clippy::panic",
  "-W", "clippy::mem_forget",
  "-W", "clippy::await_holding_lock",
  "-W", "clippy::await_holding_refcell_ref",
  "-W", "clippy::arithmetic_side_effects",
  "-W", "clippy::indexing_slicing",
  "-A", "clippy::too_many_arguments",
];

const HIGH_WARN_RULES = new Set<string>([
  "clippy::unwrap_used",
  "clippy::expect_used",
  "clippy::panic",
  "clippy::mem_forget",
  "clippy::await_holding_lock",
  "clippy::await_holding_refcell_ref",
]);

const MAX_FINDINGS_PER_RULE = 10;

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

export async function analyzeRust(changedFiles: string[]): Promise<Finding[]> {
  const rsFiles = changedFiles.filter(
    (f) => f.endsWith(".rs") && !/(^|\/)tests\//.test(f) && !f.endsWith("_test.rs")
  );
  if (rsFiles.length === 0) return [];

  // Skip entirely when there is no Cargo project at the repo root.
  // Avoids a 30-60s rustup install on monorepos that happen to contain
  // stray .rs files (docs, examples) without a Cargo.toml.
  if (!fs.existsSync(path.join(process.cwd(), "Cargo.toml"))) {
    core.info("No Cargo.toml at repo root — skipping Rust analysis.");
    return [];
  }

  core.info("Ensuring clippy component is installed...");
  const rustupResult = await tryExec("rustup", ["component", "add", "clippy"]);
  if (!rustupResult.ok) {
    core.warning("rustup / clippy component not available — skipping Rust analysis.");
    return [];
  }

  const clippyArgs = [
    "clippy",
    "--workspace",
    "--no-deps",
    "--all-targets",
    "--message-format=json",
    "--",
    ...CLIPPY_FLAGS,
  ];

  core.info(`Running cargo clippy with ${CLIPPY_FLAGS.length / 2} curated lint flags...`);
  const result = await tryExec("cargo", clippyArgs);
  if (!result.output) return [];

  return parseClippyOutput(result.output);
}

interface ClippySpan {
  file_name: string;
  line_start: number;
  is_primary?: boolean;
}

interface ClippyMessage {
  reason?: string;
  message?: {
    message: string;
    level?: string;
    code?: { code: string } | null;
    spans: ClippySpan[];
  };
}

function parseClippyOutput(output: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const perRuleCount: Record<string, number> = {};

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let data: ClippyMessage;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (data.reason !== "compiler-message") continue;

    const msg = data.message;
    if (!msg) continue;

    const ruleCode = msg.code?.code;
    if (!ruleCode || !ruleCode.startsWith("clippy::")) continue;

    const primary = msg.spans.find((s) => s.is_primary) ?? msg.spans[0];
    if (!primary || !primary.file_name) continue;

    const relPath = path.isAbsolute(primary.file_name)
      ? path.relative(process.cwd(), primary.file_name)
      : primary.file_name;

    const dedupeKey = `${relPath}:${primary.line_start}:${ruleCode}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const count = (perRuleCount[ruleCode] || 0) + 1;
    if (count > MAX_FINDINGS_PER_RULE) continue;
    perRuleCount[ruleCode] = count;

    findings.push({
      file: relPath,
      line: primary.line_start,
      severity: mapSeverity(ruleCode, msg.level),
      message: msg.message,
      rule: ruleCode,
    });
  }

  return findings;
}

function mapSeverity(rule: string, level?: string): "HIGH" | "MEDIUM" | "LOW" {
  // Deny-level (clippy::correctness group) arrives as level=error.
  if (level === "error") return "HIGH";
  if (HIGH_WARN_RULES.has(rule)) return "HIGH";
  // Everything else in the curated set: perf, complexity, suspicious,
  // arithmetic_side_effects, indexing_slicing — surfaces as a signal but
  // not a top-priority finding.
  return "MEDIUM";
}
