import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "gh-compat.sh");

function run(args, { env = {}, cwd } = {}) {
  return execFileSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  }).trim();
}

// `gh` を差し替えるスタブ。呼ばれた引数を記録し、responses に登録された
// パターンにマッチしたら stdout を返し、無ければ非0で終了する。
function makeGhStub(dir, responses) {
  const ghPath = path.join(dir, "gh");
  // 応答本文はファイルへ出し、スタブは cat するだけにする（シェル引用で改行が壊れないように）
  const cases = Object.entries(responses)
    .map(([needle, out], i) => {
      const f = path.join(dir, `resp${i}`);
      writeFileSync(f, out);
      return `  *${JSON.stringify(needle)}*) cat ${JSON.stringify(f)}; exit 0 ;;`;
    })
    .join("\n");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\necho "$@" >> "$STUB_LOG"\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(ghPath, 0o755);
  return ghPath;
}

test("parse-owner-repo はSSH/HTTPS・.git有無のいずれからも owner/repo を切り出す", () => {
  const cases = [
    ["git@github.com:acme/widget.git", "acme/widget"],
    ["git@github.com:acme/widget", "acme/widget"],
    ["https://github.com/acme/widget.git", "acme/widget"],
    ["https://github.com/acme/widget", "acme/widget"],
    ["ssh://git@github.com/acme/widget.git", "acme/widget"],
  ];
  for (const [url, expected] of cases) {
    assert.equal(run(["parse-owner-repo", url]), expected, url);
  }
});

test("issue-parent は REST を第一手段にし、gh issue view --json parent を呼ばない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "issues/12/parent": "7\n" });
  const out = run(["issue-parent", "12"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "7");
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(calls, /api repos\/acme\/widget\/issues\/12\/parent/);
  assert.doesNotMatch(calls, /--json parent/);
});

test("issue-parent は /parent が404（parent無し）なら空文字・exit 0 で返す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  // /parent 本体は非0（404相当）、-i 付きの再問い合わせで 404 ステータス行を返す
  makeGhStub(dir, { "issues/12/parent -i": "HTTP/2.0 404 Not Found\n\n{}\n" });
  const out = run(["issue-parent", "12"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "");
});

test("issue-parent は /parent が404以外（403/5xx等）で失敗し gh issue view でも取得不能なら非0で終了する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  // /parent 本体は非0、-i 付きの再問い合わせは 403 を返す（404 ではない）。gh issue view も失敗させる。
  makeGhStub(dir, { "issues/12/parent -i": "HTTP/2.0 403 Forbidden\n\n{}\n" });
  assert.throws(() => {
    run(["issue-parent", "12"], {
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
    });
  });
});

test("issue-parent は REST も Issue 取得も失敗したら gh issue view へフォールバックする", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "--json parent": "9\n" });
  const out = run(["issue-parent", "12"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "9");
});

test("add-blocking は相手側の blocked_by として登録する（REST に blocking の POST が無いため）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "issues/50 --jq .id": "9001\n", "dependencies/blocked_by": "{}" });
  run(["add-blocking", "50", "51"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  // #50 が #51 をブロックする ＝ #51 の blocked_by に #50 の id を足す
  assert.match(calls, /POST repos\/acme\/widget\/issues\/51\/dependencies\/blocked_by/);
  assert.match(calls, /issue_id=9001/);
});

test("pr-mergeable は REST の true/false/null を GraphQL 語彙へ写す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  for (const [rest, expected] of [
    ["false", "CONFLICTING"],
    ["true", "MERGEABLE"],
    ["null", "UNKNOWN"],
  ]) {
    makeGhStub(dir, { "pulls/3": `${rest}\n` });
    assert.equal(
      run(["pr-mergeable", "3"], {
        env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
      }),
      expected,
    );
  }
});

