import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh.js";

const LABELS: { name: string; color: string }[] = [
  { name: "cc-create-issue", color: "0075ca" },
  { name: "cc-update-issue", color: "e4e669" },
  { name: "cc-exec-issue",   color: "7057ff" },
  { name: "cc-fix-onetime",  color: "d93f0b" },
  { name: "cc-fix-repeat",   color: "e99695" },
  { name: "cc-in-progress",  color: "0e8a16" },
  { name: "cc-created-issue", color: "f9a825" },
];

const ISSUE_TEMPLATE = `name: "[claude-task-worker] Issue作成依頼"
description: claude-task-workerでGitHub Issueを作成する
title: "[claude-task-worker] Issue作成依頼"
labels:
  - cc-create-issue
body:
  - type: textarea
    id: request
    attributes:
      label: 依頼内容
      description: 作成してほしいIssueの内容を記述してください
    validations:
      required: true
`;

const ASSIGN_CREATOR_WORKFLOW = `name: Assign creator on cc-create-issue

on:
  issues:
    types: [opened]

jobs:
  assign:
    if: contains(github.event.issue.labels.*.name, 'cc-create-issue')
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.addAssignees({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              assignees: [context.payload.issue.user.login]
            });
`;

async function createFileIfNotExists(path: string, content: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    await writeFile(path, content, "utf-8");
    return true;
  }
}

export async function init(): Promise<void> {
  console.log("[init] Creating labels...");

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
  const templatePath = ".github/ISSUE_TEMPLATE/cc-create-issue.yml";
  const templateCreated = await createFileIfNotExists(templatePath, ISSUE_TEMPLATE);
  console.log(templateCreated ? `[init] Created: ${templatePath}` : `[init] Already exists: ${templatePath}`);

  console.log("[init] Creating GitHub Actions workflow...");
  await mkdir(".github/workflows", { recursive: true });
  const workflowPath = ".github/workflows/assign-creator-on-cc-create-issue.yml";
  const workflowCreated = await createFileIfNotExists(workflowPath, ASSIGN_CREATOR_WORKFLOW);
  console.log(workflowCreated ? `[init] Created: ${workflowPath}` : `[init] Already exists: ${workflowPath}`);

  console.log("[init] Done.");
}
