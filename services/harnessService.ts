import {
  DocumentOperation,
  HarnessDocument,
  HarnessDocumentId,
  HarnessDocuments,
  HarnessSettings,
  MagiSystem,
  ReasoningEffort,
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
    fallback: '# Tool Registry\n\n```permissions\nMELCHIOR-1:web.search.tavily=allow\nBALTHASAR-2:web.search.tavily=allow\nCASPER-3:web.search.tavily=allow\n```',
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

export const createDefaultHarnessSettings = (): HarnessSettings => ({
  apiKey: '',
  baseURL: process.env.OPENAI_BASE_URL || '',
  modelName: process.env.OPENAI_MODEL_NAME || '',
  tavilyApiKey: '',
  reasoningEnabled: false,
  reasoningEffort: 'medium',
});

export const loadHarnessSettings = (): HarnessSettings => {
  if (typeof localStorage !== 'undefined') {
    LEGACY_SETTINGS_KEYS.forEach(key => localStorage.removeItem(key));
  }

  const defaults = createDefaultHarnessSettings();
  const saved = loadLocalState<Partial<HarnessSettings> | null>('settings', null);
  if (!saved) return defaults;

  return {
    ...defaults,
    ...saved,
    reasoningEffort: isReasoningEffort(saved.reasoningEffort) ? saved.reasoningEffort : defaults.reasoningEffort,
  };
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

const normalizeDocuments = (documents: Partial<HarnessDocuments>): HarnessDocuments => {
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
  if (id !== 'registry.tools') return content;

  return content
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
  if (saved) return normalizeDocuments(saved);

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
  const escapedTool = toolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSystem = systemType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedSystem}\\s*:\\s*${escapedTool}\\s*=\\s*allow`, 'i');
  return pattern.test(registry);
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
