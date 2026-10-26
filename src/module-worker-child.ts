import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ExperienceModuleImplementation } from "./module-api.js";
import type { ExperienceContext, ExperienceModuleResult } from "./module-api.js";
import type { SessionEvent, SessionState } from "./types.js";

interface WorkerRequest {
  id: string;
  method: "start" | "handleEvent";
  context: ExperienceContext;
  state?: SessionState;
  event?: SessionEvent;
}

const modulePath = process.argv[2];
if (!modulePath) throw new Error("Module worker requires a module path.");

const imported = await import(pathToFileURL(resolve(modulePath)).href);
const implementation = (imported.default ?? imported) as Partial<ExperienceModuleImplementation>;
if (typeof implementation.start !== "function" || typeof implementation.handleEvent !== "function") {
  throw new Error("Module must export start and handleEvent functions.");
}
const start = implementation.start;
const handleEvent = implementation.handleEvent;

process.on("message", async (message: WorkerRequest) => {
  try {
    let result: SessionState | ExperienceModuleResult;
    if (message.method === "start") {
      result = await start(message.context);
    } else {
      if (!message.state || !message.event) throw new Error("handleEvent requires state and event.");
      result = await handleEvent(message.context, message.state, message.event);
    }
    process.send?.({ id: message.id, ok: true, result });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
