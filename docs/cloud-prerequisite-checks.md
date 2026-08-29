# クラウド実行の前提条件チェックの実測結果

`docs/prd-cloud-worker-execution.md` 4.5 が「ローカルから静的に検査する手段が無い（または未確認）」と分類した3項目 — 1（claude.ai サインイン）/ 2（GitHub 連携）/ 4（`allow_remote_sessions` 組織ポリシー） — について、判定手段の有無を実測で確定させた記録（Issue #225、PRD 9-1 に対応）。判定の実装は #234（`assertCloudAvailable()`）が担う。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)`
- 実行パス: `~/.local/share/claude/versions/2.1.247`
- OS: macOS (darwin 25.6.0)
- 実測アカウント: claude.ai サインイン済み（`subscriptionType: max`、個人組織）。**組織ポリシーによる制限が一切かかっていない環境**
- TTY が必要な実行は `script -q /dev/null <cmd> </dev/null` で pty を割り当てて実施
- 後続Issueが失効判定できるよう、`claude --version` がここより新しい場合は再実測すること

## 結論: 確定リスト

| # | 前提条件 | ローカル静的判定 | 4.5 での扱い |
|---|---------|----------------|-------------|
| 1 | claude.ai サインイン / 第三者プロバイダ構成 | **可能**（`claude auth status --json` + `ANTHROPIC_BASE_URL` の自前確認） | **起動時エラー** |
| 2 | GitHub 連携 | 不可（非公開 API 経由のみ。CLI 表層に無い） | 案内のみ |
| 3 | リポジトリへのプラグイン宣言 | ~~可能（本Issueのスコープ外。#239 が担当）~~ **撤去した**（Issue #268）。クラウドセッションが `.claude/settings.json` の宣言を読んで自動的にプラグインを有効化するという前提が事実でなかったため、静的検査ごと撤去。代わりに claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載する方式へ置き換え、静的検査は行わない | 案内のみ（静的検査なし） |
| 4 | `allow_remote_sessions` 組織ポリシー | 不可（ディスクキャッシュが生成されない。cache_miss と org_denied を区別できない） | 案内のみ |

PRD 4.5 の「1・2・4 はいずれも静的検査手段が無い」という記述のうち、**1 は誤り**（`claude auth status --json` で判定できる）。あわせて 4.5-2 の「未設定だとセッション作成が clone で失敗する」も **2.1.247 では不正確**（後述）。

## 前提条件1: サインイン / 第三者プロバイダ — 静的判定できる

`claude auth status --json` が構成ごとに異なる JSON を終了コード付きで返す。`--json` は既定（`--text` で人間可読形式）。

| 構成 | `loggedIn` | `authMethod` | `apiProvider` | 補助フィールド | exit |
|------|-----------|--------------|---------------|--------------|------|
| claude.ai サインイン（Max） | `true` | `claude.ai` | `firstParty` | `email` / `orgId` / `orgName` / `subscriptionType` が非 null | 0 |
| `ANTHROPIC_API_KEY` 設定 | `true` | **`claude.ai`** | `firstParty` | `apiKeySource: "ANTHROPIC_API_KEY"` が出現。`email` / `orgId` / `orgName` / `subscriptionType` が **null** | 0 |
| `ANTHROPIC_AUTH_TOKEN` 設定 | `true` | `oauth_token` | `firstParty` | `email` 等のキー自体が無い | 0 |
| `CLAUDE_CODE_USE_BEDROCK=1` | `true` | `third_party` | `bedrock` | `analyticsDisabled: true` | 0 |
| `CLAUDE_CODE_USE_VERTEX=1` | `true` | `third_party` | `vertex` | `analyticsDisabled: true` | 0 |
| 未ログイン（空の `CLAUDE_CONFIG_DIR`） | `false` | `none` | `firstParty` | — | **1** |
| `ANTHROPIC_BASE_URL` 設定 | `true` | `claude.ai` | `firstParty` | 通常のサインインと**完全に同一** | 0 |

### 判定式

```
loggedIn === true
  && apiProvider === "firstParty"
  && authMethod === "claude.ai"
  && apiKeySource が存在しない
  && process.env.ANTHROPIC_BASE_URL が未設定
```

