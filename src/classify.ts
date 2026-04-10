import * as path from "path";
import { ExtractionResult, LanguagePattern } from "./extract";

export interface Classification {
  logic: number;
  tests: number;
  types: number;
  docs: number;
  total: number;
}

const DOC_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc",
  ".yaml", ".yml", ".toml", ".json",
  ".html", ".css", ".svg", ".png", ".jpg",
  ".lock", ".sum", ".mod",
]);

export function classify(
  extraction: ExtractionResult,
  patterns: Map<string, LanguagePattern>
): Classification {
  const result: Classification = {
    logic: 0,
    tests: 0,
    types: 0,
    docs: 0,
    total: 0,
  };

  for (const [file, lines] of extraction.diffByFile) {
    const ext = path.extname(file);
    const addedLines = lines.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++")
    );
    const count = addedLines.length;
    if (count === 0) continue;

    result.total += count;

    if (DOC_EXTENSIONS.has(ext)) {
      result.docs += count;
      continue;
    }

    let langPattern: LanguagePattern | undefined;
    for (const [, p] of patterns) {
      if (p.extensions.includes(ext)) {
        langPattern = p;
        break;
      }
    }

    if (langPattern && new RegExp(langPattern.test_file_pattern).test(file)) {
      result.tests += count;
      continue;
    }

    if (!langPattern) {
      result.logic += count;
      continue;
    }

    let typeLines = 0;
    const typeRegex = langPattern.symbols.types
      ? new RegExp(langPattern.symbols.types)
      : null;
    const configRegex = langPattern.symbols.config
      ? new RegExp(langPattern.symbols.config)
      : null;

    for (const line of addedLines) {
      if (typeRegex?.test(line) || configRegex?.test(line)) {
        typeLines++;
      }
    }

    result.types += typeLines;
    result.logic += count - typeLines;
  }

  return result;
}

export function formatClassification(c: Classification): string {
  if (c.total === 0) return "";

  const bar = (n: number): string => {
    const pct = c.total > 0 ? n / c.total : 0;
    const filled = Math.round(pct * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  const pct = (n: number): string => {
    return `${Math.round((n / c.total) * 100)}%`;
  };

  const pad = (label: string, len: number): string =>
    label.padEnd(len);

  const lines: string[] = [];
  if (c.logic > 0)
    lines.push(
      `${pad("Logic:", 14)} ${String(c.logic).padStart(5)} lines  (${pct(c.logic).padStart(3)}) ${bar(c.logic)}`
    );
  if (c.tests > 0)
    lines.push(
      `${pad("Tests:", 14)} ${String(c.tests).padStart(5)} lines  (${pct(c.tests).padStart(3)}) ${bar(c.tests)}`
    );
  if (c.types > 0)
    lines.push(
      `${pad("Types/Config:", 14)} ${String(c.types).padStart(5)} lines  (${pct(c.types).padStart(3)}) ${bar(c.types)}`
    );
  if (c.docs > 0)
    lines.push(
      `${pad("Docs/Other:", 14)} ${String(c.docs).padStart(5)} lines  (${pct(c.docs).padStart(3)}) ${bar(c.docs)}`
    );

  return lines.join("\n");
}
