import { createScheduledWorker } from "./scheduled-worker";

export const updateCodingGuidelinesWorker = createScheduledWorker({
  name: "update-coding-guidelines",
  command: "/claude-task-worker:update-coding-guidelines",
  taskId: -1,
});
