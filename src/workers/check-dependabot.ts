import { addLabel } from "../gh";
import { createPrPollingWorker } from "./pr-worker";

export const checkDependabotWorker = createPrPollingWorker({
  name: "check-dependabot",
  command: "/claude-task-worker:check-dependabot",
  triggerLabel: "dependencies",
  excludeLabels: ["cc-triage-scope"],
  // `dependencies` は Dependabot が付けるPRの分類ラベルであり、ワーカーの作業状態を
  // 表すものではない。マージに至らずPRが残る場合に外れると分類情報が失われるため維持する。
  keepTriggerLabel: true,
  // トリガーラベルを維持する以上、除外ラベルは成否に関わらず付ける必要がある
  // （失敗時に付けないと `dependencies` のまま毎ポーリングで再実行し続ける）。
  onFinally: async (pr) => {
    await addLabel("pr", pr.number, "cc-triage-scope");
  },
});
