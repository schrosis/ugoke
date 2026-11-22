# ugoke schema

```text
ugoke schema [options]
```

ワークフローの定義と[プロジェクトの設定](../config.md)の JSON Schema を、`.ugoke/schemas` に作ります。エディターは、この JSON Schema で、項目の補完や間違いの表示をします。

## オプション

| オプション     | 内容               |
| -------------- | ------------------ |
| `-h`, `--help` | ヘルプを表示します |

## 作るファイル

| ファイル                              | 内容                     |
| ------------------------------------- | ------------------------ |
| `.ugoke/schemas/workflow.schema.json` | ワークフローの定義の形   |
| `.ugoke/schemas/config.schema.json`   | プロジェクトの設定の形   |

## 使う

各ファイルの一番上に、`$schema` で JSON Schema を書きます。パスは、そのファイルからの相対パスです。

```yaml
# .ugoke/workflows/deploy.yaml
$schema: ../schemas/workflow.schema.json
version: v0.1
```

```yaml
# .ugoke/config.yaml
$schema: ./schemas/config.schema.json
plugins:
  "@ugoke/adapter-ai-claude-code":
```

`$schema` は、ugoke の動きを変えません。

## 動き

- プロジェクトが読み込む[プラグイン](../plugins.md)の分も含めます。たとえば、`provider` には、使えるプロバイダーの名前だけを書けます。`with` は、そのプロバイダーの形に従います
- JSON Schema でわかるのは、項目の形だけです。ステップのつながりや式の参照は、`ugoke validate` で確かめます
- プラグインや、その設定を変えたら、もう一度実行します
- すでにあるファイルは、毎回書き直します。手で直したところは消えます

## 終了ステータス

- `0`: ファイルを作った
- `1`
  - プロジェクトが見つからなかった
  - [プロジェクトの設定](../config.md)に問題がある
  - [プラグイン](../plugins.md)を読み込めない
  - ファイルを書けなかった
