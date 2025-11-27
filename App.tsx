import React, { useState, useRef, useEffect } from 'react';
import { queryMagiSystem } from './services/aiService';
import MagiNode from './components/MagiNode';
import { MagiResponse, MagiSystem, ProcessingState, Session, Message, Language, MemoryItem } from './types';
import { v4 as uuidv4 } from 'uuid';

const App: React.FC = () => {
  // --- State ---
  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem('magi_sessions');
    return saved ? JSON.parse(saved) : [];
  });
  const [memories, setMemories] = useState<MemoryItem[]>(() => {
    const saved = localStorage.getItem('magi_memories');
    return saved ? JSON.parse(saved) : [];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<ProcessingState>('IDLE');
  const [language, setLanguage] = useState<Language>('CN'); 
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'PROTOCOLS' | 'CORTEX'>('PROTOCOLS');
  const [notification, setNotification] = useState<string | null>(null);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // --- Effects ---
  
  // Persistence
  useEffect(() => {
    localStorage.setItem('magi_sessions', JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem('magi_memories', JSON.stringify(memories));
  }, [memories]);

  // Init Session
  useEffect(() => {
    if (sessions.length === 0) {
      createNewSession();
    } else if (!currentSessionId) {
      setCurrentSessionId(sessions[0].id);
    }
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (status === 'THINKING' || status === 'COMPLETE') {
      scrollToBottom();
    }
  }, [sessions, status]);

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

  const getConsensus = (data: MagiResponse) => {
    return data.finalDecision; // Emergent decision from subconscious integration
  };

  // --- Handlers ---

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentSession = getCurrentSession();
    if (!prompt.trim() || status === 'THINKING' || status === 'SCANNING' || !currentSession) return;

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

    setTimeout(async () => {
      setStatus('THINKING');
      try {
        const result = await queryMagiSystem(userMsg.content, currentSession.messages, language, memories);
        
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
           if (opsCount > 0) setNotification(`CORTEX UPDATED: ${opsCount} OPERATIONS`);
        }

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
      } catch (error) {
        console.error(error);
        setStatus('ERROR');
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
              synthesis: "CRITICAL FAILURE. PLEASE TRY AGAIN."
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

        </div>
        
        <div className="p-4 border-t border-magi-dim/30 text-[10px] text-magi-dim text-center tracking-[0.2em]">
          MAGI SYSTEM OS v6.2
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
                      <div className="space-y-10 relative z-10">
                        
                        {/* 1. Analysis */}
                        <div className="bg-black border border-magi-dim/40 p-5 max-w-4xl mx-auto backdrop-blur-md text-center shadow-lg">
                           <div className="flex items-center justify-center gap-2 mb-3">
                              <span className="w-1 h-1 bg-magi-casper"></span>
                              <span className="text-[10px] text-magi-casper tracking-[0.3em] uppercase font-bold">Context Analysis</span>
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
                        </div>

                        {/* 2. Nodes */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8">
                           <MagiNode systemType={MagiSystem.MELCHIOR} data={msg.magiData.melchior} isLoading={false} />
                           <MagiNode systemType={MagiSystem.BALTHASAR} data={msg.magiData.balthasar} isLoading={false} />
                           <MagiNode systemType={MagiSystem.CASPER} data={msg.magiData.casper} isLoading={false} />
                        </div>

                        {/* 3. Synthesis */}
                        <div className="max-w-5xl mx-auto mt-8 pb-4">
                           <div className={`
                             relative border-l-4 p-6 md:p-10 overflow-hidden transition-all duration-1000 shadow-xl
                             ${getConsensus(msg.magiData) ? 'border-white bg-[#111]' : 'border-red-600 bg-red-950/20'}
                           `}>
                              <div className="flex flex-col md:flex-row gap-8 items-start">
                                 <div className={`
                                   flex-shrink-0 w-full md:w-32 h-24 flex items-center justify-center border-4 border-double
                                   ${getConsensus(msg.magiData) ? 'border-white text-white' : 'border-red-600 text-red-600'}
                                 `}>
                                   <span className="font-display text-4xl md:text-5xl transform -rotate-6 tracking-widest">
                                     {getConsensus(msg.magiData) ? 'YES' : 'NO'}
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
              <div className="max-w-7xl mx-auto pt-8 pb-12 opacity-80">
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
                  disabled={!prompt.trim() || (status !== 'IDLE' && status !== 'COMPLETE' && status !== 'ERROR')}
                  className={`
                    h-[58px] px-8 font-display text-xl tracking-widest transition-all duration-200
                    ${status === 'IDLE' || status === 'COMPLETE' || status === 'ERROR'
                      ? 'bg-white text-black hover:bg-gray-200 hover:-translate-y-1' 
                      : 'bg-gray-800 text-gray-500 cursor-wait border border-gray-700'}
                  `}
               >
                 {status === 'SCANNING' ? 'SCAN' : status === 'THINKING' ? 'WAIT' : 'SEND'}
               </button>
             </form>
           </div>
        </div>

      </main>
    </div>
  );
};

export default App;
