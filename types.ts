export enum MagiSystem {
  MELCHIOR = 'MELCHIOR-1',
  BALTHASAR = 'BALTHASAR-2',
  CASPER = 'CASPER-3',
}

export type Language = 'EN' | 'CN';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type HarnessDocumentId =
  | 'persona.melchior'
  | 'persona.balthasar'
  | 'persona.casper'
  | 'memory.shared'
  | 'memory.melchior'
  | 'memory.balthasar'
  | 'memory.casper'
  | 'council.protocol'
  | 'registry.tools'
  | 'registry.skills'
  | 'registry.mcp';

export type DocumentOperationType = 'APPEND' | 'REPLACE';

export interface HarnessSettings {
  apiKey: string;
  baseURL: string;
  modelName: string;
  tavilyApiKey: string;
  reasoningEnabled: boolean;
  reasoningEffort: ReasoningEffort;
}

export interface HarnessDocument {
  id: HarnessDocumentId;
  label: string;
  path: string;
  content: string;
}

export type HarnessDocuments = Record<HarnessDocumentId, HarnessDocument>;

export interface DocumentOperation {
  documentId: HarnessDocumentId;
  op: DocumentOperationType;
  content: string;
  reason?: string;
}

export interface ToolTrace {
  systemName: string;
  toolId: string;
  status: 'allowed' | 'denied' | 'skipped' | 'failed' | 'pending';
  query?: string;
  summary?: string;
  details?: string;
}

export interface SessionTraceStep {
  id: string;
  phase: string;
  actor: string;
  status: 'complete' | 'failed' | 'skipped' | 'running' | 'waiting';
  summary: string;
  timestamp: number;
  details?: string;
}

export type ToolId = 'web.search.tavily' | 'skill.run' | 'mcp.call';
export type PendingActionRisk = 'low' | 'medium' | 'high';
export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed';

export interface PendingAction {
  id: string;
  actor: string;
  toolId: ToolId;
  arguments: Record<string, unknown>;
  reason: string;
  risk: PendingActionRisk;
  requiresApproval: boolean;
  status: PendingActionStatus;
  createdAt: number;
  result?: unknown;
  error?: string;
}

export interface CouncilExchange {
  id: string;
  round: number;
  speaker: string;
  responseTo?: string;
  content: string;
  revisedProposal?: string;
  revisedVote?: boolean;
  timestamp: number;
}

export interface ClarificationRequest {
  id: string;
  question: string;
  reason?: string;
  required?: boolean;
}

export interface StreamEvent {
  id: string;
  phase: string;
  actor: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'waiting';
  message: string;
  timestamp: number;
  details?: string;
}

export interface MagiAnalysis {
  systemName: string; 
  archetype: string;
  analysis: string;
  proposal: string;
  vote: boolean; // true for Agree/Yes, false for Disagree/No
  documentOperations?: DocumentOperation[];
  toolTraces?: ToolTrace[];
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
  documentOperations?: DocumentOperation[]; // AI requests to maintain markdown harness docs
  executionPlan?: string;
  toolTraces?: ToolTrace[];
  trace?: SessionTraceStep[];
  meeting?: CouncilExchange[];
  pendingActions?: PendingAction[];
  clarificationRequests?: ClarificationRequest[];
  streamEvents?: StreamEvent[];
  requiresUserInput?: boolean;
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
