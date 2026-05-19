import OpenAI from 'openai';
import {
  ClarificationRequest,
  CouncilExchange,
  DocumentOperation,
  GroundingSource,
  HarnessDocumentId,
  HarnessDocuments,
  HarnessSettings,
  Language,
  MagiAnalysis,
  MagiResponse,
  MagiSystem,
  MemoryItem,
  Message,
  PendingAction,
  PendingActionRisk,
  SessionTraceStep,
  StreamEvent,
  TextDeltaEvent,
  SkillActionManifest,
  SkillActionSymbolRule,
  ToolAccessKey,
  ToolAccessMode,
  ToolId,
  ToolTrace,
  AuditEvent,
  AuditRef,
} from '../types';
import {
  getPersonaDocumentId,
  getPersonaMemoryDocumentId,
  hasToolPermission,
  normalizeToolAccessMatrix,
  normalizeRuntimeBudgets,
  TOOL_ACCESS_DEFINITIONS,
} from './harnessService';
import { appendAuditEvents, BridgeSkill, BridgeStatus, executeBridgeTool, getBridgeStatus, listMcpTools } from './bridgeService';

interface MagiHarnessContext {
  settings: HarnessSettings;
  documents: HarnessDocuments;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface WebFetchResult {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
}

interface SystemConfig {
  name: string;
  archetype: string;
}

interface PlannedToolRequest {
  toolId: ToolId;
  arguments?: Record<string, unknown>;
  reason?: string;
  metadata?: {
    skillActionId?: string;
    readOnly?: boolean;
    preferredOwner?: MagiSystem;
    dedupeKey?: string;
    skipFallbackToolsOnSuccess?: boolean;
  };
}

interface QueryMagiOptions {
  onEvent?: (event: StreamEvent) => void;
  onTextDelta?: (event: TextDeltaEvent) => void;
  sessionId?: string;
  runId?: string;
}

interface PersonaQueryResult extends MagiAnalysis {
  groundingSources: GroundingSource[];
  pendingActions: PendingAction[];
  streamEvents: StreamEvent[];
}

interface ToolRiskAssessment {
  risk: PendingActionRisk;
  requiresApproval: boolean;
  summary: string;
}

interface ToolExecutionResult {
  sources: GroundingSource[];
  toolTraces: ToolTrace[];
  pendingActions: PendingAction[];
  streamEvents: StreamEvent[];
  toolResultBlocks: string[];
}

interface RuntimeMcpTool {
  name: string;
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  inputSchema?: unknown;
}

interface RuntimeMcpServerTools {
  server: string;
  tools: RuntimeMcpTool[];
  error?: string;
}

interface RuntimeCapabilities {
  bridge?: BridgeStatus;
  mcpServers: RuntimeMcpServerTools[];
  loadedSkills?: RuntimeLoadedSkill[];
  errors: string[];
}

interface RuntimeLoadedSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  score: number;
  reason: string;
}

const systemConfigs: Record<MagiSystem, SystemConfig> = {
  [MagiSystem.MELCHIOR]: {
    name: 'MELCHIOR-1',
    archetype: 'SCIENTIST',
  },
  [MagiSystem.BALTHASAR]: {
    name: 'BALTHASAR-2',
    archetype: 'GUARDIAN',
  },
  [MagiSystem.CASPER]: {
    name: 'CASPER-3',
    archetype: 'CATALYST',
  },
};

const knownDocumentIds: HarnessDocumentId[] = [
  'persona.melchior',
  'persona.balthasar',
  'persona.casper',
  'memory.shared',
  'memory.melchior',
  'memory.balthasar',
  'memory.casper',
  'council.protocol',
  'registry.tools',
  'registry.skills',
  'registry.mcp',
];

const safeParse = (text: string, archetype?: string) => {
  let cleaned = text.trim();

  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.warn(
      `【${archetype || 'SYNTHESIS'}】JSON parse failed; using fallback when available. ` +
      truncateForPrompt(text.replace(/\s+/g, ' '), 500),
    );
    throw new Error('Invalid JSON response from model');
  }
};

