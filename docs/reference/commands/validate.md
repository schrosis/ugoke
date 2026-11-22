# ugoke validate

```text
ugoke validate [options] <workflow>
```

名前で指定したワークフローの定義を検証します。プロジェクトの探し方と名前の対応は、ガイドの「[プロジェクトとワークフローのファイル](../../guide/project.md)」で説明します。

## 引数

| 引数         | 内容                                                       |
| ------------ | ---------------------------------------------------------- |
| `<workflow>` | ワークフローの名前です。たとえば `deploy`、`release/notes` |

## オプション

| オプション     | 内容               |
| -------------- | ------------------ |
| `-h`, `--help` | ヘルプを表示します |

## 出力

定義が正しいときは、標準出力に表示します。

```text
deploy: valid
```

定義に問題があるときは、標準エラーに、問題ごとに 1 行ずつ表示します。形式は `ファイル:行:列 項目のパス: メッセージ` です。YAML の構文のエラーと、アンカーとエイリアスのエラーには、項目のパスが付きません。

```text
.ugoke/workflows/hello.yaml:7:5 steps.hello.foo: Unknown field: foo
.ugoke/workflows/hello.yaml:6:13 YAML anchors are not supported
```

定義の決まりは「[ワークフローの定義](../workflow-definition.md)」にあります。

## 終了ステータス

- `0`: 定義が正しい
- `1`
  - 定義に問題がある
  - 定義が見つからなかった
  - [プロジェクトの設定](../config.md)に問題がある
  - [プラグイン](../plugins.md)を読み込めない
