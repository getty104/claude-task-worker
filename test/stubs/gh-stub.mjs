/* global process */
// `gh` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、シナリオ
// （CTW_STUB_GH_SCENARIO の JSON）に応じた応答を返す。
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const recordFile = process.env.CTW_STUB_RECORD_FILE;

if (recordFile) {
  const record = { command: "gh", argv, cwd: process.cwd(), env: { ...process.env } };
  appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
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
  process.stdout.write(
    JSON.stringify({
      data: {
        repository: {
          issue: { closedByPullRequestsReferences: { nodes: scenario.closingPrs ?? [] } },
        },
      },
    }),
  );
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
  process.stdout.write(JSON.stringify(scenario.issues ?? []));
} else if (sub === "pr" && action === "list") {
  // 実際の `gh pr list --head` はサーバー側で headRefName による絞り込みを行うため、
  // スタブも同様に絞り込む（findPrNumberByHeadRef() のテストが渡した head を無視しないように）。
  const headIndex = argv.indexOf("--head");
  const head = headIndex !== -1 ? argv[headIndex + 1] : undefined;
  const prList = scenario.prList ?? [];
  process.stdout.write(JSON.stringify(head === undefined ? prList : prList.filter((pr) => pr.headRefName === head)));
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
  // 記録のみ。ラベル付け外しはレコードから検証する。
} else if ((sub === "issue" || sub === "pr") && action === "comment") {
  // 記録のみ。
} else {
  process.stderr.write(`unknown gh command: ${argv.join(" ")}\n`);
  process.exit(1);
}

process.exit(0);