const tryParseJsonObject = (text: string) => {
  let cleaned = text.trim();
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(cleaned);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Node Timeout ${ms}ms`)), ms),
    ),
  ]);

const createClient = (settings: HarnessSettings) => {
  const apiKey = settings.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = settings.baseURL || process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    throw new Error('Missing API key');
  }

  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
    dangerouslyAllowBrowser: true,
  });
};

const getModelName = (settings: HarnessSettings) => {
  const modelName = settings.modelName || process.env.OPENAI_MODEL_NAME;
  if (!modelName) {
    throw new Error('Missing model name');
  }
  return modelName;
};

const createChatParams = (
  settings: HarnessSettings,
  body: {
    model: string;
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | null;
      tool_call_id?: string;
      tool_calls?: unknown[];
    }>;
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    stream?: boolean;
    tools?: unknown[];
    tool_choice?: 'auto' | 'none';
  },
) => {
  const params: Record<string, unknown> = { ...body };
  if (settings.reasoningEnabled) {
    params.reasoning_effort = settings.reasoningEffort;
  }
  return params;
};

const getRuntimeBudgets = (settings: HarnessSettings) => normalizeRuntimeBudgets(settings.runtimeBudgets);

const requestJsonObject = async (
  client: OpenAI,
  settings: HarnessSettings,
  modelName: string,
  label: string,
  promptText: string,
  options: {
    maxTokens: number;
    retryMaxTokens?: number;
    temperature?: number;
    repairInstruction?: string;
    onRetry?: (attempt: number, reason: string, preview?: string) => void;
  },
) => {
  const budgets = getRuntimeBudgets(settings);
  let lastText = '';
  let lastReason = 'unknown';
  const attempts = Math.max(1, budgets.jsonRepairMaxAttempts + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isRepair = attempt > 0;
    const content = isRepair
      ? `${options.repairInstruction || 'Repair the previous invalid JSON response.'}

Return one valid JSON object only. No markdown, no commentary.

## Original Task
${promptText}

## Invalid Previous Response
${truncateForPrompt(lastText || '[empty response]', 6000)}

## Failure
${lastReason}`
      : promptText;
    if (isRepair) options.onRetry?.(attempt, lastReason, truncateForPrompt(lastText || '', 500));

    const response = await client.chat.completions.create(createChatParams(settings, {
      model: modelName,
      messages: [{ role: 'system', content }],
      temperature: isRepair ? 0.1 : options.temperature ?? 0.6,
      max_tokens: isRepair ? options.retryMaxTokens || options.maxTokens : options.maxTokens,
      response_format: { type: 'json_object' },
    }) as any);

    const text = response.choices[0]?.message?.content || '';
    lastText = text;
    if (!text.trim()) {
      lastReason = `${label} Silence`;
      continue;
    }

    try {
      return tryParseJsonObject(text);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : 'Invalid JSON response from model';
    }
  }

  console.warn(`【${label}】JSON failed after repair attempts. ${truncateForPrompt(lastText.replace(/\s+/g, ' '), 500)}`);
  throw new Error(lastReason.includes('Silence') ? lastReason : 'Invalid JSON response from model');
};

export const testModelConnection = async (settings: HarnessSettings) => {
  const startedAt = Date.now();
  const client = createClient(settings);
  const modelName = getModelName(settings);

  const response = await client.chat.completions.create(createChatParams(settings, {
    model: modelName,
    messages: [
      {
        role: 'system',
        content: 'You are a connection test endpoint. Reply with MAGI_OK only.',
      },
      {
        role: 'user',
        content: 'ping',
      },
    ],
    temperature: 0,
    max_tokens: 16,
  }) as any);

  return {
    modelName,
    latencyMs: Date.now() - startedAt,
    output: response.choices[0]?.message?.content?.trim() || '',
  };
};

const searchTavily = async (
  query: string,
  settings: HarnessSettings,
): Promise<{ results: TavilyResult[]; sources: GroundingSource[] }> => {
  const apiKey = settings.tavilyApiKey ||
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TAVILY_API_KEY ||
    process.env.VITE_TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('Tavily API key not found, skipping search.');
    return { results: [], sources: [] };
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        include_answer: false,
        max_results: 3,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const results = (data.results || []).map((result: any) => ({
      title: result.title,
      url: result.url,
      content: result.content,
    }));

    return {
      results,
      sources: results.map((result: TavilyResult) => ({
        title: result.title,
        uri: result.url,
      })),
    };
  } catch (error) {
    console.error('Search failed:', error);
    return { results: [], sources: [] };
  }
};

const truncateForPrompt = (value: unknown, maxLength = 6000) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
};

const compactForTrace = (
  value: unknown,
  options: { maxDepth: number; maxString: number; maxArrayItems: number; maxObjectKeys: number },
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === 'string') {
    return value.length > options.maxString
      ? `${value.slice(0, options.maxString)}\n...[truncated ${value.length - options.maxString} chars]`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= options.maxDepth) return '[Max depth reached]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, options.maxArrayItems)
      .map(item => compactForTrace(item, options, depth + 1, seen));
    if (value.length > options.maxArrayItems) {
      items.push(`[...${value.length - options.maxArrayItems} more item(s)]`);
    }
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const compacted: Record<string, unknown> = {};
  entries.slice(0, options.maxObjectKeys).forEach(([key, item]) => {
    compacted[key] = compactForTrace(item, options, depth + 1, seen);
  });
  if (entries.length > options.maxObjectKeys) {
    compacted.__truncatedKeys = entries.length - options.maxObjectKeys;
  }
  return compacted;
};

const stringifyTraceDetails = (value: unknown, maxLength = 12000) => {
  const passes = [
    { maxDepth: 8, maxString: 2400, maxArrayItems: 30, maxObjectKeys: 80 },
    { maxDepth: 6, maxString: 900, maxArrayItems: 16, maxObjectKeys: 45 },
    { maxDepth: 5, maxString: 320, maxArrayItems: 10, maxObjectKeys: 28 },
  ];

  for (const options of passes) {
    const text = JSON.stringify(compactForTrace(value, options), null, 2);
    if (text.length <= maxLength) return text;
  }

  return JSON.stringify({
    __truncated: true,
    preview: truncateForPrompt(value, maxLength - 200),
  }, null, 2);
};

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const makeStreamEvent = (
  phase: string,
  actor: string,
  status: StreamEvent['status'],
  message: string,
  details?: string,
): StreamEvent => ({
  id: makeId('event'),
  phase,
  actor,
  status,
  message,
  timestamp: Date.now(),
  details,
});

const emitStreamEvent = (
  streamEvents: StreamEvent[],
  onEvent: QueryMagiOptions['onEvent'] | undefined,
  phase: string,
  actor: string,
  status: StreamEvent['status'],
  message: string,
  details?: string,
) => {
  const event = makeStreamEvent(phase, actor, status, message, details);
  streamEvents.push(event);
  onEvent?.(event);
  return event;
};

const emitTextDelta = (
  onTextDelta: QueryMagiOptions['onTextDelta'] | undefined,
  delta: string,
  fullText: string,
) => {
  const event: TextDeltaEvent = {
    id: makeId('delta'),
    role: 'synthesis',
    delta,
    fullText,
    timestamp: Date.now(),
  };
  onTextDelta?.(event);
  return event;
};

const makeAuditEvent = (
  sessionId: string,
  runId: string,
  phase: string,
  actor: string,
  status: string,
  summary: string,
  kind: AuditEvent['kind'],
  details?: unknown,
  timestamp = Date.now(),
): AuditEvent => ({
  id: makeId('audit'),
  sessionId,
  runId,
  timestamp,
  phase,
  actor,
  status,
  summary,
  details,
  kind,
});

const buildAuditEvents = (
  sessionId: string,
  runId: string,
  streamEvents: StreamEvent[],
  trace: SessionTraceStep[],
  toolTraces: ToolTrace[],
  pendingActions: PendingAction[],
  finalSynthesis: string,
): AuditEvent[] => [
  ...streamEvents.map(event => makeAuditEvent(
    sessionId,
    runId,
    event.phase,
    event.actor,
    event.status,
    event.message,
    'stream',
    { details: event.details, metadata: event.metadata },
    event.timestamp,
  )),
  ...trace.map(step => makeAuditEvent(
    sessionId,
    runId,
    step.phase,
    step.actor,
    step.status,
    step.summary,
    'trace',
    step.details,
    step.timestamp,
  )),
  ...toolTraces.map(traceItem => makeAuditEvent(
    sessionId,
    runId,
    'tool',
    traceItem.systemName,
    traceItem.status,
    `${traceItem.toolId}: ${traceItem.summary || traceItem.query || traceItem.status}`,
    'tool',
    traceItem.details,
  )),
  ...pendingActions.map(action => makeAuditEvent(
    sessionId,
    runId,
    'approval',
    action.actor,
    action.status,
    `${action.toolId}: ${action.reason}`,
    'approval',
    {
      actionId: action.id,
      risk: action.risk,
      requiresApproval: action.requiresApproval,
      arguments: action.arguments,
      result: action.result,
      error: action.error,
    },
    action.createdAt,
  )),
  makeAuditEvent(
    sessionId,
    runId,
    'synthesis',
    'COUNCIL',
    'complete',
    'Final synthesis text recorded.',
    'synthesis',
    finalSynthesis,
  ),
];

const normalizeClarificationRequests = (
  rawRequests: unknown,
  fallbackReason?: string,
): ClarificationRequest[] => {
  if (!Array.isArray(rawRequests)) return [];

  return rawRequests
    .map((request): ClarificationRequest | null => {
      if (typeof request === 'string') {
        return {
          id: makeId('clarify'),
          question: request.trim(),
          reason: fallbackReason,
          required: true,
        };
      }

      if (!request || typeof request !== 'object') return null;
      const candidate = request as Partial<ClarificationRequest>;
      if (typeof candidate.question !== 'string' || !candidate.question.trim()) return null;

      return {
        id: typeof candidate.id === 'string' && candidate.id ? candidate.id : makeId('clarify'),
        question: candidate.question.trim(),
        reason: typeof candidate.reason === 'string' ? candidate.reason : fallbackReason,
        required: candidate.required !== false,
      };
    })
    .filter((request): request is ClarificationRequest => Boolean(request))
    .slice(0, 5);
};

const readOnlyMcpToolPattern = /^(read|list|get|search|find|stat|describe|inspect|directory_tree|list_allowed|browser_navigate|browser_read_page|browser_screenshot|browser_close)/i;
const mutatingMcpToolPattern = /(^|_)(write|edit|delete|remove|move|rename|create|mkdir|touch|patch|update|replace|append|run|execute|shell|command|click|type|fill|submit)($|_)/i;
const browserReadTools = new Set(['browser_navigate', 'browser_read_page', 'browser_screenshot', 'browser_close']);
const browserInteractTools = new Set(['browser_click', 'browser_type']);

const isReadOnlyMcpToolName = (toolName: string) =>
  readOnlyMcpToolPattern.test(toolName) && !mutatingMcpToolPattern.test(toolName);

const getToolAccessKey = (request: PlannedToolRequest): ToolAccessKey => {
  if (request.toolId === 'web.search.tavily') return 'web.search.tavily';
  if (request.toolId === 'web.fetch') return 'web.fetch';

  if (request.toolId === 'skill.run') {
    const mode = typeof request.arguments?.mode === 'string'
      ? request.arguments.mode.toLowerCase()
      : 'load';
    return mode === 'load' ? 'skill.run.load' : 'skill.run.script';
  }

  const server = typeof request.arguments?.server === 'string'
    ? request.arguments.server.toLowerCase()
    : '';
  const toolName = typeof request.arguments?.tool === 'string'
    ? request.arguments.tool.toLowerCase()
    : '';

  if (server === 'filesystem') {
    return isReadOnlyMcpToolName(toolName) ? 'mcp.filesystem.read' : 'mcp.filesystem.write';
  }

  if (server === 'browser') {
    if (browserReadTools.has(toolName)) return 'mcp.browser.read';
    if (browserInteractTools.has(toolName)) return 'mcp.browser.interact';
    return isReadOnlyMcpToolName(toolName) ? 'mcp.browser.read' : 'mcp.browser.interact';
  }

  return isReadOnlyMcpToolName(toolName) ? 'mcp.other.read' : 'mcp.other.write';
};

const getToolAccessModeForKey = (
  settings: HarnessSettings,
  systemType: MagiSystem,
  accessKey: ToolAccessKey,
): ToolAccessMode => normalizeToolAccessMatrix(settings.toolAccess)[systemType][accessKey];

const getToolAccessMode = (
  settings: HarnessSettings,
  systemType: MagiSystem,
  request: PlannedToolRequest,
): ToolAccessMode => getToolAccessModeForKey(settings, systemType, getToolAccessKey(request));

const getPreferredOwnersForAccessKey = (accessKey: ToolAccessKey): MagiSystem[] => {
  if (accessKey === 'web.search.tavily') return [MagiSystem.MELCHIOR, MagiSystem.CASPER, MagiSystem.BALTHASAR];
  if (accessKey === 'web.fetch') return [MagiSystem.MELCHIOR, MagiSystem.CASPER, MagiSystem.BALTHASAR];
  if (accessKey.startsWith('mcp.browser')) return [MagiSystem.CASPER, MagiSystem.MELCHIOR, MagiSystem.BALTHASAR];
  if (accessKey.startsWith('mcp.filesystem')) return [MagiSystem.MELCHIOR, MagiSystem.BALTHASAR, MagiSystem.CASPER];
  if (accessKey.startsWith('skill.run')) return [MagiSystem.BALTHASAR, MagiSystem.CASPER, MagiSystem.MELCHIOR];
  return [MagiSystem.BALTHASAR, MagiSystem.MELCHIOR, MagiSystem.CASPER];
};

const canPersonaRequestAccessKey = (
  settings: HarnessSettings,
  systemType: MagiSystem,
  accessKey: ToolAccessKey,
) => getToolAccessModeForKey(settings, systemType, accessKey) !== 'deny';

const shouldSuggestForPersona = (
  settings: HarnessSettings,
  systemType: MagiSystem,
  accessKey: ToolAccessKey,
) => {
  const preferredOwner = getPreferredOwnersForAccessKey(accessKey)
    .find(candidate => canPersonaRequestAccessKey(settings, candidate, accessKey));
  return preferredOwner === systemType;
};

const canPersonaRequestTool = (
  harness: MagiHarnessContext,
  systemType: MagiSystem,
  request: PlannedToolRequest,
) =>
  hasToolPermission(harness.documents, systemType, request.toolId) &&
  getToolAccessMode(harness.settings, systemType, request) !== 'deny';

const filterToolRequestsForPersona = (
  requests: PlannedToolRequest[],
  harness: MagiHarnessContext,
  systemType: MagiSystem,
) => requests.filter(request => canPersonaRequestTool(harness, systemType, request));

const formatToolAccessForPersona = (settings: HarnessSettings, systemType: MagiSystem) => {
  const matrix = normalizeToolAccessMatrix(settings.toolAccess)[systemType];
  return TOOL_ACCESS_DEFINITIONS
    .map(definition => `- ${definition.key}: ${matrix[definition.key]} (${definition.label})`)
    .join('\n');
};

const requireReviewByMatrix = (
  request: PlannedToolRequest,
  assessment: ToolRiskAssessment,
  accessKey: ToolAccessKey,
): ToolRiskAssessment => {
  if (assessment.requiresApproval) return assessment;
  return {
    risk: assessment.risk === 'low' ? 'medium' : assessment.risk,
    requiresApproval: true,
    summary: `Tool Access Matrix marks ${accessKey} as ASK/review. ${assessment.summary}`,
  };
};

const isReadOnlySkillActionScript = (request: PlannedToolRequest) =>
  request.toolId === 'skill.run' &&
  request.metadata?.readOnly === true &&
  typeof request.arguments?.mode === 'string' &&
  request.arguments.mode.toLowerCase() === 'script';

const assessToolRequestRisk = (request: PlannedToolRequest): ToolRiskAssessment => {
  const args = request.arguments || {};

  if (request.toolId === 'web.search.tavily' || request.toolId === 'web.fetch') {
    return {
      risk: 'low',
      requiresApproval: false,
      summary: `${request.toolId} is read-only and can run without approval.`,
    };
  }

  if (request.toolId === 'skill.run') {
    const mode = typeof args.mode === 'string' ? args.mode.toLowerCase() : 'load';
    if (mode === 'load') {
      return {
        risk: 'low',
        requiresApproval: false,
        summary: 'Skill loading only reads SKILL.md instructions.',
      };
    }

    return {
      risk: isReadOnlySkillActionScript(request) ? 'low' : mode === 'script' ? 'high' : 'medium',
      requiresApproval: !isReadOnlySkillActionScript(request),
      summary: isReadOnlySkillActionScript(request)
        ? 'Skill action manifest marks this script as a read-only lookup.'
        : `Skill mode "${mode}" may execute local workflow logic and needs approval.`,
    };
  }

  const toolName = typeof args.tool === 'string' ? args.tool : '';
  if (!toolName) {
    return {
      risk: 'medium',
      requiresApproval: true,
      summary: 'MCP tool name is missing, so the action needs human review.',
    };
  }

  if (isReadOnlyMcpToolName(toolName)) {
    return {
      risk: 'low',
      requiresApproval: false,
      summary: `MCP tool "${toolName}" looks read-only.`,
    };
  }

  if (mutatingMcpToolPattern.test(toolName)) {
    return {
      risk: 'high',
      requiresApproval: true,
      summary: `MCP tool "${toolName}" can mutate local state and needs approval.`,
    };
  }

  return {
    risk: 'medium',
    requiresApproval: true,
    summary: `MCP tool "${toolName}" is not classified as read-only.`,
  };
};

const makePendingAction = (
  actor: string,
  request: PlannedToolRequest,
  assessment: ToolRiskAssessment,
): PendingAction => ({
  id: makeId('action'),
  actor,
  toolId: request.toolId,
  arguments: request.arguments || {},
  reason: request.reason || assessment.summary,
  risk: assessment.risk,
  requiresApproval: assessment.requiresApproval,
  status: 'pending',
  createdAt: Date.now(),
});

const formatPendingActions = (actions: PendingAction[]) =>
  actions.length > 0
    ? actions.map(action =>
      `[${action.id}] ${action.actor} -> ${action.toolId} risk=${action.risk} status=${action.status}\nReason: ${action.reason}\nArguments: ${truncateForPrompt(action.arguments, 1200)}`,
    ).join('\n\n')
    : 'NO PENDING ACTIONS.';

const formatMeetingTranscript = (meeting: CouncilExchange[]) =>
  meeting.length > 0
    ? meeting.map(exchange =>
      `[ROUND ${exchange.round}] ${exchange.speaker}: ${exchange.content}\nRevised proposal: ${exchange.revisedProposal || 'UNCHANGED'}\nRevised vote: ${exchange.revisedVote === undefined ? 'UNCHANGED' : exchange.revisedVote ? 'APPROVE' : 'REJECT'}`,
    ).join('\n\n')
    : 'NO MEETING TRANSCRIPT.';

const extractMcpTools = (payload: unknown): RuntimeMcpTool[] => {
  if (!payload || typeof payload !== 'object') return [];
  const candidate = payload as {
    result?: { tools?: RuntimeMcpTool[] };
    tools?: RuntimeMcpTool[];
  };
  if (Array.isArray(candidate.result?.tools)) return candidate.result.tools;
  if (Array.isArray(candidate.tools)) return candidate.tools;
  return [];
};

const actionIntentPattern = /价格|当前|实时|报价|行情|查询|查|多少|price|quote|current|fetch|lookup|run|执行|获取/i;
const marketQuoteIntentPattern = /股价|股票|股票代码|行情|报价|证券|美股|港股|a股|沪市|深市|比特币|价格|price|quote|ticker|stock|share price|btc|bitcoin|crypto/i;

const getSkillActions = (runtime: RuntimeCapabilities | undefined) =>
  runtime?.bridge?.skills.flatMap(skill =>
    (skill.actions || []).map(action => ({ skill, action })),
  ) || [];

const skillKeywordHints: Record<string, string[]> = {
  'web-retrieval': ['web', 'search', 'fetch', 'lookup', 'news', 'weather', 'url', 'http', 'docs', 'documentation', '网页', '搜索', '检索', '联网', '查询', '新闻', '资料', '读取', '抓取', '来源', '事实'],
  'browser-verification': ['browser', 'ui', 'screenshot', 'dom', 'click', 'type', 'form', 'localhost', '127.0.0.1', '浏览器', '界面', '页面', '截图', '点击', '输入', '表单', '视觉', '本地页面'],
  'market-quote': ['stock', 'quote', 'ticker', 'price', 'btc', 'bitcoin', '行情', '股价', '股票', '报价', '美股', '港股', 'a股', '比特币'],
  'harness-engineering': ['harness', 'persona', 'memory', 'council', 'agent', 'trace', 'audit', 'settings', 'skill', 'tools', 'runtime', 'magi', '提示词', '人格', '记忆', '贤者', '审计', '设置', '权限', '重构', '范式'],
  'mcp-tool-authoring': ['mcp', 'server', 'json-rpc', 'stdio', 'tool schema', 'filesystem', 'browser mcp', '工具', '服务器', '文件系统', '权限', '审批', '桥接'],
};

const tokenizeForSkillRouting = (value: string) =>
  Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._:/-]+/gu, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2),
  ));

const skillRoutingText = (skill: BridgeSkill) =>
  `${skill.id} ${skill.name || ''} ${skill.description || ''} ${(skill.actions || []).map(action =>
    `${action.id} ${action.description || ''} ${(action.triggers || []).join(' ')}`,
  ).join(' ')}`;

const scoreSkillRelevance = (
  skill: BridgeSkill,
  userQuery: string,
  hasActionMatch: boolean,
) => {
  const query = userQuery.toLowerCase();
  const routingText = skillRoutingText(skill).toLowerCase();
  const queryTokens = tokenizeForSkillRouting(userQuery);
  const routingTokens = new Set(tokenizeForSkillRouting(routingText));
  const hints = skillKeywordHints[skill.id] || [];
  let score = 0;
  const reasons: string[] = [];

  if (query.includes(skill.id.toLowerCase()) || (skill.name && query.includes(skill.name.toLowerCase()))) {
    score += 30;
    reasons.push('skill id/name mentioned');
  }

  const matchedTokens = queryTokens.filter(token => routingTokens.has(token));
  if (matchedTokens.length > 0) {
    score += Math.min(18, matchedTokens.length * 3);
    reasons.push(`metadata overlap: ${matchedTokens.slice(0, 5).join(', ')}`);
  }

  const matchedHints = hints.filter(hint => query.includes(hint.toLowerCase()));
  if (matchedHints.length > 0) {
    score += Math.min(24, matchedHints.length * 6);
    reasons.push(`routing hints: ${matchedHints.slice(0, 5).join(', ')}`);
  }

  if (skill.id === 'market-quote' && hasActionMatch) {
    score += 16;
    reasons.push('matching market quote action');
  }

  if (skill.id === 'web-retrieval' && /检索|搜索|联网|网页|资料|新闻|查询|读取网页|source|search|fetch|lookup|news|docs|url|http/i.test(userQuery)) {
    score += 16;
    reasons.push('retrieval task');
  }

  if (skill.id === 'browser-verification' && userQueryBlocksBrowserMcp(userQuery)) {
    score -= 18;
    reasons.push('browser explicitly blocked');
  }

  if (skill.id === 'market-quote' && /论文|aigc|ai率|检测|学术|工具|skill|范式/i.test(userQuery) && !/股价|股票|行情|报价|ticker|stock|btc|比特币/i.test(userQuery)) {
    score -= 20;
    reasons.push('not a market quote task');
  }

  return { score, reason: reasons.join('; ') || 'weak metadata match' };
};

const selectRelevantSkills = (
  runtime: RuntimeCapabilities,
  userQuery: string,
  maxSkills = 3,
) => {
  const skills = runtime.bridge?.skills || [];
  if (skills.length === 0) return [];
  return skills
    .map(skill => ({
      skill,
      ...scoreSkillRelevance(
        skill,
        userQuery,
        (skill.actions || []).some(action => skillActionMatchesQuery(action, userQuery)),
      ),
    }))
    .filter(item => item.score >= 10)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, maxSkills);
};

const actionTriggersQuery = (action: SkillActionManifest, userQuery: string) => {
  const query = userQuery.toLowerCase();
  return (action.triggers || []).some(trigger => query.includes(trigger.toLowerCase()));
};

const applySymbolNormalization = (symbol: string, rule?: SkillActionSymbolRule) => {
  let normalized = symbol.trim().toUpperCase();
  const aliasTarget = Object.entries(rule?.aliases || {})
    .find(([alias]) => alias.toUpperCase() === normalized)?.[1];
  if (aliasTarget) normalized = aliasTarget.trim().toUpperCase();
  Object.entries(rule?.normalizeSuffixes || {}).forEach(([from, to]) => {
    if (normalized.endsWith(from.toUpperCase())) {
      normalized = `${normalized.slice(0, -from.length)}${to.toUpperCase()}`;
    }
  });
  return normalized;
};

const isBlockedSymbolCandidate = (candidate: string, rule?: SkillActionSymbolRule) => {
  const blocked = new Set((rule?.blockedWords || []).map(word => word.toUpperCase()));
  return blocked.has(candidate.toUpperCase());
};

const uniqueStrings = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const extractSkillActionSymbols = (action: SkillActionManifest, userQuery: string) => {
  const rule = action.symbol;
  if (!rule) return [];

  const upperQuery = userQuery.toUpperCase();
  const symbols: string[] = [];
  const acceptedRanges: Array<readonly [number, number]> = [];
  const isInsideAcceptedRange = (index: number) =>
    acceptedRanges.some(([start, end]) => index >= start && index < end);

  for (const [alias, symbol] of Object.entries(rule.aliases || {})) {
    if (upperQuery.includes(alias.toUpperCase())) {
      symbols.push(applySymbolNormalization(symbol, rule));
    }
  }

  for (const prefix of rule.contextualPrefixes || []) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}\\s*[:：]?\\s*([A-Za-z0-9.-]{2,12})`, 'gi');
    Array.from(userQuery.matchAll(regex)).forEach(match => {
      if (match?.[1] && !isBlockedSymbolCandidate(match[1], rule)) {
        symbols.push(applySymbolNormalization(match[1], rule));
        const start = (match.index || 0) + match[0].lastIndexOf(match[1]);
        acceptedRanges.push([start, start + match[1].length]);
      }
    });
  }

  const protectedRanges = (rule.contextualPrefixes || []).flatMap(prefix => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}\\s*[:：]?\\s*[A-Za-z0-9.-]{2,12}`, 'gi');
    return Array.from(userQuery.matchAll(regex)).map(match => [match.index || 0, (match.index || 0) + match[0].length] as const);
  });

  const isInsideProtectedRange = (index: number) =>
    protectedRanges.some(([start, end]) => index >= start && index < end);
  const orderedPatterns = (rule.patterns || []).slice().sort((left, right) => right.length - left.length);
  for (const pattern of orderedPatterns) {
    try {
      const regex = new RegExp(pattern, 'g');
      Array.from(userQuery.matchAll(regex)).forEach(match => {
        const candidate = match[0];
        const index = match.index || 0;
        if (!isBlockedSymbolCandidate(candidate, rule) && !isInsideProtectedRange(index) && !isInsideAcceptedRange(index)) {
          symbols.push(applySymbolNormalization(candidate, rule));
          acceptedRanges.push([index, index + candidate.length]);
        }
      });
    } catch {
      // Ignore malformed skill-provided patterns.
    }
  }

  return uniqueStrings(symbols);
};

const extractSkillActionSymbol = (action: SkillActionManifest, userQuery: string) => {
  return extractSkillActionSymbols(action, userQuery)[0] || '';
};

const skillActionMatchesQuery = (action: SkillActionManifest, userQuery: string) => {
  if (actionTriggersQuery(action, userQuery)) return true;
  const symbol = extractSkillActionSymbol(action, userQuery);
  const actionText = `${action.description || ''} ${(action.triggers || []).join(' ')}`.toLowerCase();
  const intentPattern = /stock|quote|ticker|股价|股票|行情|报价|比特币/.test(actionText)
    ? marketQuoteIntentPattern
    : actionIntentPattern;
  return Boolean(symbol) && intentPattern.test(userQuery);
};

const shouldExpandRuntimeManifest = (userQuery: string) =>
  /代码|源码|文件|目录|仓库|项目|本体|实现|组件|服务|浏览|网页|搜索|联网|股价|股票|行情|报价|比特币|readme|repo|repository|source|file|directory|codebase|filesystem|mcp|tool|工具|skill|技能|能力|browser|web|search|quote|ticker|stock|btc/.test(userQuery.toLowerCase());

const loadRuntimeCapabilities = async (
  onEvent?: QueryMagiOptions['onEvent'],
  includeMcpTools = false,
): Promise<RuntimeCapabilities> => {
  const streamEvents: StreamEvent[] = [];
  const emit = (
    phase: string,
    actor: string,
    status: StreamEvent['status'],
    message: string,
    details?: string,
  ) => emitStreamEvent(streamEvents, onEvent, phase, actor, status, message, details);

  try {
    emit('runtime', 'BRIDGE', 'running', 'Checking local harness bridge.');
    const bridge = await getBridgeStatus();
    emit(
      'runtime',
      'BRIDGE',
      bridge.ok ? 'complete' : 'failed',
      bridge.ok
        ? `Bridge online; ${bridge.skills.length} skill(s), ${bridge.mcpServers.length} MCP server(s).`
        : 'Bridge status returned not ok.',
    );

    const mcpServers = includeMcpTools
      ? await Promise.all((bridge.mcpServers || []).map(async server => {
      try {
        const result = await listMcpTools(server);
        const tools = extractMcpTools(result);
        emit('runtime', `MCP:${server}`, 'complete', `${tools.length} tool(s) discovered.`);
        return { server, tools };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'MCP tools/list failed.';
        emit('runtime', `MCP:${server}`, 'failed', message);
        return { server, tools: [], error: message };
      }
    }))
      : (bridge.mcpServers || []).map(server => ({ server, tools: [] }));

    return {
      bridge,
      mcpServers,
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bridge status unavailable.';
    emit('runtime', 'BRIDGE', 'failed', message);
    return {
      mcpServers: [],
      errors: [message],
    };
  }
};

const loadRelevantSkillInstructions = async (
  runtime: RuntimeCapabilities,
  userQuery: string,
  onEvent?: QueryMagiOptions['onEvent'],
) => {
  const selected = selectRelevantSkills(runtime, userQuery, 3);
  if (selected.length === 0) return [];

  const loaded: RuntimeLoadedSkill[] = [];
  for (const item of selected) {
    try {
      emitStreamEvent(
        [],
        onEvent,
        'skill-router',
        'HARNESS',
        'running',
        `Loading ${item.skill.id} SKILL.md (${item.reason}).`,
      );
      const result = await executeBridgeTool('skill.run', {
        skill: item.skill.id,
        mode: 'load',
        task: `Load SKILL.md because this skill is relevant to the user request: ${item.reason}`,
      }, 'HARNESS');
      const skillResult = result.result as {
        content?: unknown;
        skill?: { id?: unknown; name?: unknown; description?: unknown };
      };
      const content = typeof skillResult.content === 'string' ? skillResult.content : '';
      if (!content.trim()) continue;
      loaded.push({
        id: item.skill.id,
        name: item.skill.name,
        description: item.skill.description,
        content,
        score: item.score,
        reason: item.reason,
      });
      emitStreamEvent(
        [],
        onEvent,
        'skill-router',
        'HARNESS',
        'complete',
        `Loaded ${item.skill.id} SKILL.md.`,
      );
    } catch (error) {
      emitStreamEvent(
        [],
        onEvent,
        'skill-router',
        'HARNESS',
        'failed',
        `Failed to load ${item.skill.id} SKILL.md.`,
        error instanceof Error ? error.message : 'Unknown skill load error',
      );
    }
  }
  return loaded;
};

const compactSkill = (skill: BridgeSkill) => {
  const description = truncateForPrompt(skill.description || 'No description.', 220).replace(/\s+/g, ' ');
  const actions = skill.actions?.length
    ? ` actions=${skill.actions.map(action => action.id).join(',')}`
    : '';
  return `- ${skill.id}: ${description}${actions}`;
};

const compactSkillAction = (skill: BridgeSkill, action: SkillActionManifest) => {
  const description = truncateForPrompt(action.description || 'No description.', 180).replace(/\s+/g, ' ');
  const script = action.script ? ` script=${action.script}` : '';
  const triggers = action.triggers?.length ? ` triggers=${action.triggers.slice(0, 8).join('|')}` : '';
  return `- ${skill.id}.${action.id}: ${description}; tool=${action.toolId}; mode=${action.mode || 'load'}${script}; risk=${action.risk || 'medium'}; readOnly=${Boolean(action.readOnly)}${triggers}`;
};

const compactLoadedSkill = (skill: RuntimeLoadedSkill) => {
  const body = truncateForPrompt(skill.content, 4500);
  return `### ${skill.id} (score=${skill.score})
