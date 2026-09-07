# Dorey 功能回归 Case 集

这组 Case 把 Dorey 的唯一承诺主链路固定为：

```text
提交成功 -> 等待审核 -> foreground poll 收到反馈 -> Agent 回复成功
         -> 页面自动获取 completed 结果 -> 接受写回 -> acknowledge -> 结束评审
```

纯解释或无文档改动的结果无需接受，展示后即可 acknowledge；有改动的 completed 结果在接受写回成功之前持续可恢复。

其中“页面自动刷新”指页面持续查询当前 submission，并在 `completed` 后更新修订结果；不是整页 `location.reload()`。浏览器真正刷新或重新打开时，页面通过未确认 submission 恢复同一轮结果。

## 每次变更的回归门禁

- 聚焦主链路：`npm run test:regression`
- 真实浏览器主链路：`npm run test:browser`
- 全量本地门禁：`npm test && npm run test:browser && npm run typecheck && npm run build`
- GitHub 上的每次 push 和 pull request 都执行全量门禁。
- 任一 P0 Case 失败都不应发布或合入。

## P0：必须通过

| Case ID | 场景 | 关键步骤 | 通过标准 | 自动化位置 |
| --- | --- | --- | --- | --- |
| DOR-P0-001 | 主链路 | 在 1280×720 真实浏览器中 submit -> queued -> poll -> delivered -> reply -> completed -> 页面自动更新 -> accept -> acknowledge -> close | 提交按钮可真实点击；requestId 始终一致；页面无需用户手工 poll 或刷新即可展示修订；close 后 poll 返回 `review_closed` | `tests/review-lifecycle-regression.test.ts`、`tests/browser/review-lifecycle.spec.ts` |
| DOR-P0-002 | 连续两轮 | 同一 review 依次提交、领取、回复两次 | 两轮均 completed；第二轮不要求重启 server/broker | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-003 | 页面刷新恢复 | 分别在 queued、delivered、completed 状态重新读取未确认 submission | 三个状态都能恢复；completed 包含完整 response | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-004 | poll 断线重连 | delivered 后模拟连接断开并 release，再次 poll | submission 回到 queued，后续 poll 可重新领取 | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-005 | 重复回复防护 | 对同一 requestId 提交两个不同 response | 保留第一个 completed response，不产生二次改写 | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-006 | 结束评审边界 | 一个请求已 delivered、一个仍 queued，然后 close | queued 不再投递；in-flight 仍可完成；poll 终态为 `review_closed` | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-007 | 结束后重新打开 | 关闭 review，再使用相同稳定 namespace 启动 | 旧状态归档；新 review 为 open 且无旧 submission | `tests/review-lifecycle-regression.test.ts` |
| DOR-P0-008 | 待接受结果刷新恢复 | 混合评论返回且页面已展示结果后刷新，再接受；另覆盖外部写回冲突、acknowledge 失败重试、连续提交替换旧方案 | 修订、差异、评论与解释回执恢复；冲突不覆盖原文件且仍可恢复；接受成功后刷新不重复出现旧方案 | `tests/browser/review-lifecycle.spec.ts`、`tests/revision-poll-broker.test.ts` |

## P1：发布前覆盖

| Case ID | 场景 | 通过标准 | 自动化状态 |
| --- | --- | --- | --- |
| DOR-P1-001 | 启动参数与 target | `--review-file` / `--review-folder` 正确识别；无 target 时只进入 preview | `tests/revision-agent-poll-cli.test.ts` |
| DOR-P1-002 | lease 到期恢复 | abandoned delivery 到期后可被其他 poll client 领取；同 client 续租不会误抢 | `tests/revision-poll-broker.test.ts` |
| DOR-P1-003 | 单文件与相对图片 | Markdown 和引用的本地图片进入临时 workspace，资源 MIME 正确 | `tests/revision-agent-poll-cli.test.ts`、`tests/workflow-run-endpoint.test.ts` |
| DOR-P1-004 | 接受修订写回 | 原文件未变时原子写回；外部改动时返回冲突且不覆盖 | `tests/workflow-run-endpoint.test.ts` |
| DOR-P1-005 | UI 状态契约 | 页面保留自动查询、恢复、acknowledge 和 review close 的用户可见状态 | `tests/ui-contract.test.ts`、`tests/review-lifecycle-regression.test.ts` |

## 人工 smoke（发布候选版本）

自动化通过后，用一个临时 Markdown 文件执行一次真实前台评审：

1. 从原 Codex 任务运行 `dorey --review-file '<absolute-path>'`，保持启动命令和当前 turn 存活。
2. `dorey doctor` 确认 `previewOnly=false`、`deliveryMode=foreground`、target 与当前任务一致，且 lifecycle 为 `listening`。
3. 页面提交一条可观察的改写意见，确认状态依次可判断为 queued/working/completed。
4. Agent 回复后不做手工 `poll --check`，确认页面自动出现修订结果。
5. 接受前刷新页面，确认待接受结果及差异可恢复；接受修订后再次刷新，确认不重复应用。
6. 点击“结束评审”，确认 foreground poll 返回 `review_closed` 并退出。

人工 smoke 只验证真实 CLI、浏览器和 Agent turn 的连通性；它不能替代上述自动化门禁。

## v0.2.2：修订 / 解释评论分流

| Case ID | 场景 | 通过标准 | 验证位置 |
| --- | --- | --- | --- |
| DOR-TYPE-001 | 旧评论兼容及默认类型 | 缺少 kind 按修订处理，评论面板默认选择修订 | `tests/comment-kind.test.ts`、浏览器解释用例 |
| DOR-TYPE-002 | 纯解释与错误改写隔离 | payload 为 explanation；显示回答回执，保留原文，无解释正文、差异或接受按钮；已处理评论清空 | `tests/comment-kind.test.ts`、`tests/browser/review-lifecycle.spec.ts` |
| DOR-TYPE-003 | 修订意图 | revision 评论或非空全文修订要求允许返回文档修改 | `tests/comment-kind.test.ts`、浏览器修订主链路 |
| DOR-TYPE-004 | Agent 提示和投递 | Codex / TraeX 提示要求原对话回答解释，再处理修订；poll 输出类型约束 | `tests/codex-agent-adapter.test.ts`、`tests/traex-agent-adapter.test.ts`、`tests/revision-agent-poll-cli.test.ts` |
| DOR-TYPE-005 | 混合评论与切换类型 | 编辑时切换修订 / 解释；统计与提交标签同步变化；混合 payload 保留两种 kind；回复后解释仅回执，修订可接受并写回 | `tests/browser/review-lifecycle.spec.ts`，补充真实 CLI + 浏览器 smoke |

发布候选 smoke 在临时 Markdown 上依次执行纯解释、混合提交。由当前 Agent 的真实 foreground CLI 领取并向 reply endpoint 回复；解释先在原对话回答。纯解释检查原文件未变；混合提交检查刷新恢复、差异及接受写回，最后结束评审并确认 poll 退出。端口、临时目录与测试产物保持隔离，不提交 `log/`。
