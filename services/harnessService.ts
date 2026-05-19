import {
  DocumentOperation,
  HarnessDocument,
  HarnessDocumentId,
  HarnessDocuments,
  HarnessSettings,
  MagiSystem,
  ModelSaddleId,
  ReasoningEffort,
  RuntimeBudgetSettings,
  ToolAccessDefinition,
  ToolAccessKey,
  ToolAccessMatrix,
  ToolAccessMode,
} from '../types';
import { loadLocalState, saveLocalState } from './stateStorageService';

const SETTINGS_KEY = 'magi_harness_settings_v2';
const LEGACY_SETTINGS_KEYS = ['magi_harness_settings_v1'];
const DOCUMENTS_KEY = 'magi_harness_documents_v1';

type HarnessDocumentDefinition = Omit<HarnessDocument, 'content'> & { fallback: string };

const MELCHIOR_SKEPTICAL_DUTY = `## Skeptical Duty

You own mechanism skepticism. For scientific, technical, academic, policy, medical, legal, financial, or other judgment-heavy claims:

- Ask whether the claim is identifiable from the available data, not merely whether someone on the web asserts it.
- Prefer mechanism, causal structure, math, reproducibility, and falsifiability over source popularity.
- Distinguish observations from conclusions. A report, article, or search snippet is evidence candidate, not truth.
- Name the key counterfactual: what result or example would prove this claim wrong?
- If a tool or metric is said to measure something, check whether its observable features can actually identify that target.`;

const BALTHASAR_SKEPTICAL_DUTY = `## Skeptical Duty

You own incentive and harm skepticism. When evidence, tools, metrics, or authority claims appear persuasive, ask who benefits and who can be harmed.

- Check whether the source, vendor, institution, or evaluator has a commercial, reputational, regulatory, or control incentive.
- Look for false positives, false negatives, appeal paths, consent, auditability, and power asymmetry.
- Distinguish "usable as a weak signal" from "safe as a decision basis".
- Prefer reversible procedures and human review when a tool can punish people or distort incentives.
- A protective objection should name the concrete harm mechanism and the smallest safer path.`;

const CASPER_SKEPTICAL_DUTY = `## Skeptical Duty

You own counterexample and framing skepticism. When the group starts converging too smoothly, look for the alternate frame that would make the answer wrong.

- Ask whether the question's framing hides a better goal, missing option, or category error.
- Search for counterexamples: cases that look similar but mean different things.
- Notice language, culture, context, timing, and tacit incentives that a purely factual answer may flatten.
- Challenge brittle consensus and web-page persuasion; a source can be true locally while misleading for the user's actual situation.
- Turn doubt into a better framing or experiment, not vague hesitation.`;