Reason: ${skill.reason}
Description: ${skill.description || 'No description.'}

${body}`;
};

const compactMcpTool = (tool: RuntimeMcpTool) => {
  const flags = [
    tool.annotations?.readOnlyHint ? 'readOnly' : '',
    tool.annotations?.destructiveHint ? 'destructive' : '',
    tool.annotations?.idempotentHint ? 'idempotent' : '',
  ].filter(Boolean).join(',');
  const description = truncateForPrompt(tool.description || tool.title || 'No description.', 220).replace(/\s+/g, ' ');
  return `- ${tool.name}${flags ? ` [${flags}]` : ''}: ${description}`;
};

const formatRuntimeClock = () => {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  return `Current local date/time: ${local}; time zone: ${timeZone}; UTC: ${now.toISOString()}. Resolve "today", "tomorrow", and other relative dates from this clock.`;
};

const formatRuntimeCapabilities = (runtime: RuntimeCapabilities, expanded: boolean) => {
  const bridge = runtime.bridge;
  const bridgeLine = bridge?.ok
    ? `ONLINE. cwd=${bridge.cwd}; skillScripts=${bridge.allowSkillScripts ? 'enabled' : 'disabled'}; config=${bridge.bridgeConfigPath || 'default'}; mcpConfig=${bridge.mcpConfigPath || 'none'}`
    : `OFFLINE or unavailable. ${runtime.errors.join('; ') || 'No bridge status.'}`;

  const skills = bridge?.skills?.length
    ? expanded
      ? bridge.skills.slice(0, 30).map(compactSkill).join('\n')
      : `Available skill ids: ${bridge.skills.map(skill => skill.id).slice(0, 40).join(', ')}`
    : 'NO SKILLS DISCOVERED BY BRIDGE.';
  const skillActions = bridge?.skills?.length
    ? bridge.skills
      .flatMap(skill => (skill.actions || []).map(action => compactSkillAction(skill, action)))
      .slice(0, expanded ? 30 : 12)
      .join('\n')
    : '';
  const loadedSkills = runtime.loadedSkills?.length
    ? runtime.loadedSkills.map(compactLoadedSkill).join('\n\n')
    : 'NO SKILL.md INSTRUCTIONS PRELOADED FOR THIS QUERY.';

  const hasFilesystem = runtime.mcpServers.some(server => server.server === 'filesystem');
  const hasBrowser = runtime.mcpServers.some(server => server.server === 'browser');
  const toolUseRules = hasFilesystem
    ? `- To inspect this repository or local code, request mcp.call against the filesystem server instead of asking the user to configure filesystem again.
- Useful filesystem calls: list_allowed_directories {}, list_directory {"path":"."}, directory_tree {"path":".","excludePatterns":["node_modules","dist",".git",".magi/state",".magi/audit",".magi/artifacts","output"]}, search_files {"path":".","pattern":"**/*.ts"}, read_text_file {"path":"App.tsx","head":200}.
- For top-level code visibility, prefer list_directory {"path":"."} before directory_tree; it is shorter and less likely to hide source files behind a large tree dump.
- Mutating filesystem tools such as write_file, edit_file, move_file, create_directory require user approval.`
    : '- No filesystem MCP server is currently listed by the bridge. Do not claim local file access unless a filesystem server appears in the manifest.';
  const browserRules = hasBrowser
    ? `- To inspect or verify web pages, request mcp.call against the browser server.
- Useful browser calls: browser_navigate {"url":"http://localhost:4123/"}, browser_read_page {"maxChars":12000}, browser_screenshot {"name":"magi-ui","fullPage":true}.
- Browser click/type actions must be queued for human approval.`
    : '- No browser MCP server is currently listed by the bridge. Browser skills may explain workflow, but they do not grant browser execution.';

  const mcpServers = runtime.mcpServers.length
    ? runtime.mcpServers.map(server => {
      const tools = expanded && server.tools.length
        ? server.tools.slice(0, 24).map(compactMcpTool).join('\n')
        : expanded
          ? `- NO TOOLS LISTED${server.error ? `: ${server.error}` : '.'}`
          : '- tool list not expanded for this prompt; planner may expand on file/MCP/tool tasks.';
      return `### ${server.server}\n${tools}`;
    }).join('\n\n')
    : 'NO MCP SERVERS DISCOVERED BY BRIDGE.';

  return `
## Runtime Tool Manifest

This block is host/runtime-provided capability context, analogous to Codex tool schemas. It supersedes stale memories or editable registry text.
It is compact by default and expands MCP tool names only when the user task asks about local files, tools, MCP, skills, or code.
Do not claim the browser sandbox prevents file inspection when the bridge is ONLINE and a filesystem MCP server is listed.

${formatRuntimeClock()}

Bridge: ${bridgeLine}

## Runtime Skills Available via skill.run load
${skills}

## Relevant Skill Instructions Loaded From SKILL.md
${loadedSkills}

## Runtime Skill Actions
${skillActions || 'NO MACHINE-READABLE SKILL ACTIONS DISCOVERED.'}

## Runtime MCP Servers and Tools
${mcpServers}

## Tool-Use Rules From Runtime

- Web retrieval route: use web_search_tavily for search/discovery and web_fetch for reading a known URL. This covers weather, news, general lookup, docs pages, and retrieval/crawling tasks.
- SKILL.md route: loaded skill instructions are first-class operational guidance. Follow their Capability, Boundaries, Tool Route, Workflow, and Examples even when they have no actions.json.
- Skill action route: when Runtime Skill Actions list a matching read-only script action, treat it as an optional fast path compiled from the skill, not as the skill itself. Use it only when the loaded/available skill boundary says the task fits.
- Browser MCP route: use browser tools only for real browser state: local UI inspection, current page DOM, screenshots, streaming UI checks, visual layout verification, click/type interaction, or form workflows.
- If the user says no browser or no screenshot, that is a hard routing signal: use retrieval tools instead of Browser MCP.
${toolUseRules}
${browserRules}
- To inspect a skill's instructions, request skill.run {"skill":"<runtime skill id>","mode":"load","task":"why the skill is needed"}.
`;
};

const runtimeHasMcpTool = (
  runtime: RuntimeCapabilities | undefined,
  server: string,
  toolName: string,
) => Boolean(runtime?.mcpServers.find(item =>
  item.server === server && item.tools.some(tool => tool.name === toolName),
));

const runtimeHasSkill = (
  runtime: RuntimeCapabilities | undefined,
  skillId: string,
) => Boolean(runtime?.bridge?.skills.some(skill => skill.id.toLowerCase() === skillId.toLowerCase()));

const getToolRequestDedupeKey = (request: PlannedToolRequest) => {
  if (request.metadata?.dedupeKey) return request.metadata.dedupeKey;
  if (request.toolId === 'skill.run' && isSkillActionScriptRequest(request)) {
    return JSON.stringify([
      request.toolId,
      typeof request.arguments?.skill === 'string' ? request.arguments.skill.toLowerCase() : '',
      normalizeScriptPath(request.arguments?.script),
      normalizeSymbolArg(request.arguments?.args),
    ]);
  }
  return JSON.stringify([request.toolId, request.arguments]);
};

const appendUniqueToolRequest = (
  requests: PlannedToolRequest[],
  request: PlannedToolRequest,
) => {
  const requestKey = getToolRequestDedupeKey(request);
  if (!requests.some(item => getToolRequestDedupeKey(item) === requestKey)) {
    requests.push(request);
  }
};

const noBrowserIntentPattern = /(不需要|无需|不用|不要|别|禁止).{0,16}(浏览器|browser|截图|screenshot)|(no|without|don't|do not).{0,16}(browser|screenshot)/i;

const userQueryBlocksBrowserMcp = (userQuery: string) => noBrowserIntentPattern.test(userQuery);

const isBrowserMcpRequest = (request: PlannedToolRequest) =>
  request.toolId === 'mcp.call' &&
  typeof request.arguments?.server === 'string' &&
  request.arguments.server.toLowerCase() === 'browser';

const filterToolRequestsForUserIntent = (
  requests: PlannedToolRequest[],
  userQuery: string,
) => userQueryBlocksBrowserMcp(userQuery)
  ? requests.filter(request => !isBrowserMcpRequest(request))
  : requests;

const isSkillActionScriptRequest = (request: PlannedToolRequest) =>
  request.toolId === 'skill.run' &&
  typeof request.arguments?.mode === 'string' &&
  request.arguments.mode.toLowerCase() === 'script' &&
  typeof request.arguments?.script === 'string';

const isSkillLoadRequest = (request: PlannedToolRequest) =>
  request.toolId === 'skill.run' &&
  (typeof request.arguments.mode !== 'string' || request.arguments.mode.toLowerCase() === 'load');

const prioritizeToolRequestsForUserIntent = (
  requests: PlannedToolRequest[],
  userQuery: string,
) => {
  if (!requests.some(request => request.metadata?.skillActionId)) return requests;

  const priority = (request: PlannedToolRequest) => {
    if (isSkillActionScriptRequest(request)) return 0;
    if (request.toolId === 'web.fetch') return 1;
    if (request.toolId === 'web.search.tavily') return 2;
    if (isSkillLoadRequest(request)) return 3;
    return 4;
  };

  return requests
    .map((request, index) => ({ request, index }))
    .sort((left, right) => priority(left.request) - priority(right.request) || left.index - right.index)
    .map(item => item.request);
};

const bridgeResultIndicatesFailure = (request: PlannedToolRequest, result: unknown) => {
  if (
    request.toolId === 'mcp.call' &&
    result &&
    typeof result === 'object' &&
    (result as { result?: { isError?: unknown } }).result?.isError === true
  ) {
    return true;
  }

  if (request.toolId !== 'skill.run' || !result || typeof result !== 'object') return false;

  const skillResult = result as {
    mode?: unknown;
    result?: {
      exitCode?: unknown;
      stdout?: unknown;
    };
  };
  if (skillResult.mode !== 'script') return false;

  const commandResult = skillResult.result;
  if (!commandResult || typeof commandResult !== 'object') return false;
  if (typeof commandResult.exitCode === 'number' && commandResult.exitCode !== 0) return true;

  if (typeof commandResult.stdout === 'string') {
    const stdout = commandResult.stdout.trim();
    if (!stdout.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(stdout) as { ok?: unknown };
      return parsed.ok === false;
    } catch {
      return false;
    }
  }

  return false;
};

const parseSkillScriptStdoutJson = (result: unknown) => {
  if (!result || typeof result !== 'object') return null;
  const commandResult = (result as { result?: { stdout?: unknown } }).result;
  const stdout = typeof commandResult?.stdout === 'string' ? commandResult.stdout.trim() : '';
  if (!stdout.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const formatParsedQuoteResult = (parsed: Record<string, unknown>) => {
  if (!('price' in parsed) || !('source' in parsed)) return '';
  const freshness = parsed.freshness && typeof parsed.freshness === 'object'
    ? parsed.freshness as Record<string, unknown>
    : {};
  return [
    'Parsed quote result (authoritative for final answer):',
    `inputSymbol: ${parsed.inputSymbol || ''}`,
    `normalizedSymbol: ${parsed.normalizedSymbol || parsed.symbol || ''}`,
    `source: ${parsed.source || ''}`,
    `price: ${parsed.price ?? ''}`,
    `currency: ${parsed.currency || ''}`,
    `quoteTime: ${parsed.quoteTime || ''}`,
    `freshness.status: ${freshness.status || ''}`,
    `freshness.ageSeconds: ${freshness.ageSeconds ?? ''}`,
    `delay: ${parsed.delay || ''}`,
  ].join('\n');
};

const coordinateInitialToolRequests = (
  requests: PlannedToolRequest[],
  systemType: MagiSystem,
  userQuery: string,
) => {
  const actionScriptRequests = requests.filter(request =>
    request.metadata?.skillActionId &&
    isSkillActionScriptRequest(request) &&
    request.metadata.preferredOwner,
  );
  if (actionScriptRequests.length === 0) return requests;
  const owned = actionScriptRequests.some(request => request.metadata?.preferredOwner === systemType);
  if (owned) {
    return requests.some(isSkillActionScriptRequest)
      ? requests.filter(request => request.metadata?.preferredOwner === systemType && isSkillActionScriptRequest(request))
      : requests;
  }
  return requests.filter(request => !actionScriptRequests.includes(request));
};

const nativePlanningTools = [
  {
    type: 'function',
    function: {
      name: 'web_search_tavily',
      description: 'Search the web through Tavily for factual retrieval such as weather, news, documentation discovery, or finding source URLs. Read-only and low risk.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'One focused search query.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason this search is needed.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract readable text from a specific URL. Use for retrieval/crawling of a known web page; do not use Browser MCP unless the task needs real browser UI state, screenshots, or interaction.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'HTTP or HTTPS URL to fetch.',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum extracted text characters to return. Default 12000.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason this page fetch is needed.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_run',
      description: 'Load or run a local MAGI/Codex skill package. Use mode=load for reading SKILL.md instructions.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Runtime skill id or name.',
          },
          task: {
            type: 'string',
            description: 'What you need from the skill.',
          },
          mode: {
            type: 'string',
            enum: ['load', 'script'],
            description: 'Use load unless the user explicitly needs an approved script action.',
          },
          script: {
            type: 'string',
            description: 'Optional script path inside the skill for script mode.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional script arguments.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason this skill is needed.',
          },
        },
        required: ['skill'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Call a configured MCP server tool through the MAGI bridge. Read-only tools may run automatically; risky tools enter approval.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Configured MCP server id, such as filesystem or browser.',
          },
          tool: {
            type: 'string',
            description: 'MCP tool name on that server.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments to pass to the MCP tool.',
            additionalProperties: true,
          },
          reason: {
            type: 'string',
            description: 'Brief reason this MCP call is needed.',
          },
        },
        required: ['server', 'tool', 'arguments'],
        additionalProperties: false,
      },
    },
  },
] as const;

