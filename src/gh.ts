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

interface ReviewComment {
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

interface UnresolvedThread {
  threadId: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  comments: ReviewComment[];
}

interface UnresolvedReviewsResult {
  prNumber: number;
  title: string;
  url: string;
  state: string;
  author: string;
  requestedReviewers: string[];
  unresolvedThreads: UnresolvedThread[];
}

export async function fetchUnresolvedReviews(owner: string, repo: string, prNumber: number): Promise<UnresolvedReviewsResult> {
  const buildQuery = (withCursor: boolean) => `
    query($owner: String!, $repo: String!, $number: Int!${withCursor ? ", $cursor: String" : ""}) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          number
          title
          url
          state
          author { login }
          reviewRequests(first: 100) {
            nodes {
              requestedReviewer {
                ... on User { login }
              }
            }
          }
          reviewThreads(first: 100${withCursor ? ", after: $cursor" : ""}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                isResolved
                isOutdated
                path
                line
                comments(last: 100) {
                  nodes {
                    author { login }
                    body
                    url
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const pages: any[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const args = [
      "api", "graphql",
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
      "-F", `number=${prNumber}`,
      "-f", `query=${buildQuery(cursor !== null)}`,
    ];
    if (cursor) {
      args.push("-f", `cursor=${cursor}`);
    }

    const output = await execGh(args);
    const parsed = JSON.parse(output);
    pages.push(parsed);

    const pageInfo = parsed.data.repository.pullRequest.reviewThreads.pageInfo;
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor ?? null;
  }

  const firstPr = pages[0].data.repository.pullRequest;

  const unresolvedThreads: UnresolvedThread[] = pages.flatMap((page) =>
    page.data.repository.pullRequest.reviewThreads.edges
      .filter((edge: any) => !edge.node.isResolved)
      .map((edge: any) => ({
        threadId: edge.node.id,
        path: edge.node.path,
        line: edge.node.line,
        isOutdated: edge.node.isOutdated,
        comments: edge.node.comments.nodes.map((c: any) => ({
          author: c.author.login,
          body: c.body,
          url: c.url,
          createdAt: c.createdAt,
        })),
      }))
  );

  return {
    prNumber: firstPr.number,
    title: firstPr.title,
    url: firstPr.url,
    state: firstPr.state,
    author: firstPr.author.login,
    requestedReviewers: firstPr.reviewRequests.nodes.map((n: any) => n.requestedReviewer?.login).filter(Boolean),
    unresolvedThreads,
  };
}

export async function hasUnresolvedReviews(owner: string, repo: string, prNumber: number): Promise<boolean> {
  const result = await fetchUnresolvedReviews(owner, repo, prNumber);
  return result.unresolvedThreads.length > 0;
}