test("default-branch は git のローカル導出を優先し gh を呼ばない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const repo = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "trunk", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  execFileSync("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
  const log = path.join(dir, "log");
  makeGhStub(dir, {});
  assert.equal(
    run(["default-branch"], { cwd: repo, env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log } }),
    "trunk",
  );
  assert.equal(
    run(["owner-repo"], { cwd: repo, env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log } }),
    "acme/widget",
  );
});

test("pr-for-branch は REST でカレントブランチの Open PR を引く（-f でクエリをフィールド渡しする）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "pulls -f state=open -f head=acme:feature/x": "[31]\n" });
  const out = run(["pr-for-branch", "feature/x"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "31");
  assert.doesNotMatch(execFileSync("cat", [log], { encoding: "utf8" }), /pr view/);
});

test("pr-for-branch は特殊文字を含むブランチ名も -f 経由でそのまま1フィールドとして渡す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "head=acme:feature/x&y": "[31]\n" });
  const out = run(["pr-for-branch", "feature/x&y"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "31");
});

test("pr-for-branch は同一ブランチに複数のOpen PRがあれば失敗し、gh pr view へはフォールバックしない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "pulls -f state=open -f head=acme:feature/x": "[31,32]\n" });
  assert.throws(() => {
    run(["pr-for-branch", "feature/x"], {
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
    });
  });
  assert.doesNotMatch(execFileSync("cat", [log], { encoding: "utf8" }), /pr view/);
});

test("pr-for-branch はRESTが失敗した場合のみ指定ブランチを添えて gh pr view へフォールバックする", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, { "pr view feature/x --json number": "9\n" });
  const out = run(["pr-for-branch", "feature/x"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "9");
});

test("issue-deps は30件超のページングを取りこぼさないよう --paginate --slurp を付ける", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  // gh をスタブしているため実際のページ結合は gh 自身が行う（--paginate --slurp の指定を検証する）。
  // 31件超のケースを模して、jq側フィルタが通しても壊れないことをあわせて確認する。
  makeGhStub(dir, {
    "dependencies/blocked_by": "[1,2,3]",
    "dependencies/blocking": "[]",
  });
  const out = run(["issue-deps", "12"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, '{"blockedBy":[1,2,3],"blocking":[]}');
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(calls, /--paginate --slurp repos\/acme\/widget\/issues\/12\/dependencies\/blocked_by/);
  assert.match(calls, /--paginate --slurp repos\/acme\/widget\/issues\/12\/dependencies\/blocking/);
});

test("list-issues-updated-since はPRを除外しIssue番号を降順で返し、labelをgh へ -f labels= で渡す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "issues -f state=all -f since=2026-01-01T00:00:00Z -f labels=bug": JSON.stringify([
      { number: 5, title: "Issue 5" },
      { number: 3, pull_request: {}, title: "PR 3" },
      { number: 8, title: "Issue 8" },
    ]),
  });
  const out = run(["list-issues-updated-since", "2026-01-01T00:00:00Z", "bug"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "8\n5");
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(calls, /-f labels=bug/);
});

test("list-prs-updated-since はpull_requestキーを持つものだけを番号降順で返す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "issues -f state=all -f since=2026-01-01T00:00:00Z -f per_page=100": JSON.stringify([
      { number: 5, title: "Issue 5" },
      { number: 3, pull_request: {}, title: "PR 3" },
      { number: 9, pull_request: {}, title: "PR 9" },
    ]),
  });
  const out = run(["list-prs-updated-since", "2026-01-01T00:00:00Z"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  assert.equal(out, "9\n3");
});

test("list-prs-merged-since はmerged_atがnullのPR・since以前にマージされたPRを除外し、merged_at降順（番号順とは異なる）で返す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "issues -f state=closed -f labels=needs-release -f since=2026-01-01T00:00:00Z": JSON.stringify([
      { number: 100, pull_request: { merged_at: "2026-01-02T00:00:00Z" } },
      { number: 5, pull_request: { merged_at: "2026-01-09T00:00:00Z" } },
      { number: 50, pull_request: { merged_at: null } },
      { number: 60, pull_request: { merged_at: "2025-12-01T00:00:00Z" } },
    ]),
  });
  const out = run(["list-prs-merged-since", "2026-01-01T00:00:00Z", "needs-release"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  // #5 は #100 より番号は小さいがマージが後なので先に出る（番号順ではなくmerged_at降順）
  assert.equal(out, "5\n100");
});

