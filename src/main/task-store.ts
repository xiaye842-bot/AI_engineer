import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEngineeringTask, transitionTask } from "../shared/task-state-machine.js";
import type {
  EngineeringMessage,
  EngineeringTaskPackage,
  CreateTaskInput,
  EvidenceDraft,
  StageTransitionResult,
  TaskRequirements,
  TaskStageId,
  TaskWorkspace,
} from "../shared/task-types.js";

interface TaskDatabase {
  schemaVersion: 3;
  activeTaskId: string;
  tasks: EngineeringTaskPackage[];
}

export class TaskStore {
  private database?: TaskDatabase;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<TaskWorkspace> {
    await this.ensureLoaded();
    return this.snapshot();
  }

  async createTask(input: CreateTaskInput): Promise<TaskWorkspace> {
    return this.mutate(async (database) => {
      const now = new Date().toISOString();
      const task = createEngineeringTask(randomUUID(), input, now);
      database.tasks.unshift(task);
      database.activeTaskId = task.id;
      return this.snapshot(database);
    });
  }

  async selectTask(taskId: string): Promise<TaskWorkspace> {
    return this.mutate(async (database) => {
      this.requireTask(database, taskId);
      database.activeTaskId = taskId;
      return this.snapshot(database);
    });
  }

  async archiveTask(taskId: string): Promise<TaskWorkspace> {
    return this.mutate(async (database) => {
      const task = this.requireTask(database, taskId);
      const now = new Date().toISOString();
      task.archivedAt = now;
      task.updatedAt = now;
      task.auditTrail.push({
        id: randomUUID(),
        action: "task_archived",
        actor: "工程师",
        detail: "归档工程任务",
        createdAt: now,
      });
      this.ensureActiveTask(database, taskId);
      return this.snapshot(database);
    });
  }

  async restoreTask(taskId: string): Promise<TaskWorkspace> {
    return this.mutate(async (database) => {
      const task = this.requireTask(database, taskId);
      const now = new Date().toISOString();
      delete task.archivedAt;
      task.updatedAt = now;
      task.auditTrail.push({
        id: randomUUID(),
        action: "task_restored",
        actor: "工程师",
        detail: "从归档区恢复工程任务",
        createdAt: now,
      });
      return this.snapshot(database);
    });
  }

  async deleteTask(taskId: string): Promise<TaskWorkspace> {
    return this.mutate(async (database) => {
      const index = database.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error("工程任务不存在。");
      database.tasks.splice(index, 1);
      this.ensureActiveTask(database, taskId);
      return this.snapshot(database);
    });
  }

  async getTask(taskId: string): Promise<EngineeringTaskPackage> {
    await this.ensureLoaded();
    return structuredClone(this.requireTask(this.database!, taskId));
  }

  async updateMetadata(
    taskId: string,
    patch: { title?: string; description?: string },
  ): Promise<EngineeringTaskPackage> {
    return this.updateTask(taskId, (task, now) => {
      if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
      if (patch.description !== undefined) task.description = patch.description.trim();
      task.auditTrail.push({
        id: randomUUID(),
        action: "task_updated",
        actor: "工程师",
        detail: "更新任务基础信息",
        createdAt: now,
      });
    });
  }

  async updateRequirements(
    taskId: string,
    patch: Partial<TaskRequirements>,
  ): Promise<EngineeringTaskPackage> {
    return this.updateTask(taskId, (task) => {
      task.requirements = { ...task.requirements, ...patch };
    });
  }

  async updateStageConclusion(
    taskId: string,
    stageId: TaskStageId,
    conclusion: string,
  ): Promise<EngineeringTaskPackage> {
    return this.updateTask(taskId, (task) => {
      if (task.currentStageId !== stageId) throw new Error("只能编辑当前阶段的结论。");
      const stage = task.stages.find((item) => item.id === stageId);
      if (!stage) throw new Error("任务阶段不存在。");
      stage.conclusion = conclusion;
    });
  }

  async advanceStage(taskId: string, conclusion: string): Promise<StageTransitionResult> {
    return this.mutate(async (database) => {
      const index = database.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error("工程任务不存在。");
      const result = transitionTask(
        database.tasks[index],
        conclusion,
        "工程师",
        new Date().toISOString(),
        randomUUID(),
      );
      database.tasks[index] = result.task;
      return structuredClone(result);
    });
  }

