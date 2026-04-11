import * as core from "@actions/core";
import { analyzeGo } from "./analyzers/go";
import { analyzePython } from "./analyzers/python";

export interface Finding {
  file: string;
  line: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  rule: string;
}

type LanguageAnalyzer = (changedFiles: string[]) => Promise<Finding[]>;

const ANALYZERS: Record<string, LanguageAnalyzer> = {
  go: analyzeGo,
  python: analyzePython,
};

export async function runAnalyzers(
  languages: Set<string>,
  changedFiles: string[]
): Promise<Finding[]> {
  const allFindings: Finding[] = [];

  for (const lang of languages) {
    const analyze = ANALYZERS[lang];
    if (!analyze) continue;

    core.info(`Running ${lang} analyzer...`);
    try {
      const findings = await analyze(changedFiles);
      allFindings.push(...findings);
      core.info(`${lang}: ${findings.length} findings`);
    } catch (err) {
      core.warning(`${lang} analyzer failed: ${err}`);
    }
  }

  return allFindings;
}
