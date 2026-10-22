# 外部リンクの取得手段（MCP 優先）

Issue・コメント・ドキュメントに現れる外部リンクを読むときの、取得手段の選び方。`answer-issue-questions` / `create-issue` / `create-issue-from-issue-number` / `update-issue` / `read-github-issue` / `explore-agent` が参照する。

## 原則: そのサービスの MCP があれば MCP で読む。`WebFetch` は最後の手段

`WebFetch` は認証を持たない匿名アクセスなので、ログインが必要なサービス（Notion / Google Drive / Figma / Slack / Linear / Jira / Confluence / Sentry など）のURLを開いても**ログイン画面しか返らない**。これを「認証が必要で取得不可」と報告すると、セッションに繋がっている MCP なら読めた一次資料を、人への確認事項として差し戻すことになる。

1. **URL のホストからサービスを特定する**（例: `notion.so` / `app.notion.com` / `*.notion.site` → Notion、`docs.google.com` / `drive.google.com` → Google Drive、`figma.com` → Figma、`*.slack.com` → Slack）
2. **そのサービスの MCP ツールを探す**。ツール一覧に無くても、遅延ロードのツールとして名前だけ載っていることがあるので `ToolSearch` でサービス名を検索してから判断する。ツール名の接頭辞は実行環境で変わる（例: ローカルの `mcp__claude_ai_Notion__*` とクラウドの `mcp__Notion__*`）ため、特定の接頭辞を決め打ちしない
3. **MCP があればそれで読む**。本文だけでなく、MCP で取れるコメント・添付・子ページ・プロパティなど、判断に効く部分まで読む
4. **どの MCP も扱わない公開Webページ**（仕様書・記事を含む）だけ `WebFetch` で読む。ライブラリの公式ドキュメントは `check-library` スキル（または context7 MCP）、GitHub の URL は `github-access.md` の対応表を使う

## 取得に失敗したとき

- `WebFetch` がログイン画面・401・403 を返したら、それは「取得不可」の根拠にならない。まず上記2で対応する MCP を探し、見つかれば MCP で読み直す
- MCP でも読めない場合や 404・タイムアウトは1回だけ再試行する。それでも読めない場合、または対応する MCP が無く `WebFetch` でも読めない場合だけ「`<URL>` は取得不可（理由）」と明記する。理由には**試した手段**を書く（例: 「Notion MCP 未接続のため `WebFetch` を試し、ログイン画面が返った」）。手段が書いてあれば、読む側は「MCP を繋げば読める」のか「権限が無い」のかを区別できる
- 前回の実行が「取得不可」と書いていても、それを引き写さず今回の実行で取得し直す（前回は MCP が無かっただけかもしれない）
