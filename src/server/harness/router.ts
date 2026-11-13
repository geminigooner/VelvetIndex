// router.ts — Gemini 4 Argon Structure Router Harness (Arm C).
// Strict boundary: Only receives query and Table of Contents (ToC) structures. Never bodies or answers.

import { GoogleGenAI, Type } from "@google/genai";
import { registry } from "./registry.ts";
import { deterministicCache } from "./cache.ts";
import type { StructureRouterInput, StructureRouterOutput } from "./types.ts";

export function validateArgonInput(input: any): StructureRouterInput {
  if (!input || typeof input !== "object") throw new Error("Invalid input object");
  if (!input.query || typeof input.query !== "string") throw new Error("Query string is required");
  if (!Array.isArray(input.toc)) throw new Error("ToC array is required");

  // Strict role security boundary
  if ("document_body" in input || "body" in input || "text" in input) {
    throw new Error("SECURITY_VIOLATION: Argon Structure Router cannot receive document bodies");
  }
  if ("answer" in input || "reference_answer" in input || "gold_evidence" in input) {
    throw new Error("SECURITY_VIOLATION: Argon Structure Router cannot receive evaluation answers or gold evidence");
  }

  for (const doc of input.toc) {
    if (!doc.doc_id || !doc.title) throw new Error("Invalid ToC document structure");
    for (const sec of doc.sections ?? []) {
      if ("body" in sec || "text" in sec) {
        throw new Error("SECURITY_VIOLATION: Section bodies must not be passed to Argon");
      }
    }
  }

  return input as StructureRouterInput;
}

/**
 * Validates that every selected section ID exists in the provided Table of Contents.
 * Separates valid selections from invalid/hallucinated IDs.
 */
export function filterValidToCSections(
  toc: StructureRouterInput["toc"],
  candidateIds: string[]
): { valid: string[]; invalid: string[] } {
  const allowed = new Set<string>();
  for (const doc of toc) {
    for (const sec of doc.sections ?? []) {
      allowed.add(`${doc.doc_id}::${sec.section_id}`);
    }
  }

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const id of candidateIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id)) {
      valid.push(id);
    } else {
      invalid.push(id);
    }
  }

  return { valid, invalid };
}

export async function routeWithArgon(rawInput: any): Promise<StructureRouterOutput> {
  const input = validateArgonInput(rawInput);
  const reg = registry.getRegistration("structure_router");
  if (!reg) throw new Error("Structure router harness not registered");

  // Check deterministic cache
  const cached = deterministicCache.get<StructureRouterOutput>(
    reg.configuredIdentifier,
    reg.promptVersion,
    input
  );
  if (cached) {
    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'structure_router',
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs: 1,
      cached: true,
      status: 'success',
    });
    return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured");
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const prompt = `You are a Structure-Aware Router (STAIR Arm C).
Given the following user query and document Table of Contents, select the most relevant document-qualified section IDs (in exact format "doc_id::section_id").
If the query cannot be answered by any section in the ToC, set "abstained" to true and return an empty array for selected_section_ids.

User Query: "${input.query}"

Corpus Table of Contents:
${JSON.stringify(input.toc, null, 2)}
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
            selected_section_ids: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Array of document-qualified section IDs like 'doc1::sec2'",
            },
            abstained: {
              type: Type.BOOLEAN,
              description: "True if no sections are relevant or query is out of scope",
            },
            rationale: {
              type: Type.STRING,
              description: "Brief reasoning for selection or abstention",
            },
          },
          required: ["selected_section_ids", "abstained", "rationale"],
        },
      },
    });

    const latencyMs = Date.now() - start;
    const jsonStr = (response.text ?? '{}').trim();
    const rawParsed = JSON.parse(jsonStr);

    const { valid, invalid } = filterValidToCSections(
      input.toc,
      Array.isArray(rawParsed.selected_section_ids) ? rawParsed.selected_section_ids : []
    );

    const result: StructureRouterOutput = {
      selected_section_ids: rawParsed.abstained ? [] : valid,
      invalid_section_ids: invalid,
      abstained: Boolean(rawParsed.abstained) || (valid.length === 0 && invalid.length === 0),
      rationale: String(rawParsed.rationale ?? ""),
    };

    deterministicCache.set(reg.configuredIdentifier, reg.promptVersion, input, result);

    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'structure_router',
      modelIdentifier: response.modelVersion || reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      cached: false,
      status: 'success',
    });

    return result;
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    registry.logTelemetry({
      id: `tel_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'structure_router',
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
