// cache.ts — Content-addressed invocation cache for deterministic model calls.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class InvocationCache {
  private memoryCache: Map<string, any> = new Map();
  private filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  private hashKey(model: string, promptVersion: string, inputPayload: any): string {
    const raw = `${model}:${promptVersion}:${JSON.stringify(inputPayload)}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  private loadFromDisk() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const { key, value } = JSON.parse(line);
        this.memoryCache.set(key, value);
      }
    } catch {
      // Ignored if invalid cache file
    }
  }

  get<T>(model: string, promptVersion: string, inputPayload: any): T | null {
    const key = this.hashKey(model, promptVersion, inputPayload);
    return this.memoryCache.get(key) ?? null;
  }

  set(model: string, promptVersion: string, inputPayload: any, value: any) {
    const key = this.hashKey(model, promptVersion, inputPayload);
    this.memoryCache.set(key, value);
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const line = JSON.stringify({ key, value }) + "\n";
        writeFileSync(this.filePath, line, { flag: "a" });
      } catch {
        // Ignored in transient environments
      }
    }
  }

  has(model: string, promptVersion: string, inputPayload: any): boolean {
    const key = this.hashKey(model, promptVersion, inputPayload);
    return this.memoryCache.has(key);
  }

  clear() {
    this.memoryCache.clear();
  }
}

export const deterministicCache = new InvocationCache(".cache/deterministic_harness.jsonl");
