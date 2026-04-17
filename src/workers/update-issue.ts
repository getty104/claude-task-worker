import { getLastIssueComment } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const updateIssueWorker = createIssuePollingWorker({
  name: "update-issue",
  triggerLabel: "cc-update-issue",
  buildPrompt: async (issue) => {
    const lastComment = await getLastIssueComment(issue.number);
    if (!lastComment) return null;
    return `/base-tools:update-issue\nIssue番号: ${issue.number}\n依頼内容: \n${lastComment.body}`;
  },
});
