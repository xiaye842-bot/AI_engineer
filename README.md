# 工程伴随 AI 桌面端原型

基于 Pi Coding Agent SDK 的 Electron + React 桌面应用。当前版本完成：

- 工程任务工作台与六阶段流程导航
- 模型服务商、模型 ID、推理强度与 API Key 配置
- Pi `ModelRuntime` 和 `AgentSession` 模型调用链路
- 大模型流式输出、停止生成、新建会话与错误展示
- Electron 主进程隔离模型密钥，渲染进程通过受控 IPC 通信
- 工程任务包、待补充信息和证据中心的基础界面
- 六阶段任务状态机及人工确认门禁
- 会话按任务、阶段持久化，应用重启后自动恢复
- 需求、证据、阶段结论和审计轨迹结构化存储
- 通用任务类型：功能开发、现场问题、测试分析、代码评审、文档方案和常规咨询
- 常规快速模式：无阶段门禁，基于任务上下文、历史会话和关联知识材料直接回答
- Agent 能力中心：发现、启停和自动触发 Skills/Workflows
- 分级工具权限：仅提示词、只读文件、允许写入、允许执行命令
- 能力激活与实际工具权限写入任务审计轨迹

## Skills 与 Workflows

项目原生兼容 [Agent Skills](https://agentskills.io) 的 `SKILL.md` 目录结构，可直接发现以下位置：

- `.agents/skills/`、`.pi/skills/`
- `.claude/skills/`、`.codex/skills/`
- 能力中心中添加的任意外部目录
- Electron 用户目录下的 `capabilities/skills/`

Workflow 使用 Markdown 文件，支持 `WORKFLOW.md`、Pi prompt、Claude command 等常见纯文本工作流来源。默认扫描 `.agents/workflows/`、`.agents/prompts/`、`.pi/workflows/`、`.pi/prompts/`、`.claude/commands/` 和 `.codex/workflows/`。建议通过 frontmatter 声明路由信息：

```markdown
---
name: feature-development
description: Feature development workflow from requirements through archive.
task-types: 功能开发
modes: workflow
triggers: 需求分析,方案设计,测试验证
gates: 需求确认,方案评审,测试结论确认
---
```

能力默认禁用。启用后可按任务类型、工作模式和触发词自动激活，也可使用 `/skill:name` 或 `/workflow:name` 显式调用。Workflow 默认只在工程流程模式自动触发；快速模式不会被流程能力接管，除非用户显式调用或在清单中声明 `modes: quick`。

## 数据存储

任务数据存储在 Electron `userData` 目录下的 `engineering-tasks.json`。文件采用版本化结构并通过临时文件替换写入；无法解析的文件会保留为带时间戳的 `.corrupt-*` 备份，然后创建新的任务库。

工程任务包当前包含任务模式、任务类型、任务元数据、六阶段状态、关键需求字段、对话消息、证据、风险、设计决策和审计轨迹。工程流程模式必须按顺序流转，且当前阶段结论不少于 10 个字符并经工程师确认；常规快速模式不执行阶段流转。

## 本地运行

```powershell
npm install
npm run dev
```

首次启动后选择 Pi 支持的模型服务商，填写准确的模型 ID 与 API Key。密钥仅保存在当前应用进程内，不写入项目文件或浏览器存储。

## 构建

```powershell
npm run build
npm run package
```

## 测试

```powershell
npm test
```

## 当前安全边界

所有能力默认关闭且没有工具权限。用户在能力中心授权后，运行时才按当前触发能力开放对应 Pi 工具：只读权限包含 `read/grep/find/ls`，写入权限增加 `edit/write`，命令权限再增加 `bash`。第三方 Skill 和 Workflow 仍需人工审查；当前工具边界限制在应用工作目录，后续接入真实工程仓库时还需增加工作区选择、路径白名单和高风险命令审批。
