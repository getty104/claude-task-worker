/* global process */
// `gh` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、シナリオ
// （CTW_STUB_GH_SCENARIO の JSON）に応じた応答を返す。
//
// ラベル・コメントはクラウド完了検知（cc-cloud-done ポーリング）のタイミングを検証できる
// よう状態化してある。herdr-stub.mjs の readState/writeState に倣い、記録ファイルと同じ
// ディレクトリの別ファイル（`.gh-state.json`）へ永続化する（herdr の状態ファイルとは混ぜない）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const recordFile = process.env.CTW_STUB_RECORD_FILE;

if (recordFile) {
  const record = { command: "gh", argv, cwd: process.cwd(), env: { ...process.env } };
  appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
}

const stateFile = recordFile ? `${recordFile}.gh-state.json` : undefined;

function readState() {
  if (!stateFile || !existsSync(stateFile)) return { labels: {}, comments: {} };
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { labels: {}, comments: {} };
  }
}

function writeState(state) {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
}

function readScenario() {
  const raw = process.env.CTW_STUB_GH_SCENARIO;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const scenario = readScenario();
const [sub, action] = argv;

if (sub === "api" && action === "user") {
  process.stdout.write(`${scenario.login ?? "worker-user"}\n`);
} else if (sub === "api" && action === "graphql") {
  // linkClosingPr() の addCloseIssueReferences ミューテーションは記録だけして成功扱いにする。
  // 読み取り（listPrsClosingIssue）と区別できないと、紐付けの呼び出しが closingPrs を返してしまう。
  if (argv.some((arg) => arg.includes("addCloseIssueReferences"))) {
    process.stdout.write(JSON.stringify({ data: { addCloseIssueReferences: { issue: { number: 0 } } } }));
  } else {
    process.stdout.write(
      JSON.stringify({
        data: {
          repository: {
            issue: { closedByPullRequestsReferences: { nodes: scenario.closingPrs ?? [] } },
          },
        },
      }),
    );
  }
} else if (sub === "api") {
  // findCommentSince() が叩く `gh api repos/{owner}/{repo}/issues/<n>/comments?since=<ISO8601>`。
  const path = argv[1] ?? "";
  const match = /\/issues\/(\d+)\/comments\?since=(.+)$/.exec(path);
  if (match) {
    const [, numberStr, since] = match;
    const sinceMs = Date.parse(decodeURIComponent(since));
    const state = readState();
    const comments = (state.comments?.[numberStr] ?? []).filter((comment) => Date.parse(comment.created_at) >= sinceMs);
    process.stdout.write(JSON.stringify(comments.map((comment) => ({ body: comment.body }))));
  } else if (/\/issues\/\d+\/timeline$/.test(path)) {
    // listPrsCrossReferencingIssue() が叩く timeline。scenario.crossRefPrs のPR番号を
    // cross-referenced イベントとして返す。
    const repo = scenario.repo ?? { owner: "acme", name: "demo", defaultBranch: "main" };
    const events = (scenario.crossRefPrs ?? []).map((pr) => ({
      event: "cross-referenced",
      source: {
        issue: {
          number: pr.number,
          pull_request: { url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}` },
          repository: { full_name: `${repo.owner}/${repo.name}` },
        },
      },
    }));
    process.stdout.write(JSON.stringify(events));
  } else if (/\/pulls\/\d+$/.test(path)) {
    // fetchPrRef() / linkClosingPr() が叩くPR詳細（REST 形状）。
    const number = Number(path.split("/").pop());
    const pr = (scenario.crossRefPrs ?? []).find((candidate) => candidate.number === number);
    if (!pr) {
      process.stderr.write(`unknown pull request: ${number}\n`);
      process.exit(1);
    }
    process.stdout.write(
      JSON.stringify({
        node_id: `PR_${number}`,
        state: pr.state === "MERGED" ? "closed" : (pr.state ?? "OPEN").toLowerCase(),
        merged_at: pr.state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
        created_at: pr.createdAt,
        head: { ref: pr.headRefName },
        base: { ref: pr.baseRefName },
      }),
    );
  } else if (/\/issues\/\d+$/.test(path)) {
    process.stdout.write(JSON.stringify({ node_id: `I_${path.split("/").pop()}` }));
  } else {
    process.stderr.write(`unknown gh api command: ${argv.join(" ")}\n`);
    process.exit(1);
  }
} else if (sub === "repo" && action === "view") {
  const repo = scenario.repo ?? { owner: "acme", name: "demo", defaultBranch: "main" };
  process.stdout.write(
    JSON.stringify({
      owner: { login: repo.owner },
      name: repo.name,
      defaultBranchRef: { name: repo.defaultBranch },
    }),
  );
} else if (sub === "issue" && action === "list") {
  // `gh issue list --label cc-cloud-done` はクラウド完了検知のポーリング専用の絞り込みで、
  // 状態ファイルのラベルから動的に判定する。それ以外の --label（トリガーラベル等）は
  // 従来どおり scenario.issues をそのまま返す（絞り込みはしない、既存の呼び出し元互換のため）。
  const labelIndex = argv.indexOf("--label");
  const label = labelIndex !== -1 ? argv[labelIndex + 1] : undefined;
  if (label === "cc-cloud-done") {
    const state = readState();
    const numbers = Object.entries(state.labels ?? {})
      .filter(([key, labels]) => key.startsWith("issue:") && labels.includes(label))
      .map(([key]) => Number(key.split(":")[1]));
    process.stdout.write(JSON.stringify(numbers.map((number) => ({ number }))));
  } else {
    process.stdout.write(JSON.stringify(scenario.issues ?? []));
  }
} else if (sub === "pr" && action === "list") {
  // 実際の `gh pr list --head` はサーバー側で headRefName による絞り込みを行うため、
  // スタブも同様に絞り込む（findPrNumberByHeadRef() のテストが渡した head を無視しないように）。
  const labelIndex = argv.indexOf("--label");
  const label = labelIndex !== -1 ? argv[labelIndex + 1] : undefined;
  if (label === "cc-cloud-done") {
    const state = readState();
    const numbers = Object.entries(state.labels ?? {})
      .filter(([key, labels]) => key.startsWith("pr:") && labels.includes(label))
      .map(([key]) => Number(key.split(":")[1]));
    process.stdout.write(JSON.stringify(numbers.map((number) => ({ number }))));
  } else {
    const headIndex = argv.indexOf("--head");
    const head = headIndex !== -1 ? argv[headIndex + 1] : undefined;
    const prList = scenario.prList ?? [];
    process.stdout.write(JSON.stringify(head === undefined ? prList : prList.filter((pr) => pr.headRefName === head)));
  }
} else if (sub === "pr" && action === "checks") {
  // listPullRequestsWithChecks() が呼ぶ `gh pr checks <n> --json state`。
  // GhScenario に専用フィールドを増やさず、既存の `view[number].checks` を再利用する
  // （view の値の型は Record<string, unknown> なので任意キーを追加してよい）。
  const number = argv[2];
  process.stdout.write(JSON.stringify(scenario.view?.[number]?.checks ?? []));
} else if (sub === "pr" && action === "create") {
  // last-run-pr.ts の createPullRequest() は stdout のPR URLから番号を抜き出すだけなので、
  // 固定のダミーURLを返せば十分。
  process.stdout.write("https://example.com/acme/demo/pull/999\n");
} else if ((sub === "issue" || sub === "pr") && action === "view") {
  const number = argv[2];
  process.stdout.write(JSON.stringify(scenario.view?.[number] ?? {}));
} else if ((sub === "issue" || sub === "pr") && action === "edit") {
  const number = argv[2];
  const key = `${sub}:${number}`;
  const state = readState();
  const labels = new Set(state.labels?.[key] ?? []);
  const addIndex = argv.indexOf("--add-label");
  if (addIndex !== -1) labels.add(argv[addIndex + 1]);
  const removeIndex = argv.indexOf("--remove-label");
  if (removeIndex !== -1) labels.delete(argv[removeIndex + 1]);
  writeState({ ...state, labels: { ...state.labels, [key]: [...labels] } });
} else if ((sub === "issue" || sub === "pr") && action === "comment") {
  // 記録のみ。
} else if (sub === "label" && action === "create") {
  // `gh label create <name> --force` は冪等。記録のみで成功扱いにする。
} else {
  process.stderr.write(`unknown gh command: ${argv.join(" ")}\n`);
  process.exit(1);
}

process.exit(0);
