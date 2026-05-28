import { addLabel } from "../gh";
import { createPrPollingWorker } from "./pr-worker";

export const checkDependabotWorker = createPrPollingWorker({
  name: "check-dependabot",
  command: "/base-tools:check-dependabot",
  triggerLabel: "dependencies",
  excludeLabels: ["cc-triage-scope"],
  onCompleted: async (pr) => {
    await addLabel("pr", pr.number, "cc-triage-scope");
  },
});
