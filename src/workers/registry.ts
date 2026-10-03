import { answerIssueQuestionsWorker } from "./answer-issue-questions";
import { applyUiDesignWorker } from "./apply-ui-design";
import { checkDependabotWorker } from "./check-dependabot";
import { createIssueWorker } from "./create-issue";
import { createUiDesignWorker } from "./create-ui-design";
import { epicIssueWorker } from "./epic-issue";
import { execIssueWorker } from "./exec-issue";
import { fixReviewPointWorker } from "./fix-review-point";
import { resolveConflictWorker } from "./resolve-conflict";
import { triageCreatedIssueWorker } from "./triage-created-issue";
import { triagePrWorker } from "./triage-pr";
import { updateCodingGuidelinesWorker } from "./update-coding-guidelines";
import { updateDesignMdWorker } from "./update-design-md";
import { updateIssueWorker } from "./update-issue";
import { updateRequirementRulesWorker } from "./update-requirement-rules";
import type { WorkerDefinition } from "./worker-definition";

export interface PresetWorkerEntry {
  definition: WorkerDefinition;
  description: string;
  inAll: boolean;
  inYolo: boolean;
}

// update-design-md は uiDesign.enabled が false のとき自身で no-op になる
// （create-ui-design / apply-ui-design と同じ扱い）。
export const PRESET_WORKERS: readonly PresetWorkerEntry[] = [
  { definition: execIssueWorker, description: "Poll issues and run /exec-issue", inAll: true, inYolo: true },
  { definition: fixReviewPointWorker, description: "Poll PRs and run /fix-review-point", inAll: true, inYolo: true },
  { definition: createIssueWorker, description: "Poll issues and run /create-issue", inAll: true, inYolo: true },
  { definition: updateIssueWorker, description: "Poll issues and run update command", inAll: true, inYolo: true },
  {
    definition: answerIssueQuestionsWorker,
    description: "Poll issues and run /answer-issue-questions",
    inAll: true,
    inYolo: true,
  },
  {
    definition: triageCreatedIssueWorker,
    description: "Poll cc-issue-created + cc-triage-scope issues and run /triage-created-issue",
    inAll: false,
    inYolo: true,
  },
  { definition: triagePrWorker, description: "Poll and triage PRs every 5 minutes", inAll: false, inYolo: true },
  {
    definition: resolveConflictWorker,
    description: "Poll cc-resolve-conflict PRs and run /resolve-conflict",
    inAll: true,
    inYolo: true,
  },
  { definition: checkDependabotWorker, description: "Poll dependabot PRs every 1 hour", inAll: false, inYolo: true },
  {
    definition: epicIssueWorker,
    description: "Poll cc-epic-issue issues and create epic PR when all sub-issues are closed",
    inAll: true,
    inYolo: true,
  },
  {
    definition: createUiDesignWorker,
    description: "Poll cc-create-ui-design issues and create a Pencil design PR (requires uiDesign.enabled)",
    inAll: true,
    inYolo: true,
  },
  {
    definition: applyUiDesignWorker,
    description:
      "Poll cc-ui-design-pr-created issues and write the design reference back once the design PR is merged (requires uiDesign.enabled)",
    inAll: true,
    inYolo: true,
  },
  {
    definition: updateCodingGuidelinesWorker,
    description: "Run /update-coding-guidelines once every 24 hours over the last 24 hours",
    inAll: true,
    inYolo: true,
  },
  {
    definition: updateRequirementRulesWorker,
    description: "Run /update-requirement-rules once every 24 hours over the last 24 hours",
    inAll: true,
    inYolo: true,
  },
  {
    definition: updateDesignMdWorker,
    description: "Run /update-design-md once every 24 hours over the last 24 hours (requires uiDesign.enabled)",
    inAll: true,
    inYolo: true,
  },
];
