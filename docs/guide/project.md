# プロジェクトとワークフローのファイル

## プロジェクトの構成

ugoke のファイルは、プロジェクトのルートの `.ugoke` ディレクトリに置きます。

```text
my-project/                 プロジェクトのルート
├── .ugoke/
│   ├── config.yaml         プロジェクトの設定（なくてもよい）
│   ├── schemas/            ugoke schema が作る JSON Schema
│   └── workflows/          ワークフローの定義と、ugoke docs の文書
│       ├── deploy.yaml     ワークフロー deploy
│       └── release/
│           └── notes.yaml  ワークフロー release/notes
└── src/                    プロジェクトのほかのファイル
```

## プロジェクト

ugoke は、コマンドを実行したディレクトリから上へたどり、`.ugoke` ディレクトリのある最も近いディレクトリを、プロジェクトのルートにします。プロジェクトのサブディレクトリで実行しても、同じプロジェクトを使います。

途中のディレクトリにも `.ugoke` があるときは、より近い方をルートにします。どのディレクトリにも `.ugoke` がなければ、次のエラーになります。

```text
No .ugoke directory found in /home/user/scratch or its parents
```

## プロジェクトの設定

`.ugoke/config.yaml` に、プロジェクトの設定を書けます。たとえば、`temporal.address` で、プロジェクトの Temporal Server を指定できます。`plugins` で、ai ステップのプロバイダーなどを足す[プラグイン](../reference/plugins.md)を読み込めます。

```yaml
temporal:
  address: temporal.example.com:7233
```

項目と決まりは、リファレンスの「[プロジェクトの設定](../reference/config.md)」にあります。

## エディターで補完する

`ugoke schema` で、定義と設定の JSON Schema を `.ugoke/schemas` に作れます。各ファイルの一番上に `$schema` を書くと、エディターが項目を補完します。

```yaml
$schema: ../schemas/workflow.schema.json
version: v0.1
```

JSON Schema には、プロジェクトのプラグインの分も入ります。プラグインを変えたら、もう一度 `ugoke schema` を実行します。詳しくは、「[ugoke schema](../reference/commands/schema.md)」にあります。

## ワークフローの名前とファイル

ワークフローは、名前で指定します。名前が `deploy` のワークフローは、`.ugoke/workflows/deploy.yaml` か `.ugoke/workflows/deploy.yml` に定義します。`/` で区切った名前は、サブディレクトリの定義を指します。たとえば `release/notes` は、`.ugoke/workflows/release/notes.yaml` です。

名前の `/` で区切った各部分は、英字で始め、英字、数字、`_`、`-` だけで書きます。決まりに合わない名前は、プロジェクトを探す前にエラーになります。

```text
Invalid workflow name: ../deploy. Use letters, digits, _, and -, separated by /
```

同じ名前の `.yaml` と `.yml` の両方があるときと、どちらもないときは、エラーになります。

```text
Workflow deploy has both .yaml and .yml files
Workflow not found: deploy
```

## ワークフローを確かめる

定義を書いたら、`ugoke validate` で確かめられます。書き方は「[ワークフローの定義](workflow-definition.md)」で、コマンドの詳細は「[ugoke validate](../reference/commands/validate.md)」で説明します。実行するときは「[ワークフローを実行する](run.md)」を読んでください。
