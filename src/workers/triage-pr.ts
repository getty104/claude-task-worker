import { createPrPollingWorker } from "./pr-worker";

export const triagePrWorker = createPrPollingWorker({
  name: "triage-pr",
  command: "/base-tools:triage-pr",
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-fix-onetime"],
});
