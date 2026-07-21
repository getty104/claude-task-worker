import { existsSync } from "node:fs";
import { join } from "node:path";
import { getUiDesignConfig } from "../config";
import { addLabel, commentOnIssue, findPrStateByHeadRef, getIssueBody } from "../gh";
import { getWorktreePath } from "../worktree";
import { createIssuePollingWorker } from "./issue-worker";
import {
  classifyDesignPr,
  designBranchName,
  designPrMissingComment,
  designReferenceMissingComment,
  extractDesignFilePath,
} from "./ui-design";

// description に記載された `.pen` パスが、実装ゲート時点で worktree 上に実在するか。
// extractDesignFilePath はテキスト書式の検証しかしないため、パスが実際には存在しない
// （例: designs/missing.pen）まま cc-exec-issue が付与されてしまう穴を塞ぐ。
function designFileExistsInWorktree(worktreeId: string, designFilePath: string): boolean {
  return existsSync(join(getWorktreePath(worktreeId), designFilePath));
}

async function markDesignReferenceMissing(issueNumber: number, logMessage: string): Promise<void> {
  console.error(logMessage);
  await addLabel("issue", issueNumber, "cc-need-human-check").catch((err) =>
    console.error(`[apply-ui-design] addLabel cc-need-human-check failed for #${issueNumber}: ${err}`),
  );
  await commentOnIssue(issueNumber, designReferenceMissingComment(issueNumber)).catch((err) =>
    console.error(`[apply-ui-design] commentOnIssue failed for #${issueNumber}: ${err}`),
  );
}

export const applyUiDesignWorker = async (
  opts: { epicFilters?: number[]; labelFilters?: string[] } = {},
): Promise<void> => {
  if (!getUiDesignConfig().enabled) {
    console.log("[apply-ui-design] uiDesign.enabled is false, skipping");
    return;
  }
  await createIssuePollingWorker({
    name: "apply-ui-design",
    command: "/claude-task-worker:apply-ui-design",
    triggerLabels: ["cc-ui-design-pr-created"],
    excludeLabels: ["cc-ui-design-ready", "cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    preflight: async (issue) => {
      const branch = designBranchName(issue.number);
      let pr: Awaited<ReturnType<typeof findPrStateByHeadRef>>;
      try {
        pr = await findPrStateByHeadRef(branch);
      } catch (err) {
        console.error(`[apply-ui-design] #${issue.number}: findPrStateByHeadRef failed for ${branch}: ${err}`);
        return "skip";
      }
      const disposition = classifyDesignPr(pr);
      if (disposition === "proceed") return "proceed";
      if (disposition === "wait") {
        console.log(`[apply-ui-design] #${issue.number}: design PR #${pr?.number} is still open, waiting for merge`);
        return "skip";
      }
      // PR不在・未マージクローズは自動では回復できない。cc-need-human-check は
      // issue-worker.ts の共通除外ラベルなので、付与後は候補に上がらず再試行しない。
      console.error(`[apply-ui-design] #${issue.number}: design PR for ${branch} is missing or closed unmerged`);
      try {
        await addLabel("issue", issue.number, "cc-need-human-check");
        await commentOnIssue(issue.number, designPrMissingComment(issue.number)).catch((err) =>
          console.error(`[apply-ui-design] commentOnIssue failed for #${issue.number}: ${err}`),
        );
      } catch (err) {
        console.error(`[apply-ui-design] addLabel cc-need-human-check failed for #${issue.number}: ${err}`);
      }
      return "skip";
    },
    onCompleted: async (issueNumber, worktreeId) => {
      // exit 0 は description の書き戻し完了を保証しない。参照が本当に載っており、かつ
      // そのパスが実際にworktree上に存在する場合のみ実装フェーズ（cc-exec-issue）へ進める。
      let body: string;
      try {
        body = await getIssueBody(issueNumber);
      } catch (err) {
        console.error(`[apply-ui-design] #${issueNumber}: getIssueBody failed: ${err}`);
        body = "";
      }
      const designFilePath = extractDesignFilePath(body);
      if (designFilePath === null) {
        await markDesignReferenceMissing(
          issueNumber,
          `[apply-ui-design] #${issueNumber}: session exited without a design reference section; marking cc-need-human-check`,
        );
        return false;
      }
      if (!designFileExistsInWorktree(worktreeId, designFilePath)) {
        await markDesignReferenceMissing(
          issueNumber,
          `[apply-ui-design] #${issueNumber}: design reference points to ${designFilePath}, which does not exist in worktree ${worktreeId}; marking cc-need-human-check`,
        );
        return false;
      }
      // cc-exec-issue を先に付与する。片方だけ成功して打ち切られても、excludeLabels
      // に含まれる cc-ui-design-ready がまだ付いていなければ次ポーリングで
      // このワーカー自身の再試行対象に残る（先に cc-ui-design-ready が付くと
      // excludeLabels でこのワーカーからは二度と拾えなくなり座礁する）。
      await addLabel("issue", issueNumber, "cc-exec-issue").catch((err) =>
        console.error(`[apply-ui-design] addLabel cc-exec-issue failed for #${issueNumber}: ${err}`),
      );
      await addLabel("issue", issueNumber, "cc-ui-design-ready").catch((err) =>
        console.error(`[apply-ui-design] addLabel cc-ui-design-ready failed for #${issueNumber}: ${err}`),
      );
    },
  })();
};
