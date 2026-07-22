import { contextBridge, ipcRenderer } from "electron";
import type { AgentApi, AgentEvent, ModelConfig, TaskApi } from "../shared/types";

const agentApi: AgentApi = {
  getProviders: () => ipcRenderer.invoke("agent:get-providers"),
  sendMessage: (text: string, config: ModelConfig, taskId: string, messageId: string) =>
    ipcRenderer.invoke("agent:send-message", { text, config, taskId, messageId }),
  abort: () => ipcRenderer.invoke("agent:abort"),
  resetSession: () => ipcRenderer.invoke("agent:reset-session"),
  onEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
};

const taskApi: TaskApi = {
  initialize: () => ipcRenderer.invoke("tasks:initialize"),
  createTask: (title) => ipcRenderer.invoke("tasks:create", title),
  selectTask: (taskId) => ipcRenderer.invoke("tasks:select", taskId),
  updateMetadata: (taskId, patch) => ipcRenderer.invoke("tasks:update-metadata", { taskId, patch }),
  updateRequirements: (taskId, patch) => ipcRenderer.invoke("tasks:update-requirements", { taskId, patch }),
  updateStageConclusion: (taskId, stageId, conclusion) =>
    ipcRenderer.invoke("tasks:update-conclusion", { taskId, stageId, conclusion }),
  advanceStage: (taskId, conclusion) => ipcRenderer.invoke("tasks:advance", { taskId, conclusion }),
  addEvidence: (taskId, evidence) => ipcRenderer.invoke("tasks:add-evidence", { taskId, evidence }),
  appendMessage: (taskId, message) => ipcRenderer.invoke("tasks:append-message", { taskId, message }),
};

contextBridge.exposeInMainWorld("engineeringAgent", agentApi);
contextBridge.exposeInMainWorld("engineeringTasks", taskApi);
