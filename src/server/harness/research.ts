// research.ts — Gemini Flash 3.5 Research Agent Harness.
// Autonomous discovery with Google Search grounding, URL Context retrieval, and truthful Markdown document structure parsing.

import { GoogleGenAI, Type } from "@google/genai";
import { createHash } from "node:crypto";
import { registry } from "./registry.ts";
import { taskManager } from "./taskManager.ts";
import type { ResearchTaskState, ResearchPaperCandidate, AcquisitionMode } from "./types.ts";

export interface RawSectionInput {
  heading: string;
  body: string;
  level?: number;
}

/**
 * Pure helper that converts extracted headings and verbatim text bodies into
 * LF-normalized Markdown with exact UTF-16 section character offsets and SHA-256 hash.
 * Never fabricates text.
 */
export function buildStructuredMarkdownDocument(
  title: string,
  rawSections: RawSectionInput[]
): {
  markdown: string;
  sha256: string;
  sections: { section_id: string; heading: string; char_start: number; char_end: number; level: number }[];
} {
  const cleanTitle = title.replace(/\r\n?/g, "\n").trim();
  let markdown = `# ${cleanTitle}\n\n`;
  const sections: { section_id: string; heading: string; char_start: number; char_end: number; level: number }[] = [];

  const validSections = rawSections
    .map((s) => ({
      heading: (s.heading || "Section").replace(/\r\n?/g, " ").replace(/^#+\s*/, "").trim(),
      body: (s.body || "").replace(/\r\n?/g, "\n").trim(),
      level: s.level && s.level >= 1 && s.level <= 3 ? s.level : 1,
    }))
    .filter((s) => s.body.length > 0);

  for (let i = 0; i < validSections.length; i++) {
    const sec = validSections[i];
    const hashes = "#".repeat(sec.level + 1);
    const block = `${hashes} ${sec.heading}\n${sec.body}\n\n`;
    const char_start = markdown.length;
    markdown += block;
    const char_end = markdown.length;

    const secSlug = sec.heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || `sec_${i + 1}`;

    sections.push({
      section_id: `s${String(i + 1).padStart(2, "0")}_${secSlug}`,
      heading: sec.heading,
      char_start,
      char_end,
      level: sec.level,
    });
  }

  const sha256 = createHash("sha256").update(markdown).digest("hex");
  return { markdown, sha256, sections };
}

export async function runResearchDiscovery(
  query: string,
  venues: string[] = ["arXiv", "Google Research", "Anthropic", "DeepMind"],
  existingTaskId?: string
): Promise<ResearchTaskState> {
  const task = existingTaskId
    ? taskManager.getTask(existingTaskId) ?? taskManager.createTask(query, venues)
    : taskManager.createTask(query, venues);

  const reg = registry.getRegistration("research_agent");
  if (!reg) throw new Error("Research agent harness not registered");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return taskManager.updateTask(task.taskId, {
      status: 'failed',
      progressPercent: 100,
      currentStepMessage: 'Configuration error: GEMINI_API_KEY is not set',
      error: 'GEMINI_API_KEY environment variable is not configured',
    });
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  taskManager.updateTask(task.taskId, {
    status: 'searching',
    progressPercent: 15,
    currentStepMessage: `Step 1/3: Searching academic repositories (${venues.join(", ")}) via Google Search grounding...`,
  });

  const searchPrompt = `Search for 3 to 4 real, peer-reviewed or preprint academic research papers on the topic: "${query}".
Prioritize venues: ${venues.join(", ")}.
For arXiv papers, prefer direct https://arxiv.org/abs/... or https://arxiv.org/html/... URLs.
Never invent papers or authors. Include exact title, authors, publication year, venue, public URL, and verbatim abstract.`;

  const searchStart = Date.now();
  try {
    const searchResponse = await ai.models.generateContent({
      model: reg.configuredIdentifier,
      contents: searchPrompt,
      config: {
        systemInstruction: reg.systemPrompt,
        tools: [{ googleSearch: {} }],
      },
    });

    const groundingChunks = searchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundedUrls = groundingChunks
      .map((c: any) => c.web?.uri)
      .filter((u: any): u is string => typeof u === "string" && u.startsWith("http"));

    registry.logTelemetry({
      id: `tel_search_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'research_agent',
      modelIdentifier: searchResponse.modelVersion || reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs: Date.now() - searchStart,
      inputTokens: searchResponse.usageMetadata?.promptTokenCount,
      outputTokens: searchResponse.usageMetadata?.candidatesTokenCount,
      toolCalls: ['googleSearch'],
      cached: false,
      status: 'success',
    });

    const searchRaw = searchResponse.text ?? "";
    taskManager.updateTask(task.taskId, {
      status: 'fetching',
      progressPercent: 45,
      currentStepMessage: 'Step 2/3: Deduplicating papers and extracting structured metadata...',
    });

    const parsePrompt = `Extract the discovered academic papers from the following grounded search report into a JSON array.
Only include real papers present in the text. Do not fabricate metadata.
Grounded URLs found: ${JSON.stringify(groundedUrls.slice(0, 10))}

Search Report:
${searchRaw}`;

    const parseStart = Date.now();
    const parseResponse = await ai.models.generateContent({
      model: reg.configuredIdentifier,
      contents: parsePrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              authors: { type: Type.ARRAY, items: { type: Type.STRING } },
              year: { type: Type.INTEGER },
              venue: { type: Type.STRING },
              url: { type: Type.STRING },
              abstract: { type: Type.STRING },
            },
            required: ["title", "authors", "year", "venue", "url", "abstract"],
          },
        },
      },
    });

    registry.logTelemetry({
      id: `tel_parse_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'research_agent',
      modelIdentifier: parseResponse.modelVersion || reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs: Date.now() - parseStart,
      inputTokens: parseResponse.usageMetadata?.promptTokenCount,
      outputTokens: parseResponse.usageMetadata?.candidatesTokenCount,
      cached: false,
      status: 'success',
    });

    const rawList: any[] = JSON.parse(parseResponse.text ?? "[]");
    // Deduplicate by normalized title
    const seenTitles = new Set<string>();
    const dedupedList = rawList.filter((item) => {
      const key = String(item.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    const papers: ResearchPaperCandidate[] = [];

    for (let i = 0; i < dedupedList.length; i++) {
      const p = dedupedList[i];
      const pct = Math.min(95, 50 + Math.round(((i + 1) / Math.max(1, dedupedList.length)) * 45));
      taskManager.updateTask(task.taskId, {
        status: 'processing',
        progressPercent: pct,
        currentStepMessage: `Step 3/3: Acquiring URL context & structure for "${p.title.slice(0, 45)}..." (${i + 1}/${dedupedList.length})`,
      });

      let acquisitionMode: AcquisitionMode = 'abstract_only';
      let extractedSections: RawSectionInput[] = [
        { heading: "Abstract", body: String(p.abstract || "").trim(), level: 1 },
      ];

      // Attempt real URL Context retrieval if URL is valid http/https
      if (typeof p.url === "string" && /^https?:\/\//i.test(p.url)) {
        const urlStart = Date.now();
        try {
          const urlResponse = await ai.models.generateContent({
            model: reg.configuredIdentifier,
            contents: `Read the academic paper at ${p.url} ("${p.title}").
If the full paper text (beyond just the abstract) is accessible on the page, extract its actual sections (heading and verbatim text content).
If only the abstract is accessible or the full text is behind a PDF/paywall, set full_text_retrieved to false and return only the verbatim abstract. Never fabricate or invent section text.`,
            config: {
              tools: [{ urlContext: {} }],
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  full_text_retrieved: {
                    type: Type.BOOLEAN,
                    description: "True ONLY if multiple actual body sections from the paper were retrieved from the URL",
                  },
                  inaccessible: {
                    type: Type.BOOLEAN,
                    description: "True if the URL could not be reached or was blocked",
                  },
                  sections: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        heading: { type: Type.STRING },
                        body: { type: Type.STRING },
                        level: { type: Type.INTEGER },
                      },
                      required: ["heading", "body"],
                    },
                  },
                },
                required: ["full_text_retrieved", "sections"],
              },
            },
          });

          registry.logTelemetry({
            id: `tel_url_${Date.now()}_${i}`,
            timestamp: new Date().toISOString(),
            role: 'research_agent',
            modelIdentifier: urlResponse.modelVersion || reg.configuredIdentifier,
            promptVersion: reg.promptVersion,
            latencyMs: Date.now() - urlStart,
            inputTokens: urlResponse.usageMetadata?.promptTokenCount,
            outputTokens: urlResponse.usageMetadata?.candidatesTokenCount,
            toolCalls: ['urlContext'],
            cached: false,
            status: 'success',
          });

          const parsedUrlData = JSON.parse(urlResponse.text ?? "{}");
          if (parsedUrlData.inaccessible) {
            acquisitionMode = p.abstract ? 'abstract_only' : 'inaccessible';
          } else if (
            parsedUrlData.full_text_retrieved &&
            Array.isArray(parsedUrlData.sections) &&
            parsedUrlData.sections.length >= 2
          ) {
            acquisitionMode = 'full_text';
            extractedSections = parsedUrlData.sections;
          }
        } catch (urlErr: any) {
          registry.logTelemetry({
            id: `tel_url_err_${Date.now()}_${i}`,
            timestamp: new Date().toISOString(),
            role: 'research_agent',
            modelIdentifier: reg.configuredIdentifier,
            promptVersion: reg.promptVersion,
            latencyMs: Date.now() - urlStart,
            toolCalls: ['urlContext'],
            cached: false,
            status: 'error',
            errorMessage: urlErr.message,
          });
          // Fallback cleanly to verbatim abstract_only without fabricating text
          acquisitionMode = p.abstract ? 'abstract_only' : 'inaccessible';
        }
      }

      const paperSlug = String(p.title ?? `paper_${i + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 28);
      const paperId = `${paperSlug}_${p.year || 2026}`;

      const { markdown, sha256, sections } = buildStructuredMarkdownDocument(p.title, extractedSections);

      papers.push({
        id: paperId,
        title: p.title,
        authors: Array.isArray(p.authors) && p.authors.length ? p.authors : ["Unknown Author"],
        year: Number(p.year) || 2026,
        url: p.url || "",
        venue: p.venue || "Preprint",
        abstract: p.abstract || "",
        fullText: acquisitionMode === 'full_text' ? markdown : undefined,
        isFullTextAvailable: acquisitionMode === 'full_text',
        acquisitionMode,
        extractedMarkdown: markdown,
        sha256,
        sections,
        status: 'structured',
      });
    }

    const fullTextCount = papers.filter((p) => p.acquisitionMode === 'full_text').length;
    const abstractOnlyCount = papers.filter((p) => p.acquisitionMode === 'abstract_only').length;

    return taskManager.updateTask(task.taskId, {
      status: 'staged',
      progressPercent: 100,
      currentStepMessage: `Staged ${papers.length} paper(s) (${fullTextCount} full-text, ${abstractOnlyCount} abstract-only). Awaiting human approval.`,
      papers,
    });
  } catch (err: any) {
    registry.logTelemetry({
      id: `tel_err_${Date.now()}`,
      timestamp: new Date().toISOString(),
      role: 'research_agent',
      modelIdentifier: reg.configuredIdentifier,
      promptVersion: reg.promptVersion,
      latencyMs: Date.now() - searchStart,
      cached: false,
      status: 'error',
      errorMessage: err.message,
    });

    return taskManager.updateTask(task.taskId, {
      status: 'failed',
      progressPercent: 100,
      currentStepMessage: `Discovery failed: ${err.message}`,
      error: err.message,
    });
  }
}
