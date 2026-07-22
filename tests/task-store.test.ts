import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "../src/main/task-store.js";

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

    const reloaded = await new TaskStore(filePath).initialize();
    const restored = reloaded.tasks[0];
    assert.equal(restored.currentStageId, "design");
    assert.equal(restored.requirements.productVersion, "PCS-A / main / V2.3.0");
    assert.equal(restored.evidence[0].title, "现场过压故障日志");
    assert.equal(restored.messages[0].content, "请评估现有保护链路。");
    assert.ok(restored.auditTrail.some((entry) => entry.action === "stage_confirmed"));

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion: number };
    assert.equal(persisted.schemaVersion, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