const parseNativeToolArguments = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    console.warn(`Native tool arguments were not valid JSON: ${truncateForPrompt(raw, 300)}`);
    return {};
  }
};

const nativeToolCallToRequest = (toolCall: unknown): PlannedToolRequest | null => {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const call = toolCall as {
    function?: {
      name?: string;
      arguments?: unknown;
    };
  };
  const name = call.function?.name;
  const args = parseNativeToolArguments(call.function?.arguments);
  const reason = typeof args.reason === 'string' ? args.reason : '';

  if (name === 'web_search_tavily') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return null;
    return {
      toolId: 'web.search.tavily',
      arguments: {
        query,
      },
      reason,
    };
  }

  if (name === 'web_fetch') {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) return null;
    return {
      toolId: 'web.fetch',
      arguments: {
        url,
        maxChars: typeof args.maxChars === 'number' ? args.maxChars : 12000,
      },
      reason,
    };
  }

  if (name === 'skill_run') {
    const skill = typeof args.skill === 'string' ? args.skill.trim() : '';
    if (!skill) return null;
    const { reason: _reason, ...skillArgs } = args;
    return {
      toolId: 'skill.run',
      arguments: {
        ...skillArgs,
        skill,
        mode: typeof skillArgs.mode === 'string' ? skillArgs.mode : 'load',
      },
      reason,
    };
  }

  if (name === 'mcp_call') {
    const server = typeof args.server === 'string' ? args.server.trim() : '';
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!server || !tool) return null;
    return {
      toolId: 'mcp.call',
      arguments: {
        server,
        tool,
        arguments: args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments
          : {},
      },
      reason,
    };
  }

  return null;
};

const planNativeToolCalls = async (
  client: OpenAI,
  modelName: string,
  settings: HarnessSettings,
  promptText: string,
  fallbackLabel: string,
  maxRequests: number,
) => {
  const response = await client.chat.completions.create(createChatParams(settings, {
    model: modelName,
    messages: [{ role: 'system', content: promptText }],
    temperature: 0.1,
    max_tokens: getRuntimeBudgets(settings).plannerMaxTokens,
    tools: nativePlanningTools as unknown as unknown[],
    tool_choice: 'auto',
  }) as any);

  const message = response.choices[0]?.message as { tool_calls?: unknown[]; content?: string } | undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0) return [];

  const planned: PlannedToolRequest[] = [];
  toolCalls
    .map(nativeToolCallToRequest)
    .filter((request): request is PlannedToolRequest => Boolean(request))
    .forEach(request => appendUniqueToolRequest(planned, request));

  if (planned.length > 0) {
    console.info(`[${fallbackLabel}] Native tool_calls planned ${planned.length} request(s).`);
  }

  return planned.slice(0, maxRequests);
};

const extractReferencedFilePath = (userQuery: string) => {
  const match = userQuery.match(/(?:[\w.-]+[\\/])*[\w.-]+\.(?:json|md|tsx?|jsx?|mjs|cjs|css|html|yml|yaml|toml|txt|log)/i);
  return match?.[0]?.replace(/\\/g, '/') || '';
};

const materializeSkillActionArgs = (
  action: SkillActionManifest,
  userQuery: string,
  symbol?: string,
) => (action.args || []).map(arg => {
  if (arg.from === 'extracted_symbol') return symbol || extractSkillActionSymbol(action, userQuery);
  return arg.value || '';
}).filter(value => value !== '');

const buildSkillActionToolRequest = (
  skill: BridgeSkill,
  action: SkillActionManifest,
  userQuery: string,
  symbol?: string,
): PlannedToolRequest | null => {
  if (action.toolId !== 'skill.run') return null;
  const mode = action.mode || 'load';
  if (mode === 'script' && !action.script) return null;
  const extractedSymbol = symbol || extractSkillActionSymbol(action, userQuery);
  if ((action.args || []).some(arg => arg.from === 'extracted_symbol') && !extractedSymbol) {
    return null;
  }
  const args = materializeSkillActionArgs(action, userQuery, extractedSymbol);
  return {
    toolId: 'skill.run',
    arguments: {
      skill: skill.id,
      mode,
      ...(action.script ? { script: action.script } : {}),
      ...(args.length ? { args } : {}),
      task: action.description || `Run skill action ${action.id}.`,
    },
    reason: `Use skill action ${skill.id}.${action.id}${extractedSymbol ? ` for ${extractedSymbol}` : ''}.`,
    metadata: {
      skillActionId: `${skill.id}.${action.id}`,
      readOnly: action.readOnly === true,
      preferredOwner: action.preferredOwner,
      dedupeKey: action.dedupe?.key && extractedSymbol
        ? action.dedupe.key.replace('{extracted_symbol}', extractedSymbol)
        : undefined,
      skipFallbackToolsOnSuccess: action.dedupe?.skipFallbackToolsOnSuccess,
    },
  };
};

const getMatchingSkillActionRequests = (
  runtime: RuntimeCapabilities | undefined,
  userQuery: string,
) => getSkillActions(runtime).flatMap(({ skill, action }) => {
  if (!skillActionMatchesQuery(action, userQuery)) return [];
  if (action.mode === 'script' && !runtime?.bridge?.allowSkillScripts) return [];
  const requiresSymbol = (action.args || []).some(arg => arg.from === 'extracted_symbol');
  const symbols = requiresSymbol ? extractSkillActionSymbols(action, userQuery) : [''];
  return symbols
    .map(symbol => buildSkillActionToolRequest(skill, action, userQuery, symbol || undefined))
    .filter((request): request is PlannedToolRequest => Boolean(request));
});

const annotateSkillActionRequest = (
  request: PlannedToolRequest,
  runtime: RuntimeCapabilities | undefined,
  userQuery: string,
): PlannedToolRequest => {
  if (request.toolId !== 'skill.run') return request;
  const skillId = typeof request.arguments?.skill === 'string' ? request.arguments.skill.toLowerCase() : '';
  const script = normalizeScriptPath(request.arguments?.script);
  const symbol = normalizeSymbolArg(request.arguments?.args);
  if (!skillId) return request;

  const match = getSkillActions(runtime).find(({ skill, action }) => {
    if (skill.id !== skillId) return false;
    if (action.toolId !== 'skill.run') return false;
    if ((action.mode || 'load') !== (typeof request.arguments?.mode === 'string' ? request.arguments.mode : 'load')) return false;
    if (action.script && normalizeScriptPath(action.script) !== script) return false;
    const actionSymbol = extractSkillActionSymbol(action, userQuery);
    return !actionSymbol || !symbol || actionSymbol === symbol;
  });

  if (!match) return request;
  return {
    ...request,
    metadata: {
      ...request.metadata,
      skillActionId: `${match.skill.id}.${match.action.id}`,
      readOnly: match.action.readOnly === true,
      preferredOwner: match.action.preferredOwner,
      dedupeKey: match.action.dedupe?.key && symbol
        ? match.action.dedupe.key.replace('{extracted_symbol}', symbol)
        : request.metadata?.dedupeKey,
      skipFallbackToolsOnSuccess: match.action.dedupe?.skipFallbackToolsOnSuccess,
    },
  };
};

const annotateSkillActionRequests = (
  requests: PlannedToolRequest[],
  runtime: RuntimeCapabilities | undefined,
  userQuery: string,
) => requests.map(request => annotateSkillActionRequest(request, runtime, userQuery));

const suggestRuntimeToolRequests = (
  systemType: MagiSystem,
  userQuery: string,
  runtime: RuntimeCapabilities | undefined,
  settings: HarnessSettings,
): PlannedToolRequest[] => {
  const query = userQuery.toLowerCase();
  const requests: PlannedToolRequest[] = [];
  const skillActionRequests = getMatchingSkillActionRequests(runtime, userQuery);
  const hasActionMatch = skillActionRequests.length > 0;
  const asksAboutFiles = !hasActionMatch &&
    /代码|源码|文件|目录|仓库|项目|本体|实现|组件|服务|readme|repo|repository|source|file|directory|codebase|filesystem/.test(query);
  const asksAboutSkills = /skill|技能|能力包|加载|详情|instructions|skill\.md/.test(query);
  const asksForWebRetrieval = !hasActionMatch &&
    /搜索|联网|查询|天气|新闻|资料|网页|网址|抓取|检索|search|web|fetch|lookup|news|weather|http/.test(query);
  const asksForBrowserState = !userQueryBlocksBrowserMcp(userQuery) &&
    /浏览器|当前页|打开页面|看界面|截图|点击|输入|表单|页面验证|界面验证|ui|browser|screenshot|click|type|form|dom|visual|localhost|127\.0\.0\.1/.test(query);
  const referencedFile = extractReferencedFilePath(userQuery);
  const urlMatch = userQuery.match(/https?:\/\/[^\s"'<>]+|localhost:\d+[^\s"'<>]*|127\.0\.0\.1:\d+[^\s"'<>]*/i);
  const referencedUrl = urlMatch
    ? (urlMatch[0].startsWith('http') ? urlMatch[0] : `http://${urlMatch[0]}`)
    : '';
  skillActionRequests.forEach(request => {
    const accessKey = getToolAccessKey(request);
    const preferredOwner = request.metadata?.preferredOwner;
    const ownedByPersona = preferredOwner
      ? preferredOwner === systemType && canPersonaRequestAccessKey(settings, systemType, accessKey)
      : shouldSuggestForPersona(settings, systemType, accessKey);
    if (ownedByPersona) appendUniqueToolRequest(requests, request);
  });

  const hasFilesystemDirectoryRead = runtimeHasMcpTool(runtime, 'filesystem', 'list_directory') ||
    runtimeHasMcpTool(runtime, 'filesystem', 'directory_tree') ||
    runtimeHasMcpTool(runtime, 'filesystem', 'read_text_file');

  if (asksAboutFiles && hasFilesystemDirectoryRead) {
    if (shouldSuggestForPersona(settings, systemType, 'mcp.filesystem.read') && referencedFile && runtimeHasMcpTool(runtime, 'filesystem', 'read_text_file')) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'filesystem',
          tool: 'read_text_file',
          arguments: {
            path: referencedFile,
            head: 260,
          },
        },
        reason: `The user asked about ${referencedFile}; read that file directly through filesystem MCP.`,
      });
    } else if (shouldSuggestForPersona(settings, systemType, 'mcp.filesystem.read')) {
      const useListDirectory = runtimeHasMcpTool(runtime, 'filesystem', 'list_directory');
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'filesystem',
          tool: useListDirectory ? 'list_directory' : 'directory_tree',
          arguments: useListDirectory
            ? { path: '.' }
            : {
              path: '.',
              excludePatterns: ['node_modules', 'dist', '.git', '.magi/state', '.magi/audit', '.magi/artifacts', 'output'],
            },
        },
        reason: 'The user is asking about local project/code capability; inspect the repository root through filesystem MCP.',
      });
    }

    if (
      shouldSuggestForPersona(settings, systemType, 'mcp.filesystem.read') &&
      runtimeHasMcpTool(runtime, 'filesystem', 'list_allowed_directories') &&
      requests.length === 0
    ) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'filesystem',
          tool: 'list_allowed_directories',
          arguments: {},
        },
        reason: 'Verify filesystem MCP allowed directories before making claims about local access.',
      });
    }
  }

  if (asksAboutSkills && runtime?.bridge?.skills?.length) {
    const matchedSkill = runtime.bridge.skills.find(skill =>
      query.includes(skill.id.toLowerCase()) ||
      (skill.name && query.includes(skill.name.toLowerCase())),
    );

    if (shouldSuggestForPersona(settings, systemType, 'skill.run.load') && matchedSkill && runtimeHasSkill(runtime, matchedSkill.id)) {
      appendUniqueToolRequest(requests, {
        toolId: 'skill.run',
        arguments: {
          skill: matchedSkill.id,
          task: 'Load the SKILL.md instructions so MAGI can describe and use this skill accurately.',
          mode: 'load',
        },
        reason: `The user asked about skill details for ${matchedSkill.id}.`,
      });
    }
  }

  if (asksForWebRetrieval && !asksForBrowserState) {
    if (referencedUrl && shouldSuggestForPersona(settings, systemType, 'web.fetch')) {
      appendUniqueToolRequest(requests, {
        toolId: 'web.fetch',
        arguments: {
          url: referencedUrl,
          maxChars: 12000,
        },
        reason: `Fetch the referenced URL directly. Browser MCP is not needed because the task is retrieval, not UI verification.`,
      });
    } else if (shouldSuggestForPersona(settings, systemType, 'web.search.tavily')) {
      appendUniqueToolRequest(requests, {
        toolId: 'web.search.tavily',
        arguments: {
          query: userQuery,
        },
        reason: 'Use web search for information retrieval instead of opening a browser session.',
      });
    }
  }

  if (asksForBrowserState) {
    if (shouldSuggestForPersona(settings, systemType, 'mcp.browser.read') && runtimeHasMcpTool(runtime, 'browser', 'browser_navigate') && referencedUrl) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'browser',
          tool: 'browser_navigate',
          arguments: {
            url: referencedUrl,
            waitUntil: 'domcontentloaded',
          },
        },
        reason: `The user asked for browser/UI verification; navigate to ${referencedUrl}.`,
      });
    }

    if (shouldSuggestForPersona(settings, systemType, 'mcp.browser.read') && runtimeHasMcpTool(runtime, 'browser', 'browser_read_page')) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'browser',
          tool: 'browser_read_page',
          arguments: {
            maxChars: 12000,
          },
        },
        reason: 'Read the current browser page through Browser MCP because the task concerns browser/UI state.',
      });
    }

    const wantsBrowserSkillDetails = asksAboutSkills || /浏览器能力|浏览器技能|browser capability|browser skill|browser-verification/i.test(userQuery);
    const browserSkill = runtime?.bridge?.skills.find(skill => skill.id === 'browser') ||
      runtime?.bridge?.skills.find(skill => skill.id === 'browser-verification');
    if (shouldSuggestForPersona(settings, systemType, 'skill.run.load') && wantsBrowserSkillDetails && browserSkill && runtimeHasSkill(runtime, browserSkill.id)) {
      appendUniqueToolRequest(requests, {
        toolId: 'skill.run',
        arguments: {
          skill: browserSkill.id,
          task: 'Load browser-related SKILL.md instructions so MAGI can describe current browser capability accurately.',
          mode: 'load',
        },
        reason: `The user asked about browsing/search capability; inspect ${browserSkill.id}.`,
      });
    }
  }

  return requests.slice(0, getRuntimeBudgets(settings).runtimeSuggestMaxRequests);
};

