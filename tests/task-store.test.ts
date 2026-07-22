import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "../src/main/task-store.js";
import { CapabilityRegistry } from "../src/main/capability-registry.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/main/prompt-builder.js";
import { createEngineeringTask } from "../src/shared/task-state-machine.js";

test("persists task package data and enforces sequential stage transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-task-store-"));
  const filePath = join(directory, "tasks.json");

  try {
    const store = new TaskStore(filePath);
    const initial = await store.initialize();
    const taskId = initial.activeTaskId;
    assert.equal(initial.tasks.length, 1);
    assert.equal(initial.tasks[0].currentStageId, "requirements");

    await store.updateRequirements(taskId, {
      functionGoal: "当直流母线过压时触发保护并闭锁功率输出",
      productVersion: "PCS-A / main / V2.3.0",
    });

    await assert.rejects(() => store.advanceStage(taskId, "太短"), /至少需要 10 个字符/);

    const transition = await store.advanceStage(
      taskId,
      "已确认触发阈值、延时、闭锁动作及恢复条件。",
    );
    assert.equal(transition.from, "requirements");
    assert.equal(transition.to, "design");
    assert.equal(transition.task.stages[0].status, "completed");
    assert.equal(transition.task.stages[1].status, "active");

    await store.addEvidence(taskId, {
      title: "现场过压故障日志",
      type: "log",
      source: "logs/ovp-001.log",
      summary: "记录保护触发前后 5 秒关键量。",
    });
    await store.appendMessage(taskId, {
      id: "message-1",
      role: "user",
      content: "请评估现有保护链路。",
      status: "complete",
      stageId: "design",
      createdAt: new Date().toISOString(),
    });
    await store.recordCapabilityActivation(taskId, ["evidence-review"], ["read", "grep"]);

    const reloaded = await new TaskStore(filePath).initialize();
    const restored = reloaded.tasks[0];
    assert.equal(restored.currentStageId, "design");
    assert.equal(restored.requirements.productVersion, "PCS-A / main / V2.3.0");
    assert.equal(restored.evidence[0].title, "现场过压故障日志");
    assert.equal(restored.messages[0].content, "请评估现有保护链路。");
    assert.ok(restored.auditTrail.some((entry) => entry.action === "stage_confirmed"));
    assert.ok(restored.auditTrail.some((entry) => entry.action === "capability_activated"));

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion: number };
    assert.equal(persisted.schemaVersion, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates general quick tasks without workflow transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-quick-task-"));
  try {
    const store = new TaskStore(join(directory, "tasks.json"));
    await store.initialize();
    const workspace = await store.createTask({
      title: "分析现场通信异常",
      mode: "quick",
      taskType: "现场问题分析",
    });
    const task = workspace.tasks.find((item) => item.id === workspace.activeTaskId)!;
    assert.equal(task.mode, "quick");
    assert.equal(task.taskType, "现场问题分析");
    await assert.rejects(
      () => store.advanceStage(task.id, "快速模式不应该执行阶段流转操作。"),
      /不使用阶段流转/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quick mode uses a direct answer prompt without engineering requirement wrapping", () => {
  const task = createEngineeringTask("quick-prompt", {
    title: "常规问答",
    mode: "quick",
    taskType: "常规咨询",
  }, new Date().toISOString());
  const question = "用三句话解释什么是状态机";
  const prompt = buildUserPrompt(task, question);
  const systemPrompt = buildSystemPrompt(task);

  assert.equal(prompt, question);
  assert.doesNotMatch(prompt, /当前工程任务|functionGoal|需求信息/);
  assert.match(systemPrompt, /直接回答用户当前的问题/);
  assert.match(systemPrompt, /不要默认要求用户补充/);
});

test("discovers portable Agent Skills and enforces configured tool permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-capabilities-"));
  const skillDirectory = join(directory, ".agents", "skills", "log-review");
  const workflowDirectory = join(directory, ".agents", "workflows", "fault-triage");
  try {
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(workflowDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---
name: log-review
description: Review application logs and identify likely fault causes.
task-types: 现场问题分析
triggers: 日志,故障
---

# Log Review

Read the relevant logs and separate facts from hypotheses.
`, "utf8");
    await writeFile(join(workflowDirectory, "WORKFLOW.md"), `---
name: fault-triage
description: Structured fault triage workflow with a human review gate.
triggers: 日志,故障
gates: 根因评审
---

# Fault Triage

Do not pass the root-cause gate without human confirmation.
`, "utf8");
    const registry = new CapabilityRegistry(
      directory,
      join(directory, "settings.json"),
      join(directory, "managed"),
    );
    const catalog = await registry.initialize();
    const skill = catalog.capabilities.find((item) => item.name === "log-review")!;
    const workflow = catalog.capabilities.find((item) => item.name === "fault-triage")!;
    assert.equal(skill.sourceFormat, "agent-skill");
    assert.deepEqual(skill.taskModes, []);
    assert.deepEqual(workflow.taskModes, ["workflow"]);
    assert.equal(skill.policy.enabled, false);

    await registry.updatePolicy(skill.id, { enabled: true, autoTrigger: true, permission: "read" });
    await registry.updatePolicy(workflow.id, { enabled: true, autoTrigger: true, permission: "none" });
    const task = createEngineeringTask("field-task", {
      title: "现场通信故障",
      mode: "quick",
      taskType: "现场问题分析",
    }, new Date().toISOString());
    const activation = await registry.resolveActivation(task, "请分析这段故障日志");
    assert.deepEqual(activation.capabilities.map((item) => item.name), ["log-review"]);
    assert.deepEqual(activation.toolNames, ["read", "grep", "find", "ls"]);

    const workflowTask = createEngineeringTask("workflow-task", {
      title: "现场通信故障",
      mode: "workflow",
      taskType: "现场问题分析",
    }, new Date().toISOString());
    const workflowActivation = await registry.resolveActivation(workflowTask, "请分析这段故障日志");
    assert.deepEqual(workflowActivation.capabilities.map((item) => item.name), ["log-review", "fault-triage"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