export const HARNESS_DOCUMENT_DEFINITIONS: HarnessDocumentDefinition[] = [
  {
    id: 'persona.melchior',
    label: 'MELCHIOR Persona',
    path: '/harness/personas/melchior.md',
    fallback: `# MELCHIOR-1\n\nAnalytic intelligence. Protect truth and feasibility.\n\n${MELCHIOR_SKEPTICAL_DUTY}`,
  },
  {
    id: 'persona.balthasar',
    label: 'BALTHASAR Persona',
    path: '/harness/personas/balthasar.md',
    fallback: `# BALTHASAR-2\n\nProtective intelligence. Protect people and stability.\n\n${BALTHASAR_SKEPTICAL_DUTY}`,
  },
  {
    id: 'persona.casper',
    label: 'CASPER Persona',
    path: '/harness/personas/casper.md',
    fallback: `# CASPER-3\n\nIntuitive intelligence. Protect desire, timing, and taste.\n\n${CASPER_SKEPTICAL_DUTY}`,
  },
  {
    id: 'memory.shared',
    label: 'Shared Memory',
    path: '/harness/memory/shared.md',
    fallback: '# Shared MAGI Memory\n\nDurable facts shared by all personas.',
  },
  {
    id: 'memory.melchior',
    label: 'MELCHIOR Memory',
    path: '/harness/memory/melchior.md',
    fallback: '# MELCHIOR Memory\n\n- Prefer evidence and verification.',
  },
  {
    id: 'memory.balthasar',
    label: 'BALTHASAR Memory',
    path: '/harness/memory/balthasar.md',
    fallback: '# BALTHASAR Memory\n\n- Preserve user work and safety.',
  },
  {
    id: 'memory.casper',
    label: 'CASPER Memory',
    path: '/harness/memory/casper.md',
    fallback: '# CASPER Memory\n\n- Keep imagination tied to execution.',
  },
  {
    id: 'council.protocol',
    label: 'Council Protocol',
    path: '/harness/council.md',
    fallback: '# Council Protocol\n\nThree independent agents deliberate, act through permitted tools, and converge. The final synthesis is a voice-over/integrator, not a fourth persona or evidence filter.',
  },
  {
    id: 'registry.tools',
    label: 'Tool Registry',
    path: '/harness/tools.md',
    fallback: '# Tool Registry\n\n```permissions\nMELCHIOR-1:web.search.tavily=allow\nMELCHIOR-1:web.fetch=allow\nBALTHASAR-2:web.search.tavily=allow\nBALTHASAR-2:web.fetch=allow\nCASPER-3:web.search.tavily=allow\nCASPER-3:web.fetch=allow\n```',
  },
  {
    id: 'registry.skills',
    label: 'Skills Registry',
    path: '/harness/skills.md',
    fallback: '# Skills Registry\n\nSkills are Markdown-first packages with a SKILL.md entry point.',
  },
  {
    id: 'registry.mcp',
    label: 'MCP Registry',
    path: '/harness/mcp.md',
    fallback: '# MCP Registry\n\nMCP servers expose tools, prompts, and resources through a gated adapter layer.',
  },
];

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === 'low' || value === 'medium' || value === 'high';

export const DEFAULT_RUNTIME_BUDGETS: RuntimeBudgetSettings = {
  personaTimeoutMs: 300000,
  plannerMaxTokens: 4096,
  personaMaxTokens: 16384,
  meetingMaxTokens: 8192,
  meetingRetryMaxTokens: 4096,
  synthesisMaxTokens: 32768,
  finalStreamMaxTokens: 8192,
  initialToolMaxRequests: 6,
  councilToolMaxRequests: 3,
  synthesisToolMaxRequests: 4,
  runtimeSuggestMaxRequests: 8,
  actionLoopMaxRounds: 4,
  actionLoopMaxRequestsPerRound: 4,
  totalToolMaxRequests: 32,
  jsonRepairMaxAttempts: 2,
  toolAuditChars: 4000,
  traceDetailsMaxChars: 50000,
};

