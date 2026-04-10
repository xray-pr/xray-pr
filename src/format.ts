export interface FormatOptions {
  maxWidth: number;
  truncateSymbols: number;
  showLineNumbers: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  maxWidth: 80,
  truncateSymbols: 4,
  showLineNumbers: false,
};

export function truncateList(items: string[], max: number): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `+${items.length - max} more`];
}

export function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join("/");
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural || `${singular}s`);
}

export function formatPercent(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

export class MarkdownTable {
  private headers: string[];
  private alignments: ("left" | "center" | "right")[];
  private rows: string[][] = [];

  constructor(headers: string[], alignments?: ("left" | "center" | "right")[]) {
    this.headers = headers;
    this.alignments = alignments || headers.map(() => "left");
  }

  addRow(cells: string[]): void {
    this.rows.push(cells);
  }

  render(): string {
    const alignMap = { left: ":---", center: ":---:", right: "---:" };
    const header = `| ${this.headers.join(" | ")} |`;
    const separator = `| ${this.alignments.map((a) => alignMap[a]).join(" | ")} |`;
    const body = this.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
    return [header, separator, body].join("\n");
  }
}

export interface RiskLevel {
  level: "critical" | "high" | "medium" | "low";
  icon: string;
  label: string;
}

export const RISK_LEVELS: Record<string, RiskLevel> = {
  concurrency: { level: "critical", icon: "🔴", label: "concurrency" },
  errors: { level: "high", icon: "🟠", label: "error paths" },
  new_file: { level: "medium", icon: "🟢", label: "new file" },
  modified: { level: "low", icon: "🔵", label: "modified" },
};

export function getRiskLevel(
  hasConcurrency: boolean,
  hasErrors: boolean,
  isNew: boolean
): RiskLevel {
  if (hasConcurrency) return RISK_LEVELS.concurrency;
  if (hasErrors) return RISK_LEVELS.errors;
  if (isNew) return RISK_LEVELS.new_file;
  return RISK_LEVELS.modified;
}
