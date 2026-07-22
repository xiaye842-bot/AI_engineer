export type CapabilityKind = "skill" | "workflow";
export type CapabilityPermission = "none" | "read" | "write" | "execute";

export interface CapabilityPolicy {
  enabled: boolean;
  autoTrigger: boolean;
  permission: CapabilityPermission;
}

export interface AgentCapability {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  sourcePath: string;
  sourceFormat: "agent-skill" | "markdown-workflow";
  taskTypes: string[];
  taskModes: Array<"workflow" | "quick">;
  triggerKeywords: string[];
  gates: string[];
  policy: CapabilityPolicy;
}

export interface CapabilityCatalog {
  capabilities: AgentCapability[];
  sources: string[];
  managedSkillPath: string;
  managedWorkflowPath: string;
  scannedAt: string;
}

export interface CapabilityPolicyPatch {
  enabled?: boolean;
  autoTrigger?: boolean;
  permission?: CapabilityPermission;
}

export interface CapabilityActivation {
  capabilities: Array<AgentCapability & { instructions: string }>;
  toolNames: string[];
}
