import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "child_process";

interface ToolCall {
  action: "tool_call" | "final";
  tool_calls?: Array<{ name: string; arguments: any }>;
  content?: string;
}

export const cursorACP: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "cursor-acp",
      loader: async (getAuth) => {
        // Check if cursor-agent is installed
        const check = await client.$`cursor-agent --version`.quiet().nothrow();
        if (check.exitCode !== 0) {
          return { type: "failed", message: "cursor-agent not found. Install with: curl -fsS https://cursor.com/install | bash" };
        }

        // Check if logged in
        const whoami = await client.$`cursor-agent whoami`.quiet().nothrow();
        const whoamiText = whoami.text();

        if (whoamiText.includes("Not logged in")) {
          return {
            type: "failed",
            message: "Not logged in to cursor-agent. Run: cursor-agent login"
          };
        }

        return {
          type: "success",
          key: "cursor-agent",
          data: { email: whoamiText }
        };
      },
      methods: [
        {
          label: "Login via cursor-agent",
          type: "api",
          authorize: async () => {
            const login = await client.$`cursor-agent login`.nothrow();
            return login.exitCode === 0 ? { type: "success" } : { type: "failed" };
          }
        }
      ]
    },

    async "chat.params"(input, output) {
      if (input.model.providerID !== "cursor-acp") {
        return;
      }

      const model = input.model.modelID || "auto";
      const stream = input.stream ?? true;

      // Build prompt from OpenCode messages
      const messages = input.messages || [];
      const prompt = messages
        .map(m => `${m.role}: ${m.content}`)
        .join("\n\n");

      // Spawn cursor-agent with prompt via stdin
      const args = [
        "--print",
        "--output-format",
        stream ? "json-stream" : "json",
        "--model",
        model,
        "--workspace",
        process.cwd()
      ];

      const child = spawn("cursor-agent", args, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error("Failed to spawn cursor-agent");
      }

      // Write prompt to stdin (fixes E2BIG)
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = "";
      let stderr = "";

      // Handle streaming responses
      if (stream) {
        const encoder = new TextEncoder();
        const id = `cursor-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let buffer = "";

        for await (const chunk of child.stdout) {
          const text = new TextDecoder().decode(chunk);
          buffer += text;

          // Process complete lines only
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim() || !line.startsWith("data: ")) continue;

            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta?.content;
              if (delta) {
                await output.write({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: delta },
                    finish_reason: null
                  }]
                });
              }
            } catch {
              // Ignore parse errors for malformed chunks
            }
          }
        }

        // Send final chunk AFTER loop completes
        await output.write({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        });
      } else {
        // Non-streaming: wait for complete response
        stdout = await new Response(child.stdout).text();
      }

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise((resolve) => {
        child.on("close", resolve);
      });

      if (exitCode !== 0 && stderr) {
        throw new Error(`cursor-agent failed: ${stderr}`);
      }

      // Parse response for non-streaming
      if (!stream && stdout) {
        let responseContent = stdout.trim();

        // Try to extract tool calls from output
        try {
          const parsed = JSON.parse(responseContent);
          responseContent = parsed.content || responseContent;
        } catch {
          // Not JSON, use as-is
        }

        await output.write({
          id: `cursor-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseContent },
              finish_reason: "stop"
            }
          ]
        });
      }
    },

    async "chat.message"(input, output) {
      // Just pass through - let chat.params handle everything
      await output.write(input);
    },

    async "tool.execute"(input, output) {
      // Tool execution is handled by cursor-agent directly
      // We just pass tool results back to OpenCode
      await output.write({
        id: `cursor-${Date.now()}`,
        object: "tool.result",
        created: Math.floor(Date.now() / 1000),
        tool: input.tool,
        content: JSON.stringify(input.args)
      });
    }
  };
};
