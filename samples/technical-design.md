# 技术方案：配置快照发布

## 背景

本需求涉及多个应用模块的数据发布链路，需要确认当前链路、可复用能力、影响范围和验证方式。

## 当前系统建模

- 从 domain context 进入，阅读 service-map 和 end-to-end-flow。
- 通过 workspace-manifest 定位本地 repo 和 IDL。
- 通过 repo-for-codegen 下钻到具体代码入口。

## 方案

优先复用已有发布链路，只在必要位置新增配置快照发布逻辑。

| 模块 | 责任 | 备注 |
| --- | --- | --- |
| 配置快照服务 | 生成并发布配置上下文 | 保持字段可追溯 |
| 配置发布服务 | 复用现有发布入口 | 仅补齐必要字段 |

```ts
type PublishConfigSnapshotInput = {
  configId: string;
  snapshotId: string;
  source: "manual" | "agent";
};
```

> 方案评审时需要确认哪些字段属于配置快照，哪些字段属于配置发布链路的既有能力。

## 风险

- 新旧逻辑交替时可能出现发布链路不一致。
- smoke case 需要覆盖配置快照是否成功发布。

## 验证

- 跑 UT。
- 部署到测试环境。
- 使用 smoke case 验证 happy path。
- 若失败，基于日志和测试租户继续排障。
