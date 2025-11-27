export enum MagiSystem {
  MELCHIOR = 'MELCHIOR-1',
  BALTHASAR = 'BALTHASAR-2',
  CASPER = 'CASPER-3',
}

export type Language = 'EN' | 'CN';

export interface MagiAnalysis {
  systemName: string; 
  archetype: string;
  analysis: string;
  proposal: string;
  vote: boolean; // true for Agree/Yes, false for Disagree/No
}

export interface GroundingSource {
  title?: string;
  uri: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  timestamp: number;
}

export interface MemoryOperation {
  op: 'ADD' | 'DELETE';
  content?: string;
  targetId?: string; // ID to delete
}

export interface MagiResponse {
  centralAnalysis: string;
  melchior: MagiAnalysis;
  balthasar: MagiAnalysis;
  casper: MagiAnalysis;
  synthesis: string;
  finalDecision: boolean; // Synthesis-driven final decision
  groundingSources?: GroundingSource[];
  memoryOperations?: MemoryOperation[]; // AI requests to modify memory
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string; // User text
  magiData?: MagiResponse; // Model structured data
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  language: Language;
  lastUpdated: number;
}

export type ProcessingState = 'IDLE' | 'SCANNING' | 'THINKING' | 'COMPLETE' | 'ERROR';