export const MODEL_SADDLE_PRESETS: Record<ModelSaddleId, {
  id: ModelSaddleId;
  label: string;
  description: string;
  budgets: RuntimeBudgetSettings;
}> = {
  'deepseek-v4-1m': {
    id: 'deepseek-v4-1m',
    label: 'DeepSeek v4 1M',
    description: 'Large-context saddle for long tool traces, freer action loops, and deeper synthesis.',
    budgets: DEFAULT_RUNTIME_BUDGETS,
  },
  'large-context': {
    id: 'large-context',
    label: 'Large Context',
    description: 'Conservative large-context profile for long-window non-DeepSeek models.',
    budgets: {
      ...DEFAULT_RUNTIME_BUDGETS,
      personaTimeoutMs: 240000,
      personaMaxTokens: 12288,
      synthesisMaxTokens: 24576,
      actionLoopMaxRounds: 3,
      totalToolMaxRequests: 24,
    },
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'General model saddle with moderate budgets and shorter loops.',
    budgets: {
      personaTimeoutMs: 180000,
      plannerMaxTokens: 2048,
      personaMaxTokens: 8192,
      meetingMaxTokens: 4096,
      meetingRetryMaxTokens: 2048,
      synthesisMaxTokens: 16384,
      finalStreamMaxTokens: 4096,
      initialToolMaxRequests: 4,
      councilToolMaxRequests: 2,
      synthesisToolMaxRequests: 3,
      runtimeSuggestMaxRequests: 6,
      actionLoopMaxRounds: 2,
      actionLoopMaxRequestsPerRound: 3,
      totalToolMaxRequests: 16,
      jsonRepairMaxAttempts: 2,
      toolAuditChars: 2500,
      traceDetailsMaxChars: 30000,
    },
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Small/flash model saddle for quick answers with tight tool and token budgets.',
    budgets: {
      personaTimeoutMs: 90000,
      plannerMaxTokens: 1024,
      personaMaxTokens: 4096,
      meetingMaxTokens: 2048,
      meetingRetryMaxTokens: 1024,
      synthesisMaxTokens: 8192,
      finalStreamMaxTokens: 2048,
      initialToolMaxRequests: 2,
      councilToolMaxRequests: 1,
      synthesisToolMaxRequests: 2,
      runtimeSuggestMaxRequests: 4,
      actionLoopMaxRounds: 1,
      actionLoopMaxRequestsPerRound: 2,
      totalToolMaxRequests: 8,
      jsonRepairMaxAttempts: 1,
      toolAuditChars: 1200,
      traceDetailsMaxChars: 12000,
    },
  },
};

const modelSaddleIds = Object.keys(MODEL_SADDLE_PRESETS) as ModelSaddleId[];

export const inferModelSaddle = (modelName = '', baseURL = ''): ModelSaddleId => {
  const text = `${modelName} ${baseURL}`.toLowerCase();
  if (/deepseek.*v4|deepseek-v4|1m/.test(text)) return 'deepseek-v4-1m';
  if (/flash|mini|small|lite|turbo/.test(text)) return 'fast';
  if (/128k|200k|1m|long|large|claude|gpt-4\.1|gpt-5/.test(text)) return 'large-context';
  return 'balanced';
};

export const isModelSaddleId = (value: unknown): value is ModelSaddleId =>
  typeof value === 'string' && modelSaddleIds.includes(value as ModelSaddleId);

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
};