**`authMethod` だけを見てはいけない**。`ANTHROPIC_API_KEY` を設定した状態でも `authMethod` は `"claude.ai"` を返す（API キーは既存のサインインを上書きする形で効く）。API キー構成の判別は `apiKeySource` の有無、または `subscriptionType` が null であることで行う。

**`ANTHROPIC_BASE_URL` は `claude auth status` の出力に一切現れない**。CLI 内部のクラウド可否判定（`getPolicyLimitsIneligibleReason`）は custom base URL を非適格理由として扱うため、ワーカー側で環境変数を直接見る必要がある。

### 対応するエラー文言（実測）

Bedrock / Vertex 構成では、**クラウドセッションが作成される前に**拒否される（副作用なし）。

```
Error: Cloud sessions aren't available with Amazon Bedrock. They run on
Anthropic's infrastructure and require an Anthropic account.
```

```
Error: Cloud sessions aren't available with Google Vertex AI. They run on
Anthropic's infrastructure and require an Anthropic account.
```

API キー認証・未ログインに対応する CLI 内部の文言（バイナリ由来、後述の測定ログ M4 参照）:

```
Claude Code web sessions require authentication with a Claude.ai account.
API key authentication is not sufficient. Please run /login to authenticate,
or check your authentication status with ...
```

```
Cloud sessions are only available on the first-party Anthropic API provider.
```

## 前提条件2: GitHub 連携 — 判定できない

CLI 内部には連携状態の取得経路があるが、**ネットワーク API 呼び出しであり、CLI のサブコマンドとしては露出していない**。

- エンドポイント: `GET /api/oauth/organizations/:orgUUID/sync/github/auth`（内部認証スコープ `teleport-org`）
- レスポンス: `is_authenticated`（boolean）/ `auth_source`（`"oauth"` = Claude GitHub App の認可 / `"cli_import"` = `/web-setup` による `gh` トークン同期）
- 内部関数は結果を `"connected"` / `"not_connected"` / `"unknown"`（リクエスト失敗時）の3値へ丸める
- `claude --help` のサブコマンド一覧（`auth` / `doctor` / `mcp` / `plugin` / `project` / `setup-token` 等）にこれを出すものは無い。`claude auth status --json` の出力にも含まれない

ワーカーが同じ API を自前で叩くには CLI の OAuth 資格情報（キーチェーン格納）を取り出す必要があり、非公開 API への依存になるため採用しない。**案内のみ**とする。

### 判定できない代わりに得られた重要な事実

**GitHub 未連携でもクラウドセッションの作成自体は成功する**。`docs/cloud-session-launch-flags.md` の T5〜T7 / T11 で、GitHub App 未設定のリポジトリからセッションが作成され、以下が出力されている:

```
This checkout is a linked working tree, a submodule or a checkout with a
separate git directory; the new upload path does not support that yet, so the
working tree is being uploaded the previous way for this session.
```

つまり GitHub App 未設定時は、リモートを clone するのではなく**ローカル作業ツリーがアップロードされてシードされる**。PRD 4.5-2 の「未設定だとセッション作成が clone で失敗する」は 2.1.247 では成立しない。

失敗するのは `--ref` / `--on-branch` を付けた場合に限られる（`docs/cloud-session-launch-flags.md` T9 / T10）:

```
Error: --ref <branch> cannot be honored: the GitHub App is not set up for this
repository, so the session would be seeded from your local working tree
instead. Set up the GitHub integration at https://claude.ai/code, or drop
--ref to seed from local HEAD.
```

**訂正（2026-08-29）**: 上記の文言は「GitHub 連携が実際に未設定だから」ではなく、Claude Code 側のバグ（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)、2026-08-29 時点 OPEN）による誤判定でも表示されることが判明している。GitHub App 連携済みのリポジトリ（public / private とも）でも同じ文言で拒否されうる。**回避策**は環境変数 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与すること。smoke test（claude 2.1.250、2026-08-29、public / private 双方）で `--ref` / `--on-branch` ともセッション作成に成功することを確認済み。

