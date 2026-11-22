# プロジェクトの設定

プロジェクトの設定は、`.ugoke/config.yaml` に書きます。`.ugoke/config.yml` でも構いません。

```yaml
temporal:
  address: temporal.example.com:7233
```

## 項目

| 項目               | 必須   | 内容                                                                                                       |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| `$schema`          | いいえ | エディターが使う JSON Schema のパスです。ugoke の動きは変えません。[ugoke schema](commands/schema.md)を見てください |
| `temporal.address` | いいえ | プロジェクトの Temporal Server のアドレスです。書かなければ、常駐プロセスのサーバーを使います |
| `plugins`          | いいえ | 読み込むプラグインです。パッケージの名前と、その設定の組で書きます。[プラグイン](plugins.md)を見てください |

使う Temporal Server の決め方は、「[ugoke run](commands/run.md#使う-temporal-server)」にあります。

## 決まり

- ファイルがなければ、設定はありません。空のファイルも同じです
- `config.yaml` と `config.yml` の両方があると、エラーになります
- 書き方の制限は、[ワークフローの定義](workflow-definition.md#yaml-の書き方の制限)と同じです。知らない項目もエラーになります
- `temporal.address` は、空の文字列にできません
- コマンドを実行するたびに読み直します。常駐プロセスも、プロジェクトの頼みを受けるたびに読み直します。変えたあとに、常駐プロセスを起動し直す必要はありません
- ファイルに問題があると、ワークフローを扱うコマンドは、エラーを表示して 1 で終わります。たとえば、`ugoke validate`、`ugoke run`、`ugoke attach` です。`--address` を指定しても同じです
