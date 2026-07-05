import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, CONFIG_PATH, WORKER_DEFAULTS } from "../config.js";

const LABELS: { name: string; color: string }[] = [
  { name: "cc-update-issue", color: "e4e669" },
  { name: "cc-answer-issue-questions", color: "5319e7" },
  { name: "cc-exec-issue", color: "7057ff" },
  { name: "cc-fix-onetime", color: "d93f0b" },
  { name: "cc-in-progress", color: "0e8a16" },
  { name: "cc-need-human-check", color: "b60205" },
  { name: "cc-issue-created", color: "f9a825" },
  { name: "cc-pr-created", color: "006b75" },
  { name: "cc-triage-scope", color: "c5def5" },
  { name: "cc-resolve-conflict", color: "fbca04" },
  { name: "cc-epic-issue", color: "8b5cf6" },
];

const ISSUE_TEMPLATE = `name: "[claude-task-worker] Issue作成依頼"
description: claude-task-workerでGitHub Issueを作成する
title: "[claude-task-worker] Issue作成依頼"
labels:
  - cc-triage-scope
body:
  - type: textarea
    id: request
    attributes:
      label: 依頼内容
      description: 作成してほしいIssueの内容を記述してください
    validations:
      required: true
`;

const ASSIGN_CREATOR_WORKFLOW = `name: Assign creator on cc-triage-scope

on:
  issues:
    types: [opened]

jobs:
  assign:
    if: contains(github.event.issue.labels.*.name, 'cc-triage-scope')
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/github-script@v9
        with:
          script: |
            await github.rest.issues.addAssignees({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              assignees: [context.payload.issue.user.login]
            });
`;

async function writeFileWithMode(
  path: string,
  content: string,
  force: boolean,
): Promise<"created" | "overwritten" | "skipped"> {
  try {
    await access(path);
    if (!force) return "skipped";
    await writeFile(path, content, "utf-8");
    return "overwritten";
  } catch {
    await writeFile(path, content, "utf-8");
    return "created";
  }
}

function logWriteResult(result: "created" | "overwritten" | "skipped", path: string): void {
  if (result === "created") console.log(`[init] Created: ${path}`);
  else if (result === "overwritten") console.log(`[init] Overwritten: ${path}`);
  else console.log(`[init] Already exists: ${path}`);
}

async function createConfig(force: boolean): Promise<void> {
  const initialConfig = { ...DEFAULT_CONFIG, workers: { ...WORKER_DEFAULTS } };
  const result = await writeFileWithMode(CONFIG_PATH, JSON.stringify(initialConfig, null, 2), force);
  logWriteResult(result, CONFIG_PATH);
}

export async function init(options: { force?: boolean } = {}): Promise<void> {
  const force = options.force ?? false;
  console.log(`[init] Creating labels...${force ? " (force mode)" : ""}`);

  for (const label of LABELS) {
    const ok = await createLabel(label.name, label.color, true);
    if (ok) {
      console.log(`[init] Ensured label: ${label.name}`);
    } else {
      console.log(`[init] Failed to create label: ${label.name}`);
    }
  }

  console.log("[init] Creating issue template...");
  await mkdir(".github/ISSUE_TEMPLATE", { recursive: true });
  const templatePath = ".github/ISSUE_TEMPLATE/cc-triage-scope.yml";
  logWriteResult(await writeFileWithMode(templatePath, ISSUE_TEMPLATE, force), templatePath);

  console.log("[init] Creating GitHub Actions workflow...");
  await mkdir(".github/workflows", { recursive: true });
  const workflowPath = ".github/workflows/assign-creator-on-cc-triage-scope.yml";
  logWriteResult(await writeFileWithMode(workflowPath, ASSIGN_CREATOR_WORKFLOW, force), workflowPath);

  console.log("[init] Creating config file...");
  await createConfig(force);

  console.log("[init] Done.");
}
