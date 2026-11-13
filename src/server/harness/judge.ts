// judge.ts — Gemini 3.1 Pro Evaluation Judge Harness.
// Evaluates candidate answers across 3 distinct dimensions:
// 1. Correctness (vs reference answer)
// 2. Evidence Relevance (topic alignment of context)
// 3. Evidence Grounding (faithfulness without hallucinations)
// Completely separate from deterministic retrieval metrics (Hit@k, MRR).

import { GoogleGenAI, Type } from "@google/genai";
import { registry } from "./registry.ts";
import { deterministicCache } from "./cache.ts";
import type { EvaluationJudgeInput, EvaluationJudgeOutput } from "./types.ts";

export function validateJudgeInput(input: any): EvaluationJudgeInput {
  if (!input || typeof input !== "object") throw new Error("Invalid judge input");
  if (!input.question) throw new Error("Question is required");
  if (!input.reference_answer) throw new Error("Reference answer is required");
  if (!input.candidate_answer) throw new Error("Candidate answer is required");
  if (!Array.isArray(input.evidence_quotes)) throw new Error("Evidence quotes array is required");
  return input as EvaluationJudgeInput;
}

export async function evaluateWithJudge(rawInput: any): Promise<EvaluationJudgeOutput> {
  const input = validateJudgeInput(rawInput);
  const reg = registry.getRegistration("evaluation_judge");
  if (!reg) throw new Error("Evaluation judge harness not registered");

  const cached = deterministicCache.get<EvaluationJudgeOutput>(
    reg.configuredIdentifier,
    reg.promptVersion,
    input
  );
  if (cached) {
    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'evaluation_judge',
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs: 1,
      cached: true,
      status: 'success',
    });
    return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not configured");

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const prompt = `You are an academic evaluation judge.
Evaluate the blinded candidate answer against the gold reference answer and the retrieved evidence passages.
Score on a 1 to 5 scale (1 = completely failing, 5 = excellent / fully satisfied):

1. correctness_score: Does the candidate answer state factually correct information consistent with the gold reference answer?
2. relevance_score: Are the retrieved evidence passages relevant and sufficient to answer the user question?
3. grounding_score: Is the candidate answer strictly supported by the retrieved evidence without external hallucinations?

Question: "${input.question}"
Gold Reference Answer: "${input.reference_answer}"
Candidate Answer: "${input.candidate_answer}"
Retrieved Evidence Passages:
${input.evidence_quotes.map((q: string, i: number) => `[Passage ${i + 1}]: ${q}`).join("\n")}
`;

  const start = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: reg.configuredIdentifier,
      contents: prompt,
      config: {
        systemInstruction: reg.systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            correctness_score: { type: Type.INTEGER, description: "Score 1-5" },
            correctness_justification: { type: Type.STRING },
            relevance_score: { type: Type.INTEGER, description: "Score 1-5" },
            relevance_justification: { type: Type.STRING },
            grounding_score: { type: Type.INTEGER, description: "Score 1-5" },
            grounding_justification: { type: Type.STRING },
            overall_score: { type: Type.NUMBER, description: "Aggregate score 1-5" },
          },
          required: [
            "correctness_score",
            "correctness_justification",
            "relevance_score",
            "relevance_justification",
            "grounding_score",
            "grounding_justification",
            "overall_score",
          ],
        },
      },
    });

    const latencyMs = Date.now() - start;
    const jsonStr = (response.text ?? '{}').trim();
    const result: EvaluationJudgeOutput = JSON.parse(jsonStr);

    deterministicCache.set(reg.configuredIdentifier, reg.promptVersion, input, result);

    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'evaluation_judge',
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs,
      cached: false,
      status: 'success',
    });

    return result;
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'evaluation_judge',
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs,
      cached: false,
      status: 'error',
      errorMessage: err.message,
    });
    throw err;
  }
}
