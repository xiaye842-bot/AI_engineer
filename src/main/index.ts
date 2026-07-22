import { app, BrowserWindow, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getStageName } from "../shared/task-state-machine.js";
import type { EngineeringTaskPackage } from "../shared/task-types.js";
import type { AgentEvent, ModelConfig, ProviderId, ProviderOption } from "../shared/types.js";
import { TaskStore } from "./task-store.js";

const SUPPORTED_PROVIDERS: ProviderId[] = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistral",
  "groq",
  "openrouter",
];

type ActiveRun = {
  taskId: string;
  messageId: string;
  stageId: EngineeringTaskPackage["currentStageId"];
  content: string;
};

let mainWindow: BrowserWindow | null = null;
let session: AgentSession | null = null;
let unsubscribe: (() => void) | null = null;
let activeConfigKey = "";
let activeRun: ActiveRun | null = null;
let taskStore: TaskStore;

async function getProviderOptions(): Promise<ProviderOption[]> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
  return runtime.getProviders()
    .filter((provider) => SUPPORTED_PROVIDERS.includes(provider.id as ProviderId))
    .map((provider) => ({
      id: provider.id as ProviderId,
      name: provider.name,
      models: runtime.getModels(provider.id).map((model) => model.id),
    }));
}

function buildSystemPrompt(task: EngineeringTaskPackage): string {
  const requirements = Object.entries(task.requirements)
    .map(([key, value]) => `${key}: ${value || "未补充"}`)
    .join("\n");
  const history = task.messages
    .slice(-24)
    .map((message) => `${message.role === "user" ? "工程师" : "AI"}: ${message.content}`)
    .join("\n");

  return `你是公司软件工程师的工程伴随式 AI 助手。你要围绕单个工程任务持续协作，并帮助形成可追溯的阶段结论。

当前任务：${task.title}
当前阶段：${getStageName(task.currentStageId)}
任务描述：${task.description || "未补充"}
结构化需求：
${requirements}

已有证据：${task.evidence.map((item) => item.title).join("、") || "暂无"}
历史对话：
${history || "暂无"}

回答应准确、简洁，主动指出信息缺口、假设和风险。没有证据时不要把推测表述为事实。当前未开放代码和命令工具。`;
}

function buildPrompt(task: EngineeringTaskPackage, text: string): string {
  return `[当前工程任务上下文]
任务：${task.title}
阶段：${getStageName(task.currentStageId)}
需求信息：${JSON.stringify(task.requirements)}
证据数量：${task.evidence.length}

[工程师消息]
${text}`;
}

function emit(payload: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:event", payload);
  }
}

async function disposeSession(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  if (session) {
    if (session.isStreaming) await session.abort();
    session.dispose();
  }
  session = null;
  activeRun = null;
  activeConfigKey = "";
}

async function ensureSession(config: ModelConfig, task: EngineeringTaskPackage): Promise<AgentSession> {
  const keyHash = createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
  const configKey = `${config.provider}:${config.model}:${config.thinkingLevel}:${task.id}:${keyHash}`;
  if (session && activeConfigKey === configKey) return session;

  await disposeSession();
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials });
  await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);

  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`Pi 模型目录中未找到 ${config.provider}/${config.model}，请检查模型 ID。`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(app.getPath("userData"), "pi"),
    systemPromptOverride: () => buildSystemPrompt(task),
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    thinkingLevel: config.thinkingLevel,
    noTools: "all",
  });

  session = result.session;
  activeConfigKey = configKey;
  unsubscribe = session.subscribe((event) => {
    if (
      activeRun &&
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      activeRun.content += event.assistantMessageEvent.delta;
      emit({
        type: "delta",
        taskId: activeRun.taskId,
        messageId: activeRun.messageId,
        text: event.assistantMessageEvent.delta,
      });
    }
  });
  return session;
}

async function persistAssistant(status: "complete" | "error" | "aborted", fallback: string): Promise<void> {
  const run = activeRun;
  if (!run) return;
  await taskStore.appendMessage(run.taskId, {
    id: run.messageId,
    role: "assistant",
    content: run.content || fallback,
    status,
    stageId: run.stageId,
    createdAt: new Date().toISOString(),
  });
}

