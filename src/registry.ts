import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExperienceModule, ExperienceModuleImplementation } from "./module-api.js";
import { IsolatedExperienceModule } from "./module-worker-host.js";
import { experienceManifestSchema } from "./protocol.js";
import { isTrustedPublicKey, moduleDigests, verifyModuleSignature } from "./signature.js";
import type { ExperienceManifest, ExperienceRegistryEntry, ModuleSignature, ModuleSignatureStatus } from "./types.js";

export interface ModuleRegistryOptions {
  trustedKeys?: Record<string, string>;
  isolateModules?: boolean;
}

export class ModuleRegistry {
  private readonly modules = new Map<string, ExperienceModule>();
  private readonly metadata = new Map<string, ExperienceRegistryEntry>();
  private trustedKeys: Record<string, string>;
  private readonly isolateModules: boolean;

  constructor(options: ModuleRegistryOptions = {}) {
    this.trustedKeys = { ...(options.trustedKeys ?? {}) };
    this.isolateModules = options.isolateModules === true;
  }

  setTrustedKeys(trustedKeys: Record<string, string>): void {
    this.trustedKeys = { ...trustedKeys };
  }

  async loadFromDirectory(rootDir: string): Promise<void> {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const directory of directories) {
      await this.loadModule(resolve(rootDir, directory.name));
    }
  }

  get(id: string): ExperienceModule | undefined {
    return this.modules.get(id);
  }

  list(): ExperienceManifest[] {
    return [...this.modules.values()].map((module) => ({ ...module.manifest }));
  }

  listDetailed(): ExperienceRegistryEntry[] {
    return [...this.metadata.values()].map((entry) => ({
      ...entry,
      manifest: { ...entry.manifest },
      signature: entry.signature ? { ...entry.signature } : undefined,
      versions: entry.versions.map((version) => ({ ...version })),
    }));
  }

  getEntry(id: string): ExperienceRegistryEntry | undefined {
    const entry = this.metadata.get(id);
    return entry
      ? {
          ...entry,
          manifest: { ...entry.manifest },
          signature: entry.signature ? { ...entry.signature } : undefined,
          versions: entry.versions.map((version) => ({ ...version })),
        }
      : undefined;
  }

  size(): number {
    return this.modules.size;
  }

  close(): void {
    for (const module of this.modules.values()) {
      if (module instanceof IsolatedExperienceModule) module.close();
    }
  }

  private async loadModule(moduleDir: string): Promise<void> {
    const manifestPath = join(moduleDir, "manifest.json");
    const modulePath = await findModuleEntry(moduleDir);
    if (!modulePath) throw new Error(`Module ${moduleDir} is missing module.mjs or module.js`);
    const manifest = experienceManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))) as ExperienceManifest;
    if (this.modules.has(manifest.id)) throw new Error(`Duplicate experience id: ${manifest.id}`);

    const entrySource = await readFile(modulePath, "utf8");
    const signatureResult = await readModuleSignature(moduleDir);
    const verification = verifyRegistrySignature(manifest, entrySource, signatureResult, this.trustedKeys);

    if (this.isolateModules) {
      this.modules.set(manifest.id, new IsolatedExperienceModule(manifest, modulePath));
    } else {
      const imported = await import(pathToFileURL(modulePath).href);
      const implementation = (imported.default ?? imported) as Partial<ExperienceModuleImplementation>;
      if (typeof implementation.start !== "function" || typeof implementation.handleEvent !== "function") {
        throw new Error(`Module ${manifest.id} must export start and handleEvent functions`);
      }
      this.modules.set(manifest.id, {
        manifest,
        start: implementation.start,
        handleEvent: implementation.handleEvent,
      });
    }
    const digests = moduleDigests(manifest, entrySource);
    this.metadata.set(manifest.id, {
      manifest,
      source: "local",
      signature_status: verification.status,
      signature: verification.signature,
      versions: [{
        version: manifest.version,
        published_at: verification.signature?.signed_at ?? new Date().toISOString(),
        signature_status: verification.status,
        manifest_sha256: digests.manifestSha256,
        entry_sha256: digests.entrySha256,
      }],
    });
  }
}

export function defaultModulesDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "experiences");
}

export async function loadDefaultModuleRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry({ isolateModules: process.env.EXPERIENCE_ISOLATE_MODULES === "1" });
  await loadTrustedKeysFromEnvironment(registry);
  const directory = process.env.EXPERIENCE_MODULES_DIR
    ? resolve(process.env.EXPERIENCE_MODULES_DIR)
    : defaultModulesDirectory();
  await registry.loadFromDirectory(directory);
  return registry;
}

export async function loadTrustedKeysFromEnvironment(registry: ModuleRegistry): Promise<void> {
  const path = process.env.EXPERIENCE_TRUSTED_KEYS;
  if (!path) return;
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("EXPERIENCE_TRUSTED_KEYS must point to a key_id to public_key JSON object");
  }
  registry.setTrustedKeys(parsed as Record<string, string>);
}

async function findModuleEntry(moduleDir: string): Promise<string | undefined> {
  for (const fileName of ["module.mjs", "module.js"]) {
    const path = join(moduleDir, fileName);
    try {
      await readFile(path, "utf8");
      return path;
    } catch {
      // Try the next supported module entry.
    }
  }
  return undefined;
}

export function validateManifest(input: unknown): ExperienceManifest {
  return experienceManifestSchema.parse(input) as ExperienceManifest;
}

export function moduleFileExtension(path: string): string {
  return extname(path);
}

async function readModuleSignature(moduleDir: string): Promise<{ present: boolean; value?: unknown }> {
  try {
    return { present: true, value: JSON.parse(await readFile(join(moduleDir, "signature.json"), "utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true };
  }
}

function verifyRegistrySignature(
  manifest: ExperienceManifest,
  entrySource: string,
  signatureResult: { present: boolean; value?: unknown },
  trustedKeys: Record<string, string> | undefined,
): { status: ModuleSignatureStatus; signature?: ModuleSignature } {
  if (!signatureResult.present) return { status: "unsigned" };
  const signature = verifyModuleSignature(manifest, entrySource, signatureResult.value);
  if (!signature) return { status: "invalid" };
  return {
    status: isTrustedPublicKey(signature, trustedKeys?.[signature.key_id]) ? "trusted" : "signed",
    signature,
  };
}
