import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import { extract, LanguagePattern } from "./extract";
import { classify } from "./classify";
import { generateDiagram, generateSummaryLine } from "./diagram";
import { composeComment, postComment } from "./comment";
import { resolveLLMConfig, createProvider } from "./llm";
import { runAnalyzers, Finding } from "./analyze";

async function resolveBaseRef(token: string): Promise<string> {
  const explicit = core.getInput("base_ref");
  if (explicit) return explicit;

  if (github.context.payload.pull_request) {
    return github.context.payload.pull_request.base.sha;
  }

  if (github.context.payload.issue?.pull_request) {
    const octokit = github.getOctokit(token);
    const { data: pr } = await octokit.rest.pulls.get({
      ...github.context.repo,
      pull_number: github.context.payload.issue.number,
    });

    await exec.exec("git", ["fetch", "origin", pr.base.ref], { silent: true });
    return `origin/${pr.base.ref}`;
  }

  return "origin/main";
}

async function run(): Promise<void> {
  try {
    const token = core.getInput("github_token", { required: true });
    const anthropicKey = core.getInput("anthropic_api_key");
    const openaiKey = core.getInput("openai_api_key");
    const openrouterKey = core.getInput("openrouter_api_key");
    const modelOverride = core.getInput("model");
    const languageFilter = core.getInput("languages") || "auto";
    const diagramEnabled = core.getInput("diagram") !== "false";
    const minLines = parseInt(core.getInput("min_lines") || "50", 10);
    const minFileLines = parseInt(core.getInput("min_file_lines") || "20", 10);

    const llmConfig = resolveLLMConfig(anthropicKey, openaiKey, openrouterKey, modelOverride);

    const baseRef = await resolveBaseRef(token);

    core.info(`Base ref: ${baseRef}`);
    core.info(`Languages: ${languageFilter}`);
    core.info(`Diagram: ${diagramEnabled}`);
    if (llmConfig) {
      core.info(`LLM provider: ${llmConfig.provider} (model: ${llmConfig.model})`);
    }

    core.info("Extracting diff...");
    const extraction = await extract(baseRef, languageFilter);

    core.info(
      `Found ${extraction.changedFiles.length} changed files, +${extraction.linesAdded}/-${extraction.linesRemoved}`
    );

    if (extraction.linesAdded < minLines) {
      core.info(
        `PR has ${extraction.linesAdded} added lines, below min_lines threshold of ${minLines}. Skipping.`
      );
      return;
    }

    const patternsDir = path.join(__dirname, "patterns");
    const patterns = new Map<string, LanguagePattern>();
    try {
      const files = fs
        .readdirSync(patternsDir)
        .filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const lang = path.basename(file, ".json");
        const content = fs.readFileSync(
          path.join(patternsDir, file),
          "utf-8"
        );
        patterns.set(lang, JSON.parse(content));
      }
    } catch {
      core.warning("Could not load pattern files");
    }

    core.info("Classifying changes...");
    const classification = classify(extraction, patterns);

    core.info(
      `Classification: logic=${classification.logic} tests=${classification.tests} types=${classification.types} docs=${classification.docs}`
    );

    core.info(`Found ${extraction.symbols.length} symbol changes`);

    core.info("Running static analyzers...");
    let findings: Finding[] = [];
    try {
      findings = await runAnalyzers(extraction.languages, extraction.changedFiles);
      core.info(`Static analysis: ${findings.length} findings`);
    } catch (err) {
      core.warning(`Static analysis failed: ${err}`);
    }

    let diagram: string | null = null;
    let summaryLine = "";

    if (diagramEnabled && llmConfig) {
      const llm = createProvider(llmConfig);
      core.info("Generating summary and diagram...");
      try {
        [summaryLine, diagram] = await Promise.all([
          generateSummaryLine(
            llm,
            extraction.fileSummaries,
            extraction.symbols,
            extraction.changedFiles.length,
            extraction.linesAdded,
            extraction.linesRemoved
          ),
          generateDiagram(
            llm,
            extraction.fileSummaries,
            extraction.symbols,
            extraction.changedFiles.length,
            extraction.linesAdded,
            extraction.linesRemoved,
            findings,
            minFileLines
          ),
        ]);
        core.info(`Summary: ${summaryLine}`);
        if (diagram) {
          core.info("Diagram generated successfully");
        } else {
          core.info("No diagram generated (not enough symbols)");
        }
      } catch (err) {
        core.warning(`Generation failed: ${err}`);
      }
    } else if (diagramEnabled && !llmConfig) {
      core.warning(
        "Diagram enabled but no API key provided. Pass anthropic_api_key, openai_api_key, or openrouter_api_key."
      );
    }

    const prNumber = github.context.payload.pull_request?.number
      ?? github.context.payload.issue?.number;
    const repo = github.context.repo;
    const prFilesUrl = prNumber
      ? `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}/files`
      : "";

    core.info("Composing comment...");
    const body = composeComment(
      classification,
      extraction.symbols,
      extraction.fileSummaries,
      extraction.newFiles,
      extraction.deletedFiles,
      extraction.changedFiles.length,
      extraction.linesAdded,
      extraction.linesRemoved,
      diagram,
      prFilesUrl,
      summaryLine,
      findings,
      minFileLines
    );

    core.info("Posting comment...");
    await postComment(token, body);

    core.info("Done.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