const normalizeDocumentOperations = (
  rawOperations: unknown,
  allowedDocumentIds: Set<HarnessDocumentId>,
): DocumentOperation[] => {
  if (!Array.isArray(rawOperations)) return [];

  return rawOperations
    .filter((operation): operation is DocumentOperation => {
      if (!operation || typeof operation !== 'object') return false;
      const candidate = operation as Partial<DocumentOperation>;
      return (
        typeof candidate.content === 'string' &&
        (candidate.op === 'APPEND' || candidate.op === 'REPLACE') &&
        knownDocumentIds.includes(candidate.documentId as HarnessDocumentId) &&
        allowedDocumentIds.has(candidate.documentId as HarnessDocumentId)
      );
    })
    .map(operation => ({
      documentId: operation.documentId,
      op: operation.op,
      content: operation.content,
      reason: operation.reason,
    }));
};

const formatHistory = (history: Message[]) =>
  history.map(msg =>
    `${msg.role === 'user' ? 'USER_INPUT' : 'MAGI_SYNTHESIS'}: ${
      msg.role === 'user' ? msg.content : msg.magiData?.synthesis || '...'
    }`,
  ).join('\n');

const formatLegacyMemories = (memories: MemoryItem[]) =>
  memories.length > 0
    ? memories.map(memory => `[ID: ${memory.id}] ${memory.content}`).join('\n')
    : 'NO LEGACY CORTEX ITEMS.';

const concreteActionPattern = /搜索|联网|查|查询|看一下|看看|读取|打开|浏览|截图|验证|测试|运行|执行|修改|改成|修|实现|search|browse|open|read|check|verify|test|run|execute|fix|implement|weather|天气/i;
const genericClarificationPattern = /是否同意|是否批准|确认执行|要不要|希望先测试|哪方面能力|选择测试|which capability|what capability|do you want me to|should i proceed|approve.*search|confirm.*search/i;

const isConcreteActionRequest = (userQuery: string) => concreteActionPattern.test(userQuery);

const isReadOnlyToolTrace = (trace: ToolTrace) =>
  trace.toolId === 'web.search.tavily' ||
  trace.toolId === 'web.fetch' ||
  /skill\.run/.test(trace.toolId) ||
  /read|list|get|search|find|stat|describe|inspect|directory_tree|list_allowed|browser_navigate|browser_read_page|browser_screenshot|browser_close/i.test(trace.details || trace.summary || trace.toolId);

const shouldKeepClarification = (
  request: ClarificationRequest,
  userQuery: string,
  toolTraces: ToolTrace[],
  pendingActions: PendingAction[],
) => {
  if (pendingActions.some(action => action.requiresApproval && action.status === 'pending')) return true;
  if (!isConcreteActionRequest(userQuery)) return true;

  const hasReadOnlyToolAttempt = toolTraces.some(trace =>
    isReadOnlyToolTrace(trace) && (trace.status === 'allowed' || trace.status === 'failed' || trace.status === 'skipped'),
  );
  if (!hasReadOnlyToolAttempt) return true;

  return !genericClarificationPattern.test(`${request.question}\n${request.reason || ''}`);
};

const getToolRequestOwner = (request: PlannedToolRequest, harness: MagiHarnessContext): MagiSystem => {
  if (request.metadata?.preferredOwner && canPersonaRequestTool(harness, request.metadata.preferredOwner, request)) {
    return request.metadata.preferredOwner;
  }
  const accessKey = getToolAccessKey(request);
  const preferred = getPreferredOwnersForAccessKey(accessKey);
  return preferred.find(systemType => canPersonaRequestTool(harness, systemType, request)) ||
    Object.values(MagiSystem).find(systemType => canPersonaRequestTool(harness, systemType, request)) ||
    preferred[0] ||
    MagiSystem.MELCHIOR;
};

const parseTraceDetailsObject = (details?: string): Record<string, unknown> | null => {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const normalizeScriptPath = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : '';

const normalizeToolArgList = (value: unknown) =>
  Array.isArray(value) ? value.map(item => String(item)) : [];

const normalizeSymbolArg = (value: unknown) =>
  normalizeToolArgList(value)
    .find(item => item.trim() && !item.trim().startsWith('-'))
    ?.trim()
    .toUpperCase()
    .replace(/\.SH$/, '.SS') || '';

const getTraceRequestObject = (trace: ToolTrace): Record<string, unknown> | null => {
  const details = parseTraceDetailsObject(trace.details);
  const request = details?.request;
  return request && typeof request === 'object' && !Array.isArray(request)
    ? request as Record<string, unknown>
    : null;
};

const getTraceMetadataObject = (trace: ToolTrace): PlannedToolRequest['metadata'] | null => {
  const details = parseTraceDetailsObject(trace.details);
  const metadata = details?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as PlannedToolRequest['metadata']
    : null;
};

const hasSuccessfulFallbackBlockingSkillActionTrace = (traces: ToolTrace[]) =>
  traces.some(trace =>
    trace.toolId === 'skill.run' &&
    trace.status === 'allowed' &&
    getTraceMetadataObject(trace)?.skipFallbackToolsOnSuccess === true,
  );

const toolRequestAlreadyAttempted = (request: PlannedToolRequest, traces: ToolTrace[], userQuery = '') => {
  if (
    userQuery &&
    hasSuccessfulFallbackBlockingSkillActionTrace(traces) &&
    (request.toolId === 'web.search.tavily' || request.toolId === 'web.fetch' || request.toolId === 'mcp.call')
  ) {
    return true;
  }

  if (request.toolId === 'web.search.tavily') {
    const query = typeof request.arguments?.query === 'string' ? request.arguments.query.trim() : '';
    return Boolean(query) && traces.some(trace => trace.toolId === 'web.search.tavily' && trace.query === query);
  }

  if (request.toolId === 'web.fetch') {
    const url = typeof request.arguments?.url === 'string' ? request.arguments.url.trim() : '';
    return Boolean(url) && traces.some(trace =>
      trace.toolId === 'web.fetch' &&
      (trace.query === url || trace.details?.includes(`"url": "${url}"`)),
    );
  }

  if (request.toolId === 'skill.run') {
    const skill = typeof request.arguments?.skill === 'string' ? request.arguments.skill.trim() : '';
    if (!skill) return false;
    const mode = typeof request.arguments?.mode === 'string' ? request.arguments.mode.toLowerCase() : 'load';
    const script = normalizeScriptPath(request.arguments?.script);
    const symbolArg = normalizeSymbolArg(request.arguments?.args);

    return traces.some(trace => {
      if (trace.toolId !== 'skill.run' || trace.status !== 'allowed') return false;
      const traceRequest = getTraceRequestObject(trace);
      if (!traceRequest) return false;
      const traceSkill = typeof traceRequest.skill === 'string' ? traceRequest.skill.trim() : '';
      if (traceSkill !== skill) return false;
      const traceMode = typeof traceRequest.mode === 'string' ? traceRequest.mode.toLowerCase() : 'load';
      if (traceMode !== mode) return false;
      if (mode !== 'script') return true;
      const traceScript = normalizeScriptPath(traceRequest.script);
      const traceSymbolArg = normalizeSymbolArg(traceRequest.args);
      return Boolean(script) &&
        traceScript === script &&
        Boolean(symbolArg) &&
        traceSymbolArg === symbolArg;
    });
  }

  if (request.toolId === 'mcp.call') {
    const server = typeof request.arguments?.server === 'string' ? request.arguments.server : '';
    const tool = typeof request.arguments?.tool === 'string' ? request.arguments.tool : '';
    return Boolean(server && tool) && traces.some(trace =>
      trace.toolId === 'mcp.call' &&
      trace.details?.includes(`"server": "${server}"`) &&
      trace.details?.includes(`"tool": "${tool}"`),
    );
  }

  return false;
};

const buildPersonaHarness = (
  systemType: MagiSystem,
  documents: HarnessDocuments,
  legacyMemoryStr: string,
  runtimeBlock: string,
) => {
  const personaId = getPersonaDocumentId(systemType);
  const memoryId = getPersonaMemoryDocumentId(systemType);

  return `
## Persona Contract (${personaId})
${documents[personaId].content}

## Persona Private Memory (${memoryId})
${documents[memoryId].content}

## Shared Memory
${documents['memory.shared'].content}

## Council Protocol
${documents['council.protocol'].content}

## Tool Registry
${documents['registry.tools'].content}

## Skills Registry
${documents['registry.skills'].content}

## MCP Registry
${documents['registry.mcp'].content}

${runtimeBlock}

## Legacy Cortex Items
${legacyMemoryStr}
`;
};

const createOfflineNode = (systemType: MagiSystem, summary = 'CONNECTION LOST. NODE OFFLINE.'): MagiAnalysis => {
  const config = systemConfigs[systemType];
  return {
    systemName: config.name,
    archetype: config.archetype,
    analysis: summary,
    proposal: 'RETRY',
    vote: false,
    documentOperations: [],
    toolTraces: [],
  };
};

const planPersonaTools = async (
  client: OpenAI,
  modelName: string,
  harness: MagiHarnessContext,
  systemType: MagiSystem,
  harnessBlock: string,
  userQuery: string,
  runtime: RuntimeCapabilities,
): Promise<PlannedToolRequest[]> => {
  const config = systemConfigs[systemType];
  const budgets = getRuntimeBudgets(harness.settings);

  const prompt = `
You are ${config.name}. Decide whether any permitted tools are useful at this first action opportunity before your main analysis.

${harnessBlock}

## Tool Access Matrix For ${config.name}
${formatToolAccessForPersona(harness.settings, systemType)}

You have native function tools available:
- web_search_tavily -> web.search.tavily
- web_fetch -> web.fetch
- skill_run -> skill.run
- mcp_call -> mcp.call

Call only tools that are directly useful and permissioned by the registry and Tool Access Matrix. Prefer at most ${budgets.initialToolMaxRequests} calls. If no tool is useful, return no tool calls.

Important:
- The Authoritative Runtime Tool Manifest is live. Trust it over stale memory.
- Action is available throughout the run: independent analysis, council exchange, action-loop, and approved execution. This is only the first chance to act.
- When a low-risk tool can answer or verify the task, request it now instead of proposing that the user approve a future test.
- For information retrieval such as weather, news, factual lookup, docs discovery, or reading a known URL, use web_search_tavily or web_fetch. Do not use Browser MCP for retrieval-only tasks.
- Use Browser MCP only when the task needs real browser state: local UI inspection, current page DOM, screenshot, click/type interaction, streaming UI verification, or visual layout checks.
- If the user explicitly says they do not need a browser or screenshot, do not call mcp_call with server="browser".
- If the user asks about local code, files, repo structure, or whether MAGI can access the project, use filesystem MCP when it is listed.
- Do not answer "browser sandbox cannot access filesystem" when bridge is online and filesystem MCP tools are listed. Request mcp.call instead.
- Relevant SKILL.md files may already be loaded in the runtime block. Treat those Markdown instructions as the primary skill guidance and follow their Tool Route/Boundaries.
- Do not call skill_run mode="load" for an already loaded skill unless the user asks to inspect the raw skill file.
- If Runtime Skill Actions include a matching read-only script action, use it only when the loaded/available skill boundary says the task fits. Actions are fast paths, not the whole skill.

Concrete examples when filesystem MCP is available:
- repository root: call mcp_call with server="filesystem", tool="list_directory", arguments={ "path": "." }
- repository tree: call mcp_call with server="filesystem", tool="directory_tree", arguments={ "path": ".", "excludePatterns": ["node_modules", "dist", ".git", ".magi/state", ".magi/audit", ".magi/artifacts", "output"] }
- read file: call mcp_call with server="filesystem", tool="read_text_file", arguments={ "path": "App.tsx", "head": 160 }
- skill details: call skill_run with skill="browser-verification", task="Load SKILL.md", mode="load"

Concrete examples when browser MCP is available:
- navigate: call mcp_call with server="browser", tool="browser_navigate", arguments={ "url": "http://localhost:4123/", "waitUntil": "domcontentloaded" }
- read page: call mcp_call with server="browser", tool="browser_read_page", arguments={ "maxChars": 12000 }
- screenshot: call mcp_call with server="browser", tool="browser_screenshot", arguments={ "name": "magi-ui", "fullPage": true }
- click/type are high-risk browser actions and should be requested only when the user asked for that interaction.

User query: "${userQuery}"
`;

  try {
    const planned = annotateSkillActionRequests(filterToolRequestsForUserIntent(
      await planNativeToolCalls(client, modelName, harness.settings, prompt, `${config.name} TOOL PLANNER`, budgets.initialToolMaxRequests),
      userQuery,
    ), runtime, userQuery);
    if (planned.length === 0) {
      return prioritizeToolRequestsForUserIntent(
        coordinateInitialToolRequests(
          filterToolRequestsForPersona(
            filterToolRequestsForUserIntent(suggestRuntimeToolRequests(systemType, userQuery, runtime, harness.settings), userQuery),
            harness,
            systemType,
          ),
          systemType,
          userQuery,
        ),
        userQuery,
      );
    }
    const augmented = [...planned];
    suggestRuntimeToolRequests(systemType, userQuery, runtime, harness.settings).forEach(request => appendUniqueToolRequest(augmented, request));
    return prioritizeToolRequestsForUserIntent(
      coordinateInitialToolRequests(
        filterToolRequestsForPersona(filterToolRequestsForUserIntent(augmented, userQuery), harness, systemType),
        systemType,
        userQuery,
      ),
      userQuery,
    ).slice(0, budgets.initialToolMaxRequests);
  } catch (error) {
    console.warn(`[${config.name}] Tool-planning step failed.`, error);
    return prioritizeToolRequestsForUserIntent(
      coordinateInitialToolRequests(
        filterToolRequestsForPersona(
          filterToolRequestsForUserIntent(suggestRuntimeToolRequests(systemType, userQuery, runtime, harness.settings), userQuery),
          harness,
          systemType,
        ),
        systemType,
        userQuery,
      ),
      userQuery,
    );
  }
};

const executeToolRequests = async (
  requests: PlannedToolRequest[],
  systemType: MagiSystem,
  harness: MagiHarnessContext,
  onEvent?: QueryMagiOptions['onEvent'],
): Promise<ToolExecutionResult> => {
  const config = systemConfigs[systemType];
  const sources: GroundingSource[] = [];
  const toolTraces: ToolTrace[] = [];
  const pendingActions: PendingAction[] = [];
  const streamEvents: StreamEvent[] = [];
  const toolResultBlocks: string[] = [];
  const budgets = getRuntimeBudgets(harness.settings);

  for (const request of requests) {
    const registryAllowed = hasToolPermission(harness.documents, systemType, request.toolId);
    const accessKey = getToolAccessKey(request);
    const accessMode = getToolAccessMode(harness.settings, systemType, request);

    if (!registryAllowed || accessMode === 'deny') {
      const reason = !registryAllowed
        ? 'Permission denied by registry.tools.'
        : `Permission denied by Tool Access Matrix (${accessKey}=DENY).`;
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: 'denied',
        summary: reason,
        details: request.reason,
      });
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', `${request.toolId} denied: ${reason}`);
      continue;
    }

    const baseAssessment = assessToolRequestRisk(request);
    const assessment = accessMode === 'review'
      ? requireReviewByMatrix(request, baseAssessment, accessKey)
      : baseAssessment;
    if (assessment.requiresApproval) {
      const pendingAction = makePendingAction(config.name, request, assessment);
      pendingActions.push(pendingAction);
      toolResultBlocks.push(`### ${config.name} requested ${request.toolId}\nStatus: PENDING HUMAN APPROVAL\nRisk: ${assessment.risk}\nReason: ${pendingAction.reason}\nArguments:\n${truncateForPrompt(pendingAction.arguments, 1200)}`);
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: 'pending',
        summary: pendingAction.reason,
        details: `${assessment.summary}\nAction: ${pendingAction.id}`,
      });
      emitStreamEvent(
        streamEvents,
        onEvent,
        'approval',
        config.name,
        'waiting',
        `${request.toolId} queued for approval (${assessment.risk} risk).`,
        truncateForPrompt(pendingAction.arguments, 800),
      );
      continue;
    }

    if (request.toolId === 'web.search.tavily') {
      const query = typeof request.arguments?.query === 'string' ? request.arguments.query.trim() : '';
      if (!query) {
        toolTraces.push({
          systemName: config.name,
          toolId: request.toolId,
          status: 'skipped',
          summary: 'Missing search query.',
          details: request.reason,
        });
        emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', 'web.search.tavily skipped because query was empty.');
        continue;
      }

      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'running', `Searching web: ${query}`);
      const searchResult = await searchTavily(query, harness.settings);
      sources.push(...searchResult.sources);
      const searchContext = searchResult.results.length > 0
        ? searchResult.results.map(result => `[Source: ${result.title}] ${result.content}`).join('\n\n')
        : 'WEB SEARCH RETURNED NO RESULTS.';
      toolResultBlocks.push(`### ${config.name} used web.search.tavily\nQuery: ${query}\n${searchContext}`);
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: searchResult.results.length > 0 ? 'allowed' : 'failed',
        query,
        summary: request.reason || 'Persona requested web search.',
      });
      emitStreamEvent(
        streamEvents,
        onEvent,
        'tool',
        config.name,
        searchResult.results.length > 0 ? 'complete' : 'failed',
        searchResult.results.length > 0 ? `Web search returned ${searchResult.results.length} result(s).` : 'Web search returned no results.',
      );
      continue;
    }

    if (request.toolId === 'web.fetch') {
      const url = typeof request.arguments?.url === 'string' ? request.arguments.url.trim() : '';
      if (!url) {
        toolTraces.push({
          systemName: config.name,
          toolId: request.toolId,
          status: 'skipped',
          summary: 'Missing fetch URL.',
          details: request.reason,
        });
        emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', 'web.fetch skipped because URL was empty.');
        continue;
      }

      try {
        emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'running', `Fetching URL: ${url}`);
        const bridgeResult = await executeBridgeTool('web.fetch', request.arguments || {}, config.name);
        const result = bridgeResult.result as Partial<WebFetchResult> & {
          status?: number;
          ok?: boolean;
          truncated?: boolean;
        };
        if (result.url) {
          sources.push({
            title: result.title || result.url,
            uri: result.url,
          });
        }
        const promptDetails = truncateForPrompt({
          url: result.url || url,
          status: result.status,
          title: result.title,
          contentType: result.contentType,
          content: result.content || '',
        }, budgets.toolAuditChars);
        toolResultBlocks.push(`### ${config.name} used web.fetch\nReason: ${request.reason || 'No reason supplied.'}\nResult:\n${promptDetails}`);
        toolTraces.push({
          systemName: config.name,
          toolId: request.toolId,
          status: result.ok === false ? 'failed' : 'allowed',
          query: result.url || url,
          summary: request.reason || 'Persona fetched a URL.',
          details: stringifyTraceDetails(result, budgets.traceDetailsMaxChars),
        });
        emitStreamEvent(
          streamEvents,
          onEvent,
          'tool',
          config.name,
          result.ok === false ? 'failed' : 'complete',
          result.ok === false ? `web.fetch returned HTTP ${result.status || 'error'}.` : 'web.fetch completed.',
        );
      } catch (error) {
        toolTraces.push({
          systemName: config.name,
          toolId: request.toolId,
          status: 'failed',
          query: url,
          summary: request.reason || 'Persona fetched a URL.',
          details: error instanceof Error ? error.message : 'web.fetch failed.',
        });
        emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', 'web.fetch failed.', error instanceof Error ? error.message : 'web.fetch failed.');
      }
      continue;
    }

    try {
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'running', `Executing ${request.toolId}.`);
      const bridgeResult = await executeBridgeTool(request.toolId, request.arguments || {}, config.name);
      const bridgeFailed = bridgeResultIndicatesFailure(request, bridgeResult.result);
      const parsedScriptJson = parseSkillScriptStdoutJson(bridgeResult.result);
      const parsedQuoteResult = parsedScriptJson ? formatParsedQuoteResult(parsedScriptJson) : '';
      const details = stringifyTraceDetails({
        request: request.arguments || {},
        metadata: request.metadata || {},
        parsed: parsedQuoteResult ? parsedScriptJson : undefined,
        result: bridgeResult.result,
      }, budgets.traceDetailsMaxChars);
      const promptDetails = truncateForPrompt({
        request: request.arguments || {},
        metadata: request.metadata || {},
        parsed: parsedQuoteResult ? parsedScriptJson : undefined,
        result: bridgeResult.result,
      }, budgets.toolAuditChars);
      toolResultBlocks.push(`### ${config.name} used ${request.toolId}\nReason: ${request.reason || 'No reason supplied.'}\n${parsedQuoteResult ? `${parsedQuoteResult}\n` : ''}Result:\n${promptDetails}`);
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: bridgeFailed ? 'failed' : 'allowed',
        summary: request.reason || `Persona requested ${request.toolId}.`,
        details,
      });
      emitStreamEvent(
        streamEvents,
        onEvent,
        'tool',
        config.name,
        bridgeFailed ? 'failed' : 'complete',
        bridgeFailed ? `${request.toolId} returned a failure result.` : `${request.toolId} completed.`,
      );
    } catch (error) {
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: 'failed',
        summary: request.reason || `Persona requested ${request.toolId}.`,
        details: error instanceof Error ? error.message : 'Bridge tool failed.',
      });
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', `${request.toolId} failed.`, error instanceof Error ? error.message : 'Bridge tool failed.');
    }
  }

  return {
    sources,
    toolTraces,
    pendingActions,
    streamEvents,
    toolResultBlocks,
  };
};

