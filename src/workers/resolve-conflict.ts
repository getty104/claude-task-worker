import { createPrPollingWorker } from "./pr-worker";

export const resolveConflictWorker = createPrPollingWorker({
  name: "resolve-conflict",
  command: "/base-tools:resolve-conflict",
  triggerLabel: "cc-resolve-conflict",
});
