import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

export interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
  parent: { number: number } | null;
}

export interface SubIssuesSummary {
  total: number;
  completed: number;
  percentCompleted: number;
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
    childProcess.execFile("gh", args, (error, stdout, stderr) => {
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
    childProcess.execFile("gh", args, (error, stdout, stderr) => {
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
  epicFilter?: { owner: string; repo: string; numbers: number[] },
  limit = 10,
): Promise<Issue[]> {
  const labelArgs = labels.flatMap((label) => ["--label", label]);
  const searchTerms = ["sort:created-asc", "-is:blocked", ...excludeLabels.map((label) => `-label:"${label}"`)];
  if (epicFilter && epicFilter.numbers.length > 0) {
    for (const number of epicFilter.numbers) {
      searchTerms.push(`parent-issue:${epicFilter.owner}/${epicFilter.repo}#${number}`);
    }
  }
  const search = searchTerms.join(" ");
  const output = await execGh([
    "issue",
    "list",
    "--assignee",
    assignee,
    ...labelArgs,
    "--json",
    "number,title,labels,parent",
    "--search",
    search,
    "--limit",
    String(limit),
  ]);
  return JSON.parse(output);
}

export async function listIssuesByNumbers(
  assignee: string,
  labels: string[],
  excludeLabels: string[],
  numbers: number[],
): Promise<Issue[]> {
  const results: Issue[] = [];
  for (const number of numbers) {
    try {
      const output = await execGh([
        "issue",
        "view",
        String(number),
        "--json",
        "number,title,labels,parent,assignees,state",
      ]);
      const parsed = JSON.parse(output);
      // -is:blocked は listIssuesByLabel の search 由来の絞り込みだが、
      // エピックIssue自体はサブIssueにブロックされる対象ではないため再現しない。
      if (parsed.state !== "OPEN") continue;
      if (!parsed.assignees.some((a: { login: string }) => a.login === assignee)) continue;
      const labelNames = new Set(parsed.labels.map((l: { name: string }) => l.name));
      if (!labels.every((label) => labelNames.has(label))) continue;
      if (excludeLabels.some((label) => labelNames.has(label))) continue;
      results.push({
        number: parsed.number,
        title: parsed.title,
        labels: parsed.labels,
        parent: parsed.parent,
      });
    } catch (err) {
      console.error(`[gh] listIssuesByNumbers failed for #${number}: ${err}`);
    }
  }
  return results;
}

export async function findOpenPrNumberByHeadRef(headRefName: string): Promise<number | null> {
  return findPrNumberByHeadRef(headRefName, "open");
}

export async function findPrNumberByHeadRef(
  headRefName: string,
  state: "open" | "all" = "open",
): Promise<number | null> {
  const output = await execGh([
    "pr",
    "list",
    "--state",
    state,
    "--head",
    headRefName,
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  const prs: { number: number }[] = JSON.parse(output);
  return prs.length > 0 ? prs[0].number : null;
}

export interface PullRequestStateInfo {
  number: number;
  state: string;
  mergedAt: string | null;
}

// head ref から PR の状態（OPEN / MERGED / CLOSED）を取得する。
// apply-ui-design の preflight がデザインPRのマージ完了を待つために使う。
export async function findPrStateByHeadRef(headRefName: string): Promise<PullRequestStateInfo | null> {
  const output = await execGh([
    "pr",
    "list",
    "--state",
    "all",
    "--head",
    headRefName,
    "--json",
    "number,state,mergedAt",
    "--limit",
    "1",
  ]);
  const prs: { number: number; state: string; mergedAt: string | null }[] = JSON.parse(output);
  if (prs.length === 0) return null;
  return { number: prs[0].number, state: prs[0].state, mergedAt: prs[0].mergedAt ?? null };
}

export async function getIssueBody(issueNumber: number): Promise<string> {
  const output = await execGh(["issue", "view", String(issueNumber), "--json", "body"]);
  const parsed = JSON.parse(output);
  return typeof parsed?.body === "string" ? parsed.body : "";
}

export async function getIssueState(issueNumber: number): Promise<string> {
  const output = await execGh(["issue", "view", String(issueNumber), "--json", "state"]);
  const parsed = JSON.parse(output);
  return parsed.state;
}

// Issue を closing keyword（Closes #N 等）で参照する PR を探す。マージ済み・オープン中のPRのみを対象とし、
// 無関係な却下済み（未マージでクローズ）のPRを誤検出しないよう除外する。さらに、今回の実行の作業ブランチ
// （expectedHeadRefName）と headRefName が一致するPRのみを有効とみなし、無関係な既存PRの誤検出を防ぐ。
export async function findPrNumberClosingIssue(
  issueNumber: number,
  expectedHeadRefName: string,
): Promise<number | null> {
  const { owner, name } = await getRepoInfo();
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state headRefName } }
      }
    }
  }`;
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
    `number=${issueNumber}`,
  ]);
  const parsed = JSON.parse(output);
  const nodes: { number: number; state?: string; headRefName?: string }[] =
    parsed?.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  const validPr = nodes.find(
    (node) => (node.state === "MERGED" || node.state === "OPEN") && node.headRefName === expectedHeadRefName,
  );
  return validPr ? validPr.number : null;
}

export async function getIssueSubIssuesSummary(issueNumber: number): Promise<SubIssuesSummary> {
  const output = await execGh(["issue", "view", String(issueNumber), "--json", "subIssuesSummary"]);
  const parsed = JSON.parse(output);
  const summary = parsed?.subIssuesSummary;
  if (
    !summary ||
    typeof summary.total !== "number" ||
    typeof summary.completed !== "number" ||
    typeof summary.percentCompleted !== "number"
  ) {
    return { total: 0, completed: 0, percentCompleted: 0 };
  }
  return {
    total: summary.total,
    completed: summary.completed,
    percentCompleted: summary.percentCompleted,
  };
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

// CI 未完了の PR が古い順の先頭を占めると isCICompleted フィルタで除外され、
// 後続の完了済み PR が取得枠から溢れて飢餓する。取得件数は同時実行数とは
// 切り離し、フィルタ前に十分な件数を確保するため既定値を 5 とする。
export async function listPullRequestsWithChecks(
  assignee?: string,
  label?: string,
  excludeLabels: string[] = [],
  limit = 5,
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
    String(limit),
  ];
  if (assignee) {
    args.push("--assignee", assignee);
  }
  if (label) {
    args.push("--label", label);
  }
  const output = await execGh(args);
  const prs: PullRequest[] = JSON.parse(output);
  const withChecks = await Promise.all(prs.map(async (pr) => ({ ...pr, checks: await fetchPRChecks(pr.number) })));
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

export async function hasLabel(type: "issue" | "pr", number: number, label: string): Promise<boolean> {
  return withRetry(async () => {
    const output = await execGh([type, "view", String(number), "--json", "labels"]);
    const parsed = JSON.parse(output);
    const labels: { name: string }[] = parsed?.labels ?? [];
    return labels.some((l) => l.name === label);
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

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  await execGh(["issue", "comment", String(issueNumber), "--body", body]);
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
