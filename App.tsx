import React, { useState, useRef, useEffect } from 'react';
import { queryMagiSystem } from './services/aiService';
import MagiNode from './components/MagiNode';
import SettingsPanel from './components/SettingsPanel';
import { AuditEvent, AuditRef, HarnessDocumentId, HarnessDocuments, HarnessSettings, MagiResponse, MagiSystem, ProcessingState, Session, Message, Language, MemoryItem, PendingAction, StreamEvent } from './types';
import {
  applyDocumentOperations,
  clearSavedHarnessDocuments,
  createInitialHarnessDocuments,
  loadHarnessDocuments,
  loadHarnessSettings,
  normalizeHarnessDocuments,
  saveHarnessDocuments,
  saveHarnessSettings,
} from './services/harnessService';
import { appendAuditEvents, executeBridgeTool } from './services/bridgeService';
import { loadLocalState, loadPersistentState, savePersistentState } from './services/stateStorageService';
import { v4 as uuidv4 } from 'uuid';

const App: React.FC = () => {
  // --- State ---
  const [sessions, setSessions] = useState<Session[]>(() => loadLocalState('sessions', []));
  const [memories, setMemories] = useState<MemoryItem[]>(() => loadLocalState('memories', []));
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettings>(() => loadHarnessSettings());
  const [harnessDocuments, setHarnessDocuments] = useState<HarnessDocuments>(() => createInitialHarnessDocuments());
  const [harnessReady, setHarnessReady] = useState(false);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<ProcessingState>('IDLE');
  const [language, setLanguage] = useState<Language>('CN'); 
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'PROTOCOLS' | 'CORTEX' | 'OPS'>('PROTOCOLS');
  const [notification, setNotification] = useState<string | null>(null);
  const [liveStreamEvents, setLiveStreamEvents] = useState<StreamEvent[]>([]);
  const [liveSynthesis, setLiveSynthesis] = useState('');
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const didInitSessionRef = useRef(false);

  // --- Effects ---
  
  // Persistence
  useEffect(() => {
    if (harnessReady) {
      savePersistentState('sessions', sessions);
    }
  }, [sessions, harnessReady]);

  useEffect(() => {
    if (harnessReady) {
      savePersistentState('memories', memories);
    }
  }, [memories, harnessReady]);

  useEffect(() => {
    if (harnessReady) {
      saveHarnessSettings(harnessSettings);
      savePersistentState('settings', harnessSettings);
    }
  }, [harnessSettings, harnessReady]);

  useEffect(() => {
    if (harnessReady) {
      saveHarnessDocuments(harnessDocuments);
      savePersistentState('documents', harnessDocuments);
    }
  }, [harnessDocuments, harnessReady]);

  useEffect(() => {
    let cancelled = false;

    const bootHarnessState = async () => {
      const diskDocuments = await loadHarnessDocuments();
      const [sessionState, memoryState, settingsState, documentState] = await Promise.all([
        loadPersistentState<Session[]>('sessions', []),
        loadPersistentState<MemoryItem[]>('memories', []),
        loadPersistentState<HarnessSettings>('settings', loadHarnessSettings()),
        loadPersistentState<HarnessDocuments>('documents', diskDocuments),
      ]);

      if (cancelled) return;
      setSessions(sessionState.value);
      setMemories(memoryState.value);
      setHarnessSettings(settingsState.value);
      setHarnessDocuments(normalizeHarnessDocuments(documentState.value));
      setHarnessReady(true);
    };

    bootHarnessState();

    return () => {
      cancelled = true;
    };
  }, []);

  // Init Session
  useEffect(() => {
    if (!harnessReady) return;
    if (didInitSessionRef.current) return;
    didInitSessionRef.current = true;

    if (sessions.length === 0) {
      createNewSession();
    } else if (!currentSessionId) {
      setCurrentSessionId(sessions[0].id);
    }
  }, [harnessReady, sessions, currentSessionId]);

  // Auto-scroll
  useEffect(() => {
    if (status === 'THINKING' || status === 'COMPLETE') {
      scrollToBottom();
    }
  }, [sessions, status, liveSynthesis, liveStreamEvents.length]);

  // Scroll Button Logic
  useEffect(() => {
    const handleScroll = () => {
      if (scrollContainerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
        setShowScrollButton(scrollHeight - scrollTop - clientHeight > 200);
      }
    };
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, []);

  // Notification Timer
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // --- Helpers ---

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const getCurrentSession = () => sessions.find(s => s.id === currentSessionId);

  const createNewSession = () => {
    const newSession: Session = {
      id: uuidv4(),
      title: `LOG_${new Date().toLocaleTimeString().replace(/:/g, '')}`,
      messages: [],
      language: language,
      lastUpdated: Date.now(),
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setSidebarTab('PROTOCOLS');
    setStatus('IDLE');
  };

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const newSessions = sessions.filter(s => s.id !== id);
    setSessions(newSessions);
    if (currentSessionId === id) {
      if (newSessions.length > 0) setCurrentSessionId(newSessions[0].id);
      else createNewSession();
    }
  };

  const addMemory = (content: string) => {
    if (!content.trim()) return;
    const newMem: MemoryItem = {
      id: uuidv4(),
      content: content.trim(),
      timestamp: Date.now()
    };
    setMemories(prev => [newMem, ...prev]);
  };

  const deleteMemory = (id: string) => {
    setMemories(prev => prev.filter(m => m.id !== id));
  };

  const updateHarnessDocument = (id: HarnessDocumentId, content: string) => {
    setHarnessDocuments(prev => ({
      ...prev,
      [id]: {
        ...prev[id],
        content,
      }
    }));
  };

  const saveRuntimeSettings = (settings: HarnessSettings) => {
    setHarnessSettings(settings);
    setNotification('RUNTIME CONFIG SAVED');
  };

  const resetHarnessDocuments = async () => {
    clearSavedHarnessDocuments();
    const documents = await loadHarnessDocuments();
    setHarnessDocuments(documents);
    setHarnessReady(true);
    setNotification('HARNESS RESET TO DISK DEFAULTS');
  };

  const getDecisionLabel = (data: MagiResponse) => {
    if (data.requiresUserInput) return 'WAIT';
    return data.finalDecision ? 'YES' : 'NO';
  };

  const isDecisionPositive = (data: MagiResponse) => data.finalDecision && !data.requiresUserInput;

  const pushLiveEvent = (event: StreamEvent) => {
    setLiveStreamEvents(prev => [...prev, event].slice(-80));
  };

  const makeUiEvent = (
    phase: string,
    actor: string,
    eventStatus: StreamEvent['status'],
    message: string,
    details?: string,
  ): StreamEvent => ({
    id: uuidv4(),
    phase,
    actor,
    status: eventStatus,
    message,
    timestamp: Date.now(),
    details,
  });

  const findMagiData = (messageId: string): MagiResponse | null => {
    for (const session of sessions) {
      for (const message of session.messages) {
        if (message.id === messageId && message.magiData) return message.magiData;
      }
    }
    return null;
  };

  const makeAuditEvent = (
    auditRef: AuditRef,
    event: StreamEvent,
    kind: AuditEvent['kind'],
    details?: unknown,
  ): AuditEvent => ({
    id: uuidv4(),
    sessionId: auditRef.sessionId,
    runId: auditRef.runId,
    timestamp: event.timestamp,
    phase: event.phase,
    actor: event.actor,
    status: event.status,
    summary: event.message,
    details: details ?? event.details,
    kind,
  });

  const appendUiAudit = async (
    auditRef: AuditRef | undefined,
    event: StreamEvent,
    kind: AuditEvent['kind'],
    details?: unknown,
  ) => {
    if (!auditRef) return;
    try {
      await appendAuditEvents(auditRef.sessionId, [makeAuditEvent(auditRef, event, kind, details)]);
    } catch (error) {
      console.warn('UI audit append failed', error);
    }
  };

  const updateMagiMessage = (messageId: string, updater: (data: MagiResponse) => MagiResponse) => {
    setSessions(prev => prev.map(session => ({
      ...session,
      messages: session.messages.map(message => {
        if (message.id !== messageId || !message.magiData) return message;
        return {
          ...message,
          magiData: updater(message.magiData),
        };
      }),
      lastUpdated: session.messages.some(message => message.id === messageId) ? Date.now() : session.lastUpdated,
    })));
  };

  const findPendingAction = (messageId: string, actionId: string): PendingAction | null => {
    for (const session of sessions) {
      for (const message of session.messages) {
        const action = message.id === messageId
          ? message.magiData?.pendingActions?.find(item => item.id === actionId)
          : undefined;
        if (action) return action;
      }
    }
    return null;
  };

  const updatePendingAction = (
    messageId: string,
    actionId: string,
    updater: (action: PendingAction) => PendingAction,
    event?: StreamEvent,
  ) => {
    updateMagiMessage(messageId, data => {
      let updatedAction: PendingAction | null = null;
      const pendingActions = (data.pendingActions || []).map(action => {
        if (action.id !== actionId) return action;
        updatedAction = updater(action);
        return updatedAction;
      });

      const nextToolStatus = updatedAction?.status === 'executed'
        ? 'allowed'
        : updatedAction?.status === 'failed'
          ? 'failed'
          : updatedAction?.status === 'rejected'
            ? 'denied'
            : 'pending';

      return {
        ...data,
        pendingActions,
        toolTraces: updatedAction
          ? (data.toolTraces || []).map(trace =>
            trace.details?.includes(actionId)
              ? {
                ...trace,
                status: nextToolStatus,
                details: updatedAction.error || (updatedAction.result ? JSON.stringify(updatedAction.result, null, 2) : trace.details),
              }
              : trace,
          )
          : data.toolTraces,
        trace: event
          ? [
            ...(data.trace || []),
            {
              id: uuidv4(),
              phase: event.phase,
              actor: event.actor,
              status: event.status === 'failed' ? 'failed' : event.status === 'waiting' ? 'waiting' : event.status === 'running' ? 'running' : 'complete',
              summary: event.message,
              timestamp: event.timestamp,
              details: event.details,
            },
          ]
          : data.trace,
        streamEvents: event ? [...(data.streamEvents || []), event] : data.streamEvents,
        requiresUserInput: pendingActions.some(action => action.status === 'pending') ||
          (data.clarificationRequests || []).some(request => request.required !== false),
      };
    });
  };

  const handleApproveAction = async (messageId: string, actionId: string) => {
    const action = findPendingAction(messageId, actionId);
    const messageData = findMagiData(messageId);
    if (!action || action.status !== 'pending') return;

    if (action.toolId !== 'skill.run' && action.toolId !== 'mcp.call') {
      const event = makeUiEvent('approval', action.actor, 'failed', `${action.toolId} cannot be executed by the local bridge.`);
      updatePendingAction(messageId, actionId, current => ({
        ...current,
        status: 'failed',
        error: event.message,
      }), event);
      appendUiAudit(messageData?.auditRef, event, 'approval', { actionId, toolId: action.toolId });
      setNotification('ACTION FAILED');
      return;
    }

    const startedEvent = makeUiEvent('approval', action.actor, 'running', `${action.toolId} approved; executing.`);
    updatePendingAction(messageId, actionId, current => ({
      ...current,
      status: 'executing',
    }), startedEvent);
    appendUiAudit(messageData?.auditRef, startedEvent, 'approval', { actionId, toolId: action.toolId, arguments: action.arguments });

    try {
      const result = await executeBridgeTool(action.toolId, action.arguments, action.actor);
      const doneEvent = makeUiEvent('approval', action.actor, 'complete', `${action.toolId} executed after approval.`, JSON.stringify(result.result, null, 2));
      updatePendingAction(messageId, actionId, current => ({
        ...current,
        status: 'executed',
        result: result.result,
        error: undefined,
      }), doneEvent);
      appendUiAudit(messageData?.auditRef, doneEvent, 'approval', { actionId, toolId: action.toolId, result: result.result });
      setNotification('ACTION EXECUTED');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bridge execution failed.';
      const failedEvent = makeUiEvent('approval', action.actor, 'failed', `${action.toolId} failed after approval.`, message);
      updatePendingAction(messageId, actionId, current => ({
        ...current,
        status: 'failed',
        error: message,
      }), failedEvent);
      appendUiAudit(messageData?.auditRef, failedEvent, 'approval', { actionId, toolId: action.toolId, error: message });
      setNotification('ACTION FAILED');
    }
  };

  const handleRejectAction = (messageId: string, actionId: string) => {
    const action = findPendingAction(messageId, actionId);
    const messageData = findMagiData(messageId);
    if (!action || action.status !== 'pending') return;
    const event = makeUiEvent('approval', action.actor, 'complete', `${action.toolId} rejected by user.`);
    updatePendingAction(messageId, actionId, current => ({
      ...current,
      status: 'rejected',
    }), event);
    appendUiAudit(messageData?.auditRef, event, 'approval', { actionId, toolId: action.toolId, status: 'rejected' });
    setNotification('ACTION REJECTED');
  };

  const answerClarification = (question: string) => {
    setPrompt(prev => prev ? `${prev}\n${question}\n` : `关于上一轮需要确认的问题：${question}\n`);
    textareaRef.current?.focus();
  };

  // --- Handlers ---

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentSession = getCurrentSession();
    if (!prompt.trim() || status === 'THINKING' || status === 'SCANNING' || !currentSession || !harnessReady) return;

    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: prompt,
      timestamp: Date.now()
    };

    setSessions(prev => prev.map(s => 
      s.id === currentSessionId 
        ? { 
            ...s, 
            messages: [...s.messages, userMsg], 
            lastUpdated: Date.now(), 
            title: s.messages.length === 0 ? prompt.slice(0, 15).toUpperCase() + '...' : s.title 
          } 
        : s
    ));
    
    setPrompt('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setStatus('SCANNING');
    setLiveSynthesis('');
    setLiveStreamEvents([
      makeUiEvent('input', 'COMMANDER', 'complete', `Queued protocol (${userMsg.content.length} chars).`),
      makeUiEvent('scan', 'HARNESS', 'running', 'Loading markdown harness, memories, and runtime settings.'),
    ]);

    setTimeout(async () => {
      setStatus('THINKING');
      const runId = uuidv4();
      try {
        pushLiveEvent(makeUiEvent('council', 'HARNESS', 'running', 'Starting independent persona analysis.'));
        const result = await queryMagiSystem(userMsg.content, currentSession.messages, language, memories, {
          settings: harnessSettings,
          documents: harnessDocuments,
        }, {
          sessionId: currentSession.id,
          runId,
          onEvent: pushLiveEvent,
          onTextDelta: event => setLiveSynthesis(event.fullText),
        });
        let maintenanceOpsCount = 0;
        
        // Handle Memory Operations
        if (result.memoryOperations && result.memoryOperations.length > 0) {
           let opsCount = 0;
           result.memoryOperations.forEach(op => {
             if (op.op === 'ADD' && op.content) {
               addMemory(op.content);
               opsCount++;
             } else if (op.op === 'DELETE' && op.targetId) {
               deleteMemory(op.targetId);
               opsCount++;
             }
           });
           maintenanceOpsCount += opsCount;
        }

        if (result.documentOperations && result.documentOperations.length > 0) {
          const applied = applyDocumentOperations(harnessDocuments, result.documentOperations);
          if (applied.appliedCount > 0) {
            setHarnessDocuments(applied.documents);
            maintenanceOpsCount += applied.appliedCount;
          }
        }

        if (maintenanceOpsCount > 0) setNotification(`HARNESS UPDATED: ${maintenanceOpsCount} OPERATIONS`);

        const magiMsg: Message = {
          id: uuidv4(),
          role: 'model',
          content: '', 
          magiData: result,
          timestamp: Date.now()
        };

        setSessions(prev => prev.map(s => 
          s.id === currentSessionId 
            ? { ...s, messages: [...s.messages, magiMsg], lastUpdated: Date.now() } 
            : s
        ));
        setStatus('COMPLETE');
        setLiveStreamEvents(result.streamEvents || []);
        setLiveSynthesis('');
      } catch (error) {
        console.error(error);
        setStatus('ERROR');
        setLiveSynthesis('');
        const failureEvent = makeUiEvent('error', 'HARNESS', 'failed', error instanceof Error ? error.message : 'Unknown runtime error');
        pushLiveEvent(failureEvent);
        appendAuditEvents(currentSession.id, [{
          id: uuidv4(),
          sessionId: currentSession.id,
          runId,
          timestamp: failureEvent.timestamp,
          phase: failureEvent.phase,
          actor: failureEvent.actor,
          status: failureEvent.status,
          summary: failureEvent.message,
          details: failureEvent.details,
          kind: 'error',
        }]).catch(auditError => console.warn('Error audit append failed', auditError));
        // Add error message to chat
        const errorMsg: Message = {
          id: uuidv4(),
          role: 'model',
          content: 'SYSTEM ERROR',
          magiData: {
              centralAnalysis: "COMMUNICATION FAILURE",
              melchior: { systemName: 'MELCHIOR', archetype: 'SCIENTIST', analysis: 'OFFLINE', proposal: 'RETRY', vote: false },
              balthasar: { systemName: 'BALTHASAR', archetype: 'MOTHER', analysis: 'OFFLINE', proposal: 'RETRY', vote: false },
              casper: { systemName: 'CASPER', archetype: 'WOMAN', analysis: 'OFFLINE', proposal: 'RETRY', vote: false },
              synthesis: "CRITICAL FAILURE. PLEASE TRY AGAIN.",
              finalDecision: false,
              trace: [
                {
                  id: uuidv4(),
                  phase: 'error',
                  actor: 'HARNESS',
                  status: 'failed',
                  summary: error instanceof Error ? error.message : 'Unknown runtime error',
                  timestamp: Date.now()
                }
              ],
              streamEvents: [...liveStreamEvents, failureEvent]
          },
          timestamp: Date.now()
        };
        setSessions(prev => prev.map(s => 
          s.id === currentSessionId 
            ? { ...s, messages: [...s.messages, errorMsg] } 
            : s
        ));
      }
    }, 600);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const currentSession = getCurrentSession();

  return (
    <div className="flex h-full w-full bg-magi-bg font-mono text-magi-text overflow-hidden selection:bg-magi-balthasar selection:text-black">
      
      {/* --- NOTIFICATION TOAST --- */}
      {notification && (
        <div className="fixed top-20 right-8 z-50 bg-magi-balthasar text-black px-6 py-3 font-bold tracking-widest animate-pulse shadow-[0_0_20px_rgba(255,153,0,0.6)] border border-white">
          {notification}
        </div>
      )}

      {/* --- SIDEBAR --- */}
      <aside className="hidden md:flex w-72 border-r border-magi-dim/30 bg-black flex-col z-20 shrink-0">
        
        {/* Header */}
        <div className="p-5 border-b border-magi-dim/30 flex items-center justify-between bg-magi-panel/20">
          <div className="font-display tracking-tighter text-2xl text-white">MAGI<span className="text-magi-casper">.SYS</span></div>
          <button 
            onClick={createNewSession}
            className="w-8 h-8 flex items-center justify-center border border-magi-dim/50 hover:bg-white hover:text-black transition-colors"
            title="New Protocol"
          >
            <span className="text-xl leading-none font-bold">+</span>
          </button>
        </div>
        
        {/* Tab Switcher */}
        <div className="flex border-b border-magi-dim/30">
          <button 
            onClick={() => setSidebarTab('PROTOCOLS')}
            className={`flex-1 py-3 text-xs tracking-widest font-bold uppercase transition-all
              ${sidebarTab === 'PROTOCOLS' ? 'bg-magi-dim/20 text-white border-b-2 border-magi-balthasar' : 'text-magi-dim hover:text-gray-300'}`}
          >
            Protocols
          </button>
          <button 
            onClick={() => setSidebarTab('CORTEX')}
            className={`flex-1 py-3 text-xs tracking-widest font-bold uppercase transition-all
              ${sidebarTab === 'CORTEX' ? 'bg-magi-dim/20 text-white border-b-2 border-magi-melchior' : 'text-magi-dim hover:text-gray-300'}`}
          >
            Cortex
          </button>
          <button
            onClick={() => setSidebarTab('OPS')}
            className={`flex-1 py-3 text-xs tracking-widest font-bold uppercase transition-all
              ${sidebarTab === 'OPS' ? 'bg-magi-dim/20 text-white border-b-2 border-magi-casper' : 'text-magi-dim hover:text-gray-300'}`}
          >
            Ops
          </button>
        </div>
        
        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-3 space-y-1">
          
          {/* PROTOCOLS TAB */}
          {sidebarTab === 'PROTOCOLS' && sessions.map(session => (
            <div 
              key={session.id}
              onClick={() => setCurrentSessionId(session.id)}
              className={`
                group relative cursor-pointer border border-transparent hover:border-magi-dim/40 p-3 transition-all
                ${currentSessionId === session.id ? 'bg-magi-dim/10 border-magi-dim/40' : 'hover:bg-magi-dim/5'}
              `}
            >
              {currentSessionId === session.id && (
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-magi-balthasar"></div>
              )}
              <div className="pl-2">
                <div className="text-[10px] text-magi-dim font-bold mb-1 font-mono tracking-wider">
                   {new Date(session.lastUpdated).toLocaleDateString()}
                </div>
                <div className={`text-sm truncate font-mono ${currentSessionId === session.id ? 'text-white font-bold' : 'text-gray-400'}`}>
                  {session.title}
                </div>
              </div>
              <button 
                onClick={(e) => deleteSession(e, session.id)}
                className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-red-500 hover:text-white hover:bg-red-600 px-2 rounded"
              >
                ×
              </button>
            </div>
          ))}

          {/* CORTEX TAB (MEMORY) */}
          {sidebarTab === 'CORTEX' && (
            <div className="space-y-4">
              <div className="p-3 bg-magi-dim/10 border border-magi-dim/30">
                 <div className="text-[10px] text-magi-melchior tracking-widest uppercase font-bold mb-2">Memory Bank</div>
                 <input 
                   type="text" 
                   placeholder="Add persistent fact..."
                   className="w-full bg-black border border-magi-dim/50 text-xs p-2 text-white focus:border-magi-melchior focus:outline-none"
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') {
                       addMemory(e.currentTarget.value);
                       e.currentTarget.value = '';
                     }
                   }}
                 />
              </div>
              <div className="space-y-2">
                {memories.map(mem => (
                  <div key={mem.id} className="relative group p-3 border border-magi-dim/20 bg-black hover:border-magi-dim/50">
                    <div className="text-gray-300 text-xs leading-relaxed">{mem.content}</div>
                    <button 
                      onClick={() => deleteMemory(mem.id)}
                      className="absolute top-1 right-1 text-red-500 opacity-0 group-hover:opacity-100 hover:text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {memories.length === 0 && (
                  <div className="text-center text-xs text-magi-dim py-8">CORTEX EMPTY</div>
                )}
              </div>
            </div>
          )}

          {sidebarTab === 'OPS' && (
            <SettingsPanel
              settings={harnessSettings}
              documents={harnessDocuments}
              onSettingsSave={saveRuntimeSettings}
              onDocumentChange={updateHarnessDocument}
              onResetDocuments={resetHarnessDocuments}
            />
          )}

        </div>
        
        <div className="p-4 border-t border-magi-dim/30 text-[10px] text-magi-dim text-center tracking-[0.2em]">
          MAGI HARNESS OS v8.0
        </div>
      </aside>

      {/* --- MAIN COLUMN --- */}
      <main className="flex-1 flex flex-col relative h-full min-w-0 bg-[#080808]">
        
        {/* HEADER */}
        <header className="h-16 shrink-0 border-b border-magi-dim/30 flex items-center justify-between px-6 bg-black/90 backdrop-blur z-30">
          <div className="flex items-center gap-4">
            <span className={`w-3 h-3 rounded-full transition-colors duration-500 ${status === 'THINKING' ? 'bg-yellow-400 animate-pulse' : 'bg-green-500'}`}></span>
            <span className="text-xs tracking-[0.2em] text-gray-400 uppercase font-bold">
              STATUS: <span className={`${status === 'IDLE' ? 'text-white' : 'text-yellow-400'}`}>{status}</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex border border-magi-dim/30 rounded-sm overflow-hidden">
               <button 
                 onClick={() => setLanguage('CN')}
                 className={`px-3 py-1 text-xs font-bold transition-all ${language === 'CN' ? 'bg-white text-black' : 'text-gray-500 hover:text-white'}`}
               >
                 CN
               </button>
               <div className="w-[1px] bg-magi-dim/30"></div>
               <button 
                 onClick={() => setLanguage('EN')}
                 className={`px-3 py-1 text-xs font-bold transition-all ${language === 'EN' ? 'bg-white text-black' : 'text-gray-500 hover:text-white'}`}
               >
                 EN
               </button>
            </div>
             {/* Mobile History Toggle (Placeholder) */}
             <button className="md:hidden text-white p-2 border border-magi-dim/30" onClick={createNewSession}>
               +
            </button>
          </div>
        </header>

        {/* CHAT STREAM */}
        <div 
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-8 scroll-smooth"
        >
          <div className="max-w-7xl mx-auto space-y-16 pb-8">
            
            {/* Empty State */}
            {currentSession?.messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-[50vh] opacity-30 select-none pointer-events-none space-y-6">
                 <div className="text-7xl md:text-9xl font-display font-bold text-white mb-4 tracking-tighter">MAGI</div>
                 <div className="flex gap-8">
                    <div className="text-magi-melchior font-mono text-xs tracking-[0.3em]">MELCHIOR</div>
                    <div className="text-magi-balthasar font-mono text-xs tracking-[0.3em]">BALTHASAR</div>
                    <div className="text-magi-casper font-mono text-xs tracking-[0.3em]">CASPER</div>
                 </div>
                 <div className="text-sm tracking-[1em] uppercase text-gray-500 border-t border-gray-800 pt-6 mt-6">
                   Awaiting Protocol
                 </div>
              </div>
            )}

            {currentSession?.messages.map((msg) => (
              <div key={msg.id} className="animate-in fade-in duration-700 slide-in-from-bottom-4">
                
                {/* USER INPUT */}
                {msg.role === 'user' ? (
                  <div className="flex justify-end mb-8">
                    <div className="max-w-2xl w-full text-right">
                       <div className="inline-block w-full bg-[#111] border border-magi-dim/40 p-4 md:p-6 text-base md:text-lg text-white shadow-lg whitespace-pre-wrap font-sans leading-relaxed text-left">
                         {msg.content}
                       </div>
                       <div className="flex items-center justify-end gap-2 mt-2">
                         <div className="h-[1px] w-12 bg-gray-800"></div>
                         <div className="text-[10px] text-gray-500 tracking-widest uppercase font-bold">
                           COMMANDER // {new Date(msg.timestamp).toLocaleTimeString()}
                         </div>
                       </div>
                    </div>
                  </div>
                ) : (
                  /* MODEL OUTPUT */
                  <div className="relative pt-4">
                    <div className="absolute left-1/2 -top-12 bottom-0 w-[1px] bg-gradient-to-b from-transparent via-gray-800 to-transparent md:block hidden"></div>
                    
                    {msg.magiData ? (
                      <div className="relative z-10 flex flex-col gap-10">
                        
                        {/* 1. Analysis */}
                        <div className="order-5 bg-black border border-magi-dim/40 p-5 max-w-4xl mx-auto backdrop-blur-md text-center shadow-lg">
                           <div className="flex items-center justify-center gap-2 mb-3">
                              <span className="w-1 h-1 bg-magi-casper"></span>
                              <span className="text-[10px] text-magi-casper tracking-[0.3em] uppercase font-bold">Council Diagnostics</span>
                              <span className="w-1 h-1 bg-magi-casper"></span>
                           </div>
                           <p className="text-gray-300 text-sm md:text-base italic font-serif leading-relaxed">"{msg.magiData.centralAnalysis}"</p>

                           {msg.magiData.groundingSources && msg.magiData.groundingSources.length > 0 && (
                             <div className="mt-4 pt-4 border-t border-gray-800 flex flex-wrap justify-center gap-3">
                               {msg.magiData.groundingSources.map((src, i) => (
                                 <a key={i} href={src.uri} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-[10px] text-blue-400 hover:text-white border border-blue-900/40 px-3 py-1.5 bg-blue-900/10 hover:bg-blue-900/30 transition-colors uppercase tracking-wider">
                                   <span className="w-1 h-1 bg-blue-400 rounded-full"></span>
                                   {src.title || 'EXTERNAL_SOURCE'}
                                 </a>
                               ))}
                             </div>
                           )}

                           {msg.magiData.toolTraces && msg.magiData.toolTraces.length > 0 && (
                             <div className="mt-3 flex flex-wrap justify-center gap-2">
                               {msg.magiData.toolTraces.map((trace, i) => (
                                 <div key={i} className="text-[9px] text-magi-dim border border-magi-dim/20 px-2 py-1 uppercase tracking-wider">
                                   {trace.systemName}:{trace.toolId}:{trace.status}
                                 </div>
                               ))}
                             </div>
                           )}
                        </div>

                        {/* 2. Nodes */}
                        <div className="order-6 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8">
                           <MagiNode systemType={MagiSystem.MELCHIOR} data={msg.magiData.melchior} isLoading={false} />
                           <MagiNode systemType={MagiSystem.BALTHASAR} data={msg.magiData.balthasar} isLoading={false} />
                           <MagiNode systemType={MagiSystem.CASPER} data={msg.magiData.casper} isLoading={false} />
                        </div>

                        {msg.magiData.meeting && msg.magiData.meeting.length > 0 && (
                          <div className="order-7 max-w-6xl mx-auto border border-magi-dim/30 bg-black/70 p-5">
                            <div className="text-[10px] text-magi-balthasar tracking-[0.3em] uppercase font-bold mb-4">Council Transcript</div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              {msg.magiData.meeting.map(exchange => (
                                <div key={exchange.id} className="border border-gray-800 bg-[#0c0c0c] p-4 min-h-[180px]">
                                  <div className="flex items-center justify-between gap-3 mb-3">
                                    <div className="text-xs text-white font-bold tracking-widest">{exchange.speaker}</div>
                                    <div className={`text-[10px] font-bold ${exchange.revisedVote ? 'text-green-400' : 'text-red-400'}`}>
                                      {exchange.revisedVote ? 'VOTE YES' : 'VOTE NO'}
                                    </div>
                                  </div>
                                  <p className="text-xs md:text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{exchange.content}</p>
                                  {exchange.revisedProposal && (
                                    <div className="mt-4 pt-3 border-t border-gray-800">
                                      <div className="text-[9px] text-magi-dim uppercase tracking-[0.25em] mb-1">Revised Proposal</div>
                                      <div className="text-xs text-gray-400 leading-relaxed">{exchange.revisedProposal}</div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {msg.magiData.pendingActions && msg.magiData.pendingActions.length > 0 && (
                          <div className="order-2 max-w-6xl mx-auto border border-magi-balthasar/50 bg-yellow-950/10 p-5">
                            <div className="flex items-center justify-between gap-3 mb-4">
                              <div className="text-[10px] text-magi-balthasar tracking-[0.3em] uppercase font-bold">Action Approval Queue</div>
                              <div className="text-[10px] text-magi-dim uppercase">{msg.magiData.pendingActions.filter(action => action.status === 'pending').length} pending</div>
                            </div>
                            <div className="space-y-3">
                              {msg.magiData.pendingActions.map(action => (
                                <div key={action.id} className="grid grid-cols-1 lg:grid-cols-[1fr_190px] gap-4 border border-gray-800 bg-black/60 p-4">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 mb-2">
                                      <span className="text-xs text-white font-bold">{action.actor}</span>
                                      <span className="text-[10px] text-magi-dim">→</span>
                                      <span className="text-xs text-magi-casper font-bold">{action.toolId}</span>
                                      <span className={`text-[10px] px-2 py-0.5 border uppercase ${
                                        action.risk === 'high' ? 'border-red-500 text-red-400' : action.risk === 'medium' ? 'border-magi-balthasar text-magi-balthasar' : 'border-green-500 text-green-400'
                                      }`}>
                                        {action.risk}
                                      </span>
                                      <span className="text-[10px] text-gray-500 uppercase">{action.status}</span>
                                    </div>
                                    <p className="text-sm text-gray-300 leading-relaxed">{action.reason}</p>
                                    <details className="mt-3">
                                      <summary className="cursor-pointer text-[10px] text-magi-dim uppercase tracking-[0.2em]">Arguments / Result</summary>
                                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words bg-[#050505] border border-gray-900 p-3 text-[10px] text-gray-400">{JSON.stringify(action.result || action.arguments, null, 2)}</pre>
                                      {action.error && <div className="mt-2 text-xs text-red-400">{action.error}</div>}
                                    </details>
                                  </div>
                                  <div className="flex lg:flex-col gap-2">
                                    <button
                                      onClick={() => handleApproveAction(msg.id, action.id)}
                                      disabled={action.status !== 'pending'}
                                      className="flex-1 border border-green-500 text-green-400 px-3 py-2 text-xs font-bold tracking-widest uppercase hover:bg-green-500 hover:text-black disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-green-400 transition-colors"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleRejectAction(msg.id, action.id)}
                                      disabled={action.status !== 'pending'}
                                      className="flex-1 border border-red-500 text-red-400 px-3 py-2 text-xs font-bold tracking-widest uppercase hover:bg-red-500 hover:text-black disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-red-400 transition-colors"
                                    >
                                      Reject
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {msg.magiData.clarificationRequests && msg.magiData.clarificationRequests.length > 0 && (
                          <div className="order-3 max-w-6xl mx-auto border border-magi-casper/50 bg-blue-950/10 p-5">
                            <div className="text-[10px] text-magi-casper tracking-[0.3em] uppercase font-bold mb-4">Clarification Needed</div>
                            <div className="space-y-3">
                              {msg.magiData.clarificationRequests.map(request => (
                                <div key={request.id} className="flex flex-col md:flex-row gap-3 md:items-center justify-between border border-gray-800 bg-black/60 p-4">
                                  <div>
                                    <div className="text-sm text-white leading-relaxed">{request.question}</div>
                                    {request.reason && <div className="mt-1 text-xs text-gray-500">{request.reason}</div>}
                                  </div>
                                  <button
                                    onClick={() => answerClarification(request.question)}
                                    className="shrink-0 border border-magi-casper text-magi-casper px-3 py-2 text-xs font-bold tracking-widest uppercase hover:bg-magi-casper hover:text-black transition-colors"
                                  >
                                    Answer
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {msg.magiData.streamEvents && msg.magiData.streamEvents.length > 0 && (
                          <div className="order-4 max-w-6xl mx-auto border border-magi-dim/30 bg-black/50 p-5">
                            <div className="text-[10px] text-magi-melchior tracking-[0.3em] uppercase font-bold mb-4">Execution Stream</div>
                            <div className="space-y-2 max-h-72 overflow-y-auto pr-2">
                              {msg.magiData.streamEvents.slice(-18).map(event => (
                                <div key={event.id} className="grid grid-cols-[72px_86px_1fr] gap-3 text-[10px] md:text-xs border border-gray-900 bg-[#070707] p-2">
                                  <div className="text-gray-600">{new Date(event.timestamp).toLocaleTimeString()}</div>
                                  <div className={`font-bold uppercase ${
                                    event.status === 'complete' ? 'text-green-400' : event.status === 'failed' ? 'text-red-400' : event.status === 'waiting' ? 'text-magi-balthasar' : 'text-magi-casper'
                                  }`}>
                                    {event.phase}
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-white font-bold">{event.actor}</span>
                                    <span className="text-gray-400"> // {event.message}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 3. Synthesis */}
                        <div className="order-1 max-w-5xl mx-auto mt-8 pb-4">
                           <div className={`
                             relative border-l-4 p-6 md:p-10 overflow-hidden transition-all duration-1000 shadow-xl
                             ${isDecisionPositive(msg.magiData) ? 'border-white bg-[#111]' : msg.magiData.requiresUserInput ? 'border-magi-balthasar bg-yellow-950/10' : 'border-red-600 bg-red-950/20'}
                           `}>
                              <div className="flex flex-col md:flex-row gap-8 items-start">
                                 <div className={`
                                   flex-shrink-0 w-full md:w-32 h-24 flex items-center justify-center border-4 border-double
                                   ${isDecisionPositive(msg.magiData) ? 'border-white text-white' : msg.magiData.requiresUserInput ? 'border-magi-balthasar text-magi-balthasar' : 'border-red-600 text-red-600'}
                                 `}>
                                   <span className="font-display text-4xl md:text-5xl transform -rotate-6 tracking-widest">
                                     {getDecisionLabel(msg.magiData)}
                                   </span>
                                 </div>
                                 <div className="flex-1">
                                   <div className="flex items-center gap-3 mb-4">
                                     <div className="h-[1px] w-8 bg-gray-500"></div>
                                     <h3 className="text-xs font-bold tracking-[0.5em] text-gray-500 uppercase">Synthesis</h3>
                                   </div>
                                   <p className="text-base md:text-xl leading-relaxed text-gray-100 font-mono font-medium">
                                     {msg.magiData.synthesis}
                                   </p>
                                   {msg.magiData.executionPlan && (
                                     <div className="mt-5 border-t border-gray-800 pt-4">
                                       <div className="text-[10px] text-magi-dim uppercase tracking-[0.3em] font-bold mb-2">Execution Plan</div>
                                       <p className="text-sm md:text-base leading-relaxed text-gray-300 font-mono">
                                         {msg.magiData.executionPlan}
                                       </p>
                                     </div>
                                   )}
                                   {msg.magiData.auditRef && (
                                     <div className="mt-5 border-t border-gray-800 pt-4">
                                       <div className="text-[10px] text-magi-dim uppercase tracking-[0.3em] font-bold mb-2">Audit Log</div>
                                       <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[10px] text-gray-400 font-mono">
                                         <div className="border border-gray-800 bg-black/30 p-2 break-all">session: {msg.magiData.auditRef.sessionId}</div>
                                         <div className="border border-gray-800 bg-black/30 p-2 break-all">run: {msg.magiData.auditRef.runId}</div>
                                         <div className="border border-gray-800 bg-black/30 p-2">{msg.magiData.auditRef.eventCount} events</div>
                                         {msg.magiData.auditRef.filePath && (
                                           <div className="md:col-span-3 border border-gray-800 bg-black/30 p-2 break-all">{msg.magiData.auditRef.filePath}</div>
                                         )}
                                       </div>
                                     </div>
                                   )}
                                   {msg.magiData.trace && msg.magiData.trace.length > 0 && (
                                     <details className="mt-5 border-t border-gray-800 pt-4 group">
                                       <summary className="cursor-pointer text-[10px] text-magi-melchior uppercase tracking-[0.3em] font-bold list-none flex items-center gap-2">
                                         <span className="w-1.5 h-1.5 bg-magi-melchior"></span>
                                         Full Trace
                                         <span className="text-magi-dim tracking-normal">({msg.magiData.trace.length})</span>
                                       </summary>
                                       <div className="mt-3 space-y-2">
                                         {msg.magiData.trace.map(step => (
                                           <div key={step.id} className="grid grid-cols-[70px_90px_1fr] gap-3 border border-gray-800 bg-black/30 p-2 text-[10px] md:text-xs">
                                             <div className="text-magi-dim">
                                               {new Date(step.timestamp).toLocaleTimeString()}
                                             </div>
                                             <div className={`font-bold uppercase ${
                                               step.status === 'complete' ? 'text-green-400' : step.status === 'failed' ? 'text-red-400' : step.status === 'waiting' ? 'text-magi-balthasar' : step.status === 'running' ? 'text-magi-casper' : 'text-magi-dim'
                                             }`}>
                                               {step.phase}
                                             </div>
                                             <div className="min-w-0">
                                               <div className="text-white font-bold truncate">{step.actor}</div>
                                               <div className="text-gray-400 leading-relaxed break-words">{step.summary}</div>
                                               {step.details && (
                                                 <div className="mt-1 text-gray-600 leading-relaxed break-words">{step.details}</div>
                                               )}
                                             </div>
                                           </div>
                                         ))}
                                       </div>
                                     </details>
                                   )}
                                 </div>
                              </div>
                           </div>
                        </div>

                      </div>
                    ) : (
                      <div className="text-red-500 text-center border border-red-900 p-4">DATA CORRUPTION</div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Loading */}
            {status === 'THINKING' && (
              <div className="max-w-7xl mx-auto pt-8 pb-12 opacity-80 space-y-6">
                {liveStreamEvents.length > 0 && (
                  <div className="border border-magi-dim/30 bg-black/70 p-4 max-w-5xl mx-auto">
                    <div className="text-[10px] text-magi-casper tracking-[0.3em] uppercase font-bold mb-3">Live Execution</div>
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-2">
                      {liveStreamEvents.slice(-10).map(event => (
                        <div key={event.id} className="grid grid-cols-[72px_82px_1fr] gap-3 text-[10px] md:text-xs border border-gray-900 bg-[#070707] p-2">
                          <div className="text-gray-600">{new Date(event.timestamp).toLocaleTimeString()}</div>
                          <div className={`font-bold uppercase ${
                            event.status === 'complete' ? 'text-green-400' : event.status === 'failed' ? 'text-red-400' : event.status === 'waiting' ? 'text-magi-balthasar' : 'text-magi-casper'
                          }`}>
                            {event.phase}
                          </div>
                          <div className="min-w-0">
                            <span className="text-white font-bold">{event.actor}</span>
                            <span className="text-gray-400"> // {event.message}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {liveSynthesis && (
                  <div className="border border-magi-melchior/40 bg-black/80 p-5 max-w-5xl mx-auto">
                    <div className="text-[10px] text-magi-melchior tracking-[0.3em] uppercase font-bold mb-3">Live Synthesis</div>
                    <div className="text-sm md:text-base leading-relaxed text-gray-100 font-mono whitespace-pre-wrap">
                      {liveSynthesis}
                      <span className="inline-block w-2 h-4 ml-1 bg-magi-melchior animate-pulse align-middle"></span>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-pulse">
                  <MagiNode systemType={MagiSystem.MELCHIOR} isLoading={true} />
                  <MagiNode systemType={MagiSystem.BALTHASAR} isLoading={true} />
                  <MagiNode systemType={MagiSystem.CASPER} isLoading={true} />
                </div>
              </div>
            )}
            
            <div ref={chatEndRef} className="h-4 flex items-center justify-center opacity-30">
               {status === 'IDLE' && sessions.length > 0 && <div className="text-[10px] tracking-[1em] text-gray-600">TERMINAL_END</div>}
            </div>
          </div>
        </div>

        {/* Scroll Button */}
        {showScrollButton && (
          <button 
            onClick={scrollToBottom}
            className="absolute bottom-32 right-8 z-40 bg-white text-black w-10 h-10 flex items-center justify-center rounded-full hover:scale-110 transition-all animate-bounce"
          >
            ↓
          </button>
        )}

        {/* --- INPUT DECK --- */}
        <div className="shrink-0 bg-black border-t border-magi-dim/30 shadow-[0_-10px_40px_rgba(0,0,0,0.8)] z-40 relative">
           <div className={`absolute top-0 left-0 h-[1px] bg-white transition-all duration-300 ${status === 'SCANNING' || status === 'THINKING' ? 'w-full shadow-[0_0_10px_#fff]' : 'w-0'}`}></div>

           <div className="max-w-6xl mx-auto p-4 md:p-6">
             <form onSubmit={handleSubmit} className="flex gap-4 items-end">
               <div className="hidden md:flex flex-col justify-end pb-3 gap-1 w-24 shrink-0 text-right opacity-50">
                  <div className="text-[9px] text-gray-500 uppercase tracking-widest">Input Priority</div>
                  <div className="font-mono text-xl text-gray-400">AAA</div>
               </div>

               <div className="flex-1 relative group bg-[#111] border border-gray-800 hover:border-gray-500 focus-within:border-white transition-all duration-300">
                  <textarea 
                    ref={textareaRef}
                    value={prompt}
                    onChange={handleTextareaInput}
                    onKeyDown={handleKeyDown}
                    disabled={status === 'SCANNING' || status === 'THINKING'}
                    rows={1}
                    placeholder={language === 'CN' ? "请输入待议事项..." : "Enter protocol for deliberation..."}
                    className="w-full bg-transparent text-white p-4 font-mono text-base focus:outline-none placeholder-gray-700 resize-none max-h-[200px]"
                  />
                  {/* Decorative Corners */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-gray-600 group-focus-within:border-white transition-colors"></div>
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-gray-600 group-focus-within:border-white transition-colors"></div>
               </div>

               <button 
                  type="submit"
                  disabled={!prompt.trim() || !harnessReady || (status !== 'IDLE' && status !== 'COMPLETE' && status !== 'ERROR')}
                  className={`
                    h-[58px] px-8 font-display text-xl tracking-widest transition-all duration-200
                    ${(status === 'IDLE' || status === 'COMPLETE' || status === 'ERROR') && harnessReady
                      ? 'bg-white text-black hover:bg-gray-200 hover:-translate-y-1' 
                      : 'bg-gray-800 text-gray-500 cursor-wait border border-gray-700'}
                  `}
               >
                 {!harnessReady ? 'BOOT' : status === 'SCANNING' ? 'SCAN' : status === 'THINKING' ? 'WAIT' : 'SEND'}
               </button>
             </form>
           </div>
        </div>

      </main>
    </div>
  );
};

export default App;
