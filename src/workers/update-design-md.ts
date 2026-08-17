import { getUiDesignConfig } from "../config";
import { createScheduledWorker } from "./scheduled-worker";

export const updateDesignMdWorker = createScheduledWorker({
  name: "update-design-md",
  command: "/claude-task-worker:update-design-md",
  taskId: -3,
  // DESIGN.md の材料は `cc-ui-design` ラベル付きのマージ済みデザインPRで、それを作るのは
  // uiDesign.enabled のデザイン先行フローだけ。無効なリポジトリでは収集対象が原理的に
  // 存在しないため、空振りのセッションを毎日起動しないようここで止める。
  enabled: () => getUiDesignConfig().enabled,
});
