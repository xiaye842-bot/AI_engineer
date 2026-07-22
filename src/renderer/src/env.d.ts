/// <reference types="vite/client" />

import type { AgentApi, TaskApi } from "../../shared/types";

declare global {
  interface Window {
    engineeringAgent: AgentApi;
    engineeringTasks: TaskApi;
  }
}

export {};
