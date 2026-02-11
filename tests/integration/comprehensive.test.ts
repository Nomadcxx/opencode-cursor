import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createProxyServer } from "../../src/proxy/server.js";
import { ToolRegistry, executeWithChain, LocalExecutor } from "../../src/tools/index.js";
import { registerDefaultTools, getDefaultToolNames } from "../../src/tools/defaults.js";
import { ModelDiscoveryService, ConfigUpdater } from "../../src/models/index.js";
import { createCursorProvider } from "../../src/provider.js";

describe("Comprehensive End-to-End Integration", () => {
  describe("Full Provider Flow", () => {
    it("should create provider in proxy mode and execute model", async () => {
      const provider = createCursorProvider({
        mode: 'proxy',
        proxyConfig: { port: 32132 }
      });

      await provider.init();

      expect(provider.id).toBe("cursor-acp");
      expect(provider.baseURL).toContain("32132");

      // Get language model
      const model = provider.languageModel("cursor-acp/auto");
      expect(model.modelId).toBe("cursor-acp/auto");
      expect(model.provider).toBe("cursor-acp");

      // Cleanup
      await provider.proxy.stop();
    });

    it("should create provider in direct mode", async () => {
      const provider = createCursorProvider({
        mode: 'direct'
      });

      expect(provider.id).toBe("cursor-acp");
      expect(provider.name).toBe("Cursor ACP Provider");

      // Get language model
      const model = provider.languageModel("cursor-acp/gpt-5.2");
      expect(model.modelId).toBe("cursor-acp/gpt-5.2");
    });
  });

  describe("Proxy + Tools Integration", () => {
    let server: any;
    let baseURL: string;

    beforeAll(async () => {
      server = createProxyServer({ port: 32133 });
      baseURL = await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it("should have working health endpoint", async () => {
      const response = await fetch(`${baseURL.replace('/v1', '')}/health`);
      expect(response.status).toBe(200);
    });

    it("should integrate tool registry with defaults", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry);

      expect(registry.list().length).toBe(10);
      expect(registry.getTool("bash")).toBeDefined();
      expect(registry.getTool("read")).toBeDefined();
      expect(registry.getTool("write")).toBeDefined();
      expect(registry.getTool("edit")).toBeDefined();
      expect(registry.getTool("grep")).toBeDefined();
      expect(registry.getTool("ls")).toBeDefined();
      expect(registry.getTool("mkdir")).toBeDefined();
      expect(registry.getTool("rm")).toBeDefined();
      expect(registry.getTool("stat")).toBeDefined();
      expect(registry.getTool("glob")).toBeDefined();
    });
  });

  describe("Model Discovery + Config Integration", () => {
    it("should discover models and generate config", async () => {
      const service = new ModelDiscoveryService();
      const updater = new ConfigUpdater();

      const models = await service.discover();
      expect(models.length).toBeGreaterThan(0);

      const config = updater.generateProviderConfig(models, "http://localhost:32124/v1");

      expect(config.npm).toBeDefined();
      expect(config.name).toBeDefined();
      expect(config.options.baseURL).toBe("http://localhost:32124/v1");
      expect(Object.keys(config.models).length).toBeGreaterThan(0);

      // Each model should have tools and reasoning enabled
      for (const key of Object.keys(config.models)) {
        expect(config.models[key].tools).toBe(true);
        expect(config.models[key].reasoning).toBe(true);
      }
    });

    it("should cache models", async () => {
      const service = new ModelDiscoveryService({ cacheTTL: 60000 });

      const models1 = await service.discover();
      const models2 = await service.discover();

      expect(models1).toEqual(models2);
    });

    it("should format models correctly", () => {
      const updater = new ConfigUpdater();

      const models = [
        { id: "gpt-5.2", name: "GPT 5.2" },
        { id: "sonnet-4.5", name: "Sonnet 4.5" }
      ];

      const formatted = updater.formatModels(models);

      // IDs with dots should be normalized
      expect(formatted.gpt52).toBeDefined();
      expect(formatted.sonnet45).toBeDefined();
      expect(formatted.gpt52.name).toBe("GPT 5.2");
    });
  });

  describe("Tool Execution with Real Files", () => {
    it("should execute full file workflow", async () => {
      const fs = await import("fs");
      const path = await import("path");

      const registry = new ToolRegistry();
      registerDefaultTools(registry);
      const executor = new LocalExecutor(registry);

      const testDir = `/tmp/e2e-test-${Date.now()}`;
      const testFile = path.join(testDir, "test.txt");

      // Create directory
      fs.mkdirSync(testDir, { recursive: true });

      // Write file
      const writeResult = await executeWithChain([executor], "write", {
        path: testFile,
        content: "Line 1\nLine 2\nLine 3"
      });
      expect(writeResult.status).toBe("success");

      // Read file
      const readResult = await executeWithChain([executor], "read", { path: testFile });
      expect(readResult.status).toBe("success");
      expect(readResult.output).toBe("Line 1\nLine 2\nLine 3");

      // Edit file
      const editResult = await executeWithChain([executor], "edit", {
        path: testFile,
        old_string: "Line 2",
        new_string: "Modified Line"
      });
      expect(editResult.status).toBe("success");

      // Read again
      const editedResult = await executeWithChain([executor], "read", { path: testFile });
      expect(editedResult.status).toBe("success");
      expect(editedResult.output).toBe("Line 1\nModified Line\nLine 3");

      // List directory
      const lsResult = await executeWithChain([executor], "ls", { path: testDir });
      expect(lsResult.status).toBe("success");
      expect(lsResult.output).toContain("test.txt");

      // Grep for content
      const grepResult = await executeWithChain([executor], "grep", {
        pattern: "Modified",
        path: testDir
      });
      expect(grepResult.status).toBe("success");
      expect(grepResult.output).toContain("Modified Line");

      // Cleanup
      fs.unlinkSync(testFile);
      fs.rmdirSync(testDir);
    });
  });

  describe("Performance Benchmarks", () => {
    it("should start proxy server quickly", async () => {
      const startTime = Date.now();
      const server = createProxyServer({ port: 32134 });
      await server.start();
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(500); // Should start in <500ms
      await server.stop();
    });

    it("should handle multiple concurrent tool executions", async () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry);
      const executor = new LocalExecutor(registry);

      const startTime = Date.now();

      // Execute 10 tool calls concurrently
      const promises = Array(10).fill(null).map((_, i) =>
        executeWithChain([executor], "bash", { command: `echo "test-${i}"` })
      );

      const results = await Promise.all(promises);

      const endTime = Date.now();

      expect(results.length).toBe(10);
      expect(endTime - startTime).toBeLessThan(2000); // Should complete in <2s

      // Verify all results
      for (let i = 0; i < 10; i++) {
        expect(results[i].status).toBe("success");
        expect(results[i].output).toContain(`test-${i}`);
      }
    });

    it("should cache model discovery", async () => {
      const service = new ModelDiscoveryService({ cacheTTL: 5000 });
      let queryCalls = 0;
      const originalQuery = (service as any).queryCursorAgent.bind(service);
      (service as any).queryCursorAgent = async () => {
        queryCalls += 1;
        return originalQuery();
      };

      const models1 = await service.discover();
      const models2 = await service.discover();

      expect(models2).toEqual(models1);
      expect(queryCalls).toBe(1);
    });
  });

  describe("Error Handling", () => {
    it("should handle proxy server errors gracefully", async () => {
      const server = createProxyServer({ port: 32135 });
      await server.start();

      // Try to start another server on same port
      const server2 = createProxyServer({ port: 32135 });

      // Should handle gracefully (either fail or succeed)
      try {
        await server2.start();
        await server2.stop();
      } catch (e) {
        // Expected to possibly fail
      }

      await server.stop();
    });

    it("should handle tool execution errors", async () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry);
      const executor = new LocalExecutor(registry);

      // Non-existent file — handler throws and executor returns error
      const result = await executeWithChain([executor], "read", {
        path: "/non/existent/file.txt"
      });

      expect(result.status).toBe("error");
      expect(result.error).toBeDefined();
    });

    it("should handle invalid tool calls", async () => {
      const registry = new ToolRegistry();
      const executor = new LocalExecutor(registry);

      const result = await executeWithChain([executor], "non-existent-tool", {});

      expect(result.status).toBe("error");
      expect(result.error).toContain("No executor");
    });
  });

  describe("Feature Completeness", () => {
    it("should have all required proxy features", () => {
      const server = createProxyServer({
        port: 32136,
        host: "127.0.0.1",
        healthCheckPath: "/health"
      });

      expect(server.start).toBeDefined();
      expect(server.stop).toBeDefined();
      expect(server.getBaseURL).toBeDefined();
    });

    it("should have all required tool features", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry);

      // All 10 tools should be registered
      const toolNames = getDefaultToolNames();
      expect(toolNames.length).toBe(10);

      for (const name of toolNames) {
        const tool = registry.getTool(name);
        expect(tool).toBeDefined();
        expect(tool?.name).toBe(name);
        expect(tool?.description).toBeDefined();
        expect(tool?.parameters).toBeDefined();
      }
    });

    it("should have all required model discovery features", async () => {
      const service = new ModelDiscoveryService();

      expect(service.discover).toBeDefined();
      expect(service.invalidateCache).toBeDefined();

      const models = await service.discover();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Each model should have required fields
      for (const model of models) {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
      }
    });
  });
});
