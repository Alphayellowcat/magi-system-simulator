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
  ToolId,
  ToolTrace,
} from '../types';
import {
  getPersonaDocumentId,
  getPersonaMemoryDocumentId,
  hasToolPermission,
} from './harnessService';
import { executeBridgeTool } from './bridgeService';

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

const readOnlyMcpToolPattern = /^(read|list|get|search|find|stat|describe|inspect|directory_tree|list_allowed)/i;
const mutatingMcpToolPattern = /(^|_)(write|edit|delete|remove|move|rename|create|mkdir|touch|patch|update|replace|append|run|execute|shell|command)($|_)/i;

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

const buildPersonaHarness = (
  systemType: MagiSystem,
  documents: HarnessDocuments,
  legacyMemoryStr: string,
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
): Promise<PlannedToolRequest[]> => {
  const config = systemConfigs[systemType];

  const prompt = `
You are ${config.name}. Decide whether any permitted tools are useful before your main analysis.

${harnessBlock}

Available tool request shapes:
- web.search.tavily: { "query": "single focused search query" }
- skill.run: { "skill": "skill name", "task": "what you need from the skill", "mode": "load" }
- mcp.call: { "server": "configured MCP server id", "tool": "server tool name", "arguments": {} }

Request only tools that are directly useful and permissioned by the registry. Prefer at most two requests.

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
    if (!text) return [];
    const parsed = safeParse(text, `${config.name} TOOL PLANNER`) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];

    return parsed.requests
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
  } catch (error) {
    console.warn(`[${config.name}] Tool-planning step failed.`, error);
    return [];
  }
};

const queryArchetype = async (
  systemType: MagiSystem,
  userQuery: string,
  contextStr: string,
  legacyMemoryStr: string,
  language: Language,
  harness: MagiHarnessContext,
  onEvent?: QueryMagiOptions['onEvent'],
): Promise<PersonaQueryResult> => {
  const config = systemConfigs[systemType];
  const client = createClient(harness.settings);
  const modelName = getModelName(harness.settings);
  const harnessBlock = buildPersonaHarness(systemType, harness.documents, legacyMemoryStr);
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
  const toolRequests = await planPersonaTools(client, modelName, harness.settings, systemType, harnessBlock, userQuery);
  emitStreamEvent(
    streamEvents,
    onEvent,
    'tool-plan',
    config.name,
    'complete',
    `${toolRequests.length} tool request${toolRequests.length === 1 ? '' : 's'} proposed.`,
  );

  for (const request of toolRequests) {
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
      sources = [...sources, ...searchResult.sources];
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
      const details = truncateForPrompt(bridgeResult.result);
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

const queryCouncilExchange = async (
  systemType: MagiSystem,
  prompt: string,
  language: Language,
  harness: MagiHarnessContext,
  contextStr: string,
  initialOutputs: Record<MagiSystem, MagiAnalysis>,
  pendingActions: PendingAction[],
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

Respond to the other two personas. Challenge weak assumptions, name blocked actions, and revise your proposal if needed.
If the council cannot safely proceed without the user, ask one or two concrete clarification questions.

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

export const queryMagiSystem = async (
  prompt: string,
  history: Message[],
  language: Language,
  memories: MemoryItem[],
  harness: MagiHarnessContext,
  options: QueryMagiOptions = {},
): Promise<MagiResponse> => {
  const streamEvents: StreamEvent[] = [];
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

  const runNode = async (systemType: MagiSystem) => {
    try {
      emit('persona', systemConfigs[systemType].name, 'queued', 'Queued for independent analysis.');
      return await withTimeout(
        queryArchetype(systemType, prompt, contextStr, legacyMemoryStr, language, harness, event => {
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

  const allSources = dedupeSources([
    ...melchior.groundingSources,
    ...balthasar.groundingSources,
    ...casper.groundingSources,
  ]);

  const pendingActions = [
    ...melchior.pendingActions,
    ...balthasar.pendingActions,
    ...casper.pendingActions,
  ];

  const allToolTraces = [
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

  emit('meeting', 'COUNCIL', 'running', 'Starting three-persona council round.');
  const meetingResults = await Promise.all([
    queryCouncilExchange(MagiSystem.MELCHIOR, prompt, language, harness, contextStr, initialOutputs, pendingActions, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
    queryCouncilExchange(MagiSystem.BALTHASAR, prompt, language, harness, contextStr, initialOutputs, pendingActions, event => {
      streamEvents.push(event);
      options.onEvent?.(event);
    }),
    queryCouncilExchange(MagiSystem.CASPER, prompt, language, harness, contextStr, initialOutputs, pendingActions, event => {
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
If the next safe step depends on missing user intent, set requiresUserInput true and ask focused questions.
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
  ].slice(0, 6);

  const requiresUserInput = Boolean(synthesisResult.requiresUserInput) ||
    pendingActions.some(action => action.requiresApproval && action.status === 'pending') ||
    clarificationRequests.some(request => request.required !== false);

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

  return {
    centralAnalysis: synthesisResult.centralAnalysis || 'Integrated council analysis.',
    melchior,
    balthasar,
    casper,
    synthesis: synthesisResult.synthesis || 'NO SYNTHESIS RETURNED.',
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
    requiresUserInput,
  };
};
