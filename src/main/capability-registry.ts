import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentCapability,
  CapabilityActivation,
  CapabilityCatalog,
  CapabilityKind,
  CapabilityPermission,
  CapabilityPolicy,
  CapabilityPolicyPatch,
} from "../shared/capability-types.js";
import type { EngineeringTaskPackage } from "../shared/task-types.js";

interface CapabilitySettings {
  schemaVersion: 1;
  sources: string[];
  policies: Record<string, CapabilityPolicy>;
}

interface ParsedMarkdown {
  metadata: Record<string, string>;
  body: string;
}

const DEFAULT_POLICY: CapabilityPolicy = {
  enabled: false,
  autoTrigger: true,
  permission: "none",
};

const PERMISSION_TOOLS: Record<CapabilityPermission, string[]> = {
  none: [],
  read: ["read", "grep", "find", "ls"],
  write: ["read", "grep", "find", "ls", "edit", "write"],
  execute: ["read", "grep", "find", "ls", "edit", "write", "bash"],
};

export class CapabilityRegistry {
  private settings?: CapabilitySettings;

  constructor(
    private readonly cwd: string,
    private readonly settingsPath: string,
    private readonly managedRoot: string,
  ) {}

  async initialize(): Promise<CapabilityCatalog> {
    await this.ensureSettings();
    await mkdir(this.managedSkillPath, { recursive: true });
    await mkdir(this.managedWorkflowPath, { recursive: true });
    return this.getCatalog();
  }

  async getCatalog(): Promise<CapabilityCatalog> {
    await this.ensureSettings();
    const capabilities = await this.discover();
    return {
      capabilities,
      sources: [...this.settings!.sources],
      managedSkillPath: this.managedSkillPath,
      managedWorkflowPath: this.managedWorkflowPath,
      scannedAt: new Date().toISOString(),
    };
  }

  async updatePolicy(id: string, patch: CapabilityPolicyPatch): Promise<CapabilityCatalog> {
    await this.ensureSettings();
    const catalog = await this.getCatalog();
    if (!catalog.capabilities.some((item) => item.id === id)) throw new Error("能力不存在或已被移除。");
    this.settings!.policies[id] = { ...DEFAULT_POLICY, ...this.settings!.policies[id], ...patch };
    await this.persist();
    return this.getCatalog();
  }

  async addSource(path: string): Promise<CapabilityCatalog> {
    await this.ensureSettings();
    const normalized = isAbsolute(path.trim()) ? resolve(path.trim()) : resolve(this.cwd, path.trim());
    if (!path.trim()) throw new Error("能力目录不能为空。");
    const sourceStat = await stat(normalized).catch(() => undefined);
    if (!sourceStat?.isDirectory()) throw new Error("能力目录不存在或不是文件夹。");
    if (!this.settings!.sources.includes(normalized)) this.settings!.sources.push(normalized);
    await this.persist();
    return this.getCatalog();
  }

  async resolveActivation(task: EngineeringTaskPackage, message: string): Promise<CapabilityActivation> {
    const catalog = await this.getCatalog();
    const explicit = this.explicitCapabilityName(message);
    const normalizedMessage = message.toLocaleLowerCase();
    const selected = catalog.capabilities.filter((capability) => {
      if (!capability.policy.enabled) return false;
      if (explicit) return capability.name.toLocaleLowerCase() === explicit.name && capability.kind === explicit.kind;
      if (!capability.policy.autoTrigger) return false;
      if (capability.taskModes.length > 0 && !capability.taskModes.includes(task.mode)) return false;
      if (capability.taskTypes.includes(task.taskType)) return true;
      if (capability.triggerKeywords.some((keyword) => normalizedMessage.includes(keyword.toLocaleLowerCase()))) return true;
      if (normalizedMessage.includes(capability.name.toLocaleLowerCase())) return true;
      return capability.taskTypes.length === 0 && capability.triggerKeywords.length === 0;
    });

    const capabilities = await Promise.all(selected.map(async (capability) => ({
      ...capability,
      instructions: (await readFile(capability.sourcePath, "utf8")).trim(),
    })));
    const toolNames = [...new Set(selected.flatMap((item) => PERMISSION_TOOLS[item.policy.permission]))];
    return { capabilities, toolNames };
  }

  async enabledSkillPaths(): Promise<string[]> {
    const catalog = await this.getCatalog();
    return catalog.capabilities
      .filter((item) => item.kind === "skill" && item.policy.enabled && item.policy.permission !== "none")
      .map((item) => item.sourcePath);
  }

  private get managedSkillPath(): string {
    return join(this.managedRoot, "skills");
  }

  private get managedWorkflowPath(): string {
    return join(this.managedRoot, "workflows");
  }

