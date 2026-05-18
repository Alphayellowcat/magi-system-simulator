import React, { useEffect, useMemo, useState } from 'react';
import {
  RuntimeBudgetSettings,
  HarnessDocumentId,
  HarnessDocuments,
  HarnessSettings,
  MagiSystem,
  ReasoningEffort,
  ToolAccessKey,
  ToolAccessMode,
} from '../types';
import { DEFAULT_RUNTIME_BUDGETS, HARNESS_DOCUMENT_DEFINITIONS, TOOL_ACCESS_DEFINITIONS, normalizeRuntimeBudgets, normalizeToolAccessMatrix } from '../services/harnessService';
import { testModelConnection } from '../services/aiService';
import { BridgeStatus, getBridgeStatus, listMcpTools } from '../services/bridgeService';

interface SettingsPanelProps {
  settings: HarnessSettings;
  documents: HarnessDocuments;
  onSettingsSave: (settings: HarnessSettings) => void;
  onDocumentChange: (id: HarnessDocumentId, content: string) => void;
  onResetDocuments: () => void;
}

const effortOptions: ReasoningEffort[] = ['low', 'medium', 'high'];
const accessModes: ToolAccessMode[] = ['allow', 'review', 'deny'];
const accessPersonas = [MagiSystem.MELCHIOR, MagiSystem.BALTHASAR, MagiSystem.CASPER];
const budgetControls: Array<{
  key: keyof RuntimeBudgetSettings;
  label: string;
  step: number;
}> = [
  { key: 'personaTimeoutMs', label: 'Persona Timeout Ms', step: 10000 },
  { key: 'plannerMaxTokens', label: 'Planner Tokens', step: 512 },
  { key: 'personaMaxTokens', label: 'Persona Tokens', step: 1024 },
  { key: 'meetingMaxTokens', label: 'Meeting Tokens', step: 1024 },
  { key: 'synthesisMaxTokens', label: 'Synthesis Tokens', step: 2048 },
  { key: 'finalStreamMaxTokens', label: 'Final Stream Tokens', step: 1024 },
  { key: 'initialToolMaxRequests', label: 'Initial Tools', step: 1 },
  { key: 'councilToolMaxRequests', label: 'Council Tools', step: 1 },
  { key: 'synthesisToolMaxRequests', label: 'Synthesis Tools', step: 1 },
  { key: 'runtimeSuggestMaxRequests', label: 'Runtime Suggestions', step: 1 },
  { key: 'toolAuditChars', label: 'Tool Audit Chars', step: 500 },
  { key: 'traceDetailsMaxChars', label: 'Trace Details Chars', step: 5000 },
];