export const normalizeRuntimeBudgets = (budgets?: Partial<RuntimeBudgetSettings> | null): RuntimeBudgetSettings => ({
  personaTimeoutMs: clampNumber(budgets?.personaTimeoutMs, DEFAULT_RUNTIME_BUDGETS.personaTimeoutMs, 30000, 900000),
  plannerMaxTokens: clampNumber(budgets?.plannerMaxTokens, DEFAULT_RUNTIME_BUDGETS.plannerMaxTokens, 512, 32768),
  personaMaxTokens: clampNumber(budgets?.personaMaxTokens, DEFAULT_RUNTIME_BUDGETS.personaMaxTokens, 1024, 65536),
  meetingMaxTokens: clampNumber(budgets?.meetingMaxTokens, DEFAULT_RUNTIME_BUDGETS.meetingMaxTokens, 1024, 65536),
  meetingRetryMaxTokens: clampNumber(budgets?.meetingRetryMaxTokens, DEFAULT_RUNTIME_BUDGETS.meetingRetryMaxTokens, 512, 32768),
  synthesisMaxTokens: clampNumber(budgets?.synthesisMaxTokens, DEFAULT_RUNTIME_BUDGETS.synthesisMaxTokens, 2048, 131072),
  finalStreamMaxTokens: clampNumber(budgets?.finalStreamMaxTokens, DEFAULT_RUNTIME_BUDGETS.finalStreamMaxTokens, 1024, 65536),
  initialToolMaxRequests: clampNumber(budgets?.initialToolMaxRequests, DEFAULT_RUNTIME_BUDGETS.initialToolMaxRequests, 1, 16),
  councilToolMaxRequests: clampNumber(budgets?.councilToolMaxRequests, DEFAULT_RUNTIME_BUDGETS.councilToolMaxRequests, 0, 12),
  synthesisToolMaxRequests: clampNumber(budgets?.synthesisToolMaxRequests, DEFAULT_RUNTIME_BUDGETS.synthesisToolMaxRequests, 0, 12),
  runtimeSuggestMaxRequests: clampNumber(budgets?.runtimeSuggestMaxRequests, DEFAULT_RUNTIME_BUDGETS.runtimeSuggestMaxRequests, 1, 24),
  actionLoopMaxRounds: clampNumber(budgets?.actionLoopMaxRounds, DEFAULT_RUNTIME_BUDGETS.actionLoopMaxRounds, 0, 12),
  actionLoopMaxRequestsPerRound: clampNumber(budgets?.actionLoopMaxRequestsPerRound, DEFAULT_RUNTIME_BUDGETS.actionLoopMaxRequestsPerRound, 1, 12),
  totalToolMaxRequests: clampNumber(budgets?.totalToolMaxRequests, DEFAULT_RUNTIME_BUDGETS.totalToolMaxRequests, 1, 96),
  jsonRepairMaxAttempts: clampNumber(budgets?.jsonRepairMaxAttempts, DEFAULT_RUNTIME_BUDGETS.jsonRepairMaxAttempts, 0, 4),
  toolAuditChars: clampNumber(budgets?.toolAuditChars, DEFAULT_RUNTIME_BUDGETS.toolAuditChars, 800, 20000),
  traceDetailsMaxChars: clampNumber(budgets?.traceDetailsMaxChars, DEFAULT_RUNTIME_BUDGETS.traceDetailsMaxChars, 4000, 200000),
});

const systemTypes = [MagiSystem.MELCHIOR, MagiSystem.BALTHASAR, MagiSystem.CASPER] as const;

export const TOOL_ACCESS_DEFINITIONS: ToolAccessDefinition[] = [
  {
    key: 'web.search.tavily',
    label: 'Web Search',
    description: 'Read-only Tavily web search.',
  },
  {
    key: 'web.fetch',
    label: 'Web Fetch',
    description: 'Read a specific URL without opening a browser.',
  },
  {
    key: 'skill.run.load',
    label: 'Skill Load',
    description: 'Load SKILL.md instructions and metadata.',
  },
  {
    key: 'skill.run.script',
    label: 'Skill Script',
    description: 'Run an approved local skill script.',
  },
  {
    key: 'mcp.filesystem.read',
    label: 'Filesystem Read',
    description: 'Read/list/search files through filesystem MCP.',
  },
  {
    key: 'mcp.filesystem.write',
    label: 'Filesystem Write',
    description: 'Create/edit/delete files through filesystem MCP.',
  },
  {
    key: 'mcp.browser.read',
    label: 'Browser Read',
    description: 'Navigate/read/screenshot/close through Browser MCP.',
  },
  {
    key: 'mcp.browser.interact',
    label: 'Browser Interact',
    description: 'Click/type/fill/submit through Browser MCP.',
  },
  {
    key: 'mcp.other.read',
    label: 'Other MCP Read',
    description: 'Read-only calls on non-core MCP servers.',
  },
  {
    key: 'mcp.other.write',
    label: 'Other MCP Write',
    description: 'Mutating or ambiguous calls on non-core MCP servers.',
  },
];

const toolAccessKeys = TOOL_ACCESS_DEFINITIONS.map(definition => definition.key);

const isToolAccessMode = (value: unknown): value is ToolAccessMode =>
  value === 'allow' || value === 'review' || value === 'deny';

const isToolAccessKey = (value: unknown): value is ToolAccessKey =>
  typeof value === 'string' && toolAccessKeys.includes(value as ToolAccessKey);

