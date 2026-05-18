import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface BridgeConfig {
  allowSkillScripts?: boolean;
  commandTimeoutMs?: number;
  skillRoots?: string[];
}

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
  skillPath: string;
  actions?: unknown[];
}

interface McpServerConfig {
  transport?: 'stdio' | 'streamableHttp';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  timeoutMs?: number;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

interface ToolExecutionInput {
  toolId: 'web.fetch' | 'skill.run' | 'mcp.call';
  actor?: string;
  arguments?: Record<string, unknown>;
}

const BRIDGE_CONFIG_FILES = ['.magi/config/bridge.json', '.magi/bridge.json', 'magi.bridge.json'];
const MCP_CONFIG_FILES = ['.magi/mcp/servers.json', '.magi/mcp.json', 'magi.mcp.json'];
const MCP_PROTOCOL_VERSION = '2025-06-18';
const STATE_KEYS = new Set(['sessions', 'memories', 'settings', 'documents']);
const isWindows = process.platform === 'win32';
const sensitiveKeyPattern = /api[-_]?key|token|secret|password|authorization|cookie/i;

const normalizeId = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const findFirstExistingFile = async (root: string, candidates: string[]) => {
  for (const candidate of candidates) {
    const filePath = path.resolve(root, candidate);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Continue searching.
    }
  }

  return null;
};

