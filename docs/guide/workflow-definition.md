# ワークフローの定義

ワークフローは、YAML のファイルに定義します。ファイルの置き場所は「[プロジェクトとワークフローのファイル](project.md)」で説明します。このページでは、定義の書き方を順に説明します。項目と決まりの一覧は、リファレンスの「[ワークフローの定義](../reference/workflow-definition.md)」にあります。

## 最小の定義

```yaml
version: v0.1
start: hello
steps:
  hello:
    type: script
    run: echo hello
    next: end
```

定義には、形式のバージョン（`version`）、最初に実行するステップ（`start`）、ステップの一覧（`steps`）を書きます。この定義は、`hello` ステップで `echo hello` を実行し、終わります。

`type: script` のステップは、`run` に書いたコマンドを実行します。各ステップの `next` には、次に実行するステップを書きます。`next` に `end` を書くと、そのステップでワークフローが終わります。

## ステップをつなぐ

ステップを増やすときは、`next` で次のステップを指します。

```yaml
version: v0.1
start: build
steps:
  build:
    type: script
    run: make build
    next: test
  test:
    type: script
    run: make test
    timeout: 10m
    next: end
```

この定義は、`build`、`test` の順に実行して終わります。`timeout` は、ステップの最大の実行時間です。書かなければ `30m` です。