test("pr-review-comments はin_reply_to_idでスレッドへグルーピングし、isOutdatedをルートのlineから導出する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "pulls/7/comments": JSON.stringify([
      {
        id: 1,
        in_reply_to_id: null,
        line: 17,
        path: "a.ts",
        created_at: "2026-01-01T00:00:00Z",
        user: { login: "alice" },
        body: "root1",
        html_url: "https://x/1",
      },
      {
        id: 2,
        in_reply_to_id: 1,
        line: null,
        path: "a.ts",
        created_at: "2026-01-01T01:00:00Z",
        user: { login: "bob" },
        body: "reply1",
        html_url: "https://x/2",
      },
      {
        id: 3,
        in_reply_to_id: null,
        line: null,
        path: "b.ts",
        created_at: "2026-01-02T00:00:00Z",
        user: { login: "carol" },
        body: "root2",
        html_url: "https://x/3",
      },
    ]),
  });
  const out = run(["pr-review-comments", "7"], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      STUB_LOG: log,
      GH_COMPAT_OWNER_REPO: "acme/widget",
      GH_COMPAT_NO_GRAPHQL: "1",
    },
  });
  const threads = out.split("\n").map((line) => JSON.parse(line));
  assert.equal(threads.length, 2);

  const [threadWithReply, threadOutdated] = threads;
  assert.equal(threadWithReply.line, 17);
  assert.equal(threadWithReply.isOutdated, false);
  assert.equal(threadWithReply.isResolved, null);
  assert.equal(threadWithReply.comments.nodes.length, 2);
  assert.equal(threadWithReply.comments.nodes[0].body, "root1");
  assert.equal(threadWithReply.comments.nodes[1].body, "reply1");
  assert.ok(threadWithReply.comments.nodes[0].createdAt < threadWithReply.comments.nodes[1].createdAt);
  assert.equal("_root_id" in threadWithReply, false);

  assert.equal(threadOutdated.line, null);
  assert.equal(threadOutdated.isOutdated, true);
  assert.equal(threadOutdated.isResolved, null);
  assert.equal(threadOutdated.comments.nodes.length, 1);
  assert.equal("_root_id" in threadOutdated, false);
});

test("pr-files はREST statusをGraphQL語彙のchangeTypeへ写像し、pathはfilenameから来る", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  const statusMap = [
    ["added", "ADDED"],
    ["removed", "DELETED"],
    ["modified", "MODIFIED"],
    ["renamed", "RENAMED"],
    ["copied", "COPIED"],
    ["changed", "CHANGED"],
    ["unchanged", "CHANGED"],
  ];
  makeGhStub(dir, {
    "pulls/44/files": JSON.stringify(
      statusMap.map(([status], i) => ({
        filename: `file${i}.ts`,
        additions: 1,
        deletions: 0,
        status,
      })),
    ),
  });
  const out = run(["pr-files", "44"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  const files = out.split("\n").map((line) => JSON.parse(line));
  assert.equal(files.length, statusMap.length);
  files.forEach((f, i) => {
    assert.equal(f.path, `file${i}.ts`);
    assert.equal(f.changeType, statusMap[i][1]);
  });
});

test("issue-meta はREST小文字stateを大文字化し、urlはhtml_urlから、bodyのnullは空文字になる", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  const stateMap = [
    ["open", "OPEN"],
    ["closed", "CLOSED"],
  ];
  for (const [rest, expected] of stateMap) {
    makeGhStub(dir, {
      "issues/21": JSON.stringify({
        number: 21,
        title: "T",
        html_url: "https://x/issues/21",
        state: rest,
        body: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        user: { login: "alice" },
        labels: [{ name: "bug" }],
      }),
    });
    const out = run(["issue-meta", "21"], {
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
    });
    const meta = JSON.parse(out);
    assert.equal(meta.state, expected);
    assert.equal(meta.url, "https://x/issues/21");
    assert.equal(meta.body, "");
    assert.deepEqual(meta.labels, { nodes: [{ name: "bug" }] });
  }
});

