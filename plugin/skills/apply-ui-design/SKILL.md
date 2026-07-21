---
name: apply-ui-design
description: "Write the merged Pencil design reference back into a UI implementation Issue's description so the implementation session can use it as input. Takes the Issue number as argument, resolves the merged design PR on the `cc-ui-design-<Issue number>` branch, collects the `.pen` and snapshot paths it added, and appends (or replaces) the `## UIデザイン` section at the end of the Issue body using a lost-update-safe edit."
argument-hint: "[issue-number]"
disable-model-invocation: true
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-servers.mjs"
---

# Apply UI Design

マージ済みのデザインPRの内容を、実装Issue `$0` の description に「デザイン参照セクション」として書き戻すスキルです。`exec-issue` は description を唯一の入力として実装するため、ここで参照を残さないと合意済みデザインが実装セッションに届かない。

**このスキルはコードも `.pen` も変更しない**。行うのはIssue description の更新のみ。

# Instructions

## 実行モードの制約

本スキル固有のリスク: 本スキルは `claude-task-worker` の `apply-ui-design` ワーカー（`cc-ui-design-pr-created` ラベル）から自動起動され、ワーカーはスキルプロセスの同期完了を根拠にラベル遷移（`cc-ui-design-ready` + `cc-exec-issue` の付与）を進める。description の更新が未完のままターンを終えると、デザイン参照が無いまま実装フェーズへ流れ、合意済みデザインと無関係な実装PRが作られる状態壊れが起きる（ワーカー側の `onCompleted` はこれを検出して `cc-need-human-check` に落とす）。

ラベル操作はワーカー側が行う。本スキルは `gh issue edit --add-label` / `--remove-label` を実行しない。

## フェーズ0: 事前チェック

- `gh issue view $0 --json number,title,body,state` でIssueが `OPEN` であることを確認する。CLOSEDなら **中断**
- description（`body`）は後続フェーズで丸ごと保持するため、変数に控えておく

**完了条件**: Issue OPEN、現在の description を取得済み。

## フェーズ1: デザインPRとデザイン成果物の特定

### 1-1. デザインPRの特定

```bash
gh pr list --head "cc-ui-design-$0" --state all --json number,url,state,mergedAt
```

`--limit 1` は付けない。同一headブランチに未マージPRとMERGED PRが混在しうるため、まず全件取得したうえで `state == "MERGED"` のものだけを選別する。

- 選別結果が **0件** または **複数件** の場合は **中断** する（0件はマージ待ちや head 不一致、複数件はブランチの再利用・運用ミスの疑いがあり、いずれも自動判断すべきでない）。理由を出力し、ワーカー側での `cc-need-human-check` 付与を促す旨を最終報告に含めて終了する
- 選別結果が1件のみの場合に限り、その `number` と `url` を最終報告と description に使うため保持する

### 1-2. マージされた成果物のパス取得

```bash
gh pr diff <デザインPR番号> --name-only
```

出力から以下を分類する。

- `.pen` ファイル: デザインファイル（通常1件）
- `snapshots/` 配下の `.png`: スナップショット

`.pen` が1件も無い場合は **中断** する（デザインPRとして成立していない）。`.pen` はあっても `snapshots/` 配下に `.png` が1件も無い場合も **中断** する（スナップショット出力前の中途半端なPRを参照元にできないため）。

**完了条件**: デザインPR番号・URL・`.pen` パス・1件以上のスナップショットパスが確定していること。

## フェーズ2: description へのデザイン参照セクションの追記

### 2-1. 追記するセクションの組み立て

以下のフォーマットで組み立てる。パスは必ずフェーズ1-2で取得した実パスに置き換える。

```markdown
## UIデザイン

本Issueの実装は、以下のUIデザインを**参照元**として行うこと。デザインと異なる実装が必要になった場合は、実装を進める前にIssueにコメントで理由を残すこと。

- デザインファイル: `<.pen の実パス>`
- スナップショット: `<snapshots/ 配下の PNG パス。複数あれば列挙>`
- デザインPR: #<デザインPR番号>（マージ済み）

### 実装時の進め方

1. `.pen` は暗号化バイナリのため直接読まない。`inspect-pencil-node` スキルで対象Nodeの構造・スタイルを取得する
2. UIの実装は `frontend-implementer` エージェントに委譲し、上記デザインを参照元として実装する
3. デザイン側の修正が必要になった場合は `.pen` を実装PRで直接編集せず、Issueにコメントを残す
```

### 2-2. ロスト・アップデート対策付きの書き戻し

