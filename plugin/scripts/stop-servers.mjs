#!/usr/bin/env node
// Stop hook for the worker-driven skills (exec-issue / fix-review-point / ...).
//
// When a `claude -p` skill run finishes, tear down anything the run started so it does
// not linger past the run: docker services, orphaned dev/E2E web servers holding ports,
// database processes, etc. The outer worker cleans up the run's worktree right after the
// skill exits, and a leftover server holding that directory as its cwd both wastes
// resources and can block the worktree removal.
//
// The `block-async-execution` PreToolUse guard already prevents foreground work from
// surviving turn-end, so anything still alive at Stop time has detached and reparented
// to init/launchd (e.g. `docker compose up -d`, a Playwright `webServer`, a test runner
// that daemonizes). A detached process keeps whatever cwd it was started in, and the
// run's worktree cwd (`.claude/worktrees/<adj-noun-NNNN>`) is unique to this run, so
// "cwd is inside the run cwd" cleanly identifies the processes this run spawned without
// ever touching the user's own or a sibling run's processes.
//
// Two teardown steps, both best-effort and non-fatal. The hook ALWAYS exits 0 (a teardown
// hiccup never fails the skill), but it is not instant: each external command carries its
// own timeout, dominated by `docker compose down` at up to 120s:
//   1. `docker compose down --volumes --remove-orphans` when a compose file is present.
//   2. SIGTERM every process whose cwd is inside the run cwd, excluding this hook's own
//      ancestor chain (the node hook, its shell, and the `claude` process all share the
//      worktree cwd — killing them would abort the run mid-Stop and corrupt the exit code
//      the worker keys its label transitions off of).
//
// The pure decision logic (`selectPidsToKill` / `parseLsofCwds` / `isUnder`) is exported
// so it can be unit tested; the OS-touching plumbing only runs as the hook entry point.

import { readFileSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

/** True when `cwd` is `dir` itself or nested inside it. */
export function isUnder(cwd, dir) {
  if (typeof cwd !== "string" || typeof dir !== "string" || cwd === "" || dir === "") {
    return false;
  }
  // `path.relative` normalizes separators and trailing slashes for us. `cwd` is inside
  // `dir` when the relative path neither escapes upward (`..`) nor is absolute. Match `..`
  // only as a whole segment so a real child like `..foo` is not mistaken for an escape.
  const rel = path.relative(dir, cwd);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Choose which PIDs to SIGTERM: processes whose cwd is inside `targetDir`, excluding
 * pid<=1 and any protected pid (this hook's ancestor chain).
 * @param {Array<{pid:number,cwd:string}>} processList
 * @param {string} targetDir
 * @param {Set<number>} protectedPids
 * @returns {number[]}
 */
export function selectPidsToKill(processList, targetDir, protectedPids) {
  if (!Array.isArray(processList) || typeof targetDir !== "string" || targetDir === "") {
    return [];
  }
  const guarded = protectedPids instanceof Set ? protectedPids : new Set();
  const seen = new Set();
  const pids = [];
  for (const entry of processList) {
    if (!isRecord(entry)) continue;
    const pid = entry.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) continue;
    if (guarded.has(pid) || seen.has(pid)) continue;
    if (!isUnder(entry.cwd, targetDir)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

/**
 * Parse `lsof -w -n -d cwd -Fpn` output into {pid, cwd} records. Field-per-line format:
 * a `p<pid>` line opens a process set, and a following `n<path>` line is its cwd (the
 * `-d cwd` filter guarantees the only descriptor reported is the cwd).
 * @param {string} output
 * @returns {Array<{pid:number,cwd:string}>}
 */
export function parseLsofCwds(output) {
  if (typeof output !== "string") return [];
  const records = [];
  let pid = null;
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      const n = Number.parseInt(rest, 10);
      pid = Number.isInteger(n) ? n : null;
    } else if (tag === "n" && pid !== null) {
      records.push({ pid, cwd: rest });
    }
  }
  return records;
}

/** Resolve the parent pid of `pid` via `ps` (portable across macOS and Linux). */
function getParentPid(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const ppid = Number.parseInt(out.trim(), 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Walk the parent chain from `startPid` up to init, collecting every ancestor pid so we
 * never SIGTERM ourselves, our shell, or the `claude` process that hosts this hook.
 */
function collectAncestorPids(startPid) {
  const ancestors = new Set();
  let pid = startPid;
  for (let i = 0; i < 64 && Number.isInteger(pid) && pid > 1; i++) {
    if (ancestors.has(pid)) break;
    ancestors.add(pid);
    const ppid = getParentPid(pid);
    if (ppid === null || ppid === pid) break;
    pid = ppid;
  }
  return ancestors;
}

/** Enumerate every reachable process' cwd, preferring Linux /proc, falling back to lsof. */
function listProcessCwds() {
  if (existsSync("/proc")) {
    const records = [];
    let entries;
    try {
      entries = readdirSync("/proc");
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number.parseInt(name, 10);
      try {
        const cwd = readlinkSync(`/proc/${name}/cwd`);
        records.push({ pid, cwd });
      } catch {
        // Process gone or not readable — skip.
      }
    }
    if (records.length > 0) return records;
  }
  try {
    const out = execFileSync("lsof", ["-w", "-n", "-d", "cwd", "-Fpn"], {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseLsofCwds(out);
  } catch {
    return [];
  }
}

/** Best-effort `docker compose down` when the run cwd holds a compose file. */
function dockerComposeDown(cwd) {
  const hasCompose = COMPOSE_FILES.some((f) => existsSync(path.join(cwd, f)));
  if (!hasCompose) return;
  try {
    execFileSync("docker", ["compose", "down", "--volumes", "--remove-orphans"], {
      cwd,
      timeout: 120000,
      stdio: "ignore",
    });
  } catch {
    // Docker unavailable / not running / nothing to tear down — non-fatal.
  }
}

/**
 * Resolve the run's working directory from the Stop hook stdin, falling back to `fallback`.
 * The result is normalized to an absolute path so it compares cleanly against the absolute
 * cwds reported by `/proc` / `lsof` even when the stdin `cwd` arrives relative.
 */
export function resolveTargetDir(payload, fallback) {
  const raw = isRecord(payload) && typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : fallback;
  return path.resolve(raw);
}

function main() {
  // When invoked as a Stop hook the JSON payload arrives on stdin; when run by hand from
  // an interactive shell stdin is a TTY and `readFileSync(0)` would block on EOF forever,
  // so skip the read and fall back to the process cwd in that case.
  let payload = {};
  if (!process.stdin.isTTY) {
    try {
      payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
    } catch {
      payload = {};
    }
  }

  const targetDir = resolveTargetDir(payload, process.cwd());

  // 1. Tear down docker services declared in the run cwd.
  dockerComposeDown(targetDir);

  // 2. SIGTERM leftover processes rooted in the run cwd, sparing our own ancestor chain.
  const protectedPids = collectAncestorPids(process.pid);
  const pids = selectPidsToKill(listProcessCwds(), targetDir, protectedPids);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited or not permitted — ignore.
    }
  }

  // Always exit 0 so a teardown failure never fails the skill itself. Note this is not
  // instant: the steps above wait up to their subcommand timeouts (docker compose: 120s).
  process.exit(0);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main();
}
