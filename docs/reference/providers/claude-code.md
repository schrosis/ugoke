# claude-code

[ai ステップ](../workflow-definition.md#ai-ステップ)を、Claude Code で実行するプロバイダーです。`provider: claude-code` と書いて使います。

## 使う準備

`@ugoke/adapter-ai-claude-code` のパッケージをプロジェクトに置き、[プロジェクトの設定](../config.md)の `plugins` に書きます。ugoke の隣にあれば、プロジェクトに置かなくても使えます（「[プラグイン](../plugins.md)」）。

```yaml
plugins:
  "@ugoke/adapter-ai-claude-code":
```

書かないと、`provider: claude-code` は定義のエラーになります。

## 例

```yaml
review:
  type: ai
  provider: claude-code
  prompt: Review the changes in this repository and summarize the problems.
  with:
    allowedTools: [Read, Grep, Glob]
    maxBudgetUsd: 1
  next: end
```

## with

| 項目           | 必須   | 内容                                                                                   |
| -------------- | ------ | -------------------------------------------------------------------------------------- |
| `allowedTools` | いいえ | AI に使わせるツールの一覧です。Claude Code の許可のルールの形で書きます。たとえば `Read`、`Bash(git diff:*)` |
| `maxBudgetUsd` | いいえ | 使ってよい費用の上限です。米ドルで、正の数で書きます                                   |

ほかの項目は書けません。

## 動き

- Claude Code は、プロジェクトのルートで動きます。Claude Code の設定ファイル（`~/.claude/settings.json`、プロジェクトの `.claude/settings.json` と `.claude/settings.local.json`）と `CLAUDE.md` を読みます
- 許可が要るツールは、`allowedTools` か Claude Code の設定で許していなければ、使おうとしても断ります。ステップのあいだは誰も答えられないため、許すかどうかを聞きません
- `.ugoke` の中のファイルは、ファイルを編集するツールでは編集させません。動いているワークフローの定義が変わらないようにするためです。`allowedTools` で `Bash` を許すと、コマンドでは変えられます
- `model` を書けば、そのモデルを使います。書かなければ、Claude Code が選びます
- `schema` を書けば、その形の結果を返させます。書かなければ、最後の返事のテキストが結果です
- `session` が `reuse` のステップがもう一度動くときは、前の会話を続けます
- Claude Code が失敗したときと、結果を返さずに終わったときは、ステップは失敗します。`maxBudgetUsd` を超えたときも同じです
- `schema` を書いたのに、その形の結果を返さずに終わったときも、ステップは失敗します
