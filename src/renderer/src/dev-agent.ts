import { createEngineeringTask, transitionTask } from "../../shared/task-state-machine";
import type { EngineeringTaskPackage, TaskWorkspace } from "../../shared/task-types";
import type { AgentApi, AgentEvent, ProviderOption, TaskApi } from "../../shared/types";

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
    sendMessage: async (_text, _config, taskId) => {
      const messageId = crypto.randomUUID();
      emit({ type: "started", taskId, messageId });
      const parts = [
        "已收到。",
        "建议先补充功能触发条件、适用软件版本和异常恢复策略，",
        "再据此形成可评审的需求边界与风险清单。",
      ];
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
