# プログラムから使う

AI エージェントなどのプログラムから ugoke を動かすときは、`--from-ai` を付けます。人向けの進み具合の代わりに、1 行に 1 つの JSON（JSON Lines）を標準出力に出します。

`--from-ai` を付けられるのは、次のコマンドです。

- [`ugoke run`](commands/run.md)
- [`ugoke inbox list`](commands/inbox.md#ugoke-inbox-list)
- [`ugoke inbox answer`](commands/inbox.md#ugoke-inbox-answer)

## 流れ

1. `ugoke run <workflow> --from-ai` で実行を始めます
2. 誰かの答えを待つ wait ステップに来ると、`question` の行を出して、実行から切り離れます。実行は待ち続けます
3. `ugoke inbox answer <workflow-id> --step <step> --visit <visit> --values <json> --from-ai` で答えます
4. 答えたコマンドは、実行を次の質問か終わりまで追いかけます。次の質問が来たら、3 に戻ります

Worker が答える待ち方のステップでは切り離れずに、追いかけ続けます。

常駐プロセスが動かしていない実行（たとえば、`--address` を指定したとき）は、質問で切り離れたあと、ステップを動かす Worker がいません。`ugoke inbox answer --from-ai` で答えると、そのコマンドが Worker を動かして進めます。それまでは、`ugoke inbox list` で何を待っているかを読めません。

答え待ちは、`ugoke inbox list --from-ai` でも一覧にできます。

## 行の種類

どの行にも、種類を表す `type` があります。

| `type`         | 内容                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `started`      | 実行を始めた。実行の ID を含みます                                   |
| `answered`     | 答えを受け付けた                                                     |
| `stepStarted`  | ステップが始まった                                                   |
| `stepFinished` | ステップが終わった。成功、失敗、取り消しのどれかを含みます           |
| `question`     | 答えを待っている。答えるのに要ることを含みます                       |
| `unreadable`   | `ugoke inbox list` で、何を待っているかを読めない実行がある          |
| `warning`      | 実行は続くが、知らせることがある                                     |
| `completed`    | 実行が終わった                                                       |
| `failed`       | 失敗した。理由を含みます                                             |
| `cancelled`    | 実行が取り消された。実行を始める前に Ctrl+C を押したときも、これです |
| `detached`     | 質問がないまま、実行から切り離れた。たとえば、Ctrl+C を押した        |

- ステップの出力（スクリプトの出力や AI の進み具合）は出しません
- 始める前に失敗したとき（たとえば、定義に問題があるとき）は、人向けのメッセージを標準エラーに出します。標準出力には、同じ理由の `failed` の行を出します

## 最後の行と終了ステータス

`ugoke run` と `ugoke inbox answer` の最後の行は、次のどれかです。

- `question`: `3`。実行は答えを待っています
- `detached`: `3`。実行は続いています
- `completed`: `0`
- `failed`: `1`。答えを受け付けなかったときも、これです。ステップは待ち続けます
- `cancelled`: `130`

2 度目の Ctrl+C ですぐに終了したときは、最後の行を出さずに、`130` で終わります。

`ugoke inbox list` は、`unreadable` の行があれば `1`、なければ `0` で終わります。答え待ちがなければ、何も出しません。