function registerAgentIpc(): void {
  ipcMain.handle("agent:get-providers", () => getProviderOptions());

  ipcMain.handle(
    "agent:send-message",
    async (
      _event,
      payload: { text: string; config: ModelConfig; taskId: string; messageId: string },
    ): Promise<{ accepted: boolean }> => {
      const text = payload.text.trim();
      if (!text) throw new Error("消息不能为空。");
      if (!payload.config.apiKey.trim()) throw new Error("请先填写模型 API Key。");

      const task = await taskStore.getTask(payload.taskId);
      const activeSession = await ensureSession(payload.config, task);
      if (activeSession.isStreaming) throw new Error("模型正在回复，请稍后再发送。");

      await taskStore.appendMessage(task.id, {
        id: payload.messageId,
        role: "user",
        content: text,
        status: "complete",
        stageId: task.currentStageId,
        createdAt: new Date().toISOString(),
      });

      activeRun = {
        taskId: task.id,
        messageId: randomUUID(),
        stageId: task.currentStageId,
        content: "",
      };
      emit({ type: "started", taskId: task.id, messageId: activeRun.messageId });

      void activeSession
        .prompt(buildPrompt(task, text))
        .then(async () => {
          const lastAssistant = [...activeSession.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          const run = activeRun;
          if (!run) return;

          if (lastAssistant && "stopReason" in lastAssistant && lastAssistant.stopReason === "aborted") {
            await persistAssistant("aborted", "已停止生成。");
            emit({ type: "aborted", taskId: run.taskId, messageId: run.messageId });
          } else if (
            lastAssistant &&
            "errorMessage" in lastAssistant &&
            typeof lastAssistant.errorMessage === "string"
          ) {
            await persistAssistant("error", lastAssistant.errorMessage);
            emit({
              type: "error",
              taskId: run.taskId,
              messageId: run.messageId,
              message: lastAssistant.errorMessage,
            });
          } else {
            await persistAssistant("complete", "模型未返回文本内容。");
            emit({ type: "completed", taskId: run.taskId, messageId: run.messageId });
          }
          activeRun = null;
        })
        .catch(async (error: unknown) => {
          const run = activeRun;
          if (!run) return;
          const message = error instanceof Error ? error.message : "模型调用失败";
          await persistAssistant("error", message);
          emit({ type: "error", taskId: run.taskId, messageId: run.messageId, message });
          activeRun = null;
        });
      return { accepted: true };
    },
  );

  ipcMain.handle("agent:abort", async () => {
    if (session?.isStreaming) await session.abort();
  });
  ipcMain.handle("agent:reset-session", () => disposeSession());
}

function registerTaskIpc(): void {
  ipcMain.handle("tasks:initialize", () => taskStore.initialize());
  ipcMain.handle("tasks:create", async (_event, title: string) => {
    await disposeSession();
    return taskStore.createTask(title);
  });
  ipcMain.handle("tasks:select", async (_event, taskId: string) => {
    await disposeSession();
    return taskStore.selectTask(taskId);
  });
  ipcMain.handle("tasks:update-metadata", (_event, payload) =>
    taskStore.updateMetadata(payload.taskId, payload.patch),
  );
  ipcMain.handle("tasks:update-requirements", (_event, payload) =>
    taskStore.updateRequirements(payload.taskId, payload.patch),
  );
  ipcMain.handle("tasks:update-conclusion", (_event, payload) =>
    taskStore.updateStageConclusion(payload.taskId, payload.stageId, payload.conclusion),
  );
  ipcMain.handle("tasks:advance", async (_event, payload) => {
    const result = await taskStore.advanceStage(payload.taskId, payload.conclusion);
    await disposeSession();
    return result;
  });
  ipcMain.handle("tasks:add-evidence", (_event, payload) =>
    taskStore.addEvidence(payload.taskId, payload.evidence),
  );
  ipcMain.handle("tasks:append-message", (_event, payload) =>
    taskStore.appendMessage(payload.taskId, payload.message),
  );
}

function createWindow(): void {
  const capturePath = app.commandLine.getSwitchValue("capture-preview");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f4f6f8",
    title: "工程伴随 AI",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.once("did-finish-load", () => {
    if (!capturePath || !mainWindow) return;
    setTimeout(() => {
      void mainWindow?.webContents.capturePage().then(async (image) => {
        await mkdir(dirname(capturePath), { recursive: true });
        await writeFile(capturePath, image.toPNG());
        app.quit();
      });
    }, 1000);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"), {
      query: capturePath ? { preview: "workspace" } : undefined,
    });
  }
}

app.whenReady().then(async () => {
  taskStore = new TaskStore(join(app.getPath("userData"), "engineering-tasks.json"));
  await taskStore.initialize();
  registerAgentIpc();
  registerTaskIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  unsubscribe?.();
  session?.dispose();
});