どのステップも、`start` からたどれて、`end` に着ける必要があります。行き先を条件で分ける書き方は「[条件で分ける](#条件で分ける)」で、繰り返す書き方は「[繰り返す](#繰り返す)」で説明します。

## ステップ間で値を渡す

前のステップが `outputs` した値は、`${{ }}` で囲んだ式で、あとのステップから使えます。

```yaml
version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: echo hello
    outputs:
      title: ${{ result.stdout }}
    next: report
  report:
    type: script
    inputs:
      title: ${{ steps.fetch.outputs.title }}
    run: echo "title is ${{ inputs.title }}"
    next: end
```

- `fetch` の `outputs` で、スクリプトの標準出力を `title` という値にします。標準出力の最後の改行は、1 つ取り除きます
- `report` の `inputs` で `fetch` の `title` を受け取り、`run` の中で `${{ inputs.title }}` として使います

この定義を実行すると、`report` は `echo "title is hello"` を実行します。

式で参照できる値は、書く場所ごとに決まっています。`ugoke validate` は、参照できない値を参照していないかも確かめます。詳しくは、[リファレンスの式](../reference/workflow-definition.md#式)を見てください。

## ワークフローの入力を受け取る

ワークフローが始まるときに受け取る値は、最上位の `inputs` に宣言します。

```yaml
version: v0.1
inputs:
  env:
    type: choice
    options: [staging, production]
    required: true
start: deploy
steps:
  deploy:
    type: script
    run: echo "deploy to ${{ workflow.inputs.env }}"
    next: end
```

値は、`ugoke run` の `--input` に JSON で渡します。

```console
$ ugoke run deploy --input '{"env": "staging"}'
```

ステップの式からは、`${{ workflow.inputs.env }}` のように参照します。宣言に合わない値を渡すと、実行せずに失敗します。宣言の書き方は、[リファレンスのワークフローの入力](../reference/workflow-definition.md#ワークフローの入力)を見てください。

## 人の判断を待つ

`type: wait` のステップは、答えを待ちます。`method: terminal` は、`ugoke run` のターミナルで人に聞きます。pull request の出来事を待つ [`github_pr`](../reference/wait-methods/github-pr.md) など、ほかの待ち方は、リファレンスの「[待ち方](../reference/README.md#待ち方)」にあります。

```yaml
version: v0.1
start: ask
steps:
  ask:
    type: wait
    method: terminal
    with:
      message: Deploy to production?
      schema:
        decision:
          type: choice
          options: [approve, reject]
          required: true
    outputs:
      decision: ${{ result.decision }}
    next: report
  report:
    type: script
    run: echo "decision is ${{ steps.ask.outputs.decision }}"
    next: end
```

- `ask` は `message` を表示して、`schema` で宣言した `decision` を聞きます。宣言の書き方は、ワークフローの入力と同じです
- 答えは、`outputs` で `${{ result.decision }}` として受け取り、あとのステップに渡します
- 宣言に合わない答えは受け付けず、もう一度聞きます

`schema` を書かなければ、Enter を押すまで待ちます。詳しくは、[リファレンスの wait ステップ](../reference/workflow-definition.md#wait-ステップ)を見てください。

## AI に任せる

`type: ai` のステップは、`prompt` の指示を AI に実行させます。`provider: claude-code` は、Claude Code で実行します。使うには、プロジェクトの設定の `plugins` に、`@ugoke/adapter-ai-claude-code` を書きます（「[claude-code](../reference/providers/claude-code.md#使う準備)」）。

```yaml
version: v0.1
start: review
steps:
  review:
    type: ai
    provider: claude-code
    prompt: Review the changes in this repository and judge whether they can be merged.
    schema:
      type: object
      properties:
        verdict:
          type: string
          enum: [approve, request_changes]
        summary:
          type: string
      required: [verdict, summary]
    with:
      allowedTools: [Read, Grep, Glob]
    outputs:
      verdict: ${{ result.data.verdict }}
      summary: ${{ result.data.summary }}
    next: report
  report:
    type: script
    env:
      VERDICT: ${{ steps.review.outputs.verdict }}
      SUMMARY: ${{ steps.review.outputs.summary }}
    run: echo "$VERDICT - $SUMMARY"
    next: end
```

- `review` は、プロジェクトのルートで Claude Code を動かします。`with` の `allowedTools` で、AI に使わせるツールを決めます
- `schema` で結果の形を決めると、`outputs` で `${{ result.data.verdict }}` のように中の項目を受け取れます。`schema` を書かなければ、結果は AI の返事のテキストで、`${{ result.data }}` で受け取ります
- AI が言ったことやしたことは、ステップの出力として表示します
- AI の結果は、`run` に式で直接書かずに、`env` で渡します。`run` の式はそのままコマンドに入るため、AI が書いた文に `$(...)` などがあると、コマンドとして実行されてしまいます

項目の一覧は、[リファレンスの ai ステップ](../reference/workflow-definition.md#ai-ステップ)と「[claude-code](../reference/providers/claude-code.md)」にあります。

## 条件で分ける

`next` に `if` と `to` の一覧を書くと、ステップの結果で行き先を分けられます。

```yaml
version: v0.1
start: check
steps:
  check:
    type: script
    run: git status --porcelain
    outputs:
      changes: ${{ result.stdout }}
    next:
      - if: ${{ outputs.changes != '' }}
        to: commit
      - to: end
  commit:
    type: script
    run: git add --all && git commit --message "Update files"
    next: end
```

- `check` は、変更があれば `commit` に進み、なければそのまま終わります
- ステップが成功したあとに、上から順に `if` の条件を確かめ、最初に成り立った分岐の `to` に進みます。どれも成り立たなければ、最後の分岐の `to` に進みます
- 最後の分岐には `if` を書かず、それ以外の分岐には書きます
- 条件では、`outputs.<名前>` で自分の `outputs` を、`result` で自分の結果を参照できます。前のステップの `outputs` と、ワークフローの入力、`env.<名前>` で環境変数も参照できます
- いくつかのステップから、同じステップに進めます

別の分岐にあって動かなかったステップの `outputs` を参照すると、その値は `null` です。条件の書き方は、[リファレンスの分岐](../reference/workflow-definition.md#分岐)にあります。

## 繰り返す

分岐の `to` に前のステップを書くと、そこに戻って繰り返します。

```yaml
version: v0.1
start: poll
steps:
  poll:
    type: script
    run: sleep 10 && ./build-status.sh
    outputs:
      status: ${{ result.stdout }}
    maxVisits: 3
    next:
      - if: ${{ outputs.status == 'running' }}
        to: poll
      - to: report
  report:
    type: script
    env:
      STATUS: ${{ steps.poll.outputs.status }}
    run: echo "the build is $STATUS"
    next: end
```

- `poll` は、ビルドがまだ `running` なら、もう一度確かめます
- `maxVisits: 3` で、`poll` が動くのは 3 回までです。4 回目に進むと、動かさずにワークフローが失敗します
- ループがあっても、どのステップからも `end` に着ける道が要ります

何回目かの `outputs` の参照と、繰り返しの上限は、[リファレンスのループ](../reference/workflow-definition.md#ループ)にあります。

## 定義を確かめる

`ugoke validate` で、定義を実行する前に確かめられます。

```console
$ ugoke validate hello
hello: valid
```

問題があるときは、ファイル、行と列、項目のパスと一緒に表示します。たとえば、`first` の `next` が定義にない `missing` を指していると、次のようになります。

```text
.ugoke/workflows/hello.yaml:7:11 steps.first.next: Unknown step: missing
```

定義にない項目、重複したキー、YAML のアンカーとエイリアスなども、エラーになります。定義の決まりは、リファレンスの「[ワークフローの定義](../reference/workflow-definition.md)」にあります。コマンドの詳細は「[ugoke validate](../reference/commands/validate.md)」にあります。

`ugoke docs` で、つながりを図にした文書を、定義の隣に作れます。コマンドの詳細は「[ugoke docs](../reference/commands/docs.md)」にあります。

## ステップが失敗したとき

スクリプトは、プロジェクトのルートで実行します。途中のコマンドが失敗するとスクリプトが止まり、0 以外の終了ステータスで終わるか、`timeout` を過ぎると、そのステップは失敗します。ステップが失敗すると、ワークフローはそれ以降のステップを実行せずに失敗します。失敗したステップは、やり直しません。続けたいときは、あとで説明する `continueOnError` を書きます。

次は、`fail` ワークフローの `first` ステップが、終了ステータス 1 で終わったときの表示です。最後の行の先頭は、ワークフローの名前です。

```text
✗ first  Script exited with code 1 · 0.0s

fail: failed: Script exited with code 1
```

次は、`slow` ワークフローの `slow` ステップが、`timeout: 2s` を過ぎたときの表示です。

```text
✗ slow  Script timed out after 2000 ms · 2.0s

slow: failed: Script timed out after 2000 ms
```

止まらない場合や、`timeout` を過ぎたときの止め方は、リファレンスの「[実行](../reference/workflow-definition.md#実行)」にあります。

失敗しても続けたいステップには、`continueOnError: true` を書きます。`result.ok` で、成功したかを確かめられます。

```yaml
version: v0.1
start: lint
steps:
  lint:
    type: script
    run: npm run lint
    continueOnError: true
    outputs:
      passed: ${{ result.ok }}
    next: test
  test:
    type: script
    run: npm test
    next: report
  report:
    type: script
    run: echo "lint passed=${{ steps.lint.outputs.passed }}"
    next: end
```

`lint` が失敗しても、`test` に進みます。決まりは、リファレンスの「[失敗しても続ける](../reference/workflow-definition.md#失敗しても続ける)」にあります。

## 環境変数

script ステップと ai ステップは、ステップを実行するプロセスの環境変数を引き継ぎます。常駐プロセスで実行するときは、常駐プロセスを起動したときの環境変数です。

ワークフローに渡したい値は、定義の `env` と `dotenv` で渡します。

```yaml
version: v0.1
env:
  STAGE: production
dotenv: .env
start: build
steps:
  build:
    type: script
    run: echo 1.2.0
    outputs:
      version: ${{ result.stdout }}
    next: deploy
  deploy:
    type: script
    env:
      RELEASE: ${{ steps.build.outputs.version }}
    run: echo "deploy $RELEASE to $STAGE"
    next: end
```

- 一番上の `env` は、すべての script ステップと ai ステップの環境変数です
- ステップの `env` は、そのステップだけの環境変数です。値には式を書けます
- 数と真偽値は、書いたとおりの文字列になります。`1.10` のように YAML が違う値として読む書き方は、`"1.10"` と引用符で囲みます（「[YAML の書き方の制限](../reference/workflow-definition.md#yaml-の書き方の制限)」）
- `dotenv` には、プロジェクトのルートからの相対パスで、dotenv のファイルを書きます。ファイルがないと、ステップは失敗します。この例では、プロジェクトのルートに `.env` を用意してから実行します

同じ名前の環境変数は、`dotenv`、引き継いだ環境変数、一番上の `env`、ステップの `env` の順に、あとのものが使われます。