const readJsonFile = async <T,>(filePath: string | null, fallback: T): Promise<T> => {
  if (!filePath) return fallback;

  try {
    const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Failed to read JSON config ${filePath}`, error);
    return fallback;
  }
};

const getStateDir = (root: string) => path.join(root, '.magi', 'state');
const getAuditDir = (root: string) => path.join(root, '.magi', 'audit');
const getArtifactDir = (root: string) => path.join(root, '.magi', 'artifacts');

const getStatePath = (root: string, key: string) => {
  if (!STATE_KEYS.has(key)) {
    throw new Error(`Unsupported state key: ${key}`);
  }
  return path.join(getStateDir(root), `${key}.json`);
};

const normalizeFileStem = (value: string) => {
  const normalized = normalizeId(value).replace(/[:.]+/g, '-');
  if (!normalized) throw new Error('Invalid file id');
  return normalized;
};

const getAuditPath = (root: string, sessionId: string) =>
  path.join(getAuditDir(root), `${normalizeFileStem(sessionId)}.jsonl`);

const redactSensitive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!isRecord(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKeyPattern.test(key) ? '[REDACTED]' : redactSensitive(item),
  ]));
};

const readState = async (root: string, key: string) => {
  const filePath = getStatePath(root, key);
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return {
      exists: true,
      filePath,
      value: JSON.parse(raw),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        filePath,
        value: null,
      };
    }
    throw error;
  }
};

const writeState = async (root: string, key: string, value: unknown) => {
  const stateDir = getStateDir(root);
  const filePath = getStatePath(root, key);
  await fs.mkdir(stateDir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
  return filePath;
};

const appendAuditEvents = async (root: string, sessionId: string, events: unknown[]) => {
  const auditDir = getAuditDir(root);
  const filePath = getAuditPath(root, sessionId);
  await fs.mkdir(auditDir, { recursive: true });

  const lines = events
    .filter(isRecord)
    .map(event => JSON.stringify(redactSensitive(event)));

  if (lines.length > 0) {
    await fs.appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    filePath,
    count: lines.length,
  };
};

const readAuditEvents = async (root: string, sessionId: string, limit: number) => {
  const filePath = getAuditPath(root, sessionId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const events = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map(line => JSON.parse(line));

    return {
      filePath,
      events,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        filePath,
        events: [],
      };
    }
    throw error;
  }
};

const getStorageStatus = async (root: string) => {
  const stateDir = getStateDir(root);
  const files: Record<string, { exists: boolean; filePath: string; bytes?: number; updatedAt?: string }> = {};

  for (const key of STATE_KEYS) {
    const filePath = getStatePath(root, key);
    try {
      const stat = await fs.stat(filePath);
      files[key] = {
        exists: true,
        filePath,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      files[key] = {
        exists: false,
        filePath,
      };
    }
  }

  return {
    stateDir,
    files,
  };
};

const sendJson = (res: ServerResponse, statusCode: number, payload: unknown) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const readRequestBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const parseFrontMatterValue = (content: string, key: string) => {
  const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontMatter) return '';
  const line = frontMatter[1].split(/\r?\n/).find(item => item.trim().startsWith(`${key}:`));
  if (!line) return '';
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
};

const readSkillActions = async (dir: string) => {
  const actionPath = path.join(dir, 'actions.json');
  try {
    const raw = await fs.readFile(actionPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    if (Array.isArray(parsed)) return parsed;
    const actions = (parsed as { actions?: unknown }).actions;
    return Array.isArray(actions) ? actions : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`Failed to read skill actions from ${actionPath}:`, error);
    return [];
  }
};

const listSkillFiles = async (dir: string, depth: number, found: string[] = []): Promise<string[]> => {
  if (depth < 0) return found;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(entryPath);
      continue;
    }

    if (entry.isDirectory()) {
      await listSkillFiles(entryPath, depth - 1, found);
    }
  }

  return found;
};

const defaultSkillRoots = (root: string, bridgeConfig: BridgeConfig) => {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    path.join(root, 'skills'),
    path.join(root, '.magi', 'skills'),
    path.join(codexHome, 'skills'),
    path.join(codexHome, 'skills', '.system'),
    path.join(codexHome, 'plugins', 'cache'),
    ...(bridgeConfig.skillRoots || []),
  ];
};

const scanSkills = async (root: string, bridgeConfig: BridgeConfig) => {
  const roots = defaultSkillRoots(root, bridgeConfig);
  const skillFiles: string[] = [];

  await Promise.all(roots.map(async skillRoot => {
    const depth = skillRoot.includes(path.join('.codex', 'plugins', 'cache')) ? 7 : 4;
    const files = await listSkillFiles(skillRoot, depth);
    skillFiles.push(...files);
  }));

  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const skillPath of skillFiles) {
    const dir = path.dirname(skillPath);
    const content = await fs.readFile(skillPath, 'utf8');
    const name = parseFrontMatterValue(content, 'name') || path.basename(dir);
    const description = parseFrontMatterValue(content, 'description');
    const actions = await readSkillActions(dir);
    const id = normalizeId(name);
    const uniqueKey = `${id}:${dir}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    skills.push({ id, name, description, dir, skillPath, actions });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
};

const resolveSkill = async (root: string, bridgeConfig: BridgeConfig, skillName: string) => {
  const skills = await scanSkills(root, bridgeConfig);
  const target = normalizeId(skillName);
  return skills.find(skill =>
    skill.id === target ||
    normalizeId(path.basename(skill.dir)) === target ||
    normalizeId(skill.name) === target,
  ) || null;
};

const runSkill = async (
  root: string,
  bridgeConfig: BridgeConfig,
  args: Record<string, unknown>,
) => {
  const skillName = typeof args.skill === 'string' ? args.skill : '';
  if (!skillName) throw new Error('skill.run requires arguments.skill');

  const skill = await resolveSkill(root, bridgeConfig, skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);

  const skillMarkdown = await fs.readFile(skill.skillPath, 'utf8');
  const mode = typeof args.mode === 'string' ? args.mode : 'load';
  const task = typeof args.task === 'string' ? args.task : '';

  if (mode !== 'script') {
    return {
      type: 'skill',
      mode: 'load',
      skill,
      task,
      content: skillMarkdown,
    };
  }

  if (!bridgeConfig.allowSkillScripts) {
    throw new Error('Skill script execution is disabled. Set allowSkillScripts in magi.bridge.json to opt in.');
  }

  const script = typeof args.script === 'string' ? args.script : '';
  if (!script) throw new Error('skill.run script mode requires arguments.script');

  const scriptPath = path.resolve(skill.dir, script);
  const realSkillDir = await fs.realpath(skill.dir);
  const realScriptPath = await fs.realpath(scriptPath);
  if (!realScriptPath.startsWith(realSkillDir + path.sep)) {
    throw new Error('Script path must stay inside the skill directory.');
  }

  const ext = path.extname(realScriptPath).toLowerCase();
  const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const command = ext === '.py'
    ? 'python'
    : ext === '.ps1'
      ? 'powershell'
      : 'node';
  const commandArgs = ext === '.ps1'
    ? ['-ExecutionPolicy', 'Bypass', '-File', realScriptPath, ...scriptArgs]
    : [realScriptPath, ...scriptArgs];

  const result = await runCommand(command, commandArgs, {
    cwd: skill.dir,
    timeoutMs: bridgeConfig.commandTimeoutMs || 120000,
  });

  return {
    type: 'skill',
    mode: 'script',
    skill,
    task,
    script: path.relative(skill.dir, realScriptPath),
    result,
  };
};

const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
) => new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    shell: isWindows,
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  child.on('error', error => {
    clearTimeout(timer);
    reject(error);
  });

  child.on('close', code => {
    clearTimeout(timer);
    resolve({
      stdout: stdout.slice(-100000),
      stderr: stderr.slice(-100000),
      exitCode: code,
    });
  });
});

