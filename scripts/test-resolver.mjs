import { register } from "node:module";

// resolve フックを登録するエントリ。package.json の test スクリプトが
// `node --import ./scripts/test-resolver.mjs` で読み込む。
register("./test-resolver.hooks.mjs", import.meta.url);
