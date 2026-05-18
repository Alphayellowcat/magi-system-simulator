export enum MagiSystem {
  MELCHIOR = 'MELCHIOR-1',
  BALTHASAR = 'BALTHASAR-2',
  CASPER = 'CASPER-3',
}

export type Language = 'EN' | 'CN';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ToolAccessMode = 'allow' | 'review' | 'deny';
export type ToolAccessKey =
  | 'web.search.tavily'
  | 'web.fetch'
  | 'skill.run.load'
  | 'skill.run.script'
  | 'mcp.filesystem.read'
  | 'mcp.filesystem.write'
  | 'mcp.browser.read'
  | 'mcp.browser.interact'
  | 'mcp.other.read'
  | 'mcp.other.write';

export type ToolAccessMatrix = Record<MagiSystem, Record<ToolAccessKey, ToolAccessMode>>;

export interface ToolAccessDefinition {
  key: ToolAccessKey;
  label: string;
  description: string;
}

export interface SkillActionArgumentTemplate {
  from?: 'extracted_symbol' | 'literal';
  value?: string;
}

export interface SkillActionSymbolRule {
  patterns?: string[];
  aliases?: Record<string, string>;
  normalizeSuffixes?: Record<string, string>;
  blockedWords?: string[];
  contextualPrefixes?: string[];
}

export interface SkillActionManifest {
  id: string;
  description?: string;
  toolId: ToolId;
  mode?: string;
  script?: string;
  args?: SkillActionArgumentTemplate[];
  triggers?: string[];
  requiresAnyTrigger?: boolean;
  symbol?: SkillActionSymbolRule;
  risk?: PendingActionRisk;
  readOnly?: boolean;
  preferredOwner?: MagiSystem;
  dedupe?: {
    key?: string;
    symbolArg?: boolean;
    skipFallbackToolsOnSuccess?: boolean;
  };
}

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
  runtimeBudgets: RuntimeBudgetSettings;
  toolAccess: ToolAccessMatrix;
}

export interface RuntimeBudgetSettings {
  personaTimeoutMs: number;
  plannerMaxTokens: number;
  personaMaxTokens: number;
  meetingMaxTokens: number;
  meetingRetryMaxTokens: number;
  synthesisMaxTokens: number;
  finalStreamMaxTokens: number;
  initialToolMaxRequests: number;
  councilToolMaxRequests: number;
  synthesisToolMaxRequests: number;
  runtimeSuggestMaxRequests: number;
  toolAuditChars: number;
  traceDetailsMaxChars: number;
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

export type ToolId = 'web.search.tavily' | 'web.fetch' | 'skill.run' | 'mcp.call';
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
  metadata?: Record<string, unknown>;
}

export interface TextDeltaEvent {
  id: string;
  role: 'synthesis';
  delta: string;
  fullText: string;
  timestamp: number;
}

export interface AuditRef {
  sessionId: string;
  runId: string;
  filePath?: string;
  eventCount: number;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  runId: string;
  timestamp: number;
  phase: string;
  actor: string;
  status: string;
  summary: string;
  details?: unknown;
  kind?: 'stream' | 'trace' | 'tool' | 'approval' | 'error' | 'synthesis';
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
  auditRef?: AuditRef;
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
