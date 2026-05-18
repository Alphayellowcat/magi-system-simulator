import {
  DocumentOperation,
  HarnessDocument,
  HarnessDocumentId,
  HarnessDocuments,
  HarnessSettings,
  MagiSystem,
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

export const HARNESS_DOCUMENT_DEFINITIONS: HarnessDocumentDefinition[] = [
  {
    id: 'persona.melchior',
    label: 'MELCHIOR Persona',
    path: '/harness/personas/melchior.md',
    fallback: '# MELCHIOR-1\n\nAnalytic intelligence. Protect truth and feasibility.',
  },
  {
    id: 'persona.balthasar',
    label: 'BALTHASAR Persona',
    path: '/harness/personas/balthasar.md',
    fallback: '# BALTHASAR-2\n\nProtective intelligence. Protect people and stability.',
  },
  {
    id: 'persona.casper',
    label: 'CASPER Persona',
    path: '/harness/personas/casper.md',
    fallback: '# CASPER-3\n\nIntuitive intelligence. Protect desire, timing, and taste.',
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
    fallback: '# Council Protocol\n\nThree independent agents deliberate, converge, and execute bounded operations.',
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
  toolAuditChars: 4000,
  traceDetailsMaxChars: 50000,
};

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

export const createDefaultHarnessSettings = (): HarnessSettings => ({
  apiKey: '',
  baseURL: process.env.OPENAI_BASE_URL || '',
  modelName: process.env.OPENAI_MODEL_NAME || '',
  tavilyApiKey: '',
  reasoningEnabled: false,
  reasoningEffort: 'medium',
  runtimeBudgets: DEFAULT_RUNTIME_BUDGETS,
  toolAccess: createDefaultToolAccessMatrix(),
});

export const normalizeHarnessSettings = (settings?: Partial<HarnessSettings> | null): HarnessSettings => {
  const defaults = createDefaultHarnessSettings();
  if (!settings || typeof settings !== 'object') return defaults;

  return {
    ...defaults,
    ...settings,
    reasoningEffort: isReasoningEffort(settings.reasoningEffort)
      ? settings.reasoningEffort
      : defaults.reasoningEffort,
    runtimeBudgets: normalizeRuntimeBudgets(settings.runtimeBudgets),
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