const decodeHtmlEntities = (value: string) => value
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const htmlToReadableText = (html: string) => decodeHtmlEntities(html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

const runWebFetch = async (args: Record<string, unknown>) => {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('web.fetch requires arguments.url');

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('web.fetch only supports http and https URLs.');
  }

  const maxChars = Math.max(1000, Math.min(200000, Number(args.maxChars || 60000)));
  const response = await fetch(parsed.toString(), {
    headers: {
      Accept: 'text/html, text/plain, application/json;q=0.8, */*;q=0.5',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': 'MAGI-Harness/0.8 (+local verification)',
    },
    redirect: 'follow',
  });

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  const title = contentType.includes('text/html')
    ? decodeHtmlEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '')
    : '';
  const content = contentType.includes('text/html')
    ? htmlToReadableText(raw)
    : raw.replace(/\s+/g, ' ').trim();

  return {
    type: 'web',
    action: 'fetch',
    ok: response.ok,
    status: response.status,
    url: response.url,
    title,
    contentType,
    content: content.slice(0, maxChars),
    truncated: content.length > maxChars,
  };
};

class StdioMcpClient {
  private child: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stderr = '';

  constructor(private server: McpServerConfig) {
    if (!server.command) throw new Error('stdio MCP server requires command');
    this.child = spawn(server.command, server.args || [], {
      cwd: server.cwd,
      env: { ...process.env, ...(server.env || {}) },
      shell: isWindows,
      windowsHide: true,
    });

    this.child.stdout.on('data', chunk => this.handleStdout(chunk.toString('utf8')));
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk.toString('utf8');
      this.stderr = this.stderr.slice(-100000);
    });
    this.child.on('error', error => this.rejectAll(error));
    this.child.on('close', code => this.rejectAll(new Error(`MCP server exited with code ${code}. ${this.stderr}`)));
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'magi-harness-bridge',
        version: '0.1.0',
      },
    });
    this.notification('notifications/initialized', {});
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name: string, toolArguments: Record<string, unknown>) {
    return this.request('tools/call', {
      name,
      arguments: toolArguments,
    });
  }

  close() {
    this.child.kill();
  }

  private request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    const timeoutMs = this.server.timeoutMs || 120000;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notification(method: string, params: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private handleStdout(chunk: string) {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');
      if (!line) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || 'MCP request failed'));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error) {
    this.pending.forEach(pending => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
  }
}

const parseSseJson = (text: string, requestId: number) => {
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    const message = JSON.parse(data);
    if (message.id === requestId) return message.result;
  }
  throw new Error('SSE response did not include the requested MCP result.');
};