  async addEvidence(taskId: string, draft: EvidenceDraft): Promise<EngineeringTaskPackage> {
    if (!draft.title.trim()) throw new Error("证据名称不能为空。");
    return this.updateTask(taskId, (task, now) => {
      task.evidence.unshift({
        id: randomUUID(),
        title: draft.title.trim(),
        type: draft.type,
        source: draft.source.trim(),
        summary: draft.summary.trim(),
        stageId: task.currentStageId,
        createdAt: now,
      });
      task.auditTrail.push({
        id: randomUUID(),
        action: "evidence_added",
        actor: "工程师",
        detail: `添加证据：${draft.title.trim()}`,
        createdAt: now,
      });
    });
  }

  async appendMessage(taskId: string, message: EngineeringMessage): Promise<EngineeringTaskPackage> {
    return this.updateTask(taskId, (task) => {
      const existingIndex = task.messages.findIndex((item) => item.id === message.id);
      if (existingIndex >= 0) task.messages[existingIndex] = message;
      else task.messages.push(message);
    });
  }

  async recordCapabilityActivation(
    taskId: string,
    capabilityNames: string[],
    toolNames: string[],
  ): Promise<EngineeringTaskPackage> {
    return this.updateTask(taskId, (task, now) => {
      task.auditTrail.push({
        id: randomUUID(),
        action: "capability_activated",
        actor: "AI Runtime",
        detail: `激活能力：${capabilityNames.join("、")}；工具权限：${toolNames.join("、") || "仅提示词"}`,
        createdAt: now,
      });
    });
  }

  private async updateTask(
    taskId: string,
    update: (task: EngineeringTaskPackage, now: string) => void,
  ): Promise<EngineeringTaskPackage> {
    return this.mutate(async (database) => {
      const task = this.requireTask(database, taskId);
      const now = new Date().toISOString();
      update(task, now);
      task.updatedAt = now;
      return structuredClone(task);
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TaskDatabase & { schemaVersion: number };
      if (!Array.isArray(parsed.tasks)) throw new Error("unsupported schema");
      this.database = this.migrate(parsed);
      if (parsed.schemaVersion !== 3) await this.persist(this.database);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      const now = new Date().toISOString();
      const task = createEngineeringTask(randomUUID(), {
        title: "软件工程协作任务",
        mode: "workflow",
        taskType: "功能开发",
      }, now);
      this.database = { schemaVersion: 3, activeTaskId: task.id, tasks: [task] };
      await this.persist(this.database);
    }
  }

  private requireTask(database: TaskDatabase, taskId: string): EngineeringTaskPackage {
    const task = database.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("工程任务不存在。");
    return task;
  }

  private migrate(source: TaskDatabase & { schemaVersion: number }): TaskDatabase {
    return {
      schemaVersion: 3,
      activeTaskId: source.activeTaskId,
      tasks: source.tasks.map((task) => ({
        ...task,
        schemaVersion: 3,
        mode: task.mode ?? "workflow",
        taskType: task.taskType ?? "功能开发",
        archivedAt: task.archivedAt,
      })),
    };
  }

  private ensureActiveTask(database: TaskDatabase, changedTaskId: string): void {
    const activeTask = database.tasks.find((task) => task.id === database.activeTaskId);
    if (database.activeTaskId !== changedTaskId && activeTask && !activeTask.archivedAt) return;
    const nextTask = database.tasks.find((task) => !task.archivedAt);
    if (nextTask) {
      database.activeTaskId = nextTask.id;
      return;
    }
    const now = new Date().toISOString();
    const fallback = createEngineeringTask(randomUUID(), {
      title: "新建快速任务",
      mode: "quick",
      taskType: "常规咨询",
    }, now);
    database.tasks.unshift(fallback);
    database.activeTaskId = fallback.id;
  }

  private snapshot(database = this.database!): TaskWorkspace {
    return {
      activeTaskId: database.activeTaskId,
      tasks: structuredClone(database.tasks),
      storagePath: this.filePath,
    };
  }

  private async mutate<T>(operation: (database: TaskDatabase) => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.operationQueue = this.operationQueue.then(async () => {
      try {
        await this.ensureLoaded();
        const value = await operation(this.database!);
        await this.persist(this.database!);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async persist(database: TaskDatabase): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
