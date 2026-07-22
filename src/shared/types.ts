export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "mistral"
  | "groq"
  | "openrouter";

export interface ModelConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
}

export interface ProviderOption {
  id: ProviderId;
  name: string;
  models: string[];
}

export type AgentEvent =
  | { type: "started"; taskId: string; messageId: string; capabilities?: string[]; tools?: string[] }
  | { type: "delta"; taskId: string; messageId: string; text: string }
  | { type: "completed"; taskId: string; messageId: string }
  | { type: "aborted"; taskId: string; messageId: string }
  | { type: "error"; taskId: string; messageId: string; message: string };

export interface AgentApi {
  getProviders: () => Promise<ProviderOption[]>;
  sendMessage: (
    text: string,
    config: ModelConfig,
    taskId: string,
    messageId: string,
  ) => Promise<{ accepted: boolean }>;
  abort: () => Promise<void>;
  resetSession: () => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

import type { CapabilityCatalog, CapabilityPolicyPatch } from "./capability-types.js";

export interface CapabilityApi {
  initialize: () => Promise<CapabilityCatalog>;
  refresh: () => Promise<CapabilityCatalog>;
  updatePolicy: (id: string, patch: CapabilityPolicyPatch) => Promise<CapabilityCatalog>;
  addSource: (path: string) => Promise<CapabilityCatalog>;
}

import type {
  EngineeringMessage,
  EngineeringTaskPackage,
  CreateTaskInput,
  EvidenceDraft,
  StageTransitionResult,
  TaskRequirements,
  TaskStageId,
  TaskWorkspace,
} from "./task-types.js";

export interface TaskApi {
  initialize: () => Promise<TaskWorkspace>;
  createTask: (input: CreateTaskInput) => Promise<TaskWorkspace>;
  selectTask: (taskId: string) => Promise<TaskWorkspace>;
  archiveTask: (taskId: string) => Promise<TaskWorkspace>;
  restoreTask: (taskId: string) => Promise<TaskWorkspace>;
  deleteTask: (taskId: string) => Promise<TaskWorkspace>;
  updateMetadata: (
    taskId: string,
    patch: { title?: string; description?: string },
  ) => Promise<EngineeringTaskPackage>;
  updateRequirements: (
    taskId: string,
    patch: Partial<TaskRequirements>,
  ) => Promise<EngineeringTaskPackage>;
  updateStageConclusion: (
    taskId: string,
    stageId: TaskStageId,
    conclusion: string,
  ) => Promise<EngineeringTaskPackage>;
  advanceStage: (
    taskId: string,
    conclusion: string,
  ) => Promise<StageTransitionResult>;
  addEvidence: (taskId: string, evidence: EvidenceDraft) => Promise<EngineeringTaskPackage>;
  appendMessage: (taskId: string, message: EngineeringMessage) => Promise<EngineeringTaskPackage>;
}
