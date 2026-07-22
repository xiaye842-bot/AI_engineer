import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileCheck2,
  FileText,
  History,
  KeyRound,
  Menu,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { calculateCompleteness, getStageName } from "../../shared/task-state-machine";
import {
  TASK_STAGES,
  TASK_TYPE_OPTIONS,
  type CreateTaskInput,
  type EngineeringMessage,
  type EngineeringTaskPackage,
  type EvidenceDraft,
  type TaskRequirements,
  type TaskMode,
  type TaskWorkspace,
} from "../../shared/task-types";
import type { AgentEvent, ModelConfig, ProviderOption } from "../../shared/types";
import { getAgentApi, getTaskApi } from "./dev-agent";

const defaultConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-5.2",
  apiKey: "",
  thinkingLevel: "medium",
};

const emptyEvidence: EvidenceDraft = {
  title: "",
  type: "note",
  source: "",
  summary: "",
};

const emptyNewTask: CreateTaskInput = {
  title: "",
  mode: "workflow",
  taskType: "功能开发",
};

const requirementLabels: Array<{ key: keyof TaskRequirements; label: string; placeholder: string }> = [
  { key: "functionGoal", label: "功能目标与触发条件", placeholder: "目标、触发条件及预期行为" },
  { key: "productVersion", label: "适用产品及软件版本", placeholder: "产品型号、分支、版本" },
  { key: "inputsOutputs", label: "输入输出及边界条件", placeholder: "关键输入、输出和边界" },
  { key: "exceptionStrategy", label: "异常处置与恢复策略", placeholder: "异常响应、复位和恢复" },
];

const agentApi = getAgentApi();
const taskApi = getTaskApi();

