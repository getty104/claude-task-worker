import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// node --experimental-strip-types の ESM リゾルバは拡張子なし相対 import も
// `.js`→`.ts` の読み替えも行わないため、拡張子なしで書かれたソースを
// node --test で解決できるよう補完する resolve フック。
// esbuild / tsc(moduleResolution: Bundler) は元から拡張子なしを解決するので、
// テスト実行時のみこのフックで実ファイルへ橋渡しする。
const EXTS = [".ts", ".mts", ".mjs", ".js"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : `${process.cwd()}/`;
    const base = path.resolve(path.dirname(parent), specifier);
    if (!existsSync(base)) {
      const stripped = base.replace(/\.(js|mjs|ts|mts)$/, "");
      const candidates = [];
      for (const ext of EXTS) candidates.push(stripped + ext);
      for (const ext of EXTS) candidates.push(base + ext);
      for (const ext of EXTS) candidates.push(path.join(base, `index${ext}`));
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
