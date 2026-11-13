// verifier.ts — Live Model Verification probe executing real API calls via @google/genai.
import { GoogleGenAI } from "@google/genai";
import { registry } from "./registry.ts";
import type { ModelRole, ModelRegistration } from "./types.ts";

export async function verifyModelLive(role: ModelRole): Promise<ModelRegistration> {
  const reg = registry.getRegistration(role);
  if (!reg) throw new Error(`Role not registered: ${role}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return registry.updateRegistration(role, {
      verificationState: 'failed',
      lastVerifiedAt: new Date().toISOString(),
      verificationMetadata: {
        error: 'GEMINI_API_KEY is not set in environment',
      },
    });
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const start = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: reg.configuredIdentifier,
      contents: 'Respond with the single word "READY".',
    });

    const latencyMs = Date.now() - start;
    const text = (response.text ?? '').trim();
    const modelReturned = response.modelVersion || (text ? reg.configuredIdentifier : undefined);
    const promptTokens = response.usageMetadata?.promptTokenCount;
    const outputTokens = response.usageMetadata?.candidatesTokenCount;

    if (!text) {
      throw new Error('Empty response returned from model endpoint');
    }

    registry.logTelemetry({
      id: `tel_verify_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role,
      modelIdentifier: modelReturned || reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs,
      inputTokens: promptTokens,
      outputTokens,
      cached: false,
      status: 'success',
    });

    return registry.updateRegistration(role, {
      verificationState: 'live_verified',
      lastVerifiedAt: new Date().toISOString(),
      verificationMetadata: {
        modelReturned,
        latencyMs,
        promptTokens,
        outputTokens,
      },
    });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    registry.logTelemetry({
      id: `tel_verify_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role,
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs,
      cached: false,
      status: 'error',
      errorMessage: err.message || String(err),
    });

    return registry.updateRegistration(role, {
      verificationState: 'failed',
      lastVerifiedAt: new Date().toISOString(),
      verificationMetadata: {
        latencyMs,
        error: err.message || String(err),
      },
    });
  }
}
