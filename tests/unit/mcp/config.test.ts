import { describe, expect, it } from "bun:test";
import { readMcpConfigs, type McpServerConfig } from "../../../src/mcp/config.js";

describe("mcp/config", () => {
  it("reads local MCP server configs from valid JSON", () => {
    const json = JSON.stringify({
      mcp: {
        "test-server": {
          type: "local",
          command: ["node", "/path/to/server.js"],
          environment: { KEY: "val" },
        },
      },
    });

    const configs = readMcpConfigs({ configJson: json });
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("test-server");
    expect(configs[0].type).toBe("local");
    expect(configs[0].command).toEqual(["node", "/path/to/server.js"]);
    expect(configs[0].environment).toEqual({ KEY: "val" });
  });

  it("reads remote MCP server configs", () => {
    const json = JSON.stringify({
      mcp: {
        "remote-srv": {
          type: "remote",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });

    const configs = readMcpConfigs({ configJson: json });
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("remote-srv");
    expect(configs[0].type).toBe("remote");
    expect(configs[0].url).toBe("https://mcp.example.com/sse");
  });

  it("skips disabled servers", () => {
    const json = JSON.stringify({
      mcp: {
        disabled: { type: "local", command: ["x"], enabled: false },
        enabled: { type: "local", command: ["y"] },
      },
    });

    const configs = readMcpConfigs({ configJson: json });
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("enabled");
  });

  it("returns empty array when mcp key is missing", () => {
    const configs = readMcpConfigs({ configJson: JSON.stringify({}) });
    expect(configs).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const configs = readMcpConfigs({ configJson: "{broken" });
    expect(configs).toEqual([]);
  });

  it("reads from file path when configJson not provided", () => {
    const configs = readMcpConfigs({
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          mcp: { s: { type: "local", command: ["z"] } },
        }),
      env: { OPENCODE_CONFIG: "/tmp/test.json" },
    });
    expect(configs).toHaveLength(1);
  });
});
