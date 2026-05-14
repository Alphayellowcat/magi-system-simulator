import React, { useState } from 'react';
import { MagiAnalysis, MagiSystem } from '../types';

interface MagiNodeProps {
  systemType: MagiSystem;
  data?: MagiAnalysis;
  isLoading: boolean;
}

const getSystemConfig = (type: MagiSystem) => {
  switch (type) {
    case MagiSystem.MELCHIOR:
      return {
        color: 'text-magi-melchior',
        borderColor: 'border-magi-melchior',
        bg: 'bg-magi-melchior/10',
        voteYesBg: 'bg-magi-melchior',
        header: 'MELCHIOR-1',
        sub: 'SCIENTIST'
      };
    case MagiSystem.BALTHASAR:
      return {
        color: 'text-magi-balthasar',
        borderColor: 'border-magi-balthasar',
        bg: 'bg-magi-balthasar/10',
        voteYesBg: 'bg-magi-balthasar',
        header: 'BALTHASAR-2',
        sub: 'MOTHER'
      };
    case MagiSystem.CASPER:
      return {
        color: 'text-magi-casper',
        borderColor: 'border-magi-casper',
        bg: 'bg-magi-casper/10',
        voteYesBg: 'bg-magi-casper',
        header: 'CASPER-3',
        sub: 'WOMAN'
      };
  }
};

const MagiNode: React.FC<MagiNodeProps> = ({ systemType, data, isLoading }) => {
  const config = getSystemConfig(systemType);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = () => {
    if (data?.proposal) {
      navigator.clipboard.writeText(data.proposal);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  return (
    <div className={`
      relative flex flex-col h-full min-h-[300px] border-2 ${config.borderColor} ${config.bg}
      transition-all duration-500 overflow-hidden group hover:bg-black hover:bg-opacity-80
      ${isLoading ? 'opacity-80' : 'opacity-100'}
    `}>
      
      {/* Label Tab */}
      <div className={`absolute top-0 left-0 px-3 py-1 text-xs font-bold font-mono text-black ${config.voteYesBg} z-20`}>
        CODE:{systemType.split('-')[1]}
      </div>

      {/* Header */}
      <div className="mt-8 px-4 pb-2 border-b border-magi-dim/30 flex justify-between items-end bg-black/40">
        <div>
          <h2 className={`text-3xl font-display uppercase tracking-tighter leading-none ${config.color} text-shadow-glow`}>
            {config.header}
          </h2>
          <div className={`text-sm font-mono tracking-[0.3em] font-bold text-magi-dim`}>
            {config.sub}
          </div>
        </div>
        {/* Status Light */}
        <div className={`w-4 h-4 rounded-full border border-black ${isLoading ? 'animate-pulse bg-white' : (data ? config.voteYesBg : 'bg-magi-dim')}`}></div>
      </div>

      {/* Body */}
      <div className="flex-1 p-5 font-mono text-sm relative overflow-y-auto scrollbar-thin">
        {isLoading ? (
          <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-50">
             <div className={`w-16 h-16 border-4 border-t-transparent rounded-full animate-spin ${config.borderColor}`}></div>
             <p className={`${config.color} animate-pulse text-sm tracking-widest font-bold`}>PROCESSING...</p>
             
             {/* Fake code scrolling */}
             <div className="absolute inset-0 p-4 opacity-10 overflow-hidden text-[10px] leading-tight text-magi-dim pointer-events-none">
               {Array.from({length: 20}).map((_, i) => (
                 <div key={i} className="whitespace-nowrap">
                   0x{Math.random().toString(16).substr(2, 8).toUpperCase()} :: ACCESSING MEMORY BANK {systemType.split('-')[1]}...
                 </div>
               ))}
             </div>
          </div>
        ) : data ? (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="bg-black/40 p-2 rounded border-l-2 border-magi-dim/30">
              <span className="text-[10px] text-magi-dim uppercase tracking-wider block mb-1 font-bold">Analysis</span>
              <p className="text-gray-200 leading-relaxed text-sm md:text-base">
                {data.analysis}
              </p>
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-magi-dim uppercase tracking-wider font-bold">Proposed Solution</span>
                <button
                  onClick={handleCopy}
                  className={`text-[10px] uppercase tracking-wider font-bold transition-all duration-200 border border-magi-dim/30 px-2 py-0.5 rounded hover:bg-magi-dim/20 ${isCopied ? 'text-white bg-green-900/50 border-green-500' : 'text-magi-dim hover:text-white'}`}
                  title="Copy to clipboard"
                >
                  {isCopied ? 'COPIED' : 'COPY'}
                </button>
              </div>
              <p className="text-white leading-relaxed text-sm md:text-base font-bold bg-black/60 p-2 border border-magi-dim/20">
                {data.proposal}
              </p>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-magi-dim text-sm tracking-widest font-bold opacity-50">
            WAITING FOR INPUT
          </div>
        )}
      </div>

      {/* Vote Footer */}
      {data && (
        <div className="mt-auto border-t border-magi-dim/30">
          {data.vote ? (
             <div className={`w-full py-4 text-center text-black font-display text-2xl tracking-widest uppercase ${config.voteYesBg} animate-in zoom-in duration-300`}>
               VOTE YES
             </div>
          ) : (
             <div className="w-full py-4 text-center text-white bg-red-700 font-display text-2xl tracking-widest uppercase animate-in zoom-in duration-300 pattern-diagonal-lines">
               VOTE NO
             </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MagiNode;
