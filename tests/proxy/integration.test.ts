import { describe, it, expect } from "bun:test";
import { createCursorProvider } from "../../src/provider.js";

describe("Proxy Integration", () => {
  it("should create provider in proxy mode", async () => {
    const provider = await createCursorProvider({
      mode: 'proxy',
      proxyConfig: { port: 32126 }
    });

    // Initialize to start the proxy server
    const initialized = await provider.init();

    expect(provider.id).toBe("cursor-acp");
    expect(initialized.baseURL).toContain("http://127.0.0.1:32126");

    // Clean up
    const proxy = (provider as any).proxy;
    if (proxy?.stop) await proxy.stop();
  });
});