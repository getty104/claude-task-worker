import { execFile } from "node:child_process";

export interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

interface PullRequest {
  number: number;
  headRefName: string;
  labels: { name: string }[];
  title: string;
}

interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
}

function execGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function getCurrentUser(): Promise<string> {
  return execGh(["api", "user", "--jq", ".login"]);
}

export async function getRepoInfo(): Promise<RepoInfo> {
  const output = await execGh(["repo", "view", "--json", "owner,name,defaultBranchRef"]);
  const parsed = JSON.parse(output);
  return { owner: parsed.owner.login, name: parsed.name, defaultBranch: parsed.defaultBranchRef.name };
}

export async function listIssuesByLabel(assignee: string, label: string): Promise<Issue[]> {
  const output = await execGh([
    "issue", "list",
    "--assignee", assignee,
    "--label", label,
    "--json", "number,title,labels",
    "--search", "sort:created-asc",
    "--limit", "100",
  ]);
  return JSON.parse(output);
}

interface StatusCheck {
  status?: string;
  state?: string;
}

export interface PullRequestWithChecks extends PullRequest {
  statusCheckRollup: StatusCheck[];
}

export function isCICompleted(checks: StatusCheck[]): boolean {
  if (checks.length === 0) return true;
  if (checks.some(check => check.status === "FAILURE")) return true;
  return checks.every(check =>
    check.status === "COMPLETED" ||
    check.state === "SUCCESS" ||
    check.state === "FAILURE" ||
    check.state === "ERROR"
  )
}

export async function listPullRequestsWithChecks(assignee?: string): Promise<PullRequestWithChecks[]> {
  const args = [
    "pr", "list",
    "--state", "open",
    "--json", "number,title,labels,headRefName,statusCheckRollup",
    "--limit", "100",
  ];
  if (assignee) {
    args.push("--assignee", assignee);
  }
  const output = await execGh(args);
  const prs: PullRequestWithChecks[] = JSON.parse(output);
  return prs.filter(pr => isCICompleted(pr.statusCheckRollup));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`[gh] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

export async function addLabel(type: "issue" | "pr", number: number, label: string): Promise<void> {
  await withRetry(async () => {
    try {
      await execGh([type, "edit", String(number), "--add-label", label]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already exists") || message.includes("already has")) return;
      throw err;
    }
  });
}

export async function removeLabel(type: "issue" | "pr", number: number, label: string): Promise<void> {
  await withRetry(async () => {
    try {
      await execGh([type, "edit", String(number), "--remove-label", label]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found") || message.includes("does not exist") || message.includes("could not remove")) return;
      throw err;
    }
  });
}

export async function getLastIssueComment(issueNumber: number): Promise<{ author: string; body: string } | null> {
  const output = await execGh(["issue", "view", String(issueNumber), "--json", "comments"]);
  const parsed = JSON.parse(output);
  const comments = parsed.comments ?? [];
  if (comments.length === 0) return null;
  const last = comments[comments.length - 1];
  return { author: last.author.login, body: last.body };
}

export async function commentOnPR(prNumber: number, body: string): Promise<void> {
  await execGh(["pr", "comment", String(prNumber), "--body", body]);
}

export async function createLabel(name: string, color?: string, force?: boolean): Promise<boolean> {
  try {
    const args = ["label", "create", name];
    if (color) args.push("--color", color);
    if (force) args.push("--force");
    await execGh(args);
    return true;
  } catch {
    return false;
  }
}
