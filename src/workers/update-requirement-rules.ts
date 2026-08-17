import { createScheduledWorker } from "./scheduled-worker";

export const updateRequirementRulesWorker = createScheduledWorker({
  name: "update-requirement-rules",
  command: "/claude-task-worker:update-requirement-rules",
  taskId: -2,
});
