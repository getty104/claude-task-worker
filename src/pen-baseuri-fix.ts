// @pen.dev/cli の "Base URI must be absolute!" をロード時にメモリ上だけで修正する。
// `claude-task-worker pencil` が NODE_OPTIONS の --import 経由で読み込む（src/commands/pencil.ts）。
// dist/pen-baseuri-fix.mjs として index.js とは別に単体バンドルされる（package.json の build スクリプト）。
import { registerHooks } from "node:module";
import { resolve } from "node:path";

// 難読化された @pen.dev/cli の中の「アセットのベースURIを返すゲッター」定義。
// `[_0xabc(0x1)](){return this[_0xabc(0x2)]||this[_0xabc(0x3)];}` のような形をしている。
const BASE_URI_GETTER =
  /\[(_0x[0-9a-f]+)\((0x[0-9a-f]+)\)\]\(\)\{return this\[\1\((0x[0-9a-f]+)\)\]\|\|this\[\1\((0x[0-9a-f]+)\)\];\}/;
const PEN_CLI_MODULE = /@pen\.dev\/cli\/dist\/[^/]*\.mjs$/;
const ABSOLUTE_URI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// 差し込んだゲッターから呼ばれるため、モジュールスコープではなくグローバルへ置く。
declare global {
  var __penAbsURI: (path: string | undefined) => string | undefined;
}

export function toAbsoluteUri(path: string | undefined): string | undefined {
  if (!path || ABSOLUTE_URI.test(path)) return path;
  return `file://${resolve(path)}`;
}

globalThis.__penAbsURI = toAbsoluteUri;

registerHooks({
  load(url, ctx, next) {
    const loaded = next(url, ctx);
    if (!PEN_CLI_MODULE.test(url) || !loaded.source) return loaded;
    const source = String(loaded.source);
    const match = BASE_URI_GETTER.exec(source);
    if (!match) return loaded;
    const [all, decode, methodKey, primaryKey, fallbackKey] = match;
    return {
      ...loaded,
      source: source.replace(
        all,
        `[${decode}(${methodKey})](){return globalThis.__penAbsURI(this[${decode}(${primaryKey})]||this[${decode}(${fallbackKey})]);}`,
      ),
    };
  },
});
