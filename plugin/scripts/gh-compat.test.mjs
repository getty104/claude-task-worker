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

test("default-branch は origin/HEAD が無ければ REST へ進み、gh repo view は呼ばない", () => {
  // クラウド VM の作業ツリーを模して refs/remotes/origin/HEAD を張らない。ここで
  // `gh repo view --json` へ落ちると GraphQL ゲートの 403 で解決に失敗し、両スキルの
  // フェーズ0が常に中断する（#353）。
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const repo = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "work", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  const log = path.join(dir, "log");
  makeGhStub(dir, { "api repos/acme/widget --jq": "main\n" });
  assert.equal(
    run(["default-branch"], { cwd: repo, env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log } }),
    "main",
  );
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(calls, /api repos\/acme\/widget --jq/);
  assert.doesNotMatch(calls, /repo view/);
});

test("default-branch は GH_COMPAT_OWNER_REPO の上書きを REST 段でも尊重する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-compat-"));
  const repo = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "work", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  const log = path.join(dir, "log");
  makeGhStub(dir, { "api repos/other/thing --jq": "trunk\n" });
  assert.equal(
    run(["default-branch"], {
      cwd: repo,
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, GH_COMPAT_OWNER_REPO: "other/thing" },
    }),
    "trunk",
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
