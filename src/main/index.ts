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
import type { CapabilityActivation } from "../shared/capability-types.js";
import type { EngineeringTaskPackage } from "../shared/task-types.js";
import type { AgentEvent, ModelConfig, ProviderId, ProviderOption } from "../shared/types.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
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
let capabilityRegistry: CapabilityRegistry;

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

async function ensureSession(
  config: ModelConfig,
  task: EngineeringTaskPackage,
  activation: CapabilityActivation,
): Promise<AgentSession> {
  const keyHash = createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
  const capabilityKey = activation.capabilities.map((item) => item.id).sort().join(",");
  const configKey = `${config.provider}:${config.model}:${config.thinkingLevel}:${task.id}:${keyHash}:${capabilityKey}:${activation.toolNames.join(",")}`;
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
    additionalSkillPaths: await capabilityRegistry.enabledSkillPaths(),
    systemPromptOverride: () => buildSystemPrompt(task, activation),
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
    tools: activation.toolNames,
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
      const activation = await capabilityRegistry.resolveActivation(task, text);
      const activeSession = await ensureSession(payload.config, task, activation);
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
      const capabilityNames = activation.capabilities.map((item) => item.name);
      if (capabilityNames.length) {
        await taskStore.recordCapabilityActivation(task.id, capabilityNames, activation.toolNames);
      }
      emit({
        type: "started",
        taskId: task.id,
        messageId: activeRun.messageId,
        capabilities: capabilityNames,
        tools: activation.toolNames,
      });

      void activeSession
        .prompt(buildUserPrompt(task, text))
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
  ipcMain.handle("tasks:create", async (_event, input) => {
    await disposeSession();
    return taskStore.createTask(input);
  });
  ipcMain.handle("tasks:select", async (_event, taskId: string) => {
    await disposeSession();
    return taskStore.selectTask(taskId);
  });
  ipcMain.handle("tasks:archive", async (_event, taskId: string) => {
    await disposeSession();
    return taskStore.archiveTask(taskId);
  });
  ipcMain.handle("tasks:restore", async (_event, taskId: string) => {
    await disposeSession();
    return taskStore.restoreTask(taskId);
  });
  ipcMain.handle("tasks:delete", async (_event, taskId: string) => {
    await disposeSession();
    return taskStore.deleteTask(taskId);
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

function registerCapabilityIpc(): void {
  ipcMain.handle("capabilities:initialize", () => capabilityRegistry.initialize());
  ipcMain.handle("capabilities:refresh", async () => {
    await disposeSession();
    return capabilityRegistry.getCatalog();
  });
  ipcMain.handle("capabilities:update-policy", async (_event, payload) => {
    await disposeSession();
    return capabilityRegistry.updatePolicy(payload.id, payload.patch);
  });
  ipcMain.handle("capabilities:add-source", async (_event, path: string) => {
    await disposeSession();
    return capabilityRegistry.addSource(path);
  });
}

function createWindow(): void {
  const capturePath = app.commandLine.getSwitchValue("capture-preview");
  const captureView = app.commandLine.getSwitchValue("capture-view") || "workspace";
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
      query: capturePath ? { preview: captureView } : undefined,
    });
  }
}

app.whenReady().then(async () => {
  taskStore = new TaskStore(join(app.getPath("userData"), "engineering-tasks.json"));
  capabilityRegistry = new CapabilityRegistry(
    process.cwd(),
    join(app.getPath("userData"), "capability-settings.json"),
    join(app.getPath("userData"), "capabilities"),
  );
  await taskStore.initialize();
  await capabilityRegistry.initialize();
  registerAgentIpc();
  registerTaskIpc();
  registerCapabilityIpc();
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
