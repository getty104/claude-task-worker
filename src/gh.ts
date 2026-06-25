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

function execGhAllowExit(args: string[], allowedCodes: number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: number }).code;
        if (typeof code === "number" && allowedCodes.includes(code)) {
          resolve(stdout.trim());
          return;
        }
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

export async function listIssuesByLabel(
  assignee: string,
  labels: string[],
  excludeLabels: string[] = [],
): Promise<Issue[]> {
  const labelArgs = labels.flatMap((label) => ["--label", label]);
  const search = ["sort:created-asc", ...excludeLabels.map((label) => `-label:"${label}"`)].join(" ");
  const output = await execGh([
    "issue",
    "list",
    "--assignee",
    assignee,
    ...labelArgs,
    "--json",
    "number,title,labels",
    "--search",
    search,
    "--limit",
    "10",
  ]);
  return JSON.parse(output);
}

export interface PRCheck {
  state: string;
}

export interface PullRequestWithChecks extends PullRequest {
  checks: PRCheck[];
}

const COMPLETED_CHECK_STATES = new Set([
  "SUCCESS",
  "FAILURE",
  "ERROR",
  "NEUTRAL",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

export function isCICompleted(checks: PRCheck[]): boolean {
  if (checks.length === 0) return true;
  if (checks.some((check) => check.state === "FAILURE" || check.state === "ERROR")) return true;
  return checks.every((check) => COMPLETED_CHECK_STATES.has(check.state));
}

async function fetchPRChecks(prNumber: number): Promise<PRCheck[]> {
  const output = await execGhAllowExit(["pr", "checks", String(prNumber), "--json", "state"], [0, 1, 8]);
  if (!output) return [];
  return JSON.parse(output) as PRCheck[];
}

export async function listPullRequestsWithChecks(
  assignee?: string,
  label?: string,
  excludeLabels: string[] = [],
): Promise<PullRequestWithChecks[]> {
  const search = ["sort:created-asc", ...excludeLabels.map((l) => `-label:"${l}"`)].join(" ");
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,labels,headRefName",
    "--search",
    search,
    "--limit",
    "10",
  ];
  if (assignee) {
    args.push("--assignee", assignee);
  }
  if (label) {
    args.push("--label", label);
  }
  const output = await execGh(args);
  const prs: PullRequest[] = JSON.parse(output);
  const withChecks = await Promise.all(
    prs.map(async (pr) => ({ ...pr, checks: await fetchPRChecks(pr.number) })),
  );
  return withChecks.filter((pr) => isCICompleted(pr.checks));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`[gh] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      if (message.includes("not found") || message.includes("does not exist") || message.includes("could not remove"))
        return;
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

async function fetchProjectIds(
  resource: "issue" | "pullRequest",
  owner: string,
  name: string,
  number: number,
): Promise<string[]> {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${resource}(number:$number){projectItems(first:20){nodes{project{id}}}}}}`;
  try {
    const output = await execGh([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]);
    const parsed = JSON.parse(output);
    const nodes = parsed?.data?.repository?.[resource]?.projectItems?.nodes ?? [];
    return nodes
      .map((n: { project?: { id?: string } }) => n?.project?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    console.error(`[gh] failed to fetch projectIds for ${resource} #${number}: ${err}`);
    return [];
  }
}

export function getIssueProjectIds(owner: string, name: string, issueNumber: number): Promise<string[]> {
  return fetchProjectIds("issue", owner, name, issueNumber);
}

export function getPullRequestProjectIds(owner: string, name: string, prNumber: number): Promise<string[]> {
  return fetchProjectIds("pullRequest", owner, name, prNumber);
}

async function tryResolveProjectAsOwner(
  ownerType: "user" | "organization",
  owner: string,
  number: number,
): Promise<string | null> {
  const query = `query($owner:String!,$number:Int!){${ownerType}(login:$owner){projectV2(number:$number){id}}}`;
  try {
    const output = await execGh([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `number=${number}`,
    ]);
    const parsed = JSON.parse(output);
    const id = parsed?.data?.[ownerType]?.projectV2?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function resolveProjectNodeId(owner: string, number: number): Promise<string | null> {
  const asUser = await tryResolveProjectAsOwner("user", owner, number);
  if (asUser) return asUser;
  return tryResolveProjectAsOwner("organization", owner, number);
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
