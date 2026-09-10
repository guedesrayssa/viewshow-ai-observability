import type { ImportControlPort } from "../ports/import-control.js";

export class UnavailableImportControl implements ImportControlPort {
  async start(): Promise<"unavailable"> {
    return "unavailable";
  }

  async complete(): Promise<"unavailable"> {
    return "unavailable";
  }

  async get(): Promise<"unavailable"> {
    return "unavailable";
  }
}