したがって、このエラーに遭遇した場合の案内は「GitHub 連携をセットアップする」だけでなく、まず回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` の付与で解消するかを確認する順にすべきである。ワーカーは Issue 系タスクで `--ref`、PR 系タスクで `--on-branch` を付ける想定（PRD 4.2）なので、この文言はタスク実行時に顕在化しうる。

なお `docs/cloud-session-launch-flags.md`（Issue #224 の追記）が実測した「GitHub App 未設定のクラウドセッションには git remote が無く、成果物を GitHub へ push できない」という記述も、同じ誤判定チェックの影響を受けている可能性があり、連携済み環境（かつ回避策適用後）での再実測が必要である。再実測が済むまでは、案内では単なる警告ではなく実質的なブロッカーとして扱っておく。

## 前提条件4: `allow_remote_sessions` — 判定できない

CLI はポリシー取得結果をディスクにキャッシュする実装を持つが、**そのファイルが実際には生成されず、不在時の意味も一意に定まらない**。

- キャッシュファイル名: `policy-limits.json`（設定ディレクトリ直下。`remote-settings.json` / `mcp-needs-auth-cache.json` と同列に登録されている）
- スキーマ: `{ restrictions: { <policy名>: { allowed: boolean } }, compliance_taints: string[], monitoring_notice, defaults }`
- **実測環境では `~/.claude/policy-limits.json` が存在しない**。`claude auth status` の実行でも、`claude -p` セッションを1本走らせた後でも生成されなかった

CLI 内部の判定ロジック（`isPolicyAllowed`）は、キャッシュ不在時に次のように振る舞う:

```js
// 疑似コード（バイナリから復元）
function isPolicyAllowed(name) {
  const restrictions = getResponseFromCache()?.restrictions ?? null;
  if (!restrictions) {                    // キャッシュ不在
    if (DEFAULT_DENY_SET.has(name)) {     // allow_remote_sessions はこの集合に含まれる
      if (isPolicyLimitsEligible()) return false;   // 適格アカウントでは拒否
      ...
    }
    return true;
  }
  return restrictions[name]?.allowed ?? /* compliance_taints 判定 */ true;
}
```

拒否理由は `cache_miss` と `org_denied` の2種に分かれ、文言も別になる:

```
Couldn't verify your organization's policy for cloud sessions.
Check your network connection and try again.
```

```
Cloud sessions are disabled by your organization's policy.
Contact your organization admin to enable them.
```

ワーカーがキャッシュを読んで同じ判定を再現しようとすると、次の2点で成立しない:

1. **ファイルが生成されないため、常に cache_miss になる**。cache_miss を拒否として扱えば、ポリシー制限が一切ない本実測環境（実際にセッション作成に成功している）でもワーカーが起動しなくなる
2. **ファイルが存在する場合も鮮度を保証できない**。CLI 側はセッション内メモリキャッシュを優先し、ディスクへの書き戻し契機がワーカーから制御できない

したがって **案内のみ**とする。組織ポリシーによる拒否の実環境再現は、自組織のポリシーを実際に無効化する必要があるため実施していない（上記文言はバイナリ由来）。

## 案内メッセージの文面案

`assertCloudAvailable()`（#234）で使う。1 は起動時エラー、2・4 はタスク失敗時の Slack 通知・ログへの追記を想定する。

### 1（起動時エラー / 静的判定）

> クラウド実行（`--cloud` フラグ）には claude.ai アカウントでのサインインが必要です。現在の認証構成: `<authMethod>` / `<apiProvider>`。
> - 第三者プロバイダ（Bedrock / Vertex）を使っている場合: クラウドセッションは Anthropic のインフラ上で動くため利用できません。`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` を解除するか、`--cloud` フラグを外してください。
> - API キー認証（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）の場合: API キーではクラウドセッションを作成できません。環境変数を解除して `claude auth login` でサインインしてください。
> - 未サインインの場合: `claude auth login` を実行してください。
> - `ANTHROPIC_BASE_URL` を設定している場合: カスタムエンドポイント構成ではクラウドセッションを利用できません。解除してください。

### 2（タスク失敗時の案内）

> クラウドセッションの作成が `--ref` / `--on-branch` のエラー（`the GitHub App is not set up for this repository, ...`）で失敗した可能性があります。**まず環境変数 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与して再実行してください** — この文言は GitHub 連携済みのリポジトリでも Claude Code 側のバグ（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)）により表示されることがあり、同変数で回避できることを確認しています。
> それでも解消しない場合は、https://claude.ai/code で対象リポジトリの GitHub 連携をセットアップしてください。GitHub App の認可、または `/web-setup` による `gh` トークンの同期のどちらでも構いません。
> ローカルからは連携状態を確認する手段がないため、事前チェックは行っていません。

### 4（タスク失敗時の案内）

> クラウドセッションの作成が組織ポリシー（`allow_remote_sessions`）で拒否された可能性があります。組織の管理者にクラウドセッションの有効化を依頼してください。
> `Couldn't verify your organization's policy` と表示された場合はポリシーの取得自体に失敗しています（ネットワークを確認してください）。ローカルからはポリシーを照会する手段がないため、事前チェックは行っていません。

## 測定ログ（要旨）

- **M1** `claude auth status --json`（通常のサインイン）→ exit=0: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,"email":"<redacted>","orgId":"<redacted>","orgName":"<redacted>","subscriptionType":"max"}`
- **M2** 環境変数による構成差分（いずれも exit=0）:
  - `ANTHROPIC_API_KEY=<dummy>` → `apiKeySource: "ANTHROPIC_API_KEY"` が出現、`email`/`orgId`/`orgName`/`subscriptionType` は `null`、`authMethod` は `"claude.ai"` のまま
  - `ANTHROPIC_AUTH_TOKEN=dummy` → `authMethod: "oauth_token"`
  - `CLAUDE_CODE_USE_BEDROCK=1` → `authMethod: "third_party"` / `apiProvider: "bedrock"` / `analyticsDisabled: true`
  - `CLAUDE_CODE_USE_VERTEX=1` → 上と同一で `apiProvider` のみ `"vertex"`
  - `ANTHROPIC_BASE_URL=https://example.invalid` → **M1と完全に同一の出力**（検出不可）
