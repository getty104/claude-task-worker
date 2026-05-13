import { createPrPollingWorker } from "./pr-worker";

export const triagePrWorker = createPrPollingWorker({
  name: "triage-pr",
  pollingIntervalMs: 60 * 1000,
  command: "/base-tools:triage-pr",
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-fix-onetime"],
});