export const createDefaultToolAccessMatrix = (): ToolAccessMatrix =>
  systemTypes.reduce((matrix, systemType) => {
    matrix[systemType] = {
      'web.search.tavily': 'allow',
      'web.fetch': 'allow',
      'skill.run.load': 'allow',
      'skill.run.script': 'review',
      'mcp.filesystem.read': 'allow',
      'mcp.filesystem.write': 'review',
      'mcp.browser.read': 'allow',
      'mcp.browser.interact': 'review',
      'mcp.other.read': 'review',
      'mcp.other.write': 'review',
    };
    return matrix;
  }, {} as ToolAccessMatrix);

export const normalizeToolAccessMatrix = (rawMatrix?: Partial<ToolAccessMatrix> | null): ToolAccessMatrix => {
  const defaults = createDefaultToolAccessMatrix();
  if (!rawMatrix || typeof rawMatrix !== 'object') return defaults;

  systemTypes.forEach(systemType => {
    const rawRow = rawMatrix[systemType];
    if (!rawRow || typeof rawRow !== 'object') return;

    Object.entries(rawRow).forEach(([key, mode]) => {
      if (isToolAccessKey(key) && isToolAccessMode(mode)) {
        defaults[systemType][key] = mode;
      }
    });
  });

  return defaults;
};

export const createDefaultHarnessSettings = (): HarnessSettings => {
  const baseURL = process.env.OPENAI_BASE_URL || '';
  const modelName = process.env.OPENAI_MODEL_NAME || '';
  const modelSaddle = inferModelSaddle(modelName, baseURL);
  return {
    apiKey: '',
    baseURL,
    modelName,
    tavilyApiKey: '',
    modelSaddle,
    reasoningEnabled: false,
    reasoningEffort: 'medium',
    runtimeBudgets: MODEL_SADDLE_PRESETS[modelSaddle].budgets,
    toolAccess: createDefaultToolAccessMatrix(),
  };
};

export const normalizeHarnessSettings = (settings?: Partial<HarnessSettings> | null): HarnessSettings => {
  const defaults = createDefaultHarnessSettings();
  if (!settings || typeof settings !== 'object') return defaults;
  const modelSaddle = isModelSaddleId(settings.modelSaddle)
    ? settings.modelSaddle
    : inferModelSaddle(settings.modelName || defaults.modelName, settings.baseURL || defaults.baseURL);

  return {
    ...defaults,
    ...settings,
    modelSaddle,
    reasoningEffort: isReasoningEffort(settings.reasoningEffort)
      ? settings.reasoningEffort
      : defaults.reasoningEffort,
    runtimeBudgets: settings.runtimeBudgets
      ? normalizeRuntimeBudgets(settings.runtimeBudgets)
      : MODEL_SADDLE_PRESETS[modelSaddle].budgets,
    toolAccess: normalizeToolAccessMatrix(settings.toolAccess),
  };
};

export const loadHarnessSettings = (): HarnessSettings => {
  if (typeof localStorage !== 'undefined') {
    LEGACY_SETTINGS_KEYS.forEach(key => localStorage.removeItem(key));
  }

  const saved = loadLocalState<Partial<HarnessSettings> | null>('settings', null);
  return normalizeHarnessSettings(saved);
};

export const saveHarnessSettings = (settings: HarnessSettings) => {
  saveLocalState('settings', settings);
};

export const createInitialHarnessDocuments = (): HarnessDocuments =>
  HARNESS_DOCUMENT_DEFINITIONS.reduce((acc, definition) => {
    acc[definition.id] = {
      id: definition.id,
      label: definition.label,
      path: definition.path,
      content: definition.fallback,
    };
    return acc;
  }, {} as HarnessDocuments);

