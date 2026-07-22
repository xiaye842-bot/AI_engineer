export const TASK_STAGES = [
  { id: "requirements", name: "需求分析" },
  { id: "design", name: "方案设计" },
  { id: "impact", name: "影响评估" },
  { id: "development", name: "代码开发" },
  { id: "verification", name: "测试验证" },
  { id: "archive", name: "报告归档" },
] as const;

export type TaskStageId = (typeof TASK_STAGES)[number]["id"];
export type TaskStageStatus = "locked" | "active" | "completed";
export type TaskMode = "workflow" | "quick";

export const TASK_TYPE_OPTIONS = [
  "功能开发",
  "现场问题分析",
  "测试分析",
  "代码评审",
  "文档与方案",
  "常规咨询",
] as const;

export type TaskType = (typeof TASK_TYPE_OPTIONS)[number] | string;

export interface CreateTaskInput {
  title: string;
  mode: TaskMode;
  taskType: TaskType;
}

export interface TaskStageState {
  id: TaskStageId;
  status: TaskStageStatus;
  conclusion: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

export interface TaskRequirements {
  functionGoal: string;
  productVersion: string;
  inputsOutputs: string;
  exceptionStrategy: string;
}

export interface EngineeringMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "error" | "aborted";
  stageId: TaskStageId;
  createdAt: string;
}

export type EvidenceType = "document" | "log" | "waveform" | "test-result" | "note";

export interface EvidenceItem {
  id: string;
  title: string;
  type: EvidenceType;
  source: string;
  summary: string;
  stageId: TaskStageId;
  createdAt: string;
}

export interface EvidenceDraft {
  title: string;
  type: EvidenceType;
  source: string;
  summary: string;
}

export interface DecisionRecord {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  stageId: TaskStageId;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: "task_created" | "task_updated" | "stage_confirmed" | "evidence_added";
  actor: string;
  detail: string;
  createdAt: string;
}

export interface EngineeringTaskPackage {
  schemaVersion: 2;
  id: string;
  title: string;
  description: string;
  mode: TaskMode;
  taskType: TaskType;
  status: "active" | "completed";
  currentStageId: TaskStageId;
  stages: TaskStageState[];
  requirements: TaskRequirements;
  risks: string[];
  decisions: DecisionRecord[];
  evidence: EvidenceItem[];
  messages: EngineeringMessage[];
  auditTrail: AuditEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorkspace {
  activeTaskId: string;
  tasks: EngineeringTaskPackage[];
  storagePath: string;
}

export interface StageTransitionResult {
  task: EngineeringTaskPackage;
  from: TaskStageId;
  to?: TaskStageId;
  completed: boolean;
}