const queryArchetype = async (
  systemType: MagiSystem,
  userQuery: string,
  contextStr: string,
  legacyMemoryStr: string,
  language: Language,
  harness: MagiHarnessContext,
  runtime: RuntimeCapabilities,
  runtimeBlock: string,
  onEvent?: QueryMagiOptions['onEvent'],
): Promise<PersonaQueryResult> => {
  const config = systemConfigs[systemType];
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const budgets = getRuntimeBudgets(harness.settings);
  const harnessBlock = buildPersonaHarness(systemType, harness.documents, legacyMemoryStr, runtimeBlock);
  const allowedDocumentIds = new Set<HarnessDocumentId>([
    getPersonaMemoryDocumentId(systemType),
    'memory.shared',
  ]);

  let toolContext = 'NO EXTERNAL TOOLS USED.';
  let sources: GroundingSource[] = [];
  const toolTraces: ToolTrace[] = [];
  const toolResultBlocks: string[] = [];
  const pendingActions: PendingAction[] = [];
  const streamEvents: StreamEvent[] = [];
  emitStreamEvent(streamEvents, onEvent, 'tool-plan', config.name, 'running', 'Planning permitted tool usage.');
  const toolRequests = await planPersonaTools(client, modelName, harness, systemType, harnessBlock, userQuery, runtime);
  emitStreamEvent(
    streamEvents,
    onEvent,
    'tool-plan',
    config.name,
    'complete',
    `${toolRequests.length} tool request${toolRequests.length === 1 ? '' : 's'} proposed.`,
  );

  const execution = await executeToolRequests(toolRequests, systemType, harness, event => {
    streamEvents.push(event);
    onEvent?.(event);
  });
  sources = [...sources, ...execution.sources];
  toolTraces.push(...execution.toolTraces);
  pendingActions.push(...execution.pendingActions);
  toolResultBlocks.push(...execution.toolResultBlocks);

  if (toolResultBlocks.length > 0) {
    toolContext = toolResultBlocks.join('\n\n');
  }

  const langInstruction = language === 'CN'
    ? 'Output all user-facing analysis and proposals in Simplified Chinese.'
    : 'Output all user-facing analysis and proposals in English.';

  const archetypePrompt = `
You are ${config.name}, one independent MAGI agent. You are not a prompt caricature; you are a harness-governed agent with persona, memory, tools, and maintenance rules.

${langInstruction}

${harnessBlock}

## External Tool Results
${toolContext}

## Conversation Context
${contextStr || 'NO PRIOR CONVERSATION.'}

## Current Task
Analyze the current user query from your persona's mandate. Use available memory, tool results, skills registry, and MCP registry as operational context.
Apply the Skeptical Duty in your persona contract as part of your own judgment; do not wait for synthesis to do this for you.

You may propose documentOperations only for:
- ${getPersonaMemoryDocumentId(systemType)}
- memory.shared

Prefer APPEND for durable lessons. Do not replace documents unless the user explicitly asks.

Return JSON only:
{
  "analysis": "your perspective",
  "proposal": "your recommended action",
  "vote": boolean,
  "documentOperations": [
    { "documentId": "${getPersonaMemoryDocumentId(systemType)}", "op": "APPEND", "content": "- durable note", "reason": "why this should persist" }
  ]
}

User query: "${userQuery}"
`;

  try {
    emitStreamEvent(streamEvents, onEvent, 'persona', config.name, 'running', 'Composing independent analysis.');
    const parsed = await requestJsonObject(
      client,
      harness.settings,
      modelName,
      config.name,
      archetypePrompt,
      {
        temperature: 0.7,
        maxTokens: budgets.personaMaxTokens,
        retryMaxTokens: budgets.meetingRetryMaxTokens,
        repairInstruction: `You are ${config.name}. Repair your persona response into the requested schema.`,
        onRetry: (attempt, reason, preview) => emitStreamEvent(
          streamEvents,
          onEvent,
          'persona',
          config.name,
          'running',
          `Retrying persona JSON response (${attempt}/${budgets.jsonRepairMaxAttempts}).`,
          `${reason}\n${preview || ''}`,
        ),
      },
    ) as {
      analysis?: string;
      proposal?: string;
      vote?: boolean;
      documentOperations?: unknown;
    };

    emitStreamEvent(streamEvents, onEvent, 'persona', config.name, 'complete', `${parsed.vote ? 'APPROVE' : 'REJECT'} proposal prepared.`);

    return {
      systemName: config.name,
      archetype: config.archetype,
      analysis: parsed.analysis || 'DATA CORRUPTED',
      proposal: parsed.proposal || 'NO DATA',
      vote: parsed.vote ?? false,
      groundingSources: sources,
      documentOperations: normalizeDocumentOperations(parsed.documentOperations, allowedDocumentIds),
      toolTraces,
      pendingActions,
      streamEvents,
    };
  } catch (error) {
    console.error(`Node ${systemType} failed:`, error);
    emitStreamEvent(streamEvents, onEvent, 'persona', config.name, 'failed', 'Persona analysis failed.', error instanceof Error ? error.message : 'Unknown error');
    return {
      ...createOfflineNode(systemType),
      groundingSources: [],
      toolTraces,
      pendingActions,
      streamEvents,
    };
  }
};

const dedupeSources = (sources: GroundingSource[]) => {
  const seen = new Set<string>();
  return sources.filter(source => {
    if (!source.uri || seen.has(source.uri)) return false;
    seen.add(source.uri);
    return true;
  });
};

const makeTraceStep = (
  phase: string,
  actor: string,
  status: SessionTraceStep['status'],
  summary: string,
  details?: string,
): SessionTraceStep => ({
  id: makeId('trace'),
  phase,
  actor,
  status,
  summary,
  timestamp: Date.now(),
  details,
});

const planCouncilTools = async (
  systemType: MagiSystem,
  userQuery: string,
  language: Language,
  harness: MagiHarnessContext,
  runtime: RuntimeCapabilities,
  runtimeBlock: string,
  initialOutputs: Record<MagiSystem, MagiAnalysis>,
  existingToolTraces: ToolTrace[],
  pendingActions: PendingAction[],
): Promise<PlannedToolRequest[]> => {
  const config = systemConfigs[systemType];
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const budgets = getRuntimeBudgets(harness.settings);
  const langInstruction = language === 'CN'
    ? 'Think in Chinese.'
    : 'Think in English.';
  const ownOutput = initialOutputs[systemType];
  const toolAudit = existingToolTraces.map(trace =>
    `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', budgets.toolAuditChars)}`,
  ).join('\n') || 'NO TOOL CALLS YET.';

  const promptText = `
You are ${config.name}. The council is allowed to act while deliberating. Decide whether you need another permitted tool call before the meeting statement.

${langInstruction}

${runtimeBlock}

## Tool Access Matrix For ${config.name}
${formatToolAccessForPersona(harness.settings, systemType)}

## User Query
${userQuery}

## Your Initial Output
Analysis: ${ownOutput.analysis}
Proposal: ${ownOutput.proposal}
Vote: ${ownOutput.vote ? 'APPROVE' : 'REJECT'}

## Existing Tool Audit
${toolAudit}

## Pending Actions
${formatPendingActions(pendingActions)}

Rules:
- You have native function tools available: web_search_tavily, web_fetch, skill_run, mcp_call.
- Tool calls must be permitted by both registry.tools and the Tool Access Matrix above.
- Do not ask the user for permission to run low-risk read-only tools; call the tool now.
- If a factual claim can be checked with an available read-only tool, call the tool.
- Use web_search_tavily/web_fetch for retrieval-only questions. Use Browser MCP only for UI state, screenshots, DOM/page verification, or click/type interactions.
- If the user explicitly says they do not need a browser or screenshot, do not call mcp_call with server="browser".
- Follow any Relevant Skill Instructions already loaded in the runtime block. Do not reload those SKILL.md files unless raw inspection is needed.
- Avoid repeating a tool call that already has a useful result in Tool Audit.
- Risky click/type/write actions may be requested, but they will enter the approval queue.
- Return no tool calls when no additional action is useful.
`;

  try {
    const planned = annotateSkillActionRequests(filterToolRequestsForUserIntent(
      await planNativeToolCalls(client, modelName, harness.settings, promptText, `${config.name} COUNCIL TOOL PLANNER`, budgets.councilToolMaxRequests),
      userQuery,
    ), runtime, userQuery);
    return prioritizeToolRequestsForUserIntent(planned
      .filter(request => canPersonaRequestTool(harness, systemType, request))
      .filter(request => !toolRequestAlreadyAttempted(request, existingToolTraces, userQuery)),
      userQuery,
    )
      .slice(0, budgets.councilToolMaxRequests);
  } catch (error) {
    console.warn(`[${config.name}] Council tool-planning step failed.`, error);
    return [];
  }
};

const planActionLoopTools = async (
  userQuery: string,
  language: Language,
  harness: MagiHarnessContext,
  runtime: RuntimeCapabilities,
  runtimeBlock: string,
  initialOutputs: Record<MagiSystem, MagiAnalysis>,
  meeting: CouncilExchange[],
  existingToolTraces: ToolTrace[],
  pendingActions: PendingAction[],
): Promise<PlannedToolRequest[]> => {
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const budgets = getRuntimeBudgets(harness.settings);
  const langInstruction = language === 'CN'
    ? 'Think in Chinese.'
    : 'Think in English.';
  const personaBrief = Object.values(MagiSystem).map(systemType => {
    const output = initialOutputs[systemType];
    return `[${output.systemName}]\nAnalysis: ${output.analysis}\nProposal: ${output.proposal}\nVote: ${output.vote ? 'APPROVE' : 'REJECT'}`;
  }).join('\n\n');
  const toolAudit = existingToolTraces.map(trace =>
    `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', budgets.toolAuditChars)}`,
  ).join('\n') || 'NO TOOL CALLS YET.';

  const promptText = `
You are the MAGI council action-loop planner. The personas have already discussed, but discussion is not a substitute for useful, permitted action.

${langInstruction}

${runtimeBlock}

## Tool Access Matrix
${Object.values(MagiSystem).map(systemType => {
    const matrix = normalizeToolAccessMatrix(harness.settings.toolAccess)[systemType];
    return `### ${systemType}\n${TOOL_ACCESS_DEFINITIONS.map(definition => `- ${definition.key}: ${matrix[definition.key]}`).join('\n')}`;
  }).join('\n\n')}

## User Query
${userQuery}

## Persona Outputs
${personaBrief}

## Council Meeting Transcript
${formatMeetingTranscript(meeting)}

## Existing Tool Audit
${toolAudit}

## Pending Actions
${formatPendingActions(pendingActions)}