const postMcpHttp = async (
  url: string,
  message: Record<string, unknown>,
  sessionId?: string,
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });

  if (message.id === undefined) {
    if (response.status !== 202 && !response.ok) {
      throw new Error(`MCP notification failed: ${response.status}`);
    }
    return { result: null, sessionId };
  }

  if (!response.ok) {
    throw new Error(`MCP HTTP request failed: ${response.status}`);
  }

  const nextSessionId = response.headers.get('Mcp-Session-Id') || sessionId;
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/event-stream')) {
    const result = parseSseJson(await response.text(), Number(message.id));
    return { result, sessionId: nextSessionId };
  }

  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'MCP HTTP request failed');
  return { result: payload.result, sessionId: nextSessionId };
};

const runHttpMcp = async (
  server: McpServerConfig,
  action: 'listTools' | 'callTool',
  toolName?: string,
  toolArguments: Record<string, unknown> = {},
) => {
  if (!server.url) throw new Error('streamableHttp MCP server requires url');
  let sessionId: string | undefined;
  let id = 1;

  const initialized = await postMcpHttp(server.url, {
    jsonrpc: '2.0',
    id: id++,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'magi-harness-bridge',
        version: '0.1.0',
      },
    },
  });
  sessionId = initialized.sessionId;

  await postMcpHttp(server.url, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }, sessionId);

  const response = await postMcpHttp(server.url, {
    jsonrpc: '2.0',
    id: id++,
    method: action === 'listTools' ? 'tools/list' : 'tools/call',
    params: action === 'listTools'
      ? {}
      : {
        name: toolName,
        arguments: toolArguments,
      },
  }, sessionId);

  return response.result;
};

const callMcp = async (
  root: string,
  mcpConfig: McpConfig,
  args: Record<string, unknown>,
  action: 'listTools' | 'callTool',
  stdioClients?: Map<string, StdioMcpClient>,
) => {
  const serverName = typeof args.server === 'string' ? args.server : '';
  if (!serverName) throw new Error('mcp.call requires arguments.server');

  const server = mcpConfig.servers?.[serverName];
  if (!server) throw new Error(`MCP server not configured: ${serverName}`);

  const toolName = typeof args.tool === 'string' ? args.tool : '';
  const toolArguments = isRecord(args.arguments) ? args.arguments : {};
  const transport = server.transport || 'stdio';

  if (action === 'callTool' && !toolName) {
    throw new Error('mcp.call requires arguments.tool');
  }

  if (transport === 'streamableHttp') {
    return {
      type: 'mcp',
      server: serverName,
      transport,
      action,
      result: await runHttpMcp(server, action, toolName, toolArguments),
    };
  }

  const clientKey = `${serverName}:${JSON.stringify(server)}`;
  let client = stdioClients?.get(clientKey);

  try {
    if (!client) {
      client = new StdioMcpClient({
        ...server,
        cwd: server.cwd ? path.resolve(root, server.cwd) : root,
      });
      await client.initialize();
      stdioClients?.set(clientKey, client);
    }

    const result = action === 'listTools'
      ? await client.listTools()
      : await client.callTool(toolName, toolArguments);
    return {
      type: 'mcp',
      server: serverName,
      transport: 'stdio',
      action,
      result,
    };
  } catch (error) {
    if (client && stdioClients?.has(clientKey)) {
      client.close();
      stdioClients.delete(clientKey);
    }
    throw error;
  } finally {
    if (!stdioClients) client?.close();
  }
};

const executeTool = async (
  root: string,
  bridgeConfig: BridgeConfig,
  mcpConfig: McpConfig,
  input: ToolExecutionInput,
  stdioClients?: Map<string, StdioMcpClient>,
) => {
  if (input.toolId === 'web.fetch') {
    return runWebFetch(input.arguments || {});
  }

  if (input.toolId === 'skill.run') {
    return runSkill(root, bridgeConfig, input.arguments || {});
  }

  if (input.toolId === 'mcp.call') {
    return callMcp(root, mcpConfig, input.arguments || {}, 'callTool', stdioClients);
  }

  throw new Error(`Unsupported bridge tool: ${input.toolId}`);
};

