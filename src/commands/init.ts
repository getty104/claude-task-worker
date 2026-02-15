import { createLabel } from "../gh.js";

const LABELS = [
  "create-issue",
  "update-issue",
  "dev-ready",
  "fix-onetime",
  "fix-repeat",
  "in-progress",
];

export async function init(): Promise<void> {
  console.log("[init] Creating labels...");

  for (const label of LABELS) {
    const created = await createLabel(label);
    if (created) {
      console.log(`[init] Created label: ${label}`);
    } else {
      console.log(`[init] Label already exists: ${label}`);
    }
  }

  console.log("[init] Done.");
}
