import type {
  AuditEntry,
  CreateTaskInput,
  EngineeringTaskPackage,
  StageTransitionResult,
  TaskStageId,
} from "./task-types.js";
import { TASK_STAGES } from "./task-types.js";

export function createEngineeringTask(id: string, input: CreateTaskInput, now: string): EngineeringTaskPackage {
  const title = input.title.trim() || "未命名工程任务";
  const audit: AuditEntry = {
    id: `${id}-created`,
    action: "task_created",
    actor: "工程师",
    detail: `创建工程任务：${title}`,
    createdAt: now,
  };

  return {
    schemaVersion: 2,
    id,
    title,
    description: "",
    mode: input.mode,
    taskType: input.taskType,
    status: "active",
    currentStageId: "requirements",
    stages: TASK_STAGES.map((stage, index) => ({
      id: stage.id,
      status: index === 0 ? "active" : "locked",
      conclusion: "",
    })),
    requirements: {
      functionGoal: "",
      productVersion: "",
      inputsOutputs: "",
      exceptionStrategy: "",
    },
    risks: [],
    decisions: [],
    evidence: [],
    messages: [],
    auditTrail: [audit],
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionTask(
  source: EngineeringTaskPackage,
  conclusion: string,
  actor: string,
  now: string,
  auditId: string,
): StageTransitionResult {
  if (source.status === "completed") throw new Error("任务已经完成，不能再次流转。");
  if (source.mode === "quick") throw new Error("常规快速模式不使用阶段流转。");
  if (conclusion.trim().length < 10) throw new Error("阶段结论至少需要 10 个字符后才能确认流转。");

  const currentIndex = TASK_STAGES.findIndex((stage) => stage.id === source.currentStageId);
  if (currentIndex < 0) throw new Error("当前任务阶段无效。");

  const nextDefinition = TASK_STAGES[currentIndex + 1];
  const task = structuredClone(source);
  const current = task.stages[currentIndex];
  current.status = "completed";
  current.conclusion = conclusion.trim();
  current.confirmedAt = now;
  current.confirmedBy = actor;

  if (nextDefinition) {
    task.currentStageId = nextDefinition.id;
    task.stages[currentIndex + 1].status = "active";
  } else {
    task.status = "completed";
  }

  task.updatedAt = now;
  task.auditTrail.push({
    id: auditId,
    action: "stage_confirmed",
    actor,
    detail: nextDefinition
      ? `确认“${TASK_STAGES[currentIndex].name}”结论并进入“${nextDefinition.name}”`
      : `确认“${TASK_STAGES[currentIndex].name}”结论并完成任务`,
    createdAt: now,
  });

  return {
    task,
    from: source.currentStageId,
    to: nextDefinition?.id,
    completed: !nextDefinition,
  };
}

export function getStageName(stageId: TaskStageId): string {
  return TASK_STAGES.find((stage) => stage.id === stageId)?.name ?? stageId;
}

export function calculateCompleteness(task: EngineeringTaskPackage): number {
  if (task.mode === "quick") {
    const contextScore = task.description.trim() ? 40 : 0;
    const knowledgeScore = task.evidence.length > 0 ? 40 : 0;
    const conversationScore = task.messages.length > 0 ? 20 : 0;
    return contextScore + knowledgeScore + conversationScore;
  }
  const requirementScore = Object.values(task.requirements).filter((value) => value.trim()).length * 15;
  const evidenceScore = task.evidence.length > 0 ? 15 : 0;
  const conclusionScore = task.stages.some((stage) => stage.conclusion.trim()) ? 15 : 0;
  const progressScore = task.stages.some((stage) => stage.status === "completed") ? 10 : 0;
  return Math.min(100, requirementScore + evidenceScore + conclusionScore + progressScore);
}