export const harnessBridgePlugin = (root: string): Plugin => ({
  name: 'magi-harness-bridge',
  configureServer(server) {
    const stdioClients = new Map<string, StdioMcpClient>();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      stdioClients.forEach(client => client.close());
      stdioClients.clear();
    };
    const registerCleanup = () => {
      server.httpServer?.once('close', cleanup);
      server.watcher?.once('close', cleanup);
    };
    registerCleanup();

    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/harness/bridge')) {
        next();
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      const bridgeConfigPath = await findFirstExistingFile(root, BRIDGE_CONFIG_FILES);
      const mcpConfigPath = await findFirstExistingFile(root, MCP_CONFIG_FILES);
      const bridgeConfig = await readJsonFile<BridgeConfig>(bridgeConfigPath, {});
      const mcpConfig = await readJsonFile<McpConfig>(mcpConfigPath, { servers: {} });

      try {
        if (req.method === 'GET' && requestUrl.pathname === '/api/harness/bridge/status') {
          const skills = await scanSkills(root, bridgeConfig);
          const storage = await getStorageStatus(root);
          const auditDir = getAuditDir(root);
          const artifactDir = getArtifactDir(root);
          sendJson(res, 200, {
            ok: true,
            cwd: root,
            bridgeConfigPath,
            mcpConfigPath,
            storage,
            auditDir,
            artifactDir,
            allowSkillScripts: Boolean(bridgeConfig.allowSkillScripts),
            skills: skills.map(skill => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              dir: skill.dir,
              actions: skill.actions || [],
            })),
            mcpServers: Object.keys(mcpConfig.servers || {}),
          });
          return;
        }

        const auditMatch = requestUrl.pathname.match(/^\/api\/harness\/bridge\/audit\/([^/]+)$/);
        if (auditMatch && req.method === 'GET') {
          const limit = Math.max(1, Math.min(1000, Number(requestUrl.searchParams.get('limit') || 200)));
          const audit = await readAuditEvents(root, decodeURIComponent(auditMatch[1]), limit);
          sendJson(res, 200, {
            ok: true,
            ...audit,
          });
          return;
        }

        if (auditMatch && req.method === 'POST') {
          const body = await readRequestBody(req);
          const events = isRecord(body) && Array.isArray(body.events) ? body.events : [];
          const audit = await appendAuditEvents(root, decodeURIComponent(auditMatch[1]), events);
          sendJson(res, 200, {
            ok: true,
            ...audit,
          });
          return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/harness/bridge/storage/status') {
          sendJson(res, 200, {
            ok: true,
            storage: await getStorageStatus(root),
          });
          return;
        }

        const storageMatch = requestUrl.pathname.match(/^\/api\/harness\/bridge\/storage\/([a-z0-9_-]+)$/);
        if (storageMatch && req.method === 'GET') {
          const state = await readState(root, storageMatch[1]);
          sendJson(res, 200, {
            ok: true,
            ...state,
          });
          return;
        }

        if (storageMatch && req.method === 'POST') {
          const body = await readRequestBody(req);
          const filePath = await writeState(root, storageMatch[1], body);
          sendJson(res, 200, {
            ok: true,
            filePath,
          });
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/harness/bridge/tools/execute') {
          const body = await readRequestBody(req) as ToolExecutionInput;
          const startedAt = Date.now();
          const result = await executeTool(root, bridgeConfig, mcpConfig, body, stdioClients);
          sendJson(res, 200, {
            ok: true,
            actor: body.actor || 'HARNESS',
            toolId: body.toolId,
            latencyMs: Date.now() - startedAt,
            result,
          });
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/harness/bridge/mcp/list-tools') {
          const body = await readRequestBody(req);
          const result = await callMcp(root, mcpConfig, isRecord(body) ? body : {}, 'listTools', stdioClients);
          sendJson(res, 200, { ok: true, result });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'Unknown harness bridge route' });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'Harness bridge error',
        });
      }
    });

    return () => {
      registerCleanup();
    };
  },
});