function App() {
  const previewView = new URLSearchParams(window.location.search).get("preview");
  const previewWorkspace = previewView === "workspace" || previewView === "new-task";
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [messages, setMessages] = useState<EngineeringMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!previewWorkspace);
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(previewView === "new-task");
  const [evidenceFormOpen, setEvidenceFormOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [config, setConfig] = useState<ModelConfig>(defaultConfig);
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(defaultConfig);
  const [configReady, setConfigReady] = useState(false);
  const [draftRequirements, setDraftRequirements] = useState<TaskRequirements>({
    functionGoal: "",
    productVersion: "",
    inputsOutputs: "",
    exceptionStrategy: "",
  });
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft>(emptyEvidence);
  const [newTaskDraft, setNewTaskDraft] = useState<CreateTaskInput>(emptyNewTask);
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const activeTaskIdRef = useRef("");
  const activeStageIdRef = useRef<EngineeringTaskPackage["currentStageId"]>("requirements");

  const currentTask = useMemo(
    () => workspace?.tasks.find((task) => task.id === workspace.activeTaskId),
    [workspace],
  );

  useEffect(() => {
    void Promise.all([agentApi.getProviders(), taskApi.initialize()]).then(([providerOptions, initial]) => {
      setProviders(providerOptions);
      applyWorkspace(initial);
    }).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : "应用初始化失败");
    });
    return agentApi.onEvent(handleAgentEvent);
  }, []);

  useEffect(() => {
    if (!currentTask) return;
    activeTaskIdRef.current = currentTask.id;
    activeStageIdRef.current = currentTask.currentStageId;
    setDraftRequirements(currentTask.requirements);
    setDraftTitle(currentTask.title);
    setDraftDescription(currentTask.description);
    const stage = currentTask.stages.find((item) => item.id === currentTask.currentStageId);
    setConclusion(stage?.conclusion ?? "");
  }, [currentTask?.id, currentTask?.currentStageId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function applyWorkspace(next: TaskWorkspace) {
    const task = next.tasks.find((item) => item.id === next.activeTaskId);
    setWorkspace(next);
    setMessages(task?.messages ?? []);
    if (task) {
      activeTaskIdRef.current = task.id;
      activeStageIdRef.current = task.currentStageId;
    }
  }

  function replaceTask(task: EngineeringTaskPackage) {
    setWorkspace((current) => current ? {
      ...current,
      tasks: current.tasks.map((item) => item.id === task.id ? task : item),
    } : current);
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.taskId !== activeTaskIdRef.current) return;
    if (event.type === "started") {
      setStreaming(true);
      setMessages((current) => [
        ...current,
        {
          id: event.messageId,
          role: "assistant",
          content: "",
          status: "complete",
          stageId: activeStageIdRef.current,
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }

    if (event.type === "delta") {
      setMessages((current) => current.map((message) =>
        message.id === event.messageId
          ? { ...message, content: message.content + event.text }
          : message,
      ));
      return;
    }

    if (event.type === "completed" || event.type === "aborted") {
      setStreaming(false);
      setMessages((current) => current.map((message) =>
        message.id === event.messageId
          ? { ...message, content: message.content || "已停止生成。", status: event.type === "aborted" ? "aborted" : "complete" }
          : message,
      ));
      void refreshWorkspace(event.taskId);
      return;
    }

    setStreaming(false);
    setMessages((current) => current.map((message) =>
      message.id === event.messageId
        ? { ...message, content: message.content || event.message, status: "error" }
        : message,
    ));
    void refreshWorkspace(event.taskId);
  }

  async function refreshWorkspace(expectedTaskId: string) {
    const next = await taskApi.initialize();
    if (activeTaskIdRef.current === expectedTaskId) applyWorkspace(next);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !currentTask) return;
    if (!configReady) {
      setSettingsOpen(true);
      setNotice("请先完成模型配置");
      return;
    }

    const message: EngineeringMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "complete",
      stageId: currentTask.currentStageId,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, message]);
    setInput("");
    setNotice("");
    setStreaming(true);
    try {
      await agentApi.sendMessage(text, config, currentTask.id, message.id);
    } catch (error) {
      setStreaming(false);
      const content = error instanceof Error ? error.message : "消息发送失败";
      const errorMessage: EngineeringMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        status: "error",
        stageId: currentTask.currentStageId,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, errorMessage]);
      await taskApi.appendMessage(currentTask.id, message);
      await taskApi.appendMessage(currentTask.id, errorMessage);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function saveConfig() {
    if (!draftConfig.apiKey.trim() || !draftConfig.model.trim()) {
      setNotice("请填写模型 ID 和 API Key");
      return;
    }
    setConfig(draftConfig);
    setConfigReady(true);
    setSettingsOpen(false);
    setNotice("");
  }

  function selectProvider(providerId: ModelConfig["provider"]) {
    const selected = providers.find((provider) => provider.id === providerId);
    setDraftConfig((current) => ({ ...current, provider: providerId, model: selected?.models[0] ?? "" }));
  }

  async function createTask() {
    const title = newTaskDraft.title.trim() || `${newTaskDraft.taskType}任务 ${(workspace?.tasks.length ?? 0) + 1}`;
    const next = await taskApi.createTask({ ...newTaskDraft, title });
    await agentApi.resetSession();
    applyWorkspace(next);
    setNewTaskDraft(emptyNewTask);
    setNewTaskOpen(false);
    setHistoryOpen(false);
    setNotice("已创建新的工程任务包");
  }

  async function selectTask(taskId: string) {
    const next = await taskApi.selectTask(taskId);
    await agentApi.resetSession();
    applyWorkspace(next);
    setHistoryOpen(false);
    setNotice("");
  }

  async function saveTitle() {
    if (!currentTask || !draftTitle.trim() || draftTitle.trim() === currentTask.title) return;
    replaceTask(await taskApi.updateMetadata(currentTask.id, { title: draftTitle }));
  }

  async function saveDescription() {
    if (!currentTask || draftDescription === currentTask.description) return;
    replaceTask(await taskApi.updateMetadata(currentTask.id, { description: draftDescription }));
  }

  async function saveRequirement(key: keyof TaskRequirements) {
    if (!currentTask || draftRequirements[key] === currentTask.requirements[key]) return;
    replaceTask(await taskApi.updateRequirements(currentTask.id, { [key]: draftRequirements[key] }));
  }

  async function saveConclusion() {
    if (!currentTask) return;
    replaceTask(await taskApi.updateStageConclusion(currentTask.id, currentTask.currentStageId, conclusion));
  }

  async function advanceStage() {
    if (!currentTask) return;
    try {
      const result = await taskApi.advanceStage(currentTask.id, conclusion);
      replaceTask(result.task);
      setConclusion("");
      setNotice(result.completed ? "任务全部阶段已完成" : `已进入${getStageName(result.to!)}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "阶段流转失败");
    }
  }

  async function addEvidence() {
    if (!currentTask) return;
    try {
      replaceTask(await taskApi.addEvidence(currentTask.id, evidenceDraft));
      setEvidenceDraft(emptyEvidence);
      setEvidenceFormOpen(false);
      setNotice("证据已加入工程任务包");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "证据保存失败");
    }
  }

  const currentProvider = providers.find((provider) => provider.id === draftConfig.provider);
  const completeness = currentTask ? calculateCompleteness(currentTask) : 0;
  const currentStageIndex = currentTask
    ? TASK_STAGES.findIndex((stage) => stage.id === currentTask.currentStageId)
    : 0;

  if (!currentTask || !workspace) {
    return <div className="loading-screen"><Database size={24} /><span>正在加载工程任务包...</span></div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={19} /></div>
          <div><strong>工程伴随 AI</strong><span>Engineering Companion</span></div>
        </div>
        <div className="task-heading">
          <span className="task-kicker">当前工程任务</span>
          <span className="task-name">{currentTask.title}</span>
          <span className={`mode-badge ${currentTask.mode}`}>{currentTask.mode === "workflow" ? "工程流程" : "快速模式"}</span>
          <span className={`task-status ${currentTask.status}`}>{currentTask.status === "completed" ? "已完成" : "进行中"}</span>
        </div>
        <div className="topbar-actions">
          <button className="model-chip" onClick={() => setSettingsOpen(true)}>
            <CircleDot size={14} />
            <span>{configReady ? `${config.provider} / ${config.model}` : "配置模型"}</span>
            <ChevronDown size={14} />
          </button>
          <button className="icon-button" title="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
        </div>
      </header>

      <aside className="left-rail">
        <button className="new-task-button" onClick={() => setNewTaskOpen(true)}><Plus size={17} /> 新建任务</button>
        <nav className="rail-nav" aria-label="主导航">
          <button className="nav-item active"><MessageSquareText size={18} />任务协作</button>
          <button className="nav-item"><Search size={18} />知识检索</button>
          <button className="nav-item"><FileCheck2 size={18} />证据中心</button>
          <button className={`nav-item ${historyOpen ? "active" : ""}`} onClick={() => setHistoryOpen((value) => !value)}>
            <History size={18} />历史任务
          </button>
        </nav>

        {historyOpen && (
          <div className="task-history-list">
            {workspace.tasks.map((task) => (
              <button key={task.id} className={task.id === currentTask.id ? "selected" : ""} onClick={() => void selectTask(task.id)}>
                <span>{task.title}</span><small>{task.taskType} · {task.mode === "workflow" ? getStageName(task.currentStageId) : "快速模式"}</small>
              </button>
            ))}
          </div>
        )}

        {currentTask.mode === "workflow" ? (
          <div className="stage-section">
            <div className="section-label">工程流程</div>
            <ol className="stage-list">
              {currentTask.stages.map((stage, index) => (
                <li key={stage.id} className={stage.status}>
                  <span className="stage-index">{stage.status === "completed" ? <Check size={12} /> : index + 1}</span>
                  <span>{TASK_STAGES[index].name}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="quick-mode-panel"><Zap size={17} /><div><strong>常规快速模式</strong><span>上下文与知识材料直接问答</span></div></div>
        )}

        <div className="storage-indicator"><Database size={14} /><span>任务包已持久化</span></div>
        <div className="rail-footer">
          <div className="user-avatar">工</div>
          <div><strong>工程师</strong><span>软件研发部</span></div>
          <Menu size={17} />
        </div>
      </aside>

      <main className={`workspace ${evidenceOpen ? "with-evidence" : ""}`}>
        <section className="conversation">
          <div className="conversation-toolbar">
            <div><h1>{currentTask.mode === "workflow" ? getStageName(currentTask.currentStageId) : "快速协作"}</h1>
              <p>{currentTask.mode === "workflow" ? "围绕当前阶段持续协作，并将结论与证据写入任务包" : "基于任务上下文、历史会话和关联知识材料直接回答"}</p></div>
            <button className="icon-button" title={evidenceOpen ? "收起任务包" : "展开任务包"} onClick={() => setEvidenceOpen((value) => !value)}>
              {evidenceOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
          </div>

          <div className="message-list" ref={listRef}>
            <div className="date-divider"><span>任务会话</span></div>
            {messages.length === 0 && (
              <article className="message assistant">
                <div className="message-avatar"><Bot size={17} /></div>
                <div className="message-body"><div className="message-meta"><strong>工程伴随 AI</strong></div>
                  <div className="message-content">可以从功能目标、现场现象或待澄清的需求开始。我会持续结合工程任务包协助分析。</div>
                </div>
              </article>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-avatar">{message.role === "assistant" ? <Bot size={17} /> : "工"}</div>
                <div className={`message-body ${message.status === "error" ? "error" : ""}`}>
                  <div className="message-meta"><strong>{message.role === "assistant" ? "工程伴随 AI" : "工程师"}</strong><span>{currentTask.mode === "workflow" ? getStageName(message.stageId) : "快速协作"}</span></div>
                  <div className="message-content">{message.content || <span className="typing"><i /><i /><i /></span>}</div>
                </div>
              </article>
            ))}
          </div>

          <form className="composer" onSubmit={submit}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown}
              placeholder="描述功能目标、现场现象或需要澄清的问题..." rows={3} disabled={streaming || currentTask.status === "completed"} />
            <div className="composer-footer"><span>{currentTask.mode === "workflow" ? `当前阶段：${getStageName(currentTask.currentStageId)}` : `任务类型：${currentTask.taskType}`}</span>
              {streaming ? (
                <button className="send-button stop" type="button" title="停止生成" onClick={() => void agentApi.abort()}><Square size={15} fill="currentColor" /></button>
              ) : (
                <button className="send-button" type="submit" title="发送消息" disabled={!input.trim() || currentTask.status === "completed"}><Send size={17} /></button>
              )}
            </div>
          </form>
        </section>

        {evidenceOpen && (
          <aside className="evidence-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">任务上下文</span><h2>工程任务包</h2></div>
              <button className="icon-button compact" title="收起" onClick={() => setEvidenceOpen(false)}><X size={16} /></button>
            </div>

            <div className="task-title-edit">
              <label>任务名称 · {currentTask.taskType}</label>
              <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onBlur={() => void saveTitle()} />
            </div>

            <div className="task-context-edit">
              <label>{currentTask.mode === "quick" ? "任务上下文" : "任务说明"}</label>
              <textarea rows={3} value={draftDescription} placeholder="补充背景、目标、约束或当前问题"
                onChange={(event) => setDraftDescription(event.target.value)} onBlur={() => void saveDescription()} />
            </div>

            <div className="completion-block">
              <div><span>信息完整度</span><strong>{completeness}%</strong></div>
              <div className="progress-track"><span style={{ width: `${completeness}%` }} /></div>
            </div>

            {currentTask.mode === "workflow" && <div className="evidence-section requirement-fields">
              <h3>关键需求信息</h3>
              {requirementLabels.map((item) => (
                <label key={item.key}>
                  <span>{item.label}</span>
                  <textarea rows={2} value={draftRequirements[item.key]} placeholder={item.placeholder}
                    onChange={(event) => setDraftRequirements((current) => ({ ...current, [item.key]: event.target.value }))}
                    onBlur={() => void saveRequirement(item.key)} />
                </label>
              ))}
            </div>}

            <div className="evidence-section">
              <div className="section-row"><h3>{currentTask.mode === "quick" ? "关联知识与材料" : "已采集证据"} <span>{currentTask.evidence.length}</span></h3>
                <button title="添加证据" onClick={() => setEvidenceFormOpen((value) => !value)}><Plus size={15} /></button></div>
              {evidenceFormOpen && (
                <div className="evidence-form">
                  <input placeholder="证据名称" value={evidenceDraft.title} onChange={(event) => setEvidenceDraft((current) => ({ ...current, title: event.target.value }))} />
                  <div className="evidence-form-row">
                    <select value={evidenceDraft.type} onChange={(event) => setEvidenceDraft((current) => ({ ...current, type: event.target.value as EvidenceDraft["type"] }))}>
                      <option value="note">说明记录</option><option value="document">文档</option><option value="log">日志</option>
                      <option value="waveform">测试波形</option><option value="test-result">测试结果</option>
                    </select>
                    <input placeholder="来源/路径" value={evidenceDraft.source} onChange={(event) => setEvidenceDraft((current) => ({ ...current, source: event.target.value }))} />
                  </div>
                  <textarea rows={2} placeholder="证据摘要" value={evidenceDraft.summary} onChange={(event) => setEvidenceDraft((current) => ({ ...current, summary: event.target.value }))} />
                  <button className="inline-primary" onClick={() => void addEvidence()}>保存证据</button>
                </div>
              )}
              {currentTask.evidence.length ? (
                <div className="evidence-list">{currentTask.evidence.slice(0, 5).map((item) => (
                  <div key={item.id}><FileText size={15} /><span><strong>{item.title}</strong><small>{getStageName(item.stageId)} · {item.type}</small></span></div>
                ))}</div>
              ) : <div className="empty-state"><FileText size={22} /><span>{currentTask.mode === "quick" ? "尚未关联知识或上下文材料" : "尚未添加证据材料"}</span></div>}
            </div>

            {currentTask.mode === "workflow" && <div className="evidence-section conclusion-editor">
              <h3>阶段结论</h3>
              <textarea rows={4} value={conclusion} disabled={currentTask.status === "completed"}
                placeholder="记录本阶段已确认的结论、依据和遗留风险"
                onChange={(event) => setConclusion(event.target.value)} onBlur={() => void saveConclusion()} />
              <button className="advance-button" disabled={currentTask.status === "completed"} onClick={() => void advanceStage()}>
                {currentStageIndex === TASK_STAGES.length - 1 ? "确认并完成任务" : "确认并进入下一阶段"}<ChevronRight size={15} />
              </button>
            </div>}
          </aside>
        )}
      </main>

      {notice && <button className="toast" onClick={() => setNotice("")}>{notice}<X size={14} /></button>}

      {newTaskOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setNewTaskOpen(false)}>
          <section className="new-task-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div className="modal-icon"><Plus size={19} /></div>
              <div><h2 id="new-task-title">创建工程任务</h2><p>选择协作模式和任务类型</p></div>
              <button className="icon-button compact" title="关闭" onClick={() => setNewTaskOpen(false)}><X size={18} /></button>
            </div>
            <div className="new-task-body">
              <div className="mode-selector">
                <button className={newTaskDraft.mode === "workflow" ? "selected" : ""} onClick={() => setNewTaskDraft((current) => ({ ...current, mode: "workflow" as TaskMode }))}>
                  <Workflow size={19} /><span><strong>工程流程模式</strong><small>六阶段推进与人工确认门禁</small></span>
                </button>
                <button className={newTaskDraft.mode === "quick" ? "selected" : ""} onClick={() => setNewTaskDraft((current) => ({ ...current, mode: "quick" as TaskMode }))}>
                  <Zap size={19} /><span><strong>常规快速模式</strong><small>无流程限制，直接协作问答</small></span>
                </button>
              </div>
              <label><span>任务类型</span><select value={newTaskDraft.taskType} onChange={(event) => setNewTaskDraft((current) => ({ ...current, taskType: event.target.value }))}>
                {TASK_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label><span>任务名称</span><input autoFocus value={newTaskDraft.title} placeholder={`例如：${newTaskDraft.taskType}任务`}
                onChange={(event) => setNewTaskDraft((current) => ({ ...current, title: event.target.value }))} /></label>
            </div>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setNewTaskOpen(false)}>取消</button>
              <button className="primary-button" onClick={() => void createTask()}>创建任务</button></div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => configReady && setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div className="modal-icon"><KeyRound size={19} /></div>
              <div><h2 id="settings-title">连接大模型</h2><p>配置仅保存在当前应用进程内</p></div>
              {configReady && <button className="icon-button compact" title="关闭" onClick={() => setSettingsOpen(false)}><X size={18} /></button>}
            </div>
            <div className="form-grid">
              <label><span>模型服务商</span><select value={draftConfig.provider} onChange={(event) => selectProvider(event.target.value as ModelConfig["provider"])}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
              <label><span>模型 ID</span><input list="model-options" value={draftConfig.model}
                onChange={(event) => setDraftConfig((current) => ({ ...current, model: event.target.value }))} placeholder="例如 gpt-5.2" />
                <datalist id="model-options">{currentProvider?.models.map((model) => <option key={model} value={model} />)}</datalist></label>
              <label><span>推理强度</span><select value={draftConfig.thinkingLevel}
                onChange={(event) => setDraftConfig((current) => ({ ...current, thinkingLevel: event.target.value as ModelConfig["thinkingLevel"] }))}>
                <option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
              </select></label>
              <label className="full-width"><span>API Key</span><input type="password" autoComplete="off" value={draftConfig.apiKey}
                onChange={(event) => setDraftConfig((current) => ({ ...current, apiKey: event.target.value }))} placeholder="输入服务商 API Key" /></label>
            </div>
            <div className="security-note"><ShieldCheck size={16} /><span>密钥通过隔离通道传给主进程，不写入任务包、项目文件或浏览器存储。</span></div>
            <div className="modal-actions">{configReady && <button className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button>}
              <button className="primary-button" onClick={saveConfig}>保存并开始</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
