// Smoke test del @cursor/sdk fuera de OpenCode.
// Uso:  CURSOR_API_KEY=... node scripts/sdk-smoke.mjs
//       CURSOR_API_KEY=... bun  scripts/sdk-smoke.mjs
import { Agent } from "@cursor/sdk";

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, m);

if (!process.env.CURSOR_API_KEY) {
  console.error("CURSOR_API_KEY no seteada");
  process.exit(1);
}

const timer = setTimeout(() => {
  log("TIMEOUT 60s — colgado");
  process.exit(2);
}, 60_000);

log("Agent.create...");
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY,
  model: { id: "auto" },
  mode: "agent",
  local: { cwd: process.cwd(), settingSources: ["all"] },
});
log("Agent.create OK");

// PROMPT_KB=90 simula el prompt grande que manda el plugin (~92KB)
const kb = Number(process.env.PROMPT_KB || 0);
const padding = kb > 0 ? "\n\nContexto (ignorar):\n" + "lorem ipsum dolor sit amet ".repeat((kb * 1024) / 27) : "";
log(`agent.send... (prompt ${(padding.length / 1024).toFixed(0)}KB extra)`);
const run = await agent.send("Reply with exactly one word: hello" + padding);
log("send OK, streaming...");

for await (const msg of run.stream()) {
  log(`evt: ${msg?.type}${msg?.type === "assistant" ? " → " + JSON.stringify(msg.message?.content?.slice(0, 1)) : ""}`);
}
log("stream done");
clearTimeout(timer);
process.exit(0);