Rules:
- You have native function tools available: web_search_tavily, web_fetch, skill_run, mcp_call.
- Tool calls must be permitted by registry.tools and at least one persona row in the Tool Access Matrix.
- If a permitted tool can settle a remaining factual, file, browser, skill, or MCP uncertainty, request it now.
- Do not ask the user for permission to run low-risk read-only tools. Call them.
- Use web_search_tavily/web_fetch for retrieval-only questions. Use Browser MCP only for UI state, screenshots, DOM/page verification, or click/type interactions.
- If the user explicitly says they do not need a browser or screenshot, do not call mcp_call with server="browser".
- Follow any Relevant Skill Instructions already loaded in the runtime block. Treat actions.json as an optional fast path and SKILL.md as the real operating manual.
- Avoid repeating useful tool calls already present in Tool Audit.
- Risky click/type/write/execute actions may be requested, but they will become pending approvals.
- Return no tool calls when the answer can already be grounded in existing tool results.
`;

  try {
    const planned = annotateSkillActionRequests(filterToolRequestsForUserIntent(
      await planNativeToolCalls(client, modelName, harness.settings, promptText, 'COUNCIL ACTION-LOOP TOOL PLANNER', budgets.synthesisToolMaxRequests),
      userQuery,
    ), runtime, userQuery);
    return prioritizeToolRequestsForUserIntent(planned
      .filter(request => Object.values(MagiSystem).some(systemType => canPersonaRequestTool(harness, systemType, request)))
      .filter(request => !toolRequestAlreadyAttempted(request, existingToolTraces, userQuery)),
      userQuery,
    )
      .slice(0, budgets.synthesisToolMaxRequests);
  } catch (error) {
    console.warn('[COUNCIL] Action-loop tool-planning step failed.', error);
    return [];
  }
};

const queryCouncilExchange = async (
  systemType: MagiSystem,
  prompt: string,
  language: Language,
  harness: MagiHarnessContext,
  contextStr: string,
  initialOutputs: Record<MagiSystem, MagiAnalysis>,
  pendingActions: PendingAction[],
  toolAudit: ToolTrace[],
  runtimeBlock: string,
  onEvent?: QueryMagiOptions['onEvent'],
): Promise<{ exchange: CouncilExchange; clarifications: ClarificationRequest[]; events: StreamEvent[] }> => {
  const config = systemConfigs[systemType];
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const budgets = getRuntimeBudgets(harness.settings);
  const streamEvents: StreamEvent[] = [];
  const langInstruction = language === 'CN'
    ? 'Output all user-facing content in Simplified Chinese.'
    : 'Output all user-facing content in English.';

  const otherOutputs = Object.values(MagiSystem)
    .filter(other => other !== systemType)
    .map(other => {
      const output = initialOutputs[other];
      return `[${output.systemName}]\nAnalysis: ${output.analysis}\nProposal: ${output.proposal}\nVote: ${output.vote ? 'APPROVE' : 'REJECT'}`;
    })
    .join('\n\n');

  const ownOutput = initialOutputs[systemType];
  const promptText = `
You are ${config.name} in the MAGI council meeting. This is the cross-examination round after independent thinking.

${langInstruction}

## Your Persona Contract
${harness.documents[getPersonaDocumentId(systemType)].content}

## Your Persona Private Memory
${harness.documents[getPersonaMemoryDocumentId(systemType)].content}

## Council Protocol
${harness.documents['council.protocol'].content}

## Shared Memory
${harness.documents['memory.shared'].content}

${runtimeBlock}

## Conversation Context
${contextStr || 'NO PRIOR CONVERSATION.'}

## User Query
"${prompt}"

## Your Initial Output
Analysis: ${ownOutput.analysis}
Proposal: ${ownOutput.proposal}
Vote: ${ownOutput.vote ? 'APPROVE' : 'REJECT'}

## Other Persona Outputs
${otherOutputs}

## Pending Action Queue
${formatPendingActions(pendingActions)}

## Tool Audit So Far
${toolAudit.map(trace => `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', budgets.toolAuditChars)}`).join('\n') || 'NO TOOL CALLS.'}

Respond to the other two personas and the tool results. Challenge weak assumptions, name blocked actions, and revise your proposal if needed.
Do not ask the user to approve low-risk read-only work that already executed or could have executed. Ask clarification only for genuinely missing intent, credentials, destructive changes, or pending approval.

Return JSON only:
{
  "content": "your meeting statement",
  "revisedProposal": "updated proposal or unchanged",
  "revisedVote": boolean,
  "clarificationRequests": [
    { "question": "question for the user", "reason": "why this blocks the next step", "required": true }
  ]
}
`;

  try {
    emitStreamEvent(streamEvents, onEvent, 'meeting', config.name, 'running', 'Entering council meeting round.');
    const parsed = await requestJsonObject(
      client,
      harness.settings,
      modelName,
      `${config.name} MEETING`,
      promptText,
      {
        temperature: 0.6,
        maxTokens: budgets.meetingMaxTokens,
        retryMaxTokens: budgets.meetingRetryMaxTokens,
        repairInstruction: `You are ${config.name}. Repair your council meeting response into the requested schema.`,
        onRetry: (attempt, reason, preview) => emitStreamEvent(
          streamEvents,
          onEvent,
          'meeting',
          config.name,
          'running',
          `Retrying council JSON response (${attempt}/${budgets.jsonRepairMaxAttempts}).`,
          `${reason}\n${preview || ''}`,
        ),
      },
    ) as {
      content?: string;
      revisedProposal?: string;
      revisedVote?: boolean;
      clarificationRequests?: unknown;
    };

    const exchange: CouncilExchange = {
      id: makeId('exchange'),
      round: 1,
      speaker: config.name,
      content: parsed.content || 'No meeting statement returned.',
      revisedProposal: parsed.revisedProposal || ownOutput.proposal,
      revisedVote: parsed.revisedVote ?? ownOutput.vote,
      timestamp: Date.now(),
    };

    emitStreamEvent(streamEvents, onEvent, 'meeting', config.name, 'complete', `${exchange.revisedVote ? 'APPROVE' : 'REJECT'} after council round.`);

    return {
      exchange,
      clarifications: normalizeClarificationRequests(parsed.clarificationRequests, `${config.name} council question`),
      events: streamEvents,
    };
  } catch (error) {
    emitStreamEvent(streamEvents, onEvent, 'meeting', config.name, 'failed', 'Council meeting response failed.', error instanceof Error ? error.message : 'Unknown error');
    return {
      exchange: {
        id: makeId('exchange'),
        round: 1,
        speaker: config.name,
        content: 'MEETING RESPONSE FAILED.',
        revisedProposal: ownOutput.proposal,
        revisedVote: false,
        timestamp: Date.now(),
      },
      clarifications: [],
      events: streamEvents,
    };
  }
};

const streamFinalSynthesis = async (
  client: OpenAI,
  modelName: string,
  harness: MagiHarnessContext,
  language: Language,
  prompt: string,
  synthesisResult: {
    centralAnalysis?: string;
    synthesis?: string;
    executionPlan?: string;
    finalDecision?: boolean;
    requiresUserInput?: boolean;
  },
  meeting: CouncilExchange[],
  pendingActions: PendingAction[],
  toolTraces: ToolTrace[],
  fallback: string,
  emit: (
    phase: string,
    actor: string,
    eventStatus: StreamEvent['status'],
    message: string,
    details?: string,
  ) => StreamEvent,
  onTextDelta?: QueryMagiOptions['onTextDelta'],
) => {
  let fullText = '';
  const budgets = getRuntimeBudgets(harness.settings);
  const langInstruction = language === 'CN'
    ? 'Output in Simplified Chinese.'
    : 'Output in English.';

const promptText = `
You are the final MAGI council voice-over. Write the final user-facing answer only; do not return JSON.
Do not become a fourth persona, evidence filter, or separate skeptical layer. Preserve the council's substance and make it readable.

${langInstruction}

## User Query
${prompt}

## Structured Council Result
Central analysis: ${synthesisResult.centralAnalysis || ''}
Decision: ${synthesisResult.finalDecision === undefined ? 'unset' : synthesisResult.finalDecision ? 'approve' : 'reject'}
Requires user input: ${Boolean(synthesisResult.requiresUserInput)}
Draft synthesis: ${synthesisResult.synthesis || ''}
Execution plan: ${synthesisResult.executionPlan || ''}

## Council Meeting
${formatMeetingTranscript(meeting)}

## Pending Actions
${formatPendingActions(pendingActions)}

## Tool Audit
${toolTraces.map(trace => `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', budgets.toolAuditChars)}`).join('\n') || 'NO TOOL CALLS.'}

Rules:
- Be concise and concrete.
- Lead with the answer or completed action result, not the council process.
- If pending actions require approval, clearly say they are waiting and do not claim they have executed.
- If user input is required, ask the focused question(s) implied by the draft; do not ask for confirmation to run low-risk tools that already ran.
- For market quotes, do not call a price current/real-time unless the tool audit contains a fresh source timestamp or recent quoteTime. If provider scripts/fetch failed, were rate-limited, returned freshness unknown/stale, or only old search snippets are available, say live quote retrieval failed and avoid presenting an old numeric price as current.
- If tool audit includes parsed quote JSON, copy the numeric price/source/quoteTime/freshness exactly from that JSON, even if the draft synthesis says something different.
- If the user requested an exact marker, token, phrase, or output sentinel, include it verbatim and do not paraphrase it.
- Preserve the substance of the structured council result.
- Do not add new independent claims, objections, or tool needs that are absent from the structured council result, meeting, pending actions, or tool audit.
`;

  emit('synthesis-stream', 'COUNCIL', 'running', 'Streaming final synthesis text.');

  try {
    const stream = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: promptText }],
      temperature: 0.5,
      max_tokens: budgets.finalStreamMaxTokens,
      stream: true,
    }) as any);

    for await (const chunk of stream as any) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      fullText += delta;
      emitTextDelta(onTextDelta, delta, fullText);
    }

    const finalText = fullText.trim();
    emit('synthesis-stream', 'COUNCIL', 'complete', finalText ? 'Final synthesis stream completed.' : 'Final synthesis stream returned no text.');
    return finalText || fallback;
  } catch (error) {
    emit(
      'synthesis-stream',
      'COUNCIL',
      'failed',
      'Final synthesis stream failed; falling back to structured synthesis.',
      error instanceof Error ? error.message : 'Unknown streaming error',
    );
    return fallback;
  }
};

export const queryMagiSystem = async (
  prompt: string,
  history: Message[],
  language: Language,
  memories: MemoryItem[],
  harness: MagiHarnessContext,
  options: QueryMagiOptions = {},
): Promise<MagiResponse> => {
  const streamEvents: StreamEvent[] = [];
  const runId = options.runId || makeId('run');
  const budgets = getRuntimeBudgets(harness.settings);
  const emit = (
    phase: string,
    actor: string,
    eventStatus: StreamEvent['status'],
    message: string,
    details?: string,
  ) => emitStreamEvent(streamEvents, options.onEvent, phase, actor, eventStatus, message, details);

  const trace: SessionTraceStep[] = [
    makeTraceStep(
      'input',
      'COMMANDER',
      'complete',
      `Received prompt (${prompt.length} chars).`,
    ),
    makeTraceStep(
      'runtime',
      'HARNESS',
      'complete',
      `Model ${harness.settings.modelName || process.env.OPENAI_MODEL_NAME || 'unset'}; reasoning ${harness.settings.reasoningEnabled ? harness.settings.reasoningEffort : 'off'}; persona timeout ${budgets.personaTimeoutMs}ms.`,
    ),
    makeTraceStep(
      'context',
      'HARNESS',
      'complete',
      `${Object.keys(harness.documents).length} markdown documents loaded; ${memories.length} legacy cortex items.`,
    ),
  ];
  emit('input', 'COMMANDER', 'complete', `Received prompt (${prompt.length} chars).`);
  emit(
    'runtime',
    'HARNESS',
    'complete',
    `Model ${harness.settings.modelName || process.env.OPENAI_MODEL_NAME || 'unset'}; reasoning ${harness.settings.reasoningEnabled ? harness.settings.reasoningEffort : 'off'}; budgets persona=${budgets.personaMaxTokens}, synthesis=${budgets.synthesisMaxTokens}, tools=${budgets.initialToolMaxRequests}/${budgets.councilToolMaxRequests}/${budgets.synthesisToolMaxRequests}.`,
  );

  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);

  const langInstruction = language === 'CN'
    ? 'Output in Simplified Chinese.'
    : 'Output in English.';

  const contextStr = formatHistory(history);
  const legacyMemoryStr = formatLegacyMemories(memories);
  const expandRuntimeManifest = shouldExpandRuntimeManifest(prompt);
  const runtime = await loadRuntimeCapabilities(event => {
    streamEvents.push(event);
    options.onEvent?.(event);
  }, expandRuntimeManifest);
  runtime.loadedSkills = await loadRelevantSkillInstructions(runtime, prompt, event => {
    streamEvents.push(event);
    options.onEvent?.(event);
  });
  const runtimeBlock = formatRuntimeCapabilities(runtime, expandRuntimeManifest);
  trace.push(makeTraceStep(
    'runtime',
    'BRIDGE',
    runtime.bridge?.ok ? 'complete' : 'failed',
    runtime.bridge?.ok
      ? `Bridge online: ${runtime.bridge.skills.length} skill(s), ${runtime.bridge.mcpServers.length} MCP server(s).`
      : `Bridge unavailable: ${runtime.errors.join('; ') || 'unknown error'}`,
    runtimeBlock,
  ));
  trace.push(makeTraceStep(
    'skill-router',
    'HARNESS',
    'complete',
    runtime.loadedSkills?.length
      ? `Preloaded ${runtime.loadedSkills.length} relevant SKILL.md instruction file(s).`
      : 'No relevant SKILL.md instruction files preloaded.',
    runtime.loadedSkills?.map(skill => `${skill.id}: ${skill.reason}`).join('\n') || '',
  ));

  const runNode = async (systemType: MagiSystem) => {
    try {
      emit('persona', systemConfigs[systemType].name, 'queued', 'Queued for independent analysis.');
      return await withTimeout(
        queryArchetype(systemType, prompt, contextStr, legacyMemoryStr, language, harness, runtime, runtimeBlock, event => {
          streamEvents.push(event);
          options.onEvent?.(event);
        }),
        budgets.personaTimeoutMs,
      );
    } catch (error) {
      console.error(`Timed out or failed: ${systemType}`, error);
      emit('persona', systemConfigs[systemType].name, 'failed', 'Timed out or failed during independent analysis.', error instanceof Error ? error.message : 'Unknown error');
      return {
        ...createOfflineNode(systemType, 'TIMEOUT OR HARNESS FAILURE. NODE OFFLINE.'),
        groundingSources: [],
        pendingActions: [],
        streamEvents: [],
      };
    }
  };

  const [melchior, balthasar, casper] = await Promise.all([
    runNode(MagiSystem.MELCHIOR),
    runNode(MagiSystem.BALTHASAR),
    runNode(MagiSystem.CASPER),
  ]);

  [melchior, balthasar, casper].forEach(node => {
    trace.push(makeTraceStep(
      'persona',
      node.systemName,
      node.analysis.includes('OFFLINE') ? 'failed' : 'complete',
      `${node.vote ? 'APPROVE' : 'REJECT'}: ${node.proposal.slice(0, 120)}`,
      node.analysis,
    ));
  });

  let allSources = dedupeSources([
    ...melchior.groundingSources,
    ...balthasar.groundingSources,
    ...casper.groundingSources,
  ]);

  let pendingActions = [
    ...melchior.pendingActions,
    ...balthasar.pendingActions,
    ...casper.pendingActions,
  ];

  let allToolTraces = [
    ...(melchior.toolTraces || []),
    ...(balthasar.toolTraces || []),
    ...(casper.toolTraces || []),
  ];

  allToolTraces.forEach(toolTrace => {
    trace.push(makeTraceStep(
      'tool',
      toolTrace.systemName,
      toolTrace.status === 'failed'
        ? 'failed'
        : toolTrace.status === 'skipped'
          ? 'skipped'
          : toolTrace.status === 'pending'
            ? 'waiting'
            : 'complete',
      `${toolTrace.toolId}: ${toolTrace.status}`,
      toolTrace.details || toolTrace.query || toolTrace.summary,
    ));
  });

  const initialOutputs: Record<MagiSystem, MagiAnalysis> = {
    [MagiSystem.MELCHIOR]: melchior,
    [MagiSystem.BALTHASAR]: balthasar,
    [MagiSystem.CASPER]: casper,
  };

  emit('council-tools', 'COUNCIL', 'running', 'Checking whether deliberation needs more tool action.');
  const councilToolPlans = await Promise.all(Object.values(MagiSystem).map(async systemType => ({
    systemType,
    requests: await planCouncilTools(
      systemType,
      prompt,
      language,
      harness,
      runtime,
      runtimeBlock,
      initialOutputs,
      allToolTraces,
      pendingActions,
    ),
  })));

  const councilToolExecutions = await Promise.all(councilToolPlans.map(async plan => ({
    systemType: plan.systemType,
    result: await executeToolRequests(plan.requests, plan.systemType, harness, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
  })));

  const councilToolCount = councilToolExecutions.reduce((sum, item) => sum + item.result.toolTraces.length, 0);
  councilToolExecutions.forEach(item => {
    allSources = dedupeSources([...allSources, ...item.result.sources]);
    pendingActions = [...pendingActions, ...item.result.pendingActions];
    allToolTraces = [...allToolTraces, ...item.result.toolTraces];
    item.result.toolTraces.forEach(toolTrace => {
      trace.push(makeTraceStep(
        'council-tool',
        toolTrace.systemName,
        toolTrace.status === 'failed'
          ? 'failed'
          : toolTrace.status === 'skipped'
            ? 'skipped'
            : toolTrace.status === 'pending'
              ? 'waiting'
              : 'complete',
        `${toolTrace.toolId}: ${toolTrace.status}`,
        toolTrace.details || toolTrace.query || toolTrace.summary,
      ));
    });
  });
  emit(
    'council-tools',
    'COUNCIL',
    'complete',
    councilToolCount > 0 ? `${councilToolCount} council-stage tool action(s) processed.` : 'No additional council-stage tool action needed.',
  );

  emit('meeting', 'COUNCIL', 'running', 'Starting three-persona council round.');
  const meetingResults = await Promise.all([
    queryCouncilExchange(MagiSystem.MELCHIOR, prompt, language, harness, contextStr, initialOutputs, pendingActions, allToolTraces, runtimeBlock, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
    queryCouncilExchange(MagiSystem.BALTHASAR, prompt, language, harness, contextStr, initialOutputs, pendingActions, allToolTraces, runtimeBlock, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
    queryCouncilExchange(MagiSystem.CASPER, prompt, language, harness, contextStr, initialOutputs, pendingActions, allToolTraces, runtimeBlock, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
  ]);
  emit('meeting', 'COUNCIL', 'complete', 'Council round completed.');

  const meeting = meetingResults.map(result => result.exchange);
  const personaClarifications = meetingResults.flatMap(result => result.clarifications);

  meeting.forEach(exchange => {
    trace.push(makeTraceStep(
      'meeting',
      exchange.speaker,
      exchange.content === 'MEETING RESPONSE FAILED.' ? 'failed' : 'complete',
      `${exchange.revisedVote === false ? 'REJECT' : 'APPROVE'} after council round.`,
      exchange.content,
    ));
  });

  let actionLoopBudgetExhausted = false;
  let actionLoopRoundsUsed = 0;
  for (let round = 1; round <= budgets.actionLoopMaxRounds; round += 1) {
    if (pendingActions.some(action => action.requiresApproval && action.status === 'pending')) {
      emit('action-loop', 'COUNCIL', 'waiting', 'Action loop paused because approval is pending.');
      break;
    }

    const remainingToolBudget = budgets.totalToolMaxRequests - allToolTraces.length;
    if (remainingToolBudget <= 0) {
      actionLoopBudgetExhausted = true;
      emit('action-loop', 'COUNCIL', 'waiting', `Action loop tool budget exhausted (${budgets.totalToolMaxRequests}).`);
      break;
    }

    emit('action-loop', 'COUNCIL', 'running', `Action loop round ${round}/${budgets.actionLoopMaxRounds}: checking for remaining executable work.`);
    const loopRequests = (await planActionLoopTools(
      prompt,
      language,
      harness,
      runtime,
      runtimeBlock,
      initialOutputs,
      meeting,
      allToolTraces,
      pendingActions,
    )).slice(0, Math.min(budgets.actionLoopMaxRequestsPerRound, remainingToolBudget));

    if (loopRequests.length === 0) {
      emit('action-loop', 'COUNCIL', 'complete', round === 1 ? 'No additional action-loop work needed.' : 'Action loop converged with no additional tool calls.');
      break;
    }

    actionLoopRoundsUsed = round;
    const loopExecutions = await Promise.all(loopRequests.map(async request => {
      const owner = getToolRequestOwner(request, harness);
      return {
        owner,
        result: await executeToolRequests([request], owner, harness, event => {
          streamEvents.push(event);
          options.onEvent?.(event);
        }),
      };
    }));

    let loopToolCount = 0;
    loopExecutions.forEach(item => {
      loopToolCount += item.result.toolTraces.length;
      allSources = dedupeSources([...allSources, ...item.result.sources]);
      pendingActions = [...pendingActions, ...item.result.pendingActions];
      allToolTraces = [...allToolTraces, ...item.result.toolTraces];
      item.result.toolTraces.forEach(toolTrace => {
        trace.push(makeTraceStep(
          'action-loop',
          toolTrace.systemName,
          toolTrace.status === 'failed'
            ? 'failed'
            : toolTrace.status === 'skipped'
              ? 'skipped'
              : toolTrace.status === 'pending'
                ? 'waiting'
                : 'complete',
          `${toolTrace.toolId}: ${toolTrace.status}`,
          toolTrace.details || toolTrace.query || toolTrace.summary,
        ));
      });
    });

    emit('action-loop', 'COUNCIL', 'complete', `Action loop round ${round} processed ${loopToolCount} tool action(s).`);
    if (loopToolCount === 0) break;
    if (allToolTraces.length >= budgets.totalToolMaxRequests) {
      actionLoopBudgetExhausted = true;
      emit('action-loop', 'COUNCIL', 'waiting', `Action loop stopped at total tool budget ${budgets.totalToolMaxRequests}.`);
      break;
    }
  }

  const synthesisAllowedDocs = new Set<HarnessDocumentId>([
    'memory.shared',
    'council.protocol',
  ]);

  const synthesisPrompt = `
