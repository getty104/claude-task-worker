import { addLabel } from "../gh";
import { createPrPollingWorker } from "./pr-worker";

export const checkDependabotWorker = createPrPollingWorker({
  name: "check-dependabot",
  pollingIntervalMs: 60 * 60 * 1000,
  command: "/base-tools:check-dependabot",
  triggerLabel: "dependencies",
  excludeLabels: ["cc-triage-scope"],
  onCompleted: async (pr) => {
    await addLabel("pr", pr.number, "cc-triage-scope");
  },
});
