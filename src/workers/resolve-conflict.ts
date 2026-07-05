import { createPrPollingWorker } from "./pr-worker";

export const resolveConflictWorker = createPrPollingWorker({
  name: "resolve-conflict",
  command: "/claude-task-worker:resolve-pr-conflict",
  triggerLabel: "cc-resolve-conflict",
});
