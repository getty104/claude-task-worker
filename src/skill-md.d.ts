// SKILL.md をビルド時に文字列としてバンドルするための宣言（esbuild の `--loader:.md=text`）。
// init が配布するプロジェクトスキルの中身を init.ts へ写経すると plugin/skills の本体と
// 二重管理になるため、プラグイン側のファイルをそのまま取り込む。
declare module "*.md" {
  const content: string;
  export default content;
}