test("pr-meta はPR本文のclosing keywordからclosingIssuesReferencesを導出し、各フィールドをREST語彙からGraphQL語彙へ写像する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "pulls/99": JSON.stringify({
      number: 99,
      title: "Feature X",
      html_url: "https://github.com/acme/widget/pull/99",
      body: "Closes #12\n\nAlso fixes #34 for extra credit.",
      merged_at: "2026-01-05T00:00:00Z",
      base: { ref: "main" },
      head: { ref: "feature/x" },
      user: { login: "dev1" },
      merge_commit_sha: "abc123",
      labels: [{ name: "bug" }],
    }),
    "issues/12": JSON.stringify({ number: 12, title: "Twelve" }),
    "issues/34": JSON.stringify({ number: 34, title: "ThirtyFour" }),
  });
  const out = run(["pr-meta", "99"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  const meta = JSON.parse(out);
  assert.equal(meta.url, "https://github.com/acme/widget/pull/99");
  assert.equal(meta.mergedAt, "2026-01-05T00:00:00Z");
  assert.equal(meta.baseRefName, "main");
  assert.equal(meta.headRefName, "feature/x");
  assert.equal(meta.author.login, "dev1");
  assert.deepEqual(meta.mergeCommit, { oid: "abc123" });
  assert.deepEqual(meta.closingIssuesReferences.nodes, [
    { number: 12, title: "Twelve" },
    { number: 34, title: "ThirtyFour" },
  ]);
});

test("pr-meta はclosing keywordを持たない本文ならclosingIssuesReferencesが空配列で、merge_commit_shaがnullならmergeCommitもnullになる", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "pulls/101": JSON.stringify({
      number: 101,
      title: "WIP",
      html_url: "https://github.com/acme/widget/pull/101",
      body: "Just a description, no links here.",
      merged_at: null,
      base: { ref: "main" },
      head: { ref: "feature/y" },
      user: { login: "dev2" },
      merge_commit_sha: null,
      labels: [],
    }),
  });
  const out = run(["pr-meta", "101"], {
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" },
  });
  const meta = JSON.parse(out);
  assert.deepEqual(meta.closingIssuesReferences.nodes, []);
  assert.equal(meta.mergeCommit, null);
});

test("pr-conversation-comments / issue-comments はurl/createdAt/author.loginをREST語彙から写像し、GH_COMPAT_NO_GRAPHQL下ではisMinimizedがfalseになる", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {
    "issues/55/comments": JSON.stringify([
      {
        id: 77,
        body: "hello",
        html_url: "https://x/77",
        created_at: "2026-02-01T00:00:00Z",
        user: { login: "eve" },
      },
    ]),
  });
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    STUB_LOG: log,
    GH_COMPAT_OWNER_REPO: "acme/widget",
    GH_COMPAT_NO_GRAPHQL: "1",
  };
  const expected = {
    author: { login: "eve" },
    body: "hello",
    url: "https://x/77",
    createdAt: "2026-02-01T00:00:00Z",
    isMinimized: false,
  };
  assert.deepEqual(JSON.parse(run(["pr-conversation-comments", "55"], { env })), expected);
  assert.deepEqual(JSON.parse(run(["issue-comments", "55"], { env })), expected);
});

test("取得失敗時は0件へフォールバックせず非0で終了する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const log = path.join(dir, "log");
  makeGhStub(dir, {});
  const env = { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "acme/widget" };
  assert.throws(() => run(["list-issues-updated-since", "2026-01-01T00:00:00Z"], { env }));
  assert.throws(() => run(["pr-meta", "1"], { env }));
  assert.throws(() => run(["issue-meta", "1"], { env }));
});
