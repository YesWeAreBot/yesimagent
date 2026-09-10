import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { AgentEntry } from "./entry.js";

export interface AgentStorage<T = AgentEntry> {
  append(...entries: T[]): Promise<void> | void;
  read(): Promise<Readonly<T[]>> | Readonly<T[]>;
  clear(): Promise<void> | void;
}

export function createMemoryStorage<T extends AgentEntry = AgentEntry>(initialEntries: readonly T[] = []): AgentStorage<T> {
  const entries = [...initialEntries];

  return {
    append(...nextEntries) {
      entries.push(...nextEntries);
    },
    read() {
      return [...entries];
    },
    clear() {
      entries.length = 0;
    },
  };
}

export function createJsonlStorage(filePath: string): AgentStorage<AgentEntry> {
  return {
    async append(...entries) {
      if (entries.length === 0) return;

      await mkdir(path.dirname(filePath), { recursive: true });
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
      await appendFile(filePath, `${payload}\n`, "utf8");
    },
    async read() {
      try {
        const content = await readFile(filePath, "utf8");
        const entries: AgentEntry[] = [];
        for (const [index, line] of content.split("\n").entries()) {
          if (!line) continue;
          try {
            entries.push(JSON.parse(line) as AgentEntry);
          } catch (error) {
            throw new SyntaxError(`Invalid JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return entries;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    clear() {
      return rm(filePath, { force: true });
    },
  };
}
