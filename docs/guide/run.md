# ワークフローを実行する

このページでは、ワークフローを実行して、結果を確かめるまでを順に説明します。コマンドの詳細は、リファレンスの「[ugoke run](../reference/commands/run.md)」にあります。

## 準備

まだプロジェクトがなければ、`ugoke init` で作ります。試すためのワークフロー `hello` も作ります（「[プロジェクトとワークフローのファイル](project.md)」）。

ワークフローは、Temporal Server の上で実行します。ふだんは、常駐プロセスを 1 度起動しておきます。常駐プロセスが、Temporal Server を起動し、ワークフローのステップを実行します。仕組みは「[アーキテクチャ](../explanation/architecture.md)」で説明します。

```console
$ ugoke daemon start
```

常駐プロセスの状態は `ugoke daemon status` で確認できます。止めるときは `ugoke daemon stop` です（「[ugoke daemon](../reference/commands/daemon.md)」）。

常駐プロセスは、初めて起動するときに、Temporal Server を起動する Temporal CLI をダウンロードします（「[Temporal CLI](../reference/commands/daemon.md#temporal-cli)」）。

常駐プロセスを使わないときは、用意した Temporal Server を `--address` で指定します。プロジェクトの設定の `temporal.address` でも指定できます（「[プロジェクトの設定](../reference/config.md)」）。

## 実行する

`ugoke run` に、ワークフローの名前を指定します。

```console
$ ugoke run ok
first
│ > echo first
│ first
✓ first  0.0s

second
│ > echo second
│ second
✓ second  0.0s

ok: completed (first, second)
```

ステップごとに、ステップの ID、実行するコマンド（`│ >` の行）、コマンドの出力（`│` の行）、結果（`✓` の行）を表示します。最後の行は、ワークフローの名前、結果、実行したステップの順番です。

実行する前に、`ugoke validate` と同じように定義を確かめます。定義に問題があるときは、エラーを表示し、何も実行しません。

## 失敗したとき

ステップが失敗すると、`✗` の行に理由を表示し、ワークフローはそれ以降のステップを実行せずに失敗します。終了ステータスは 1 です。`continueOnError` を書いたステップは、失敗しても次に進みます（「[ワークフローの定義](workflow-definition.md#ステップが失敗したとき)」）。

```text
first
│ > false
│ > echo not reached
✗ first  Script exited with code 1 · 0.0s

fail: failed: Script exited with code 1
```

どんなときにステップが失敗するかは、「[ワークフローの定義](workflow-definition.md#ステップが失敗したとき)」で説明します。

## 途中で止める

実行の途中で Ctrl+C を押したときの動きは、どこでステップを実行しているかで変わります。

常駐プロセスで実行しているときは、`ugoke run` はすぐにワークフローから切り離れます。ワークフローは止まらずに、常駐プロセスで続きます。

```text
wait: detached. Run "ugoke attach" to continue
```

`ugoke run` が自分でステップを実行しているとき（`--address` など）は、実行中のステップが終わるのを待ってから切り離れます。待っているあいだにもう 1 度 Ctrl+C を押すと、すぐに終了します。このとき、実行中のステップは失敗し、そのワークフローは続けられなくなります。

```text
Waiting for the running step to finish, so that you can attach to the run later.
Press Ctrl+C again to exit now. The running step will fail, and the run cannot be continued.
```

## 実行に戻る

切り離した実行には、`ugoke attach` で戻れます。実行の ID を書かなければ、プロジェクトの実行を一覧にして、選んでもらいます。

```console
$ ugoke attach
1. deploy  waiting at approve: Deploy to production?  started 5m ago
Select a run (1-1): 1
```

戻ると、`ugoke run` と同じように、終わるまで追いかけます。待機ステップが答えを待っていれば、ここで答えられます。1 つの実行を追いかけられるのは、1 つのプロセスだけです。

## あとで答える

常駐プロセスが動かしている実行なら、戻らずに答えることもできます。初めから追いかけないときは、`ugoke run --detach` で始めます。

```console
$ ugoke run deploy --detach
deploy: started deploy-8f2c… in ugoke daemon. Its questions wait in "ugoke inbox list", and "ugoke attach deploy-8f2c…" follows it
```

`ugoke inbox list` で、答えを待っているステップと、答えるコマンドを一覧にします。

```console
$ ugoke inbox list
deploy-8f2c…  deploy  approve (visit 0)  started 5m ago
  │ Deploy to production?
  answers:
    decision: one of approve, reject (required)
  ugoke inbox answer deploy-8f2c… --step approve --visit 0 --values '{...}' --detach
```

出たコマンドの `{...}` を答えに変えて、実行します。

```console
$ ugoke inbox answer deploy-8f2c… --step approve --visit 0 --values '{"decision":"approve"}' --detach
deploy: answered approve. The run goes on in ugoke daemon
```

オプションは、リファレンスの「[ugoke inbox](../reference/commands/inbox.md)」にあります。

## 進み具合を見る

切り離した実行の進み具合は、`ugoke log` で見られます。終わった実行も見られます。

```console
$ ugoke log deploy-8f2c… --tail 3
│ > ./deploy.sh
│ deployed
✓ deploy  12.3s
```

実行が終わるまで見続けるときは、`--follow` を付けます。オプションは、リファレンスの「[ugoke log](../reference/commands/log.md)」にあります。

## 取り消す

実行を止めるときは、`ugoke cancel` で取り消します。待機ステップの待ちと、実行中のスクリプトや AI を止めます。

```console
$ ugoke cancel
1. deploy  waiting at approve: Deploy to production?  started 5m ago
Select a run (1-1): 1
deploy: cancelled
```

`--address` で実行したときは、`ugoke run` と同じ `--address` を、`ugoke attach` と `ugoke cancel` にも付けます。オプションは、リファレンスの「[ugoke attach](../reference/commands/attach.md)」と「[ugoke cancel](../reference/commands/cancel.md)」にあります。
