// registry.ts — Model Registry for the Shared Model Harness Framework.
import type { ModelRegistration, ModelRole, InvocationTelemetry } from './types.ts';

class ModelRegistry {
  private registrations: Map<ModelRole, ModelRegistration> = new Map();
  private telemetryLogs: InvocationTelemetry[] = [];

  constructor() {
    this.initDefaults();
  }

  private initDefaults() {
    this.registrations.set('structure_router', {
      role: 'structure_router',
      requestedName: 'Gemini 4 Argon',
      configuredIdentifier: 'gemini-4-argon',
      verificationState: 'unverified',
      promptVersion: 'v1.0.0',
      systemPrompt: 'You are a STAIR Structure Router. You inspect only document Table of Contents structures and select relevant document-qualified section IDs for the user query. Output strictly JSON.'
    });

    this.registrations.set('evaluation_judge', {
      role: 'evaluation_judge',
      requestedName: 'Gemini 3.1 Pro',
      configuredIdentifier: 'gemini-3.1-pro-preview',
      verificationState: 'unverified',
      promptVersion: 'v1.0.0',
      systemPrompt: 'You are an objective academic evaluation judge. You evaluate blinded candidate answers against gold references across correctness, evidence relevance, and evidence grounding using a 1-5 scale.'
    });

    this.registrations.set('research_agent', {
      role: 'research_agent',
      requestedName: 'Gemini Flash 3.5',
      configuredIdentifier: 'gemini-3.8-flash',
      verificationState: 'unverified',
      promptVersion: 'v1.0.0',
      systemPrompt: 'You are an autonomous Research Acquisition Agent. You discover academic papers, extract structured document headings (#, ##), and prepare clean Markdown for RAG ingestion.'
    });
  }

  getRegistration(role: ModelRole): ModelRegistration | undefined {
    return this.registrations.get(role);
  }

  getAllRegistrations(): ModelRegistration[] {
    return Array.from(this.registrations.values());
  }

  updateRegistration(role: ModelRole, updates: Partial<ModelRegistration>): ModelRegistration {
    const existing = this.registrations.get(role);
    if (!existing) throw new Error(`Unknown role: ${role}`);
    const updated = { ...existing, ...updates };
    this.registrations.set(role, updated);
    return updated;
  }

  logTelemetry(telemetry: InvocationTelemetry) {
    this.telemetryLogs.unshift(telemetry);
    if (this.telemetryLogs.length > 200) {
      this.telemetryLogs.pop();
    }
  }

  getTelemetryLogs(role?: ModelRole): InvocationTelemetry[] {
    if (!role) return [...this.telemetryLogs];
    return this.telemetryLogs.filter((t) => t.role === role);
  }
}

export const registry = new ModelRegistry();