You are the MAGI council voice-over. Three independent agents have deliberated and acted through the action-loop. Your job is to integrate their judgments, disagreement, tool results, pending actions, and continuation state into one user-facing answer.
Do not become a fourth persona, evidence filter, or separate skeptical layer. If skepticism is needed, reflect what the personas already surfaced; do not invent new objections, claims, evidence rankings, or tool needs at synthesis time.

${langInstruction}

## Council Protocol
${harness.documents['council.protocol'].content}

## Shared Memory
${harness.documents['memory.shared'].content}

## Tool Registry
${harness.documents['registry.tools'].content}

## Skills Registry
${harness.documents['registry.skills'].content}

## MCP Registry
${harness.documents['registry.mcp'].content}

${runtimeBlock}

## Conversation Context
${contextStr || 'NO PRIOR CONVERSATION.'}

## User Query
"${prompt}"

## Persona Outputs
[MELCHIOR]
Analysis: ${melchior.analysis}
Proposal: ${melchior.proposal}
Vote: ${melchior.vote ? 'APPROVE' : 'REJECT'}

[BALTHASAR]
Analysis: ${balthasar.analysis}
Proposal: ${balthasar.proposal}
Vote: ${balthasar.vote ? 'APPROVE' : 'REJECT'}

[CASPER]
Analysis: ${casper.analysis}
Proposal: ${casper.proposal}
Vote: ${casper.vote ? 'APPROVE' : 'REJECT'}

## Council Meeting Transcript
${formatMeetingTranscript(meeting)}

## Pending Action Queue
${formatPendingActions(pendingActions)}

## Runtime Budget Status
Action loop rounds used: ${actionLoopRoundsUsed}/${budgets.actionLoopMaxRounds}
Tool traces used: ${allToolTraces.length}/${budgets.totalToolMaxRequests}
Budget exhausted: ${actionLoopBudgetExhausted ? 'yes' : 'no'}

## Tool Audit
${allToolTraces.map(trace => `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', budgets.toolAuditChars)}`).join('\n') || 'NO TOOL CALLS.'}

Return JSON only:
{
  "centralAnalysis": "brief neutral summary",
  "synthesis": "final answer to the user",
  "executionPlan": "concrete next action or implementation plan",
  "finalDecision": boolean,
  "requiresUserInput": boolean,
  "clarificationRequests": [
    { "question": "precise question for the user", "reason": "what decision/action it blocks", "required": true }
  ],
  "memoryOperations": [
    { "op": "ADD", "content": "legacy cortex note" },
    { "op": "DELETE", "targetId": "legacy cortex id" }
  ],
  "documentOperations": [
    { "documentId": "memory.shared", "op": "APPEND", "content": "- durable shared note", "reason": "why this should persist" }
  ]
}

If the pending action queue is not empty, do not claim those actions have executed. Ask for approval in clarificationRequests when approval is required.
If low-risk read-only tools have already run, answer from their results instead of asking whether to run them.
Do not request or imply new tool work from synthesis. Any remaining executable work must be represented as continuation or a focused clarification, not as a hidden synthesis-stage action.
If the next safe step depends on genuinely missing user intent, credentials, destructive changes, or a risky action approval, set requiresUserInput true and ask focused questions.
If the runtime budget is exhausted before all useful safe work is finished, set requiresUserInput true and explain exactly what should continue next.
If runtime bridge is online and filesystem MCP tools are listed, do not say the system cannot inspect local files. Instead summarize tool results or state which mcp.call should be approved/executed next.
For market quote tasks, the source quote timestamp controls wording. If quote data is absent, stale, older than the current/latest trading session, or only from an old search snippet, do not call it "current", "real-time", or "实时"; state the shown timestamp and write "报价新鲜度: 未确认" or "stale".
For tool results containing "Parsed quote result", copy the numeric price, source, quoteTime, currency, and freshness exactly from that parsed block. Do not substitute remembered prices, search snippets, or approximate market values.
If all live quote routes failed, were rate-limited, or only returned dated snippets, say that live quote retrieval failed. Do not present a numeric price from an old search result as the current price.
If the user requested an exact marker, token, phrase, or output sentinel, preserve it verbatim in synthesis.
`;

  emit('synthesis', 'COUNCIL', 'running', 'Integrating votes, meeting transcript, and action queue.');
  const synthesisResult = await requestJsonObject(
    client,
    harness.settings,
    modelName,
    'SYNTHESIS',
    synthesisPrompt,
    {
      temperature: 0.7,
      maxTokens: budgets.synthesisMaxTokens,
      retryMaxTokens: budgets.meetingRetryMaxTokens,
      repairInstruction: 'Repair the MAGI synthesis response into the exact requested JSON schema.',
      onRetry: (attempt, reason, preview) => emit(
        'synthesis',
        'COUNCIL',
        'running',
        `Retrying synthesis JSON response (${attempt}/${budgets.jsonRepairMaxAttempts}).`,
        `${reason}\n${preview || ''}`,
      ),
    },
  ) as {
    centralAnalysis?: string;
    synthesis?: string;
    executionPlan?: string;
    finalDecision?: boolean;
    requiresUserInput?: boolean;
    clarificationRequests?: unknown;
    memoryOperations?: MagiResponse['memoryOperations'];
    documentOperations?: unknown;
  };

  const fallbackDecision = (melchior.vote && balthasar.vote) ||
    (casper.vote && melchior.vote) ||
    (balthasar.vote && casper.vote);

  const personaDocumentOps = [
    ...(melchior.documentOperations || []),
    ...(balthasar.documentOperations || []),
    ...(casper.documentOperations || []),
  ];

  const councilDocumentOps = normalizeDocumentOperations(
    synthesisResult.documentOperations,
    synthesisAllowedDocs,
  );

  const clarificationRequests = [
    ...personaClarifications,
    ...normalizeClarificationRequests(synthesisResult.clarificationRequests, 'Council synthesis needs confirmation.'),
  ]
    .filter(request => shouldKeepClarification(request, prompt, allToolTraces, pendingActions))
    .slice(0, 6);

  const requiresUserInput = Boolean(synthesisResult.requiresUserInput) ||
    actionLoopBudgetExhausted ||
    pendingActions.some(action => action.requiresApproval && action.status === 'pending') ||
    clarificationRequests.some(request => request.required !== false);

  const continuation: MagiResponse['continuation'] | undefined = actionLoopBudgetExhausted
    ? {
      reason: 'budget_exhausted',
      message: `Action loop stopped after ${actionLoopRoundsUsed}/${budgets.actionLoopMaxRounds} round(s) and ${allToolTraces.length}/${budgets.totalToolMaxRequests} tool trace(s).`,
      nextStep: synthesisResult.executionPlan || 'Continue the same task with remaining safe tool actions.',
    }
    : pendingActions.some(action => action.requiresApproval && action.status === 'pending')
      ? {
        reason: 'pending_approval',
        message: `${pendingActions.filter(action => action.requiresApproval && action.status === 'pending').length} action(s) require approval before continuing.`,
        nextStep: 'Approve or reject the pending actions.',
      }
      : clarificationRequests.some(request => request.required !== false)
        ? {
          reason: 'clarification_required',
          message: 'The council needs user clarification before continuing.',
          nextStep: clarificationRequests[0]?.question,
        }
        : undefined;

  const fallbackSynthesis = synthesisResult.synthesis || 'NO SYNTHESIS RETURNED.';
  const finalSynthesis = await streamFinalSynthesis(
    client,
    modelName,
    harness,
    language,
    prompt,
    { ...synthesisResult, requiresUserInput },
    meeting,
    pendingActions,
    allToolTraces,
    fallbackSynthesis,
    emit,
    options.onTextDelta,
  );

  trace.push(makeTraceStep(
    'synthesis',
    'COUNCIL',
    'complete',
    `${requiresUserInput ? 'WAIT' : synthesisResult.finalDecision !== undefined ? (synthesisResult.finalDecision ? 'YES' : 'NO') : (fallbackDecision ? 'YES' : 'NO')} final decision.`,
    synthesisResult.executionPlan,
  ));
  emit('synthesis', 'COUNCIL', 'complete', requiresUserInput ? 'Synthesis completed and is waiting for user input.' : 'Synthesis completed.');

  if (pendingActions.length > 0) {
    trace.push(makeTraceStep(
      'approval',
      'HARNESS',
      'waiting',
      `${pendingActions.length} action${pendingActions.length === 1 ? '' : 's'} waiting for approval.`,
      formatPendingActions(pendingActions),
    ));
    emit('approval', 'HARNESS', 'waiting', `${pendingActions.length} action${pendingActions.length === 1 ? '' : 's'} waiting for approval.`);
  }

  if (clarificationRequests.length > 0) {
    trace.push(makeTraceStep(
      'clarify',
      'COUNCIL',
      'waiting',
      `${clarificationRequests.length} clarification question${clarificationRequests.length === 1 ? '' : 's'} raised.`,
      clarificationRequests.map(request => request.question).join('\n'),
    ));
    emit('clarify', 'COUNCIL', 'waiting', `${clarificationRequests.length} clarification question${clarificationRequests.length === 1 ? '' : 's'} raised.`);
  }

  const documentOperationCount = personaDocumentOps.length + councilDocumentOps.length;
  if (documentOperationCount > 0) {
    trace.push(makeTraceStep(
      'maintenance',
      'HARNESS',
      'complete',
      `${documentOperationCount} markdown document operations proposed.`,
    ));
  }

  let auditRef: AuditRef | undefined;
  if (options.sessionId) {
    try {
      const auditEvents = buildAuditEvents(
        options.sessionId,
        runId,
        streamEvents,
        trace,
        allToolTraces,
        pendingActions,
        finalSynthesis,
      );
      const audit = await appendAuditEvents(options.sessionId, auditEvents);
      auditRef = {
        sessionId: options.sessionId,
        runId,
        filePath: audit.filePath,
        eventCount: audit.count,
      };
      trace.push(makeTraceStep(
        'audit',
        'HARNESS',
        'complete',
        `Audit log appended (${audit.count} events).`,
        audit.filePath,
      ));
    } catch (error) {
      trace.push(makeTraceStep(
        'audit',
        'HARNESS',
        'failed',
        'Audit log append failed.',
        error instanceof Error ? error.message : 'Unknown audit error',
      ));
    }
  }

  return {
    centralAnalysis: synthesisResult.centralAnalysis || 'Integrated council analysis.',
    melchior,
    balthasar,
    casper,
    synthesis: finalSynthesis,
    executionPlan: synthesisResult.executionPlan || '',
    finalDecision: synthesisResult.finalDecision !== undefined ? synthesisResult.finalDecision : fallbackDecision,
    groundingSources: allSources,
    memoryOperations: synthesisResult.memoryOperations || [],
    documentOperations: [...personaDocumentOps, ...councilDocumentOps],
    toolTraces: allToolTraces,
    trace,
    meeting,
    pendingActions,
    clarificationRequests,
    streamEvents,
    auditRef,
    requiresUserInput,
    continuation,
  };
};