const accessModeLabel: Record<ToolAccessMode, string> = {
  allow: 'ALLOW',
  review: 'ASK',
  deny: 'DENY',
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  documents,
  onSettingsSave,
  onDocumentChange,
  onResetDocuments,
}) => {
  const [draftSettings, setDraftSettings] = useState<HarnessSettings>(settings);
  const [selectedDocumentId, setSelectedDocumentId] = useState<HarnessDocumentId>('persona.melchior');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [bridgeMessage, setBridgeMessage] = useState('BRIDGE STATUS UNKNOWN');
  const [browserToolCount, setBrowserToolCount] = useState<number | null>(null);
  const selectedDocument = documents[selectedDocumentId];
  const isDirty = JSON.stringify(draftSettings) !== JSON.stringify(settings);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  const refreshBridgeStatus = async () => {
    setBridgeMessage('CHECKING LOCAL BRIDGE...');
    try {
      const status = await getBridgeStatus();
      setBridgeStatus(status);
      setBridgeMessage(`ONLINE: ${status.skills.length} SKILLS, ${status.mcpServers.length} MCP SERVERS`);
      setBrowserToolCount(null);
      if (status.mcpServers.includes('browser')) {
        try {
          const result = await listMcpTools('browser') as any;
          const tools = Array.isArray(result?.result?.tools) ? result.result.tools : [];
          setBrowserToolCount(tools.length);
        } catch {
          setBrowserToolCount(0);
        }
      }
    } catch (error) {
      setBridgeStatus(null);
      setBrowserToolCount(null);
      setBridgeMessage(error instanceof Error ? error.message : 'BRIDGE OFFLINE');
    }
  };

  useEffect(() => {
    refreshBridgeStatus();
  }, []);

  const documentOptions = useMemo(
    () => HARNESS_DOCUMENT_DEFINITIONS.map(definition => ({
      id: definition.id,
      label: definition.label,
    })),
    [],
  );

  const updateSettings = <K extends keyof HarnessSettings>(key: K, value: HarnessSettings[K]) => {
    setDraftSettings(prev => ({ ...prev, [key]: value }));
    setTestState('idle');
    setTestMessage('');
  };

  const updateRuntimeBudget = (key: keyof RuntimeBudgetSettings, value: number) => {
    setDraftSettings(prev => ({
      ...prev,
      runtimeBudgets: normalizeRuntimeBudgets({
        ...prev.runtimeBudgets,
        [key]: value,
      }),
    }));
    setTestState('idle');
    setTestMessage('');
  };

  const resetRuntimeBudgets = () => {
    setDraftSettings(prev => ({
      ...prev,
      runtimeBudgets: DEFAULT_RUNTIME_BUDGETS,
    }));
    setTestState('idle');
    setTestMessage('');
  };

  const updateToolAccess = (systemType: MagiSystem, key: ToolAccessKey, mode: ToolAccessMode) => {
    setDraftSettings(prev => {
      const matrix = normalizeToolAccessMatrix(prev.toolAccess);
      return {
        ...prev,
        toolAccess: {
          ...matrix,
          [systemType]: {
            ...matrix[systemType],
            [key]: mode,
          },
        },
      };
    });
    setTestState('idle');
    setTestMessage('');
  };

  const saveSettings = () => {
    onSettingsSave(draftSettings);
    setTestState('idle');
    setTestMessage('SAVED TO LOCAL HARNESS');
  };

  const handleTestConnection = async () => {
    setTestState('testing');
    setTestMessage('TESTING CONNECTION...');

    try {
      const result = await testModelConnection(draftSettings);
      setTestState('ok');
      setTestMessage(`OK ${result.modelName} ${result.latencyMs}ms ${result.output}`);
    } catch (error) {
      setTestState('error');
      setTestMessage(error instanceof Error ? error.message : 'CONNECTION FAILED');
    }
  };

  return (
    <div className="space-y-5">
      <div className="p-3 border border-magi-dim/30 bg-magi-dim/10 space-y-3">
        <div className="text-[10px] text-magi-balthasar tracking-widest uppercase font-bold">Model Runtime</div>

        <label className="block space-y-1">
          <span className="text-[10px] text-magi-dim uppercase tracking-wider">Base URL</span>
          <input
            value={draftSettings.baseURL}
            onChange={(e) => updateSettings('baseURL', e.target.value)}
            className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-white focus:outline-none"
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] text-magi-dim uppercase tracking-wider">API Key</span>
          <input
            type="password"
            value={draftSettings.apiKey}
            onChange={(e) => updateSettings('apiKey', e.target.value)}
            className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-white focus:outline-none"
            placeholder="sk-..."
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] text-magi-dim uppercase tracking-wider">Model</span>
          <input
            value={draftSettings.modelName}
            onChange={(e) => updateSettings('modelName', e.target.value)}
            className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-white focus:outline-none"
            placeholder="gpt-4.1-mini"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] text-magi-dim uppercase tracking-wider">Tavily Key</span>
          <input
            type="password"
            value={draftSettings.tavilyApiKey}
            onChange={(e) => updateSettings('tavilyApiKey', e.target.value)}
            className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-white focus:outline-none"
            placeholder="tvly-..."
          />
        </label>

        <div className="flex items-center justify-between border border-magi-dim/30 bg-black p-2">
          <span className="text-[10px] text-magi-dim uppercase tracking-wider">Reasoning</span>
          <button
            type="button"
            onClick={() => updateSettings('reasoningEnabled', !draftSettings.reasoningEnabled)}
            className={`px-3 py-1 text-[10px] font-bold tracking-widest uppercase border transition-all ${
              draftSettings.reasoningEnabled
                ? 'bg-white text-black border-white'
                : 'text-magi-dim border-magi-dim/40 hover:text-white'
            }`}
          >
            {draftSettings.reasoningEnabled ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="grid grid-cols-3 border border-magi-dim/30">
          {effortOptions.map(effort => (
            <button
              key={effort}
              type="button"
              onClick={() => updateSettings('reasoningEffort', effort)}
              disabled={!draftSettings.reasoningEnabled}
              className={`py-2 text-[10px] font-bold uppercase tracking-wider border-r border-magi-dim/30 last:border-r-0 transition-colors ${
                draftSettings.reasoningEffort === effort && draftSettings.reasoningEnabled
                  ? 'bg-magi-balthasar text-black'
                  : 'text-magi-dim hover:text-white disabled:opacity-40'
              }`}
            >
              {effort}
            </button>
          ))}
        </div>

        <div className="border border-magi-dim/30 bg-black p-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] text-magi-balthasar uppercase tracking-wider font-bold">Runtime Budgets</div>
              <div className="text-[9px] text-magi-dim uppercase tracking-wider">DeepSeek v4 / 1M context profile</div>
            </div>
            <button
              type="button"
              onClick={resetRuntimeBudgets}
              className="border border-magi-dim/50 px-2 py-1 text-[9px] text-white hover:bg-white hover:text-black"
            >
              DEFAULT
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {budgetControls.map(control => (
              <label key={control.key} className="block space-y-1">
                <span className="text-[9px] text-magi-dim uppercase tracking-wider">{control.label}</span>
                <input
                  type="number"
                  step={control.step}
                  value={draftSettings.runtimeBudgets[control.key]}
                  onChange={(e) => updateRuntimeBudget(control.key, Number(e.target.value))}
                  className="w-full bg-[#050505] border border-magi-dim/40 text-xs p-2 text-white focus:border-magi-balthasar focus:outline-none"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testState === 'testing'}
            className="border border-magi-melchior/60 text-magi-melchior py-2 text-[10px] tracking-widest font-bold hover:bg-magi-melchior hover:text-black disabled:opacity-40"
          >
            {testState === 'testing' ? 'TESTING' : 'TEST'}
          </button>
          <button
            type="button"
            onClick={saveSettings}
            disabled={!isDirty}
            className={`border py-2 text-[10px] tracking-widest font-bold transition-colors ${
              isDirty
                ? 'border-white text-white hover:bg-white hover:text-black'
                : 'border-magi-dim/30 text-magi-dim/50'
            }`}
          >
            {isDirty ? 'SAVE' : 'SAVED'}
          </button>
        </div>

        <div className={`min-h-8 border px-3 py-2 text-[10px] leading-relaxed tracking-wider ${
          testState === 'ok'
            ? 'border-green-700 text-green-400 bg-green-950/20'
            : testState === 'error'
              ? 'border-red-800 text-red-300 bg-red-950/20'
              : isDirty
                ? 'border-magi-balthasar/60 text-magi-balthasar bg-magi-balthasar/10'
                : 'border-magi-dim/20 text-magi-dim'
        }`}>
          {testMessage || (isDirty ? 'UNSAVED CONFIGURATION' : 'CONFIGURATION SAVED')}
        </div>
      </div>

      <div className="p-3 border border-magi-dim/30 bg-black space-y-3">
        <div>
          <div className="text-[10px] text-magi-melchior tracking-widest uppercase font-bold">Tool Access Matrix</div>
          <div className="mt-1 text-[9px] text-magi-dim uppercase tracking-wider">
            ALLOW auto-runs low-risk calls, ASK routes the call to approval, DENY blocks the persona.
          </div>
        </div>

        <div className="overflow-x-auto border border-magi-dim/20">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[minmax(150px,1.25fr)_repeat(3,minmax(150px,1fr))] border-b border-magi-dim/20 bg-magi-dim/10">
              <div className="p-2 text-[9px] text-magi-dim uppercase tracking-wider">Capability</div>
              {accessPersonas.map(systemType => (
                <div key={systemType} className="p-2 text-[9px] text-white uppercase tracking-wider border-l border-magi-dim/20">
                  {systemType}
                </div>
              ))}
            </div>

            {TOOL_ACCESS_DEFINITIONS.map(definition => (
              <div
                key={definition.key}
                className="grid grid-cols-[minmax(150px,1.25fr)_repeat(3,minmax(150px,1fr))] border-b border-magi-dim/15 last:border-b-0"
              >
                <div className="p-2">
                  <div className="text-[10px] text-white uppercase tracking-wider">{definition.label}</div>
                  <div className="text-[9px] text-magi-dim leading-snug">{definition.key}</div>
                </div>

                {accessPersonas.map(systemType => {
                  const currentMode = normalizeToolAccessMatrix(draftSettings.toolAccess)[systemType][definition.key];
                  return (
                    <div key={`${systemType}-${definition.key}`} className="p-2 border-l border-magi-dim/20">
                      <div className="grid grid-cols-3 border border-magi-dim/30">
                        {accessModes.map(mode => (
                          <button
                            key={mode}
                            type="button"
                            title={definition.description}
                            onClick={() => updateToolAccess(systemType, definition.key, mode)}
                            className={`py-1 text-[9px] font-bold uppercase tracking-wider border-r border-magi-dim/30 last:border-r-0 transition-colors ${
                              currentMode === mode
                                ? mode === 'allow'
                                  ? 'bg-magi-melchior text-black'
                                  : mode === 'review'
                                    ? 'bg-magi-balthasar text-black'
                                    : 'bg-magi-casper text-black'
                                : 'text-magi-dim hover:text-white'
                            }`}
                          >
                            {accessModeLabel[mode]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-3 border border-magi-dim/30 bg-black space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-magi-casper tracking-widest uppercase font-bold">Local Bridge</div>
          <button
            type="button"
            onClick={refreshBridgeStatus}
            className="text-[10px] text-white border border-magi-dim/50 px-2 py-1 hover:bg-white hover:text-black"
          >
            REFRESH
          </button>
        </div>
        <div className={`border px-3 py-2 text-[10px] leading-relaxed tracking-wider ${
          bridgeStatus?.ok
            ? 'border-green-700 text-green-400 bg-green-950/20'
            : 'border-magi-dim/30 text-magi-dim'
        }`}>
          {bridgeMessage}
        </div>
        {bridgeStatus && (
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">MCP Config</div>
              <div className="text-gray-300 break-all">{bridgeStatus.mcpConfigPath || 'not configured'}</div>
            </div>
            <div className="border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">Skill Scripts</div>
              <div className={bridgeStatus.allowSkillScripts ? 'text-magi-balthasar' : 'text-gray-300'}>
                {bridgeStatus.allowSkillScripts ? 'enabled' : 'load-only'}
              </div>
            </div>
            <div className="col-span-2 border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">MCP Servers</div>
              <div className="text-gray-300 break-words">
                {bridgeStatus.mcpServers.length > 0 ? bridgeStatus.mcpServers.join(', ') : 'none'}
              </div>
            </div>
            <div className="col-span-2 border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">State Store</div>
              <div className="text-gray-300 break-all">
                {bridgeStatus.storage?.stateDir || 'localStorage fallback'}
              </div>
              {bridgeStatus.storage && (
                <div className="mt-2 grid grid-cols-2 gap-1 text-[9px]">
                  {(Object.entries(bridgeStatus.storage.files) as Array<[string, { exists: boolean; bytes?: number }]>).map(([key, file]) => (
                    <div key={key} className={file.exists ? 'text-green-400' : 'text-magi-dim'}>
                      {key}:{file.exists ? `${file.bytes || 0}b` : 'empty'}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="col-span-2 border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">Audit / Artifacts</div>
              <div className="text-gray-300 break-all">{bridgeStatus.auditDir || 'audit unavailable'}</div>
              <div className="mt-1 text-gray-300 break-all">{bridgeStatus.artifactDir || 'artifacts unavailable'}</div>
            </div>
            <div className="col-span-2 border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">Browser MCP</div>
              <div className={bridgeStatus.mcpServers.includes('browser') ? 'text-green-400' : 'text-magi-dim'}>
                {bridgeStatus.mcpServers.includes('browser')
                  ? `online${browserToolCount !== null ? `: ${browserToolCount} tools` : ''}`
                  : 'not configured'}
              </div>
            </div>
            <div className="col-span-2 border border-magi-dim/20 p-2">
              <div className="text-magi-dim uppercase tracking-wider mb-1">Skills</div>
              <div className="text-gray-300 break-words">
                {bridgeStatus.skills.slice(0, 8).map(skill => skill.name).join(', ') || 'none'}
                {bridgeStatus.skills.length > 8 ? ` +${bridgeStatus.skills.length - 8}` : ''}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border border-magi-dim/30 bg-black space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-magi-melchior tracking-widest uppercase font-bold">Harness Markdown</div>
          <button
            type="button"
            onClick={onResetDocuments}
            className="text-[10px] text-red-400 border border-red-900/70 px-2 py-1 hover:bg-red-950"
          >
            RESET
          </button>
        </div>

        <select
          value={selectedDocumentId}
          onChange={(e) => setSelectedDocumentId(e.target.value as HarnessDocumentId)}
          className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-magi-melchior focus:outline-none"
        >
          {documentOptions.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <textarea
          value={selectedDocument?.content || ''}
          onChange={(e) => onDocumentChange(selectedDocumentId, e.target.value)}
          className="w-full min-h-[360px] bg-[#050505] border border-magi-dim/50 text-xs leading-relaxed p-3 text-gray-200 focus:border-magi-melchior focus:outline-none resize-y"
          spellCheck={false}
        />
      </div>
    </div>
  );
};

export default SettingsPanel;
