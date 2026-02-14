import { execFile } from "node:child_process";

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

interface PullRequest {
  number: number;
  headRefName: string;
  labels: { name: string }[];
}

interface RepoInfo {
  owner: string;
  name: string;
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
  const output = await execGh(["repo", "view", "--json", "owner,name"]);
  const parsed = JSON.parse(output);
  return { owner: parsed.owner.login, name: parsed.name };
}

export async function listIssues(assignee: string, label: string): Promise<Issue[]> {
  const output = await execGh([
    "issue", "list",
    "--assignee", assignee,
    "--label", label,
    "--json", "number,title,labels",
    "--limit", "100",
  ]);
  return JSON.parse(output);
}

export async function listPullRequests(): Promise<PullRequest[]> {
  const output = await execGh([
    "pr", "list",
    "--json", "number,headRefName,labels",
    "--limit", "100",
  ]);
  return JSON.parse(output);
}

export async function addLabel(type: "issue" | "pr", number: number, label: string): Promise<void> {
  await execGh([type, "edit", String(number), "--add-label", label]);
}

export async function removeLabel(number: number, label: string): Promise<void> {
  await execGh(["issue", "edit", String(number), "--remove-label", label]);
}

export async function hasUnresolvedReviews(owner: string, repo: string, prNumber: number): Promise<boolean> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { isResolved }
          }
        }
      }
    }
  `;

  const output = await execGh([
    "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `repo=${repo}`,
    "-F", `number=${prNumber}`,
    "-f", `query=${query}`,
  ]);

  const parsed = JSON.parse(output);
  const threads = parsed.data.repository.pullRequest.reviewThreads.nodes as { isResolved: boolean }[];
  return threads.some((t) => !t.isResolved);
}
