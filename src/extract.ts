import * as exec from "@actions/exec";
import * as fs from "fs";
import * as path from "path";

export interface Symbol {
  name: string;
  kind: string;
  file: string;
  change: "added" | "removed";
}

export interface LanguagePattern {
  extensions: string[];
  doc_extensions: string[];
  test_file_pattern: string;
  symbols: Record<string, string>;
}

export interface ExtractionResult {
  symbols: Symbol[];
  changedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
  linesAdded: number;
  linesRemoved: number;
  diffByFile: Map<string, string[]>;
  languages: Set<string>;
}

async function execOutput(cmd: string, args: string[]): Promise<string> {
  let output = "";
  await exec.exec(cmd, args, {
    listeners: { stdout: (data) => (output += data.toString()) },
    silent: true,
  });
  return output.trim();
}

function loadPatterns(languageFilter: string): Map<string, LanguagePattern> {
  const patternsDir = path.join(__dirname, "patterns");
  const patterns = new Map<string, LanguagePattern>();

  let files: string[];
  try {
    files = fs.readdirSync(patternsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return patterns;
  }

  const filterSet =
    languageFilter === "auto"
      ? null
      : new Set(languageFilter.split(",").map((l) => l.trim().toLowerCase()));

  for (const file of files) {
    const lang = path.basename(file, ".json");
    if (filterSet && !filterSet.has(lang)) continue;
    try {
      const content = fs.readFileSync(path.join(patternsDir, file), "utf-8");
      patterns.set(lang, JSON.parse(content));
    } catch {
      // skip malformed pattern files
    }
  }

  return patterns;
}

function detectLanguages(
  files: string[],
  patterns: Map<string, LanguagePattern>
): Set<string> {
  const detected = new Set<string>();
  for (const file of files) {
    const ext = path.extname(file);
    for (const [lang, pattern] of patterns) {
      if (pattern.extensions.includes(ext)) {
        detected.add(lang);
      }
    }
  }
  return detected;
}

function extractSymbolsFromDiff(
  diffLines: string[],
  currentFile: string,
  pattern: LanguagePattern
): Symbol[] {
  const symbols: Symbol[] = [];

  for (const line of diffLines) {
    const isAdd = line.startsWith("+");
    const isRemove = line.startsWith("-");
    if (!isAdd && !isRemove) continue;

    const change = isAdd ? "added" : "removed";

    for (const [kind, regex] of Object.entries(pattern.symbols)) {
      if (kind === "tests") continue;
      try {
        const re = new RegExp(regex);
        const match = line.match(re);
        if (match) {
          const captures = match.slice(1).filter(Boolean);
          const name = captures.find(
            (c) => c.length > 1 && !/^(pub|export|async|public|protected|private|abstract)\s*$/.test(c)
          ) || captures[0] || "unknown";
          
          if (name && name !== "unknown" && !symbols.some(
            (s) => s.name === name && s.kind === kind && s.change === change
          )) {
            symbols.push({ name: name.trim(), kind, file: currentFile, change });
          }
        }
      } catch {
        // skip bad regex
      }
    }
  }

  return symbols;
}

function parseDiffByFile(diff: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let currentFile = "";
  let currentLines: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        byFile.set(currentFile, currentLines);
      }
      currentLines = [];
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "";
    } else {
      currentLines.push(line);
    }
  }

  if (currentFile) {
    byFile.set(currentFile, currentLines);
  }

  return byFile;
}

export async function extract(
  baseRef: string,
  languageFilter: string
): Promise<ExtractionResult> {
  const changedFiles = (
    await execOutput("git", ["diff", "--name-only", `${baseRef}...HEAD`])
  )
    .split("\n")
    .filter(Boolean);

  const newFiles = (
    await execOutput("git", [
      "diff",
      "--diff-filter=A",
      "--name-only",
      `${baseRef}...HEAD`,
    ])
  )
    .split("\n")
    .filter(Boolean);

  const deletedFiles = (
    await execOutput("git", [
      "diff",
      "--diff-filter=D",
      "--name-only",
      `${baseRef}...HEAD`,
    ])
  )
    .split("\n")
    .filter(Boolean);

  const stat = await execOutput("git", [
    "diff",
    "--numstat",
    `${baseRef}...HEAD`,
  ]);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const a = parseInt(parts[0], 10);
      const r = parseInt(parts[1], 10);
      if (!isNaN(a)) linesAdded += a;
      if (!isNaN(r)) linesRemoved += r;
    }
  }

  const fullDiff = await execOutput("git", ["diff", `${baseRef}...HEAD`]);
  const diffByFile = parseDiffByFile(fullDiff);

  const allPatterns = loadPatterns(languageFilter);
  const languages = detectLanguages(changedFiles, allPatterns);

  const symbols: Symbol[] = [];

  for (const [file, lines] of diffByFile) {
    const ext = path.extname(file);
    for (const [, pattern] of allPatterns) {
      if (pattern.extensions.includes(ext)) {
        symbols.push(...extractSymbolsFromDiff(lines, file, pattern));
        break;
      }
    }
  }

  return {
    symbols,
    changedFiles,
    newFiles,
    deletedFiles,
    linesAdded,
    linesRemoved,
    diffByFile,
    languages,
  };
}

export { loadPatterns, detectLanguages };
