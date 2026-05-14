import { AuditEvent } from '../types';

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
  auditDir?: string;
  artifactDir?: string;
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

const getBridgeBaseUrl = () => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  const envBase = process.env.MAGI_BRIDGE_BASE_URL || process.env.VITE_DEV_SERVER_URL;
  if (envBase) return envBase.replace(/\/$/, '');

  const port = process.env.VITE_PORT || '3000';
  return `http://127.0.0.1:${port}`;
};

const bridgeUrl = (path: string) =>
  path.startsWith('http') ? path : `${getBridgeBaseUrl()}${path}`;

export const getBridgeStatus = async (): Promise<BridgeStatus> => {
  const response = await fetch(bridgeUrl('/api/harness/bridge/status'));
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
  const response = await fetch(bridgeUrl('/api/harness/bridge/tools/execute'), {
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
  const response = await fetch(bridgeUrl('/api/harness/bridge/mcp/list-tools'), {
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
  const response = await fetch(bridgeUrl('/api/harness/bridge/storage/status'));
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge storage status failed: ${response.status}`);
  }
  return payload.storage;
};

export const loadBridgeState = async <T,>(key: string): Promise<T | null> => {
  const response = await fetch(bridgeUrl(`/api/harness/bridge/storage/${encodeURIComponent(key)}`));
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge state load failed: ${response.status}`);
  }
  return payload.exists ? payload.value as T : null;
};

export const saveBridgeState = async (key: string, value: unknown): Promise<string> => {
  const response = await fetch(bridgeUrl(`/api/harness/bridge/storage/${encodeURIComponent(key)}`), {
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

export const appendAuditEvents = async (
  sessionId: string,
  events: AuditEvent[],
): Promise<{ filePath: string; count: number }> => {
  const response = await fetch(bridgeUrl(`/api/harness/bridge/audit/${encodeURIComponent(sessionId)}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ events }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Audit append failed: ${response.status}`);
  }
  return {
    filePath: payload.filePath,
    count: payload.count,
  };
};

export const readAuditEvents = async (
  sessionId: string,
  limit = 200,
): Promise<{ filePath: string; events: AuditEvent[] }> => {
  const response = await fetch(bridgeUrl(`/api/harness/bridge/audit/${encodeURIComponent(sessionId)}?limit=${encodeURIComponent(String(limit))}`));
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Audit read failed: ${response.status}`);
  }
  return {
    filePath: payload.filePath,
    events: payload.events || [],
  };
};
