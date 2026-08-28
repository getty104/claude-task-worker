import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import { commentOnPR } from "../gh";
import { loadConfig } from "../config";
import { resolvePluginScriptPath } from "../plugin-path";
import { createPrPollingWorker } from "./pr-worker";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

// resolve-pr-comments.sh の実行上限。GraphQL ページング + 未解決スレッド数分の
// mutation で数十秒かかりうる一方、gh がネットワーク停滞や認証プロンプトでハングした
// 場合にワーカーのイベントループを無期限に止めないための上限。
const RESOLVE_SCRIPT_TIMEOUT_MS = 120_000;

// クラウド実行時は fix-review-point の Stop フックが走らないため、レビュースレッドの
// 一括 Resolve をここから代わりに実行する（ローカル実行時はフック側が担う）。
// デーモンの単一イベントループ上で呼ばれるため spawnSync は使わない。
function resolveReviewThreadsForCloudPr(prNumber: number): Promise<void> {
  const scriptPath = resolvePluginScriptPath("resolve-pr-comments.sh");
  if (!scriptPath) {
    console.error("[fix-review-point] resolve-pr-comments.sh not found; skipping thread resolution");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    childProcess.execFile(
      "bash",
      [scriptPath, String(prNumber)],
      { encoding: "utf8", timeout: RESOLVE_SCRIPT_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        for (const line of (stdout ?? "").split("\n").filter(Boolean)) {
          console.log(`[fix-review-point] ${line}`);
        }
        for (const line of (stderr ?? "").split("\n").filter(Boolean)) {
          console.error(`[fix-review-point] ${line}`);
        }
        if (error) {
          console.error(`[fix-review-point] failed to run resolve-pr-comments.sh for PR #${prNumber}: ${error}`);
        }
        resolve();
      },
    );
  });
}

export const fixReviewPointWorker = createPrPollingWorker({
  name: "fix-review-point",
  command: "/claude-task-worker:fix-review-point",
  triggerLabel: "cc-fix-onetime",
  onCompleted: async (pr, _output, cloud) => {
    if (cloud) {
      await resolveReviewThreadsForCloudPr(pr.number);
    }
    const config = loadConfig();
    if (config.fixReviewPointCallbackCommentMessage) {
      try {
        await commentOnPR(pr.number, config.fixReviewPointCallbackCommentMessage);
      } catch (err) {
        console.error(`[fix-review-point] failed to post comment on PR #${pr.number}: ${err}`);
      }
    }
  },
});
