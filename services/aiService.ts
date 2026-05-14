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
  ToolId,
  ToolTrace,
  AuditEvent,
  AuditRef,
} from '../types';
import {
  getPersonaDocumentId,
  getPersonaMemoryDocumentId,
  hasToolPermission,
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

interface SystemConfig {
  name: string;
  archetype: string;
}

interface PlannedToolRequest {
  toolId: ToolId;
  arguments?: Record<string, unknown>;
  reason?: string;
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
  errors: string[];
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
    console.error(`【${archetype || 'SYNTHESIS'}】JSON Parse Error:`, text);
    throw new Error('Invalid JSON response from model');
  }
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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    stream?: boolean;
  },
) => {
  const params: Record<string, unknown> = { ...body };
  if (settings.reasoningEnabled) {
    params.reasoning_effort = settings.reasoningEffort;
  }
  return params;
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
  const apiKey = settings.tavilyApiKey || import.meta.env.VITE_TAVILY_API_KEY;
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

const assessToolRequestRisk = (request: PlannedToolRequest): ToolRiskAssessment => {
  const args = request.arguments || {};

  if (request.toolId === 'web.search.tavily') {
    return {
      risk: 'low',
      requiresApproval: false,
      summary: 'External search is read-only and can run without approval.',
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
      risk: mode === 'script' ? 'high' : 'medium',
      requiresApproval: true,
      summary: `Skill mode "${mode}" may execute local workflow logic and needs approval.`,
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

  if (readOnlyMcpToolPattern.test(toolName)) {
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

const shouldExpandRuntimeManifest = (userQuery: string) =>
  /代码|源码|文件|目录|仓库|项目|本体|实现|组件|服务|浏览|网页|搜索|联网|readme|repo|repository|source|file|directory|codebase|filesystem|mcp|tool|工具|skill|技能|能力|browser|web|search/.test(userQuery.toLowerCase());

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

const compactSkill = (skill: BridgeSkill) => {
  const description = truncateForPrompt(skill.description || 'No description.', 220).replace(/\s+/g, ' ');
  return `- ${skill.id}: ${description}`;
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

  const hasFilesystem = runtime.mcpServers.some(server => server.server === 'filesystem');
  const hasBrowser = runtime.mcpServers.some(server => server.server === 'browser');
  const toolUseRules = hasFilesystem
    ? `- To inspect this repository or local code, request mcp.call against the filesystem server instead of asking the user to configure filesystem again.
- Useful filesystem calls: list_allowed_directories {}, list_directory {"path":"."}, directory_tree {"path":".","excludePatterns":["node_modules","dist",".git",".magi/state"]}, search_files {"path":".","pattern":"**/*.ts"}, read_text_file {"path":"App.tsx","head":200}.
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

Bridge: ${bridgeLine}

## Runtime Skills Available via skill.run load
${skills}

## Runtime MCP Servers and Tools
${mcpServers}

## Tool-Use Rules From Runtime

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

const appendUniqueToolRequest = (
  requests: PlannedToolRequest[],
  request: PlannedToolRequest,
) => {
  const key = JSON.stringify([request.toolId, request.arguments]);
  if (!requests.some(item => JSON.stringify([item.toolId, item.arguments]) === key)) {
    requests.push(request);
  }
};

const suggestRuntimeToolRequests = (
  systemType: MagiSystem,
  userQuery: string,
  runtime: RuntimeCapabilities | undefined,
): PlannedToolRequest[] => {
  const query = userQuery.toLowerCase();
  const requests: PlannedToolRequest[] = [];
  const asksAboutFiles = /代码|源码|文件|目录|仓库|项目|本体|实现|组件|服务|readme|repo|repository|source|file|directory|codebase|filesystem|mcp/.test(query);
  const asksAboutSkills = /skill|技能|能力包|加载|详情|instructions|skill\.md/.test(query);
  const asksAboutBrowsing = /浏览|网页|搜索|联网|browser|web|search/.test(query);
  const urlMatch = userQuery.match(/https?:\/\/[^\s"'<>]+|localhost:\d+[^\s"'<>]*|127\.0\.0\.1:\d+[^\s"'<>]*/i);
  const browserUrl = urlMatch
    ? (urlMatch[0].startsWith('http') ? urlMatch[0] : `http://${urlMatch[0]}`)
    : '';

  if (asksAboutFiles && runtimeHasMcpTool(runtime, 'filesystem', 'directory_tree')) {
    if (systemType === MagiSystem.MELCHIOR) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'filesystem',
          tool: 'directory_tree',
          arguments: {
            path: '.',
            excludePatterns: ['node_modules', 'dist', '.git', '.magi/state'],
          },
        },
        reason: 'The user is asking about local project/code capability; inspect the repository tree through filesystem MCP.',
      });
    }

    if (systemType === MagiSystem.BALTHASAR && runtimeHasMcpTool(runtime, 'filesystem', 'list_allowed_directories')) {
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

    if (matchedSkill && runtimeHasSkill(runtime, matchedSkill.id)) {
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

  if (asksAboutBrowsing && runtime?.bridge?.skills?.length) {
    if (systemType === MagiSystem.CASPER && runtimeHasMcpTool(runtime, 'browser', 'browser_navigate') && browserUrl) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'browser',
          tool: 'browser_navigate',
          arguments: {
            url: browserUrl,
            waitUntil: 'domcontentloaded',
          },
        },
        reason: `The user asked for browser verification; navigate to ${browserUrl}.`,
      });
    }

    if (systemType === MagiSystem.CASPER && runtimeHasMcpTool(runtime, 'browser', 'browser_read_page')) {
      appendUniqueToolRequest(requests, {
        toolId: 'mcp.call',
        arguments: {
          server: 'browser',
          tool: 'browser_read_page',
          arguments: {
            maxChars: 12000,
          },
        },
        reason: 'Read the current browser page through Browser MCP before making claims about the UI.',
      });
    }

    const browserSkill = runtime.bridge.skills.find(skill => skill.id === 'browser') ||
      runtime.bridge.skills.find(skill => skill.id === 'browser-verification');
    if (browserSkill && runtimeHasSkill(runtime, browserSkill.id)) {
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

  return requests.slice(0, 2);
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

const shouldPersonaOwnToolRequest = (systemType: MagiSystem, request: PlannedToolRequest) => {
  if (request.toolId === 'web.search.tavily') return systemType === MagiSystem.MELCHIOR;

  if (request.toolId === 'mcp.call') {
    const server = typeof request.arguments?.server === 'string' ? request.arguments.server : '';
    const tool = typeof request.arguments?.tool === 'string' ? request.arguments.tool : '';
    if (server === 'browser') return systemType === MagiSystem.CASPER;
    if (server === 'filesystem' && /list_allowed/i.test(tool)) return systemType === MagiSystem.BALTHASAR;
    if (server === 'filesystem') return systemType === MagiSystem.MELCHIOR;
  }

  return true;
};

const getToolRequestOwner = (request: PlannedToolRequest): MagiSystem => {
  if (request.toolId === 'web.search.tavily') return MagiSystem.MELCHIOR;

  if (request.toolId === 'skill.run') {
    const skill = typeof request.arguments?.skill === 'string' ? request.arguments.skill.toLowerCase() : '';
    if (/browser|visual|ui|verification/.test(skill)) return MagiSystem.CASPER;
    if (/mcp|tool|permission|safety|audit/.test(skill)) return MagiSystem.BALTHASAR;
    return MagiSystem.MELCHIOR;
  }

  if (request.toolId === 'mcp.call') {
    const server = typeof request.arguments?.server === 'string' ? request.arguments.server : '';
    const tool = typeof request.arguments?.tool === 'string' ? request.arguments.tool : '';
    if (server === 'browser') return MagiSystem.CASPER;
    if (server === 'filesystem' && /list_allowed/i.test(tool)) return MagiSystem.BALTHASAR;
    if (server === 'filesystem') return MagiSystem.MELCHIOR;
  }

  return MagiSystem.MELCHIOR;
};

const toolRequestAlreadyAttempted = (request: PlannedToolRequest, traces: ToolTrace[]) => {
  if (request.toolId === 'web.search.tavily') {
    const query = typeof request.arguments?.query === 'string' ? request.arguments.query.trim() : '';
    return Boolean(query) && traces.some(trace => trace.toolId === 'web.search.tavily' && trace.query === query);
  }

  if (request.toolId === 'skill.run') {
    const skill = typeof request.arguments?.skill === 'string' ? request.arguments.skill.trim() : '';
    return Boolean(skill) && traces.some(trace =>
      trace.toolId === 'skill.run' &&
      trace.details?.includes(`"skill": "${skill}"`),
    );
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
  settings: HarnessSettings,
  systemType: MagiSystem,
  harnessBlock: string,
  userQuery: string,
  runtime: RuntimeCapabilities,
): Promise<PlannedToolRequest[]> => {
  const config = systemConfigs[systemType];

  const prompt = `
You are ${config.name}. Decide whether any permitted tools are useful at this first action opportunity before your main analysis.

${harnessBlock}

Available tool request shapes:
- web.search.tavily: { "query": "single focused search query" }
- skill.run: { "skill": "skill name", "task": "what you need from the skill", "mode": "load" }
- mcp.call: { "server": "configured MCP server id", "tool": "server tool name", "arguments": {} }

Request only tools that are directly useful and permissioned by the registry. Prefer at most two requests.

Important:
- The Authoritative Runtime Tool Manifest is live. Trust it over stale memory.
- Action is available throughout the whole run: analysis, council, synthesis, and approved execution. This is only the first chance to act.
- When a low-risk tool can answer or verify the task, request it now instead of proposing that the user approve a future test.
- If the user asks about local code, files, repo structure, or whether MAGI can access the project, use filesystem MCP when it is listed.
- Do not answer "browser sandbox cannot access filesystem" when bridge is online and filesystem MCP tools are listed. Request mcp.call instead.
- If the user asks for skill details and a matching runtime skill is listed, request skill.run with mode "load".

Concrete examples when filesystem MCP is available:
- repository tree: { "toolId": "mcp.call", "arguments": { "server": "filesystem", "tool": "directory_tree", "arguments": { "path": ".", "excludePatterns": ["node_modules", "dist", ".git", ".magi/state"] } }, "reason": "Inspect project tree" }
- read file: { "toolId": "mcp.call", "arguments": { "server": "filesystem", "tool": "read_text_file", "arguments": { "path": "App.tsx", "head": 160 } }, "reason": "Inspect source file" }
- skill details: { "toolId": "skill.run", "arguments": { "skill": "browser-verification", "task": "Load SKILL.md", "mode": "load" }, "reason": "Inspect skill instructions" }

Concrete examples when browser MCP is available:
- navigate: { "toolId": "mcp.call", "arguments": { "server": "browser", "tool": "browser_navigate", "arguments": { "url": "http://localhost:4123/", "waitUntil": "domcontentloaded" } }, "reason": "Open page for browser verification" }
- read page: { "toolId": "mcp.call", "arguments": { "server": "browser", "tool": "browser_read_page", "arguments": { "maxChars": 12000 } }, "reason": "Read current page" }
- screenshot: { "toolId": "mcp.call", "arguments": { "server": "browser", "tool": "browser_screenshot", "arguments": { "name": "magi-ui", "fullPage": true } }, "reason": "Capture visual artifact" }
- click/type are high-risk browser actions and should be requested only when the user asked for that interaction.

Return JSON only:
{
  "requests": [
    {
      "toolId": "web.search.tavily | skill.run | mcp.call",
      "arguments": {},
      "reason": "brief reason"
    }
  ]
}

User query: "${userQuery}"
`;

  try {
    const response = await client.chat.completions.create(createChatParams(settings, {
      model: modelName,
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }) as any);

    const text = response.choices[0]?.message?.content;
    if (!text) return suggestRuntimeToolRequests(systemType, userQuery, runtime);
    const parsed = safeParse(text, `${config.name} TOOL PLANNER`) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return suggestRuntimeToolRequests(systemType, userQuery, runtime);

    const planned = parsed.requests
      .filter((request): request is PlannedToolRequest => {
        if (!request || typeof request !== 'object') return false;
        const candidate = request as PlannedToolRequest;
        return candidate.toolId === 'web.search.tavily' ||
          candidate.toolId === 'skill.run' ||
          candidate.toolId === 'mcp.call';
      })
      .slice(0, 2)
      .map(request => ({
        toolId: request.toolId,
        arguments: request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
          ? request.arguments
          : {},
        reason: typeof request.reason === 'string' ? request.reason : '',
      }));
    if (planned.length === 0) {
      return suggestRuntimeToolRequests(systemType, userQuery, runtime);
    }
    const augmented = [...planned];
    suggestRuntimeToolRequests(systemType, userQuery, runtime).forEach(request => appendUniqueToolRequest(augmented, request));
    return augmented.slice(0, 2);
  } catch (error) {
    console.warn(`[${config.name}] Tool-planning step failed.`, error);
    return suggestRuntimeToolRequests(systemType, userQuery, runtime);
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

  for (const request of requests.filter(request => shouldPersonaOwnToolRequest(systemType, request))) {
    const allowed = hasToolPermission(harness.documents, systemType, request.toolId);
    if (!allowed) {
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: 'denied',
        summary: 'Permission denied by registry.tools.',
        details: request.reason,
      });
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'failed', `${request.toolId} denied by registry.tools.`);
      continue;
    }

    const assessment = assessToolRequestRisk(request);
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

    try {
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'running', `Executing ${request.toolId}.`);
      const bridgeResult = await executeBridgeTool(request.toolId, request.arguments || {}, config.name);
      const details = truncateForPrompt({
        request: request.arguments || {},
        result: bridgeResult.result,
      });
      toolResultBlocks.push(`### ${config.name} used ${request.toolId}\nReason: ${request.reason || 'No reason supplied.'}\nResult:\n${details}`);
      toolTraces.push({
        systemName: config.name,
        toolId: request.toolId,
        status: 'allowed',
        summary: request.reason || `Persona requested ${request.toolId}.`,
        details,
      });
      emitStreamEvent(streamEvents, onEvent, 'tool', config.name, 'complete', `${request.toolId} completed.`);
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
  const toolRequests = await planPersonaTools(client, modelName, harness.settings, systemType, harnessBlock, userQuery, runtime);
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
    const response = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: archetypePrompt }],
      temperature: 0.7,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    }) as any);

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error(`${config.name} Silence.`);

    const parsed = safeParse(text, config.name) as {
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
  const langInstruction = language === 'CN'
    ? 'Think in Chinese and return JSON only.'
    : 'Think in English and return JSON only.';
  const ownOutput = initialOutputs[systemType];
  const toolAudit = existingToolTraces.map(trace =>
    `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', 800)}`,
  ).join('\n') || 'NO TOOL CALLS YET.';

  const promptText = `
You are ${config.name}. The council is allowed to act while deliberating. Decide whether you need another permitted tool call before the meeting statement.

${langInstruction}

${runtimeBlock}

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
- Do not ask the user for permission to run low-risk read-only tools; request the tool now.
- If a factual claim can be checked with an available read-only tool, request it.
- Avoid repeating a tool call that already has a useful result in Tool Audit.
- Risky click/type/write actions may be requested, but they will enter the approval queue.
- Return no requests when no additional action is useful.

Return JSON only:
{
  "requests": [
    { "toolId": "web.search.tavily | skill.run | mcp.call", "arguments": {}, "reason": "brief reason" }
  ]
}
`;

  try {
    const response = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: promptText }],
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }) as any);
    const text = response.choices[0]?.message?.content;
    if (!text) return [];
    const parsed = safeParse(text, `${config.name} COUNCIL TOOL PLANNER`) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];

    return parsed.requests
      .filter((request): request is PlannedToolRequest => {
        if (!request || typeof request !== 'object') return false;
        const candidate = request as PlannedToolRequest;
        return candidate.toolId === 'web.search.tavily' ||
          candidate.toolId === 'skill.run' ||
          candidate.toolId === 'mcp.call';
      })
      .map(request => ({
        toolId: request.toolId,
        arguments: request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
          ? request.arguments
          : {},
        reason: typeof request.reason === 'string' ? request.reason : '',
      }))
      .filter(request => shouldPersonaOwnToolRequest(systemType, request))
      .filter(request => !toolRequestAlreadyAttempted(request, existingToolTraces))
      .slice(0, 1);
  } catch (error) {
    console.warn(`[${config.name}] Council tool-planning step failed.`, error);
    return [];
  }
};

