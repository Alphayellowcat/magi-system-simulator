export interface BridgeSkill {
  id: string;
  name: string;
  description: string;
  dir: string;
}

export interface BridgeStatus {
  ok: boolean;
  cwd: string;
  bridgeConfigPath: string | null;
  mcpConfigPath: string | null;
  storage?: BridgeStorageStatus;
  allowSkillScripts: boolean;
  skills: BridgeSkill[];
  mcpServers: string[];
}

export interface BridgeStorageFile {
  exists: boolean;
  filePath: string;
  bytes?: number;
  updatedAt?: string;
}

export interface BridgeStorageStatus {
  stateDir: string;
  files: Record<string, BridgeStorageFile>;
}

export interface BridgeToolResult {
  ok: boolean;
  actor: string;
  toolId: string;
  latencyMs: number;
  result: unknown;
  error?: string;
}

export const getBridgeStatus = async (): Promise<BridgeStatus> => {
  const response = await fetch('/api/harness/bridge/status');
  if (!response.ok) {
    throw new Error(`Bridge status failed: ${response.status}`);
  }
  return response.json();
};

export const executeBridgeTool = async (
  toolId: 'skill.run' | 'mcp.call',
  args: Record<string, unknown>,
  actor = 'HARNESS',
): Promise<BridgeToolResult> => {
  const response = await fetch('/api/harness/bridge/tools/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      toolId,
      actor,
      arguments: args,
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge tool failed: ${response.status}`);
  }
  return payload;
};

export const listMcpTools = async (server: string) => {
  const response = await fetch('/api/harness/bridge/mcp/list-tools', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ server }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `MCP list-tools failed: ${response.status}`);
  }
  return payload.result;
};

export const getBridgeStorageStatus = async (): Promise<BridgeStorageStatus> => {
  const response = await fetch('/api/harness/bridge/storage/status');
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge storage status failed: ${response.status}`);
  }
  return payload.storage;
};

export const loadBridgeState = async <T,>(key: string): Promise<T | null> => {
  const response = await fetch(`/api/harness/bridge/storage/${encodeURIComponent(key)}`);
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge state load failed: ${response.status}`);
  }
  return payload.exists ? payload.value as T : null;
};

export const saveBridgeState = async (key: string, value: unknown): Promise<string> => {
  const response = await fetch(`/api/harness/bridge/storage/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge state save failed: ${response.status}`);
  }
  return payload.filePath;
};
