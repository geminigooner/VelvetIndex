// types.ts — Shared Model Harness Framework interfaces and telemetry types.

export type ModelRole = 'structure_router' | 'evaluation_judge' | 'research_agent';

export type VerificationState = 'unverified' | 'live_verified' | 'failed';

export interface ModelRegistration {
  role: ModelRole;
  requestedName: string;
  configuredIdentifier: string;
  verificationState: VerificationState;
  lastVerifiedAt?: string;
  verificationMetadata?: {
    modelReturned?: string;
    latencyMs?: number;
    promptTokens?: number;
    outputTokens?: number;
    error?: string;
  };
  promptVersion: string;
  systemPrompt: string;
}

export interface InvocationTelemetry {
  id: string;
  timestamp: string;
  role: ModelRole;
  modelIdentifier: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: string[];
  cached: boolean;
  status: 'success' | 'error';
  errorMessage?: string;
}

export interface TableOfContentsSection {
  section_id: string;
  heading: string;
  level: number;
}

export interface TableOfContentsDoc {
  doc_id: string;
  title: string;
  sections: TableOfContentsSection[];
}

export interface StructureRouterInput {
  query: string;
  toc: TableOfContentsDoc[];
}

export interface StructureRouterOutput {
  selected_section_ids: string[];
  invalid_section_ids: string[];
  abstained: boolean;
  rationale: string;
}

export interface EvaluationJudgeInput {
  question: string;
  reference_answer: string;
  candidate_answer: string; // blinded label: e.g. "Candidate 1"
  evidence_quotes: string[];
}

export interface EvaluationJudgeOutput {
  correctness_score: number; // 1-5
  correctness_justification: string;
  relevance_score: number; // 1-5
  relevance_justification: string;
  grounding_score: number; // 1-5
  grounding_justification: string;
  overall_score: number;
}

export type TaskStatus = 'idle' | 'searching' | 'fetching' | 'processing' | 'staged' | 'approved' | 'rejected' | 'failed';

export type AcquisitionMode = 'full_text' | 'abstract_only' | 'inaccessible';

export interface ResearchPaperCandidate {
  id: string;
  title: string;
  authors: string[];
  year: number;
  url: string;
  venue: string;
  abstract: string;
  fullText?: string;
  isFullTextAvailable: boolean;
  acquisitionMode: AcquisitionMode;
  extractedMarkdown: string;
  sha256: string;
  sections: { section_id: string; heading: string; char_start: number; char_end: number; level: number }[];
  status: 'discovered' | 'acquired' | 'structured' | 'approved' | 'rejected';
}

export interface ResearchTaskState {
  taskId: string;
  query: string;
  venues: string[];
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  progressPercent: number;
  currentStepMessage: string;
  papers: ResearchPaperCandidate[];
  error?: string;
}
