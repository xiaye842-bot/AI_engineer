/// <reference types="vite/client" />

import type { AgentApi, CapabilityApi, TaskApi } from "../../shared/types";

declare global {
  interface Window {
    engineeringAgent: AgentApi;
    engineeringTasks: TaskApi;
    engineeringCapabilities: CapabilityApi;
  }
}

export {};
