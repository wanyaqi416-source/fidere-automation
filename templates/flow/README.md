# Client + Admin Approval Flow Template

复制模板时只实现领域差异。认证、Sandbox门禁、资金开关、候选唯一性、Resume、Oracle裁决和报告必须复用`src/flow-engine/`。

需要提供：

1. Registry中的`BusinessFlowDefinition`。
2. Client领域Page Object。
3. Admin领域Page Object。
4. 逐层Candidate字段。
5. Primary与Secondary Oracle。
6. Validation和Dry Run。

`.template.ts`文件是代码骨架，不会被Playwright收集或执行。