export const normalizeHarnessDocuments = (documents: Partial<HarnessDocuments>): HarnessDocuments => {
  const initial = createInitialHarnessDocuments();

  HARNESS_DOCUMENT_DEFINITIONS.forEach(definition => {
    const saved = documents[definition.id];
    if (saved?.content) {
      initial[definition.id] = {
        id: definition.id,
        label: definition.label,
        path: definition.path,
        content: migrateHarnessDocument(definition.id, saved.content),
      };
    }
  });

  return initial;
};

const migrateHarnessDocument = (id: HarnessDocumentId, content: string) => {
  let next = content
    .replace(/magi\.mcp\.example\.json/g, '.magi/mcp/servers.example.json')
    .replace(/magi\.mcp\.json/g, '.magi/mcp/servers.json')
    .replace(/magi\.bridge\.json/g, '.magi/config/bridge.json')
    .replace(/无MCP filesystem服务器/g, 'filesystem MCP 状态以 Runtime Tool Manifest 为准')
    .replace(/本体代码不可见（filesystem MCP 状态以 Runtime Tool Manifest 为准）/g, '本体代码可见性以 Runtime Tool Manifest 为准；若 filesystem MCP 在线，应通过 mcp.call 读取')
    .replace(/本体代码不可见/g, '本体代码可见性以 Runtime Tool Manifest 为准')
    .replace(/MCP桥接状态待确认/g, 'MCP 桥接状态应以 Runtime Tool Manifest 为准');

  if (id === 'persona.melchior' && !/## Skeptical Duty/.test(next)) {
    next = `${next.trim()}\n\n${MELCHIOR_SKEPTICAL_DUTY}\n`;
  }

  if (id === 'persona.balthasar' && !/## Skeptical Duty/.test(next)) {
    next = `${next.trim()}\n\n${BALTHASAR_SKEPTICAL_DUTY}\n`;
  }

  if (id === 'persona.casper' && !/## Skeptical Duty/.test(next)) {
    next = `${next.trim()}\n\n${CASPER_SKEPTICAL_DUTY}\n`;
  }

  if (id === 'council.protocol') {
    next = next
      .replace(
        /Action is not a single phase\. Any persona, meeting round, or synthesis pass may request permitted tools whenever a tool can clarify the task, verify a fact, inspect local state, or prepare an implementation\. Discussion should expose uncertainty; it must not replace available low-risk action\./g,
        'Action is not a single phase. Any persona or meeting round may request permitted tools whenever a tool can clarify the task, verify a fact, inspect local state, or prepare an implementation. The action-loop may continue that work before the final answer. Discussion should expose uncertainty; it must not replace available low-risk action. The final synthesis is a voice-over/integrator, not a fourth persona or evidence filter.',
      )
      .replace(/4\. The synthesis pass may still request final verification before answering\./g, '4. If final verification is useful, the council/action-loop should do it before synthesis.')
      .replace(/5\. The council synthesis integrates tool results, disagreement, pending actions, and clarification questions into one user-facing answer\./g, '5. The synthesis voice-over integrates tool results, disagreement, pending actions, and clarification questions into one user-facing answer without adding a new persona judgment.')
      .replace(/A protective veto must be treated as a blocker unless the synthesis can name a safer equivalent path\./g, 'A protective veto must be treated as a blocker unless the council can name a safer equivalent path.')
      .replace(/If two personas approve but the third identifies a missing fact, the synthesis should prefer an available verification tool before asking the user\./g, 'If two personas approve but the third identifies a missing fact, the council/action-loop should prefer an available verification tool before asking the user.')
      .replace(/If all personas approve, the synthesis should still return a concrete execution plan\./g, 'If all personas approve, the synthesis voice-over should still return a concrete execution plan.')
      .replace(/If any next action requires user intent, credentials, destructive local changes, or non-read MCP\/tool execution, the synthesis should wait for confirmation instead of pretending the action ran\./g, 'If any next action requires user intent, credentials, destructive local changes, or non-read MCP/tool execution, the synthesis voice-over should wait for confirmation instead of pretending the action ran.');
  }

  if (id !== 'registry.tools') return next;

  return next
    .replace(/status: planned/g, 'status: implemented-local-bridge')
    .replace(/MELCHIOR-1:mcp\.call=plan/g, 'MELCHIOR-1:mcp.call=allow')
    .replace(/MELCHIOR-1:skill\.run=plan/g, 'MELCHIOR-1:skill.run=allow')
    .replace(/BALTHASAR-2:mcp\.call=review/g, 'BALTHASAR-2:mcp.call=allow')
    .replace(/BALTHASAR-2:skill\.run=review/g, 'BALTHASAR-2:skill.run=allow')
    .replace(/CASPER-3:mcp\.call=plan/g, 'CASPER-3:mcp.call=allow')
    .replace(/CASPER-3:skill\.run=plan/g, 'CASPER-3:skill.run=allow');
};