既存本文は必ず保持する。すでに `## UIデザイン` セクションがある場合は、**重複追記せず置換**する（セクション見出しから、次の同レベル見出し（行頭が `##` で始まる見出し）の直前まで、または自セクションが生成した定型内容（上記2-1のフォーマット）の終端までを差し替える。セクション末尾に人間が追記したコメント等はこの定型内容の外側とみなし、置換対象に含めず保持する）。

固定パスは同一Issueへの並行実行で衝突しうるため `mktemp` で一意な一時ファイルを確保する。さらに、本文の取得（`view`）と書き戻し（`edit`）の間に人間または別プロセスが本文を更新している可能性があるため、`edit` 直前に本文を再取得して差分を検証する。

```bash
BODY_FILE="$(mktemp -t issue-$0-body-XXXXXX.md)"
trap 'rm -f "$BODY_FILE"' EXIT

ORIGINAL_BODY="$(gh issue view $0 --json body --jq .body)"
# 既存の ## UIデザイン セクション（定型内容部分のみ）を除去した本文 + 新しいセクション を BODY_FILE に書き出す
# （既存セクションが無ければ元の本文の末尾に追記する。セクション末尾の人間による追記は保持する）
<組み立て処理>

# edit直前に最新本文を再取得し、無条件の上書き（ロスト・アップデート）を避ける
LATEST_BODY="$(gh issue view $0 --json body --jq .body)"
if [ "$LATEST_BODY" != "$ORIGINAL_BODY" ]; then
  attempt=1
  while [ "$attempt" -le 2 ]; do
    # 最新本文を起点にセクションを組み立て直す（上記の <組み立て処理> をLATEST_BODYに対して再実行）
    ORIGINAL_BODY="$LATEST_BODY"
    <組み立て処理（LATEST_BODY基準）>
    if gh issue edit $0 --body-file "$BODY_FILE"; then
      LATEST_BODY_AFTER="$(gh issue view $0 --json body --jq .body)"
      break
    fi
    LATEST_BODY="$(gh issue view $0 --json body --jq .body)"
    attempt=$((attempt + 1))
  done
  if [ "$attempt" -gt 2 ]; then
    echo "外部変更との競合が2回の再試行後も収束しなかったため更新を断念" >&2
    exit 1
  fi
else
  gh issue edit $0 --body-file "$BODY_FILE"
fi
```

外部変更を検知した場合は、**上書きせず**最新本文を起点に `BODY_FILE` を再構築してから `gh issue edit` を再試行する（最大2回まで）。2回目も `LATEST_BODY` が再取得のたびに変化し続ける等で収束しない場合は、更新を諦め、その旨と理由を最終報告に明記して**失敗として終了**する（ワーカー側の `onCompleted` が検出して `cc-need-human-check` に落とす前提）。

### 2-3. 更新の検証

```bash
gh issue view $0 --json body --jq .body | grep -F '## UIデザイン'
gh issue view $0 --json body --jq .body | grep -F '.pen'
```

両方がヒットしない場合は更新が反映されていない。もう一度だけ 2-2 を試行し、それでも反映されなければ理由を最終報告に含めて終了する（ワーカーの `onCompleted` が検出して `cc-need-human-check` に落とす）。

**完了条件**: description に `## UIデザイン` セクションと `.pen` のパスが含まれていること。既存本文が失われていないこと。

## フェーズ3: 最終報告

以下を1-4行で報告して終了する。

- デザインPR番号とURL
- description に書き戻した `.pen` パス・スナップショットパス
- 既存セクションを置換したか、新規に追記したか
- （該当時）更新できなかった理由

## 中断条件

以下のいずれかに該当する場合のみ、理由を1-2行で出力して即中断する。

- 引数が空、または Issue 番号として解釈できない
- `gh issue view` でIssueが見つからない、または `CLOSED`
- `cc-ui-design-$0` を head とするPRのうち `MERGED` なものが0件、または複数件
- デザインPRの差分に `.pen` が含まれていない
- デザインPRの差分に `snapshots/` 配下の `.png` が含まれていない
- 本文書き戻しの外部変更競合が再試行2回以内に収束しない

## 注意事項

- **既存の description を消さない**: 追記・置換のいずれでも、`## UIデザイン` セクション以外の本文は完全に保持する
- **ラベルを操作しない**: `cc-ui-design-ready` / `cc-exec-issue` の付与はワーカーの責務。本スキルは description の更新のみを行う
- **`.pen` を読まない・編集しない**: パスの取得は `gh pr diff --name-only` で行い、ファイル自体には触れない
- **未完の処理を残したまま完了報告してターンを終えない**: description 未更新のまま終了すると、デザインなしで実装が始まる状態壊れにつながる
- **ユーザーに判断を求めない**: 中断条件以外はすべて本スキル内のルールで自動決定する
