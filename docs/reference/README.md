# リファレンス

ugoke のコマンドとファイルの形式を、項目ごとに引けるようにまとめます。順に読んで使い方を知るには、[ガイド](../guide/)を読んでください。

## コマンド

| コマンド                                 | 内容                                       |
| ---------------------------------------- | ------------------------------------------ |
| [`ugoke`](commands/ugoke.md)             | 全体のオプションと終了ステータス           |
| [`ugoke init`](commands/init.md)         | プロジェクトを作る                         |
| [`ugoke run`](commands/run.md)           | ワークフローを実行する                     |
| [`ugoke validate`](commands/validate.md) | ワークフローの定義を検証する               |
| [`ugoke docs`](commands/docs.md)         | ワークフローのつながりを図にした文書を作る |
| [`ugoke schema`](commands/schema.md)     | エディターのための JSON Schema を作る      |
| [`ugoke attach`](commands/attach.md)     | 実行に戻って追いかける                     |
| [`ugoke cancel`](commands/cancel.md)     | 実行を取り消す                             |
| [`ugoke inbox`](commands/inbox.md)       | 答えを待っているステップを一覧にして答える |
| [`ugoke daemon`](commands/daemon.md)     | 常駐プロセスを起動、停止し、状態を表示する |

## ファイルの形式

| ファイル                                             | 内容                     |
| ---------------------------------------------------- | ------------------------ |
| [ワークフローの定義](workflow-definition.md)         | 定義の項目と決まり       |
| [プロジェクトの設定](config.md)                      | `.ugoke/config.yaml` の項目と決まり |
| [プラグイン](plugins.md)                             | プラグインの使い方と決まり |

## プログラムから使う

AI エージェントなどのプログラムからコマンドを動かすときの出力は、「[プログラムから使う](from-ai.md)」にあります。

## AI のプロバイダー

[ai ステップ](workflow-definition.md#ai-ステップ)を実行するプロバイダーです。

| プロバイダー                                  | 内容                           |
| --------------------------------------------- | ------------------------------ |
| [`claude-code`](providers/claude-code.md)     | Claude Code で実行する         |

## 仕組み

ugoke がワークフローをどのように実行するかは、「[アーキテクチャ](../explanation/architecture.md)」で説明します。
