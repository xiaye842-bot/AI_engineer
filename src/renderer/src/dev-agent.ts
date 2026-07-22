import { createEngineeringTask, transitionTask } from "../../shared/task-state-machine";
import type { EngineeringTaskPackage, TaskWorkspace } from "../../shared/task-types";
import type { CapabilityCatalog } from "../../shared/capability-types";
import type { AgentApi, AgentEvent, CapabilityApi, ProviderOption, TaskApi } from "../../shared/types";

const previewProviders: ProviderOption[] = [
  { id: "openai", name: "OpenAI", models: ["gpt-5.2", "gpt-5.1", "gpt-5-mini"] },
  { id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-6"] },
  { id: "deepseek", name: "DeepSeek", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
];

const listeners = new Set<(event: AgentEvent) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const seededTask = createEngineeringTask("preview-task", {
  title: "软件工程协作任务",
  mode: "workflow",
  taskType: "功能开发",
}, new Date().toISOString());
let workspace: TaskWorkspace = {
  activeTaskId: seededTask.id,
  tasks: [seededTask],
  storagePath: "开发预览内存",
};
let capabilityCatalog: CapabilityCatalog = {
  capabilities: [
    {
      id: "workflow:preview",
      kind: "workflow",
      name: "feature-development",
      description: "面向功能开发全过程的六阶段工程协作流程。",
      sourcePath: ".agents/workflows/feature-development/WORKFLOW.md",
      sourceFormat: "markdown-workflow",
      taskTypes: ["功能开发"],
      taskModes: ["workflow"],
      triggerKeywords: ["功能开发", "方案设计"],
      gates: ["需求确认", "方案评审", "测试结论确认"],
      policy: { enabled: true, autoTrigger: true, permission: "read" },
    },
    {
      id: "skill:preview",
      kind: "skill",
      name: "evidence-review",
      description: "检查日志、测试记录和波形证据的完整性与可追溯性。",
      sourcePath: ".agents/skills/evidence-review/SKILL.md",
      sourceFormat: "agent-skill",
      taskTypes: ["测试分析", "现场问题分析"],
      taskModes: [],
      triggerKeywords: ["证据", "日志", "波形"],
      gates: [],
      policy: { enabled: false, autoTrigger: true, permission: "none" },
    },
  ],
  sources: [],
  managedSkillPath: "用户数据/capabilities/skills",
  managedWorkflowPath: "用户数据/capabilities/workflows",
  scannedAt: new Date().toISOString(),
};

function emit(event: AgentEvent): void {
  listeners.forEach((listener) => listener(event));
}

function updateTask(taskId: string, update: (task: EngineeringTaskPackage) => void): EngineeringTaskPackage {
  const task = workspace.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("工程任务不存在。");
  update(task);
  task.updatedAt = new Date().toISOString();
  return structuredClone(task);
}

function createPreviewAgent(): AgentApi {
  return {
    getProviders: async () => previewProviders,
    sendMessage: async (text, _config, taskId) => {
      const messageId = crypto.randomUUID();
      emit({ type: "started", taskId, messageId });
      const task = workspace.tasks.find((item) => item.id === taskId);
      const parts = task?.mode === "quick"
        ? ["这是常规快速模式，我会直接回答：", text, "。不会强制进入工程阶段流程。"]
        : ["已收到。", "我会结合当前阶段、已授权能力和证据材料继续协作。"];
      let index = 0;
      timer = setInterval(() => {
        emit({ type: "delta", taskId, messageId, text: parts[index] });
        index += 1;
        if (index === parts.length) {
          clearInterval(timer);
          timer = undefined;
          emit({ type: "completed", taskId, messageId });
        }
      }, 220);
      return { accepted: true };
    },
    abort: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    resetSession: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createPreviewCapabilities(): CapabilityApi {
  return {
    initialize: async () => structuredClone(capabilityCatalog),
    refresh: async () => structuredClone(capabilityCatalog),
    updatePolicy: async (id, patch) => {
      capabilityCatalog.capabilities = capabilityCatalog.capabilities.map((item) =>
        item.id === id ? { ...item, policy: { ...item.policy, ...patch } } : item,
      );
      return structuredClone(capabilityCatalog);
    },
    addSource: async (path) => {
      if (path.trim() && !capabilityCatalog.sources.includes(path.trim())) capabilityCatalog.sources.push(path.trim());
      return structuredClone(capabilityCatalog);
    },
  };
}

function createPreviewTasks(): TaskApi {
  return {
    initialize: async () => structuredClone(workspace),
    createTask: async (input) => {
      const task = createEngineeringTask(crypto.randomUUID(), input, new Date().toISOString());
      workspace.tasks.unshift(task);
      workspace.activeTaskId = task.id;
      return structuredClone(workspace);
    },
    selectTask: async (taskId) => {
      workspace.activeTaskId = taskId;
      return structuredClone(workspace);
    },
    updateMetadata: async (taskId, patch) => updateTask(taskId, (task) => Object.assign(task, patch)),
    updateRequirements: async (taskId, patch) =>
      updateTask(taskId, (task) => Object.assign(task.requirements, patch)),
    updateStageConclusion: async (taskId, stageId, conclusion) =>
      updateTask(taskId, (task) => {
        const stage = task.stages.find((item) => item.id === stageId);
        if (stage) stage.conclusion = conclusion;
      }),
    advanceStage: async (taskId, conclusion) => {
      const task = workspace.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("工程任务不存在。");
      const result = transitionTask(task, conclusion, "工程师", new Date().toISOString(), crypto.randomUUID());
      workspace.tasks[workspace.tasks.findIndex((item) => item.id === taskId)] = result.task;
      return structuredClone(result);
    },
    addEvidence: async (taskId, draft) =>
      updateTask(taskId, (task) => {
        task.evidence.unshift({
          ...draft,
          id: crypto.randomUUID(),
          stageId: task.currentStageId,
          createdAt: new Date().toISOString(),
        });
      }),
    appendMessage: async (taskId, message) =>
      updateTask(taskId, (task) => {
        task.messages.push(message);
      }),
  };
}

export function getAgentApi(): AgentApi {
  if (window.engineeringAgent) return window.engineeringAgent;
  if (import.meta.env.DEV) return createPreviewAgent();
  throw new Error("Electron 预加载桥未初始化。");
}

export function getTaskApi(): TaskApi {
  if (window.engineeringTasks) return window.engineeringTasks;
  if (import.meta.env.DEV) return createPreviewTasks();
  throw new Error("工程任务存储桥未初始化。");
}

export function getCapabilityApi(): CapabilityApi {
  if (window.engineeringCapabilities) return window.engineeringCapabilities;
  if (import.meta.env.DEV) return createPreviewCapabilities();
  throw new Error("Agent 能力桥未初始化。");
}
