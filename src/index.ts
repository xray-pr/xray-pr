import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import { extract, LanguagePattern } from "./extract";
import { classify } from "./classify";
import { generateDiagram } from "./diagram";
import { composeComment, postComment } from "./comment";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github_token", { required: true });
    const anthropicKey = core.getInput("anthropic_api_key");
    const languageFilter = core.getInput("languages") || "auto";
    const diagramEnabled = core.getInput("diagram") !== "false";
    const minLines = parseInt(core.getInput("min_lines") || "50", 10);

    let baseRef = core.getInput("base_ref");
    if (!baseRef && github.context.payload.pull_request) {
      baseRef = github.context.payload.pull_request.base.sha;
    }
    if (!baseRef) {
      baseRef = "main";
    }

    core.info(`Base ref: ${baseRef}`);
    core.info(`Languages: ${languageFilter}`);
    core.info(`Diagram: ${diagramEnabled}`);

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

    let diagram: string | null = null;
    if (diagramEnabled && anthropicKey) {
      core.info("Generating diagram...");
      try {
        diagram = await generateDiagram(
          anthropicKey,
          extraction.symbols,
          extraction.changedFiles.length,
          extraction.linesAdded,
          extraction.linesRemoved
        );
        if (diagram) {
          core.info("Diagram generated successfully");
        } else {
          core.info("No diagram generated (not enough symbols)");
        }
      } catch (err) {
        core.warning(`Diagram generation failed: ${err}`);
      }
    } else if (diagramEnabled && !anthropicKey) {
      core.warning(
        "Diagram enabled but no anthropic_api_key provided. Skipping diagram."
      );
    }

    core.info("Composing comment...");
    const body = composeComment(
      classification,
      extraction.symbols,
      extraction.newFiles,
      extraction.deletedFiles,
      extraction.changedFiles.length,
      extraction.linesAdded,
      extraction.linesRemoved,
      diagram
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
