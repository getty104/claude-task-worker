#!/usr/bin/env node
// package.json の version を Claude Code プラグイン (plugin/.claude-plugin/plugin.json) の
// version へ同期する。npm version の `version` ライフサイクルフックから呼ばれるため、
// npm でバージョンを上げる (npm run publish 相当・publish.yml) たびにプラグイン側も
// 一緒に上がり、両者のバージョンが常に一致する。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(repoRoot, "package.json");
const pluginJsonPath = join(repoRoot, "plugin", ".claude-plugin", "plugin.json");

const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error(`package.json に有効な version がありません: ${version}`);
}

const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
if (plugin.version === version) {
  console.log(`[sync-plugin-version] plugin.json は既に ${version} です`);
  process.exit(0);
}

const previous = plugin.version;
plugin.version = version;
writeFileSync(pluginJsonPath, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`[sync-plugin-version] plugin.json を ${previous} から ${version} へ更新しました`);