  private async discover(): Promise<AgentCapability[]> {
    const roots: Array<{ path: string; hint?: CapabilityKind }> = [
      { path: join(this.cwd, ".agents", "skills"), hint: "skill" },
      { path: join(this.cwd, ".pi", "skills"), hint: "skill" },
      { path: join(this.cwd, ".claude", "skills"), hint: "skill" },
      { path: join(this.cwd, ".codex", "skills"), hint: "skill" },
      { path: join(this.cwd, ".agents", "workflows"), hint: "workflow" },
      { path: join(this.cwd, ".agents", "prompts"), hint: "workflow" },
      { path: join(this.cwd, ".pi", "workflows"), hint: "workflow" },
      { path: join(this.cwd, ".pi", "prompts"), hint: "workflow" },
      { path: join(this.cwd, ".claude", "commands"), hint: "workflow" },
      { path: join(this.cwd, ".codex", "workflows"), hint: "workflow" },
      { path: this.managedSkillPath, hint: "skill" },
      { path: this.managedWorkflowPath, hint: "workflow" },
      ...this.settings!.sources.map((path) => ({ path })),
    ];
    const found = new Map<string, AgentCapability>();
    for (const root of roots) {
      if (!(await this.exists(root.path))) continue;
      for (const filePath of await this.findMarkdown(root.path)) {
        const fileName = filePath.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
        const kind = fileName === "skill.md" ? "skill" : fileName === "workflow.md" ? "workflow" : root.hint ?? "workflow";
        if (!kind) continue;
        const capability = await this.readCapability(filePath, kind);
        if (capability && !found.has(capability.id)) found.set(capability.id, capability);
      }
    }
    return [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  private async readCapability(filePath: string, kind: CapabilityKind): Promise<AgentCapability | undefined> {
    const parsed = this.parseMarkdown(await readFile(filePath, "utf8"));
    const fallbackName = dirname(filePath).split(/[\\/]/).at(-1) ?? "unnamed";
    const name = parsed.metadata.name || fallbackName;
    const description = parsed.metadata.description || this.firstParagraph(parsed.body);
    if (!description) return undefined;
    const id = `${kind}:${createHash("sha256").update(resolve(filePath).toLocaleLowerCase()).digest("hex").slice(0, 16)}`;
    return {
      id,
      kind,
      name,
      description,
      sourcePath: resolve(filePath),
      sourceFormat: kind === "skill" ? "agent-skill" : "markdown-workflow",
      taskTypes: this.parseList(parsed.metadata["task-types"]),
      taskModes: this.parseModes(parsed.metadata.modes, kind),
      triggerKeywords: this.parseList(parsed.metadata.triggers || parsed.metadata.keywords),
      gates: this.parseList(parsed.metadata.gates),
      policy: { ...DEFAULT_POLICY, ...this.settings!.policies[id] },
    };
  }

  private parseMarkdown(content: string): ParsedMarkdown {
    const normalized = content.replace(/^\uFEFF/, "");
    if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
      return { metadata: {}, body: normalized };
    }
    const lines = normalized.split(/\r?\n/);
    const end = lines.indexOf("---", 1);
    if (end < 0) return { metadata: {}, body: normalized };
    const metadata: Record<string, string> = {};
    const frontmatter = lines.slice(1, end);
    for (let index = 0; index < frontmatter.length; index += 1) {
      const match = frontmatter[index].match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLocaleLowerCase();
      const rawValue = match[2].trim();
      if (rawValue === ">" || rawValue === "|") {
        const values: string[] = [];
        while (index + 1 < frontmatter.length && /^\s+/.test(frontmatter[index + 1])) {
          values.push(frontmatter[index + 1].trim());
          index += 1;
        }
        metadata[key] = values.join(rawValue === ">" ? " " : "\n");
      } else if (!rawValue) {
        const values: string[] = [];
        while (index + 1 < frontmatter.length && /^\s*-\s+/.test(frontmatter[index + 1])) {
          values.push(frontmatter[index + 1].replace(/^\s*-\s+/, "").trim());
          index += 1;
        }
        metadata[key] = values.join(",");
      } else {
        metadata[key] = rawValue.replace(/^['"]|['"]$/g, "");
      }
    }
    return { metadata, body: lines.slice(end + 1).join("\n").trim() };
  }

  private parseList(value = ""): string[] {
    return value.replace(/^\[|\]$/g, "").split(/[,，]/).map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }

  private parseModes(value: string | undefined, kind: CapabilityKind): Array<"workflow" | "quick"> {
    const modes = this.parseList(value).filter((item): item is "workflow" | "quick" => item === "workflow" || item === "quick");
    return modes.length ? modes : kind === "workflow" ? ["workflow"] : [];
  }

  private firstParagraph(body: string): string {
    return body.split(/\n\s*\n/).map((item) => item.replace(/^#+\s+.*$/gm, "").trim()).find(Boolean) ?? "";
  }

  private explicitCapabilityName(message: string): { kind: CapabilityKind; name: string } | undefined {
    const match = message.trim().match(/^\/(skill|workflow):([^\s]+)/i);
    return match ? { kind: match[1].toLocaleLowerCase() as CapabilityKind, name: match[2].toLocaleLowerCase() } : undefined;
  }

  private async findMarkdown(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const paths: string[] = [];
    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) paths.push(...await this.findMarkdown(fullPath));
      else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === ".md") paths.push(fullPath);
    }
    return paths;
  }

  private async exists(path: string): Promise<boolean> {
    return access(path).then(() => true).catch(() => false);
  }

  private async ensureSettings(): Promise<void> {
    if (this.settings) return;
    await mkdir(dirname(this.settingsPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as CapabilitySettings;
      this.settings = {
        schemaVersion: 1,
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        policies: parsed.policies && typeof parsed.policies === "object" ? parsed.policies : {},
      };
    } catch {
      this.settings = { schemaVersion: 1, sources: [], policies: {} };
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.settingsPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.settingsPath);
  }
}