const planSynthesisTools = async (
  userQuery: string,
  language: Language,
  harness: MagiHarnessContext,
  runtimeBlock: string,
  initialOutputs: Record<MagiSystem, MagiAnalysis>,
  meeting: CouncilExchange[],
  existingToolTraces: ToolTrace[],
  pendingActions: PendingAction[],
): Promise<PlannedToolRequest[]> => {
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const langInstruction = language === 'CN'
    ? 'Think in Chinese and return JSON only.'
    : 'Think in English and return JSON only.';
  const personaBrief = Object.values(MagiSystem).map(systemType => {
    const output = initialOutputs[systemType];
    return `[${output.systemName}]\nAnalysis: ${output.analysis}\nProposal: ${output.proposal}\nVote: ${output.vote ? 'APPROVE' : 'REJECT'}`;
  }).join('\n\n');
  const toolAudit = existingToolTraces.map(trace =>
    `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', 900)}`,
  ).join('\n') || 'NO TOOL CALLS YET.';

  const promptText = `
You are the MAGI council integrator immediately before final synthesis. The council has already discussed, but discussion is not a substitute for action.

${langInstruction}

${runtimeBlock}

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
- This is the final pre-answer action checkpoint. If a permitted tool can settle a remaining factual, file, browser, skill, or MCP uncertainty, request it now.
- Do not ask the user for permission to run low-risk read-only tools. Use them.
- Avoid repeating useful tool calls already present in Tool Audit.
- Risky click/type/write/execute actions may be requested, but they will become pending approvals.
- Return no requests when the answer can already be grounded in existing tool results.

Return JSON only:
{
  "requests": [
    { "toolId": "web.search.tavily | skill.run | mcp.call", "arguments": {}, "reason": "brief reason" }
  ]
}
`;

  try {
    const response = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: promptText }],
      temperature: 0.2,
      max_tokens: 420,
      response_format: { type: 'json_object' },
    }) as any);
    const text = response.choices[0]?.message?.content;
    if (!text) return [];
    const parsed = safeParse(text, 'SYNTHESIS TOOL PLANNER') as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];

    return parsed.requests
      .filter((request): request is PlannedToolRequest => {
        if (!request || typeof request !== 'object') return false;
        const candidate = request as PlannedToolRequest;
        return candidate.toolId === 'web.search.tavily' ||
          candidate.toolId === 'skill.run' ||
          candidate.toolId === 'mcp.call';
      })
      .map(request => ({
        toolId: request.toolId,
        arguments: request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
          ? request.arguments
          : {},
        reason: typeof request.reason === 'string' ? request.reason : '',
      }))
      .filter(request => !toolRequestAlreadyAttempted(request, existingToolTraces))
      .slice(0, 2);
  } catch (error) {
    console.warn('[COUNCIL] Synthesis tool-planning step failed.', error);
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
${toolAudit.map(trace => `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', 900)}`).join('\n') || 'NO TOOL CALLS.'}

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
    const response = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: promptText }],
      temperature: 0.6,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }) as any);

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error(`${config.name} meeting silence.`);

    const parsed = safeParse(text, `${config.name} MEETING`) as {
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
  const langInstruction = language === 'CN'
    ? 'Output in Simplified Chinese.'
    : 'Output in English.';

  const promptText = `
You are the final MAGI council voice. Write the final user-facing answer only; do not return JSON.

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

Rules:
- Be concise and concrete.
- Lead with the answer or completed action result, not the council process.
- If pending actions require approval, clearly say they are waiting and do not claim they have executed.
- If user input is required, ask the focused question(s) implied by the draft; do not ask for confirmation to run low-risk tools that already ran.
- Preserve the substance of the structured council result.
`;

  emit('synthesis-stream', 'COUNCIL', 'running', 'Streaming final synthesis text.');

  try {
    const stream = await client.chat.completions.create(createChatParams(harness.settings, {
      model: modelName,
      messages: [{ role: 'system', content: promptText }],
      temperature: 0.5,
      max_tokens: 2048,
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
      `Model ${harness.settings.modelName || process.env.OPENAI_MODEL_NAME || 'unset'}; reasoning ${harness.settings.reasoningEnabled ? harness.settings.reasoningEffort : 'off'}.`,
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
    `Model ${harness.settings.modelName || process.env.OPENAI_MODEL_NAME || 'unset'}; reasoning ${harness.settings.reasoningEnabled ? harness.settings.reasoningEffort : 'off'}.`,
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

  const runNode = async (systemType: MagiSystem) => {
    try {
      emit('persona', systemConfigs[systemType].name, 'queued', 'Queued for independent analysis.');
      return await withTimeout(
        queryArchetype(systemType, prompt, contextStr, legacyMemoryStr, language, harness, runtime, runtimeBlock, event => {
          streamEvents.push(event);
          options.onEvent?.(event);
        }),
        60000,
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

  emit('synthesis-tools', 'COUNCIL', 'running', 'Checking whether final synthesis needs more tool action.');
  const synthesisToolRequests = await planSynthesisTools(
    prompt,
    language,
    harness,
    runtimeBlock,
    initialOutputs,
    meeting,
    allToolTraces,
    pendingActions,
  );
  const synthesisToolExecutions = await Promise.all(synthesisToolRequests.map(async request => {
    const owner = getToolRequestOwner(request);
    return {
      owner,
      result: await executeToolRequests([request], owner, harness, event => {
        streamEvents.push(event);
        options.onEvent?.(event);
      }),
    };
  }));
  const synthesisToolCount = synthesisToolExecutions.reduce((sum, item) => sum + item.result.toolTraces.length, 0);
  synthesisToolExecutions.forEach(item => {
    allSources = dedupeSources([...allSources, ...item.result.sources]);
    pendingActions = [...pendingActions, ...item.result.pendingActions];
    allToolTraces = [...allToolTraces, ...item.result.toolTraces];
    item.result.toolTraces.forEach(toolTrace => {
      trace.push(makeTraceStep(
        'synthesis-tool',
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
    'synthesis-tools',
    'COUNCIL',
    'complete',
    synthesisToolCount > 0 ? `${synthesisToolCount} synthesis-stage tool action(s) processed.` : 'No final tool action needed before synthesis.',
  );

  const synthesisAllowedDocs = new Set<HarnessDocumentId>([
    'memory.shared',
    'council.protocol',
  ]);

  const synthesisPrompt = `
You are the MAGI council integrator. Three independent agents have deliberated. Your job is to converge, decide, and produce a bounded execution plan.

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

## Tool Audit
${allToolTraces.map(trace => `${trace.systemName}:${trace.toolId}:${trace.status}:${trace.query || ''}:${trace.summary || ''}:${truncateForPrompt(trace.details || '', 1200)}`).join('\n') || 'NO TOOL CALLS.'}

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
If the next safe step depends on genuinely missing user intent, credentials, destructive changes, or a risky action approval, set requiresUserInput true and ask focused questions.
If runtime bridge is online and filesystem MCP tools are listed, do not say the system cannot inspect local files. Instead summarize tool results or state which mcp.call should be approved/executed next.
`;

  emit('synthesis', 'COUNCIL', 'running', 'Integrating votes, meeting transcript, and action queue.');
  const response = await client.chat.completions.create(createChatParams(harness.settings, {
    model: modelName,
    messages: [{ role: 'system', content: synthesisPrompt }],
    temperature: 0.7,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  }) as any);

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Synthesis Silence.');

  const synthesisResult = safeParse(text, 'SYNTHESIS') as {
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
    pendingActions.some(action => action.requiresApproval && action.status === 'pending') ||
    clarificationRequests.some(request => request.required !== false);

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
  };
};