export const loadHarnessDocuments = async (): Promise<HarnessDocuments> => {
  const saved = loadLocalState<Partial<HarnessDocuments> | null>('documents', null);
  if (saved) return normalizeHarnessDocuments(saved);

  const documents = createInitialHarnessDocuments();

  await Promise.all(HARNESS_DOCUMENT_DEFINITIONS.map(async definition => {
    try {
      const response = await fetch(definition.path);
      if (!response.ok) return;
      documents[definition.id] = {
        id: definition.id,
        label: definition.label,
        path: definition.path,
        content: await response.text(),
      };
    } catch (error) {
      console.warn(`Failed to load ${definition.path}`, error);
    }
  }));

  return documents;
};

export const saveHarnessDocuments = (documents: HarnessDocuments) => {
  saveLocalState('documents', documents);
};

export const clearSavedHarnessDocuments = () => {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(DOCUMENTS_KEY);
};

export const getPersonaDocumentId = (systemType: MagiSystem): HarnessDocumentId => {
  switch (systemType) {
    case MagiSystem.MELCHIOR:
      return 'persona.melchior';
    case MagiSystem.BALTHASAR:
      return 'persona.balthasar';
    case MagiSystem.CASPER:
      return 'persona.casper';
  }
};

export const getPersonaMemoryDocumentId = (systemType: MagiSystem): HarnessDocumentId => {
  switch (systemType) {
    case MagiSystem.MELCHIOR:
      return 'memory.melchior';
    case MagiSystem.BALTHASAR:
      return 'memory.balthasar';
    case MagiSystem.CASPER:
      return 'memory.casper';
  }
};

export const hasToolPermission = (documents: HarnessDocuments, systemType: MagiSystem, toolId: string) => {
  const registry = documents['registry.tools']?.content || '';
  const hasExplicitPermission = (candidateToolId: string) => {
    const escapedTool = candidateToolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedSystem = systemType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedSystem}\\s*:\\s*${escapedTool}\\s*=\\s*allow`, 'i');
    return pattern.test(registry);
  };

  if (hasExplicitPermission(toolId)) return true;
  if (toolId === 'web.fetch') return hasExplicitPermission('web.search.tavily');
  return false;
};

export const applyDocumentOperations = (
  documents: HarnessDocuments,
  operations: DocumentOperation[] = [],
) => {
  let appliedCount = 0;
  const next: HarnessDocuments = { ...documents };

  operations.forEach(operation => {
    const current = next[operation.documentId];
    if (!current || !operation.content?.trim()) return;

    const content = operation.content.trim();
    if (operation.op === 'APPEND') {
      next[operation.documentId] = {
        ...current,
        content: `${current.content.trim()}\n\n${content}`,
      };
      appliedCount += 1;
    }

    if (operation.op === 'REPLACE') {
      next[operation.documentId] = {
        ...current,
        content,
      };
      appliedCount += 1;
    }
  });

  return { documents: next, appliedCount };
};
