import { describe, expect, it } from "bun:test";
import { ModelDiscoveryService } from "../../../src/models/discovery.js";

describe("models/discovery", () => {
  it("does not pass the legacy cursor-agent placeholder to SDK model discovery", async () => {
    const originalApiKey = process.env.CURSOR_API_KEY;
    const originalRunnerPath = process.env.CURSOR_ACP_SDK_RUNNER_PATH;
    process.env.CURSOR_API_KEY = "cursor-agent";
    process.env.CURSOR_ACP_SDK_RUNNER_PATH = "/definitely/missing/sdk-runner.mjs";

    const service = new ModelDiscoveryService();

    try {
      await expect((service as any).queryViaSdk()).rejects.toThrow("No Cursor API key available");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CURSOR_API_KEY;
      } else {
        process.env.CURSOR_API_KEY = originalApiKey;
      }
      if (originalRunnerPath === undefined) {
        delete process.env.CURSOR_ACP_SDK_RUNNER_PATH;
      } else {
        process.env.CURSOR_ACP_SDK_RUNNER_PATH = originalRunnerPath;
      }
    }
  });
});
