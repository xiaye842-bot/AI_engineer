import { getStageName } from "../shared/task-state-machine.js";
import type { CapabilityActivation } from "../shared/capability-types.js";
import type { EngineeringTaskPackage } from "../shared/task-types.js";

function formatMaterials(task: EngineeringTaskPackage): string {
  return task.evidence
    .map((item) => `- ${item.title}（${item.type}）：${item.summary || "无摘要"}${item.source ? `；来源：${item.source}` : ""}`)
    .join("\n");
}

function formatHistory(task: EngineeringTaskPackage): string {
  return task.messages.slice(-20).map((message) =>
    `${message.role === "user" ? "用户" : "AI"}：${message.content}`,
  ).join("\n");
}

function formatCapabilities(activation: CapabilityActivation): string {
  if (!activation.capabilities.length) return "";
  return activation.capabilities.map((item) => {
    const gates = item.gates.length ? `\n人工门禁：${item.gates.join("、")}` : "";
    return `## ${item.kind === "skill" ? "Skill" : "Workflow"}：${item.name}\n${item.description}${gates}\n\n${item.instructions}`;
  }).join("\n");
}

export function buildSystemPrompt(
  task: EngineeringTaskPackage,
  activation: CapabilityActivation = { capabilities: [], toolNames: [] },
): string {
  const materials = formatMaterials(task);
  const history = formatHistory(task);
  const capabilities = formatCapabilities(activation);

  if (task.mode === "quick") {
    return `你是一个通用 AI 助手。当前处于常规快速模式，不执行工程开发阶段流程，也不设置阶段门禁。

直接回答用户当前的问题。不要默认要求用户补充功能目标、软件版本、触发条件、输入输出、测试证据或阶段结论。只有当缺失信息确实阻止你给出有用答案时，才提出最少量的澄清问题；否则说明合理假设后直接作答。

可以利用以下上下文，但不要把任务名称或任务类型误当成用户必须遵守的流程：
- 会话主题：${task.title}
- 类型标签：${task.taskType}
- 用户维护的上下文：${task.description || "无"}
- 关联知识与材料：\n${materials || "暂无"}
- 最近会话：\n${history || "暂无"}

${capabilities ? `本轮已授权并激活的能力：\n${capabilities}\n` : ""}
回答应准确、自然、简洁。区分已知事实、材料结论和你的推断；没有内部资料时明确说明，不要编造公司内部知识。`;
  }

  const requirements = Object.entries(task.requirements)
    .map(([key, value]) => `${key}: ${value || "未补充"}`)
    .join("\n");

  return `你是公司软件工程师的工程伴随式 AI 助手。
当前任务：${task.title}
任务类型：${task.taskType}
当前阶段：${getStageName(task.currentStageId)}
任务说明：${task.description || "未补充"}
结构化需求：\n${requirements}
已关联知识与证据：\n${materials || "暂无"}
最近会话：\n${history || "暂无"}

围绕当前阶段协作，主动识别信息缺口、风险和证据不足，帮助形成可由工程师确认的阶段结论。任何 Workflow 声明的人工门禁都只能由用户确认，不得自行判定通过。
${capabilities ? `\n本轮已授权并激活的能力：\n${capabilities}` : ""}

回答应准确、简洁。没有证据时不要把推测表述为事实。`;
}

export function buildUserPrompt(task: EngineeringTaskPackage, text: string): string {
  if (task.mode === "quick") {
    const context = task.description.trim()
      ? `\n\n可选背景（仅在相关时使用）：${task.description.trim()}`
      : "";
    return `${text}${context}`;
  }

  return `[当前工程任务]
任务：${task.title}
类型：${task.taskType}
阶段：${getStageName(task.currentStageId)}
需求信息：${JSON.stringify(task.requirements)}
知识与证据：${JSON.stringify(task.evidence.map((item) => ({ title: item.title, summary: item.summary, source: item.source })))}

[工程师消息]
${text}`;
}
