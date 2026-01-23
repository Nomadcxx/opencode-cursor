import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { CursorAcpHybridAgent } from "./acp/agent.js";
import { CursorNativeWrapper } from "./acp/cursor.js";

export function runAcp() {
  const input = process.stdin as any;
  const output = process.stdout as any;
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client: any) => CursorAcpHybridAgent(client), stream);

  process.stdin.resume();
}

// OpenCode plugin format - export a function that returns hooks
const plugin: Plugin = async (input) => {
  // This plugin runs ACP via stdin/stdout, so we don't need traditional OpenCode hooks
  // But we must return a hooks object to satisfy the plugin interface
  const hooks: Hooks = {
    // Optional config hook - can be used to validate/transform config if needed
    config: async (config) => {
      // No-op for now, but can be extended if needed
    }
  };
  
  return hooks;
};

export default plugin;

export { CursorAcpHybridAgent, CursorNativeWrapper };
