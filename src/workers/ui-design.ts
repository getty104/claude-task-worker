// create-ui-design / apply-ui-design が共有する、副作用のない純粋ヘルパー。
// ワーカー本体（gh 依存）と分離しておき、分岐だけをユニットテストできるようにする。

export const DESIGN_REFERENCE_HEADING = "## UIデザイン";

// デザインPRの head ブランチ。`cc-epic-<N>` と同じく固定命名にすることで、
// 後段の apply-ui-design が head ref からデザインPRを一意に特定できる。
export function designBranchName(issueNumber: number): string {
  return `cc-ui-design-${issueNumber}`;
}

// 行頭の `## UIデザイン` 見出し行のみを対象にする（`### UIデザイン` のような部分一致や、
// テンプレートの地の文中の言及との誤マッチを避けるため）。
const DESIGN_REFERENCE_HEADING_LINE = /^## UIデザイン[ \t]*$/m;

// apply-ui-design が書き込む実パス行の形式。プレースホルダ `<.pen の実パス>` は
// `<`/`>` を含み `.pen` で終わらないため、この形式には一致しない。
const DESIGN_FILE_LINE = /^-\s*デザインファイル:\s*`([^`]+)`/m;

// description 内の `## UIデザイン` セクション本文を、次の同レベル見出し（`## ` 始まり）
// の直前まで、無ければ本文末尾までで切り出す。次セクションに漏れ出た `.pen` を
// 自セクションの参照として誤って拾わないようにするため。
function extractDesignSection(body: string): string | null {
  const headingMatch = DESIGN_REFERENCE_HEADING_LINE.exec(body);
  if (headingMatch === null) return null;
  const rest = body.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = /^## /m.exec(rest);
  return nextHeadingMatch === null ? rest : rest.slice(0, nextHeadingMatch.index);
}

// description のデザイン参照セクションから `.pen` の実パスを抜き出す。書式検証のみを行う
// 純粋関数で、パスの実在確認はしない（実在確認は apply-ui-design.ts 側の非純粋関数が担う）。
export function extractDesignFilePath(body: string): string | null {
  const section = extractDesignSection(body);
  if (section === null) return null;
  const match = DESIGN_FILE_LINE.exec(section);
  if (match === null) return null;
  const path = match[1].trim();
  if (path.length === 0 || path.includes("<") || path.includes(">") || !path.endsWith(".pen")) return null;
  return path;
}

// description にデザイン参照セクションが生きているか。見出しの厳密一致に加え、
// 実パスを持つ `- デザインファイル: \`<path>.pen\`` 行の存在を要求する（見出しだけ
// 残って中身が消えた状態や、未置換のプレースホルダを「反映済み」と誤認しないため）。
export function hasDesignReference(body: string): boolean {
  return extractDesignFilePath(body) !== null;
}

export type DesignPrDisposition = "proceed" | "wait" | "needs-human";

// デザインPRの状態から apply-ui-design の preflight 判定を導く。
// MERGED のみ前進し、OPEN はレビュー・マージ待ちで次のポーリングへ回す。
// 未マージクローズ・PR不在は自動では回復できないため人手に委ねる。
export function classifyDesignPr(pr: { state: string; mergedAt: string | null } | null): DesignPrDisposition {
  if (pr === null) return "needs-human";
  if (pr.state === "MERGED" || pr.mergedAt !== null) return "proceed";
  if (pr.state === "OPEN") return "wait";
  return "needs-human";
}

export function designPrMissingComment(issueNumber: number): string {
  return [
    "## デザインPRを確認できません（要人手確認）",
    `apply-ui-design はデザインブランチ \`${designBranchName(issueNumber)}\` を head とするPRを待っていますが、そのPRが見つからないか、マージされずクローズされています。`,
    "",
    "## 状態の確認",
    `- デザインPRが却下された場合: このIssueをデザインなしで進めるか、デザインをやり直すかを決めてください`,
    `- デザインPRがそもそも作られていない場合: リモートブランチ \`${designBranchName(issueNumber)}\` の有無を確認してください`,
    "",
    "## 対応後の進め方",
    "- デザインをやり直す場合: `cc-need-human-check` / `cc-ui-design-pr-created` ラベルを外し、`cc-create-ui-design` ラベルを付け直してください",
    "- デザインなしで実装へ進める場合: `cc-need-human-check` / `cc-ui-design-pr-created` ラベルを外し、`cc-exec-issue` ラベルのみ付けてください",
  ].join("\n");
}

export function designPrNotCreatedComment(issueNumber: number): string {
  return [
    "## デザインPR未作成のまま自動実行が終了しました（要人手確認）",
    `create-ui-design のセッションは正常終了（exit 0）しましたが、デザインブランチ \`${designBranchName(issueNumber)}\` を head とするPRが見つかりませんでした。PR作成前にセッションが終了した可能性があります。`,
    "",
    "## 状態の確認",
    `- 変更が push 済みの場合はリモートブランチ \`${designBranchName(issueNumber)}\` が残っています。内容を確認し、必要なら手動でデザインPRを作成してください`,
    "",
    "## 対応後の進め方",
    "- 自動実行をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-create-ui-design` ラベルを付け直してください",
    "- 手動でデザインPRを作成した場合: `cc-need-human-check` ラベルを外し、`cc-ui-design-pr-created` ラベルを付けてください",
    "- デザインを諦めてそのまま実装へ進める場合: `cc-need-human-check` ラベルを外し、`cc-exec-issue` ラベルのみ付けてください",
  ].join("\n");
}

export function designReferenceMissingComment(issueNumber: number): string {
  return [
    "## デザイン参照の書き戻しを確認できません（要人手確認）",
    `apply-ui-design のセッションは正常終了（exit 0）しましたが、Issue #${issueNumber} の description に \`${DESIGN_REFERENCE_HEADING}\` セクション（\`.pen\` のパスを含む）が見つかりませんでした。`,
    "",
    "## なぜ止めているか",
    "- デザイン参照が description に無いと、`exec-issue` はデザインを入力にできず、合意済みのデザインと無関係な実装になります",
    "",
    "## 対応後の進め方",
    "- 自動実行をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-ui-design-pr-created` ラベルを付け直してください",
    "- 手動で description に参照を追記した場合: `cc-need-human-check` ラベルを外し、`cc-ui-design-ready` と `cc-exec-issue` ラベルを付けてください",
  ].join("\n");
}
