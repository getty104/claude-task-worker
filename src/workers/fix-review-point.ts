import { commentOnPR } from "../gh";
import { loadConfig } from "../config";
import { createPrPollingWorker } from "./pr-worker";

export const fixReviewPointWorker = createPrPollingWorker({
  name: "fix-review-point",
  pollingIntervalMs: 30 * 1000,
  command: "/base-tools:fix-review-point",
  triggerLabel: "cc-fix-onetime",
  onCompleted: async (pr) => {
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
