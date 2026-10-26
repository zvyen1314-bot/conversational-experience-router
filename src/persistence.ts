import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AuditRecord {
  id: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  actor_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DocumentStore {
  readonly backend: "sqlite" | "json";
  load<T>(key: string): Promise<T | undefined>;
  save<T>(key: string, value: T): Promise<void>;
  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(limit?: number): Promise<AuditRecord[]>;
  close(): Promise<void>;
}

export async function createPersistentStore(filePath: string): Promise<DocumentStore> {
  const resolvedPath = resolve(filePath);
  try {
    const sqliteModule = await import("node:sqlite");
    return new SqliteDocumentStore(resolvedPath, sqliteModule.DatabaseSync);
  } catch {
    return new JsonDocumentStore(resolvedPath);
  }
}

export function createAuditRecord(
  action: string,
  resourceType: string,
  resourceId?: string,
  actorId?: string,
  metadata: Record<string, unknown> = {},
): AuditRecord {
  return {
    id: `audit-${randomUUID().slice(0, 12)}`,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    actor_id: actorId,
    metadata: sanitizeMetadata(metadata),
    created_at: new Date().toISOString(),
  };
}

class SqliteDocumentStore implements DocumentStore {
  readonly backend = "sqlite" as const;
  private readonly database: {
    exec(sql: string): void;
    prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  };

  constructor(path: string, DatabaseSync: new (path: string) => unknown) {
    this.database = new DatabaseSync(path) as typeof this.database;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  async load<T>(key: string): Promise<T | undefined> {
    const row = this.database.prepare("SELECT payload FROM documents WHERE key = ?").get(key) as { payload?: string } | undefined;
    return row?.payload ? JSON.parse(row.payload) as T : undefined;
  }

  async save<T>(key: string, value: T): Promise<void> {
    this.database.prepare(`
      INSERT INTO documents (key, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    this.database.prepare("INSERT OR IGNORE INTO audit_log (id, created_at, payload) VALUES (?, ?, ?)")
      .run(record.id, record.created_at, JSON.stringify(record));
  }

  async listAudit(limit = 100): Promise<AuditRecord[]> {
    const rows = this.database.prepare("SELECT payload FROM audit_log ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => JSON.parse((row as { payload: string }).payload) as AuditRecord);
  }

  async close(): Promise<void> {
    (this.database as { close?: () => void }).close?.();
  }
}

interface JsonStoreDocument {
  documents: Record<string, unknown>;
  audit_log: AuditRecord[];
}

class JsonDocumentStore implements DocumentStore {
  readonly backend = "json" as const;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load<T>(key: string): Promise<T | undefined> {
    await this.writeQueue;
    const document = await this.read();
    return document.documents[key] as T | undefined;
  }

  async save<T>(key: string, value: T): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read();
      document.documents[key] = value;
      await this.write(document);
    });
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read();
      document.audit_log.push(record);
      document.audit_log = document.audit_log.slice(-5000);
      await this.write(document);
    });
  }

  async listAudit(limit = 100): Promise<AuditRecord[]> {
    await this.writeQueue;
    const document = await this.read();
    return document.audit_log.slice(-Math.min(Math.max(limit, 1), 500)).reverse();
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async read(): Promise<JsonStoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<JsonStoreDocument>;
      return {
        documents: parsed.documents && typeof parsed.documents === "object" ? parsed.documents as Record<string, unknown> : {},
        audit_log: Array.isArray(parsed.audit_log) ? parsed.audit_log : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { documents: {}, audit_log: [] };
      throw error;
    }
  }

  private async write(document: JsonStoreDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 20)) {
    if (typeof value === "string") safe[key] = value.slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    else if (Array.isArray(value)) safe[key] = value.slice(0, 20).filter((item) => typeof item === "string").map((item) => item.slice(0, 200));
  }
  return safe;
}
