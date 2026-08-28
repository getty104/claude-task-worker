import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "resolve-pr-comments.sh");

function hasJq() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeGhStub(dir) {
  const ghPath = path.join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -e
echo "$@" >> "${path.join(dir, "gh-calls.log")}"
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo 'owner/repo'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '42'
elif [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if [[ "$*" == *"resolveReviewThread"* ]]; then
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"x","isResolved":true}}}}'
  else
    echo '{"data":{"repository":{"pullRequest":{"number":42,"title":"t","url":"u","state":"OPEN","author":{"login":"a"},"reviewRequests":{"nodes":[]},"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"edges":[]}}}}}'
  fi
else
  echo "unhandled gh invocation: $@" >&2
  exit 1
fi
`,
  );
  chmodSync(ghPath, 0o755);
  return dir;
}

test("uses the PR number passed as the first argument", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  execFileSync("bash", [scriptPath, "99"], { env });
  const log = execFileSync("cat", [path.join(dir, "gh-calls.log")], { encoding: "utf8" });
  assert.match(log, /pullRequest\(number: 99\)/);
  assert.doesNotMatch(log, /^pr view/m);
});

test("falls back to `gh pr view` when no argument is given", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  execFileSync("bash", [scriptPath], { env });
  const log = execFileSync("cat", [path.join(dir, "gh-calls.log")], { encoding: "utf8" });
  assert.match(log, /pullRequest\(number: 42\)/);
  assert.match(log, /^pr view/m);
});
