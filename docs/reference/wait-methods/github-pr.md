# github_pr

[wait ステップ](../workflow-definition.md#wait-ステップ)で、GitHub の pull request の出来事を待つ待ち方です。`method: github_pr` と書いて使います。マージ、クローズ、チェックの完了、レビューを待てます。

## 使う準備

`@ugoke/adapter-wait-github` のパッケージをプロジェクトに置き、[プロジェクトの設定](../config.md)の `plugins` に書きます（「[プラグイン](../plugins.md)」）。

```yaml
plugins:
  "@ugoke/adapter-wait-github":
```

書かないと、`method: github_pr` は定義のエラーになります。

pull request は、[GitHub CLI](https://cli.github.com/)（`gh`）で読みます。ステップを動かす Worker の環境に `gh` を入れ、`gh auth login` でログインしておきます。

- 常駐プロセスは、`ugoke daemon start` を実行した環境の `PATH` で `gh` を探します
- `gh` は、Worker を動かす人のログインで pull request を読みます

## 例

```yaml
wait_review:
  type: wait
  method: github_pr
  with:
    message: Waiting for the review
    pr: ${{ steps.open.outputs.url }}
    events: [merged, closed, checks, review]
    checks:
      names: [check]
    review:
      states: [APPROVED, CHANGES_REQUESTED]
  outputs:
    event: ${{ result.event }}
    verdict: ${{ result.reviewState }}
  next:
    - if: ${{ outputs.event == 'review' }}
      to: address_review
    - to: end
```

## with

| 項目             | 必須                              | 内容                                                                                                                        |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pr`             | はい                              | pull request の URL（`https://github.com/<owner>/<repo>/pull/<番号>`）か、番号です                                          |
| `repo`           | `pr` が番号のときは必須           | `<owner>/<repo>` です。`pr` が URL のときは書けません                                                                       |
| `events`         | はい                              | 待つ出来事の一覧です。`merged`、`closed`、`checks`、`review` から 1 つ以上を書きます                                        |
| `checks.names`   | `events` に `checks` があれば必須 | 終わるのを待つチェックの名前の一覧です                                                                                      |
| `review.authors` | いいえ                            | 数えるレビューを書いた人のログインの一覧です。書かなければ、誰のレビューも数えます                                          |
| `review.states`  | いいえ                            | 数えるレビューの状態の一覧です。`APPROVED`、`COMMENTED`、`CHANGES_REQUESTED` から書きます。書かなければ、どの状態も数えます |
| `message`        | いいえ                            | 進み具合に表示する文です                                                                                                    |

- `checks` は、`events` に `checks` があるときだけ書けます
- `review` は、`events` に `review` があるときだけ書けます
- 一覧に同じ値を 2 度は書けません
- `pr`、`repo`、`message`、`review.authors`、`checks.names` には、[式](../workflow-definition.md#式)を書けます。式を含む値は、式の値を求めてから形を確かめます
- `events` と `review.states` には、式を書けません

ほかの項目は書けません。

## 答え

答えは、`result.<名前>` で参照できます。出来事に関わらない値は `null` です。

| 名前               | 内容                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `event`            | 待ちを終えた出来事です。`merged`、`closed`、`checks`、`review` のどれかです                                                |
| `url`              | pull request の URL です                                                                                                   |
| `number`           | pull request の番号です                                                                                                    |
| `headSha`          | 出来事を見つけたときの、pull request の先頭のコミットの SHA です                                                           |
| `occurredAt`       | 出来事が GitHub で起きた時刻です。ISO 8601 の文字列です。`checks` では、いちばん遅く終わったチェックの時刻です             |
| `reviewState`      | `review` のとき、レビューの状態です                                                                                        |
| `reviewAuthor`     | `review` のとき、レビューを書いた人のログインです                                                                          |
| `reviewBody`       | `review` のとき、レビューの本文です                                                                                        |
| `reviewUrl`        | `review` のとき、レビューの URL です                                                                                       |
| `reviewCommit`     | `review` のとき、レビューしたコミットの SHA です                                                                           |
| `checksConclusion` | `checks` のとき、すべて成功なら `success`、そうでなければ `failure` です                                                   |
| `failedChecks`     | `checks` のとき、失敗したチェックの名前を、`checks.names` の順に `, ` でつないだ文字列です。失敗がなければ、空の文字列です |

## 動き

- Worker が pull request を確かめて、答えます。ステップを追いかけるプロセスがなくても、進みます（「[アーキテクチャ](../../explanation/architecture.md#worker)」）
- `ugoke inbox list` には出ません。`ugoke inbox answer` や、ステップを追いかけるプロセスからは答えられません
- 出来事は、`events` に書いた順に関わらず、`merged`、`closed`、`checks`、`review` の順に確かめます
- `merged`、`closed`、`checks` は、pull request のいまの状態で決めます。待ち始める前にマージされていたり、チェックが終わっていたりしても、すぐに答えます
- `events` にない `merged` や `closed` が起きると、ステップは失敗します
- `checks` は、`checks.names` のチェックがすべて終わると、答えます
  - 名前は、大文字と小文字を区別します
  - まだ現れていないチェックは、終わっていないものとして待ちます
  - 同じ名前のチェックがいくつもあれば、すべてが終わるのを待ちます。1 つでも失敗すれば、その名前は失敗です
  - 結果が `success`、`neutral`、`skipped` のチェックは、成功です。ほかの結果は、失敗です
- `review` は、ステップが待ち始めたあとに出されたレビューだけを数えます。数えるレビューがいくつもあれば、いちばん早く出されたものを答えます
  - `review.authors` は、大文字と小文字を区別しません。`[bot]` の有無も区別しません
- 通信や GitHub の一時的なエラーのあいだは、確かめる間隔をのばしながら、確かめ直します。レート制限に当たったときは、戻るまで待ちます
- 次のときは、ステップは失敗します
  - `gh` が見つからない
  - `gh` でログインしていない
  - pull request が見つからない。または、`gh` のログインでは読めない
- 一時的なエラーが続いているあいだは、常駐プロセスのログに書きます

## 設定

`plugins` の、パッケージの名前の下に書きます。

```yaml
plugins:
  "@ugoke/adapter-wait-github":
    pollInterval: 1m
```

| 項目           | 必須   | 内容                                                                                                                            |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `pollInterval` | いいえ | pull request を確かめる間隔です。`10s` から `168h` までです。既定は `30s` です。書き方は script ステップの `timeout` と同じです |
