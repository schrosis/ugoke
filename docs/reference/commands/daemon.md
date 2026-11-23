# ugoke daemon

```text
ugoke daemon start [options]
ugoke daemon stop
ugoke daemon status
```

常駐プロセスを起動、停止し、その状態を表示します。常駐プロセスは、ホストに 1 つだけ動き、Temporal Server を起動して、登録したプロジェクトのステップを実行します。仕組みは「[アーキテクチャ](../../explanation/architecture.md)」で説明します。

## ugoke daemon start

常駐プロセスをバックグラウンドで起動します。

| オプション              | 内容                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `--address <address>`   | 開発サーバーを起動せずに、このアドレスの Temporal Server を使います                               |
| `-h`, `--help`          | ヘルプを表示します                                                                                 |

- `--address` を指定しなければ、開発サーバーを起動します。開発サーバーは実行の記録を残すので、常駐プロセスを止めても、記録は消えません
- すでに動いていれば、新しく起動せずに終わります。動いている常駐プロセスと ugoke のバージョンやサーバーのオプションが違うときは、そのことを表示します。変えるときは、`ugoke daemon stop` で止めてから起動し直します
- script ステップと ai ステップは、常駐プロセスを起動したときの環境変数を引き継ぎます

## ugoke daemon stop

常駐プロセスを止めます。常駐プロセスは、実行中のスクリプトや AI ステップが終わるのを待ってから止まります。SIGTERM か SIGINT を受けたときも、同じように止まります。

## ugoke daemon status

常駐プロセスのプロセス ID、サーバー、ugoke のバージョン、起動した時刻、ログのファイル、登録したプロジェクトを表示します。

## Temporal CLI

開発サーバーは、ugoke が決めたバージョンの Temporal CLI で起動します。キャッシュになければ、ダウンロードします。キャッシュは `$XDG_CACHE_HOME/ugoke/temporal-cli` で、`XDG_CACHE_HOME` がなければ `~/.cache/ugoke/temporal-cli` です。`--address` を指定したときは、Temporal CLI を使いません。

> [!NOTE]
> Windows では、Temporal CLI をダウンロードしません。`ugoke daemon start --address` で、用意した Temporal Server を指定してください。

## プロジェクトの登録

`--address` を指定しない `ugoke run`、`ugoke attach`、`ugoke cancel` は、そのプロジェクトを常駐プロセスに登録します。常駐プロセスは、プロジェクトごとに Worker を動かし、ステップを実行します。`.ugoke` のないプロジェクトは登録できず、コマンドは 1 で終わります。登録したプロジェクトは、常駐プロセスを起動し直しても覚えています。`.ugoke` がなくなったプロジェクトは、起動し直したときに外します。Worker を起動できなかったときも、コマンドは 1 で終わります。登録は残し、次に登録するときに起動し直します。

常駐プロセスは、[信頼の記録](../trust.md#常駐プロセス)を見ません。登録したプロジェクトを、そのまま動かします。

各プロジェクトの Worker は、プロジェクトの `temporal.address` のサーバーで動きます。`temporal.address` がなければ、常駐プロセスのサーバーで動きます。

- 常駐プロセスは、登録を受けるたびに、プロジェクトの設定を読み直します
- `temporal.address` を変えると、新しいサーバーで Worker を動かします
- 前のサーバーの Worker は、常駐プロセスが止まるまで、そのサーバーの実行を受け持ちます
- 前に使ったサーバーに戻すと、そのサーバーの Worker をまた使います
- `plugins` か、プラグインの設定を変えると、Worker を作り直します。`plugins` の順番を変えたときも同じです。前の Worker は、動いているステップが終わってから止まります。新しい Worker が始まらなければ、前の Worker が続けます
- プラグインのパッケージを更新したときは、`ugoke daemon stop` と `ugoke daemon start` で、常駐プロセスを起動し直します。起動し直すまで、Worker は前のコードで動きます。設定を変えて Worker を作り直しても同じです
- `ugoke daemon status` は、プロジェクトごとに、そのサーバーと前のサーバーも表示します

## 終了ステータス

- `ugoke daemon start`
  - `0`
    - 起動した
    - すでに動いていた
  - `1`
    - 起動に失敗した
    - 60 秒たっても答えなかった
- `ugoke daemon stop`
  - `0`
    - 止めた
    - 動いていなかった
  - `1`: 60 秒たっても止まらなかった
- `ugoke daemon status`
  - `0`: 動いている
  - `1`: 動いていない
