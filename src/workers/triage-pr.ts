import { createPrPollingWorker } from "./pr-worker";

export const triagePrWorker = createPrPollingWorker({
  name: "triage-pr",
  command: "/claude-task-worker:triage-pr",
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-fix-onetime", "cc-resolve-conflict"],
});