- **M3** 未ログイン状態（空の `CLAUDE_CONFIG_DIR`）: `CLAUDE_CONFIG_DIR=$(mktemp -d) claude auth status --json` → **exit=1**、`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false}`。`--text` 形式は `Not logged in. Run claude auth login to authenticate.`。副作用: 指定した空ディレクトリに `.claude.json` 等が生成される（実測後に削除済み、実ホームの設定は不変）
- **M4** 第三者プロバイダでの `--cloud`（pty）、いずれもセッション未作成:
  - `CLAUDE_CODE_USE_BEDROCK=1 claude --cloud "<desc>"` → `Error: Cloud sessions aren't available with Amazon Bedrock. They run on Anthropic's infrastructure and require an Anthropic account.`
  - `CLAUDE_CODE_USE_VERTEX=1 claude --cloud "<desc>"` → 同文言で Bedrock→Google Vertex AI に置換
  - `--cloud` の TTY チェックより後、セッション作成（ネットワーク）より前で拒否される
- **M5** ポリシーキャッシュの生成有無: `ls ~/.claude/policy-limits.json` は当初・`claude auth status` 実行後・`claude -p` セッション1本完了後のいずれでも `No such file or directory`（生成されない）

## 未実測項目

1. **API キー認証での `--cloud` の実エラー文言**
   - 理由: `ANTHROPIC_API_KEY` を設定して pty から `--cloud` を実行したところ、Bedrock / Vertex のような即時拒否にならず TUI が起動したまま2分のタイムアウトに達した。セッションが作成されたかどうかは確認できていない（クラウドセッションを一覧するローカルコマンドが無いため）
   - 影響: 上記の文言（`Claude Code web sessions require authentication with a Claude.ai account. ...`）はバイナリ由来であり、実際にこの経路で表示されるかは未確認。**前提条件1の判定自体は M2 の `apiKeySource` で成立する**ため、案内文言の精度の問題に留まる
   - 再現手順: claude.ai サインイン済みの状態で `ANTHROPIC_API_KEY=<有効なキー> claude --cloud "<desc>"` を pty から実行し、TUI の初期表示とエラーを確認する
2. **組織ポリシーで `allow_remote_sessions` が拒否される環境での実文言と `policy-limits.json` の実体**
   - 理由: 実測アカウントの組織にポリシー制限がかかっておらず、自組織で無効化するのは破壊的なため実施しなかった
   - 再現手順: ポリシー制限のある組織アカウントで `claude --cloud "<desc>"` を実行し、エラー文言と `~/.claude/policy-limits.json` の有無・内容を確認する
3. **`--ref` / `--on-branch` のブランチ名検証以降の挙動（回避策適用後）**
   - `docs/cloud-session-launch-flags.md` の未実測項目1と同一。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` の適用でセッション作成には成功することは smoke test で確認済み（2026-08-29）だが、本Issueの範囲では解消していない
