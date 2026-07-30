---
name: agent-browser
description: agent-browser CLI（`agent-browser` コマンド）でブラウザを操作するスキル。Webページを開く・スクリーンショットを撮る・要素をクリック/入力する・フォームを埋める・DOMやコンソールログ/ネットワーク通信を確認する・ログインが必要な画面を確認する・実装したUIのレンダリング結果を視覚的に検証する、といったブラウザ操作全般で必ずこのスキルを使う。「画面を開いて確認して」「スクリーンショットを撮って」「この画面の表示崩れを調べて」「ログイン後の画面を見て」「E2E的に操作して確かめて」などの依頼で発動する。claude-in-chrome MCP（`mcp__claude-in-chrome__*`）や `WebFetch` でのページ取得ではなく、本スキル経由の agent-browser を使うこと。
---

# agent-browser

ブラウザ操作は agent-browser CLI で行う。Chrome/Chromium を CDP 経由で操作し、アクセシビリティツリーのスナップショットと `@eN` 形式の要素refで、生HTMLを読むより桁違いに少ないトークンでページを扱える。

公式ドキュメント: [agent-browser.dev](https://agent-browser.dev/)

# 最初に必ずやること: `skills get core` で使い方をロードする

**このファイルは発見用のスタブであり、使い方の本体ではない**。`agent-browser` のコマンドを1つでも実行する前に、CLI から実際の手順を読み込む:

```bash
agent-browser skills get core          # ワークフロー・よく使うパターン・トラブルシューティング
agent-browser skills get core --full   # 全コマンドリファレンスとテンプレートも含める
```

CLI が**インストール済みバージョンと一致する**手順を返すため、この内容は古くならない。逆にこのスタブへコマンド仕様を書き写すとバージョン更新で嘘になるので、ここには書かない（フラグの綴りを推測で組み立てるのも禁止。必ず `skills get core --full` か `agent-browser --help` で確認する）。

対象がWebページ以外の場合は専用スキルをロードする:

```bash
agent-browser skills get electron       # Electronデスクトップアプリ（VS Code, Slack, Figma 等）
agent-browser skills get slack          # Slackワークスペース操作
agent-browser skills get dogfood        # 探索的テスト・QA・バグ探し
agent-browser skills list               # 利用可能な全スキル
```

# このプロジェクトでの実行ルール

## 1. 既定は `--auto-connect`（起動中のChromeに接続してログイン状態を再利用する）

`--auto-connect` は**サブコマンドの前**に置くグローバルフラグで、起動中の Chrome を自動検出して接続し、その Cookie / localStorage / ログイン状態をそのまま使う:

```bash
agent-browser --auto-connect open http://localhost:3000
agent-browser --auto-connect snapshot -i
agent-browser --auto-connect screenshot ./tmp/dashboard.png
```

ローカル開発の画面確認や、認証が必要な画面の確認は原則この形にする。ログインし直す手間が要らず、ユーザーが手元で見ているのと同じ状態を確認できる。

## 2. `--auto-connect` 中は `close` を実行しない

`--auto-connect` の接続先は**ユーザー自身が使っている Chrome** であり、`agent-browser close` / `close --all` はそのブラウザ・タブを閉じてしまう（ユーザーの作業中タブを閉じる破壊的操作になる）。接続して確認したあとは何も閉じずに終了する。

自分で起動したブラウザ（`--auto-connect` なしのセッション）に限り、作業後に `agent-browser close` で片付ける。

## 3. `--auto-connect` が失敗したら独立セッションへフォールバックする

起動中の Chrome が無い、またはリモートデバッグが有効でない環境では `--auto-connect` は失敗する。その場合は `--auto-connect` を外して agent-browser 自身にブラウザを起動させる（既定はheadless。描画を目で見る必要があるときは `--headed`）:

```bash
agent-browser open http://localhost:3000
agent-browser snapshot -i
agent-browser screenshot ./tmp/dashboard.png
agent-browser close
```

認証が必要な画面をこの独立セッションで扱う場合は、`--auto-connect state save` で認証状態を書き出し `--state` で読み込む（手順は `skills get core --full` の認証セクション参照）。

## 4. refはスナップショットごとに振り直される

`@e1` / `@e2` は `snapshot` を撮った時点のページに対する参照で、**ページが変化した瞬間に無効になる**（遷移するクリック、フォーム送信、動的な再描画、ダイアログの開閉など）。ref を使う操作の前には必ず `snapshot -i` を撮り直す。

## 5. スクリーンショット・成果物の保存先

worktree 内（`.claude/worktrees/<id>` 配下）で作業している場合は、出力パスが必ずその worktree 内を指すようにする。`pwd` で確認してから相対パスを組む。ファイル名にはタイムスタンプを含め、繰り返し撮影で上書きしない。

## 6. モーダルダイアログに注意する

`alert` / `confirm` を出すボタン（削除系など）は、必要が無ければ押さない。押す必要がある場合はダイアログの扱いを `skills get core --full` で確認してから操作する。

## 7. 深追いしない

同じ操作が2〜3回失敗する、ページが応答しない、想定外の複雑さに突き当たった場合は、リトライを繰り返さず、試したコマンドと出力（エラー行）を添えて状況を報告する。自動起動セッションではユーザーに問い返せないため、確認できたところまでを事実として報告し、残課題を明記して終了する。

# 未インストールの場合

`agent-browser` コマンドが無い場合は、リポジトリでの導入手順に従う:

```bash
claude-task-worker install   # CLI導入とブラウザバイナリ取得を一括で行う
```

手動で入れる場合は `npm install -g agent-browser && agent-browser install`。導入できない環境では、ブラウザ操作を伴う検証は行わず「agent-browser 利用不可」を実行コマンドとエラー出力つきで報告して終了する（呼び出し元が後処理を判断する）。
