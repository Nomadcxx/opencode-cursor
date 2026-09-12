export interface ParsedRequest {
  model: string;
  prompt: string;
  stream: boolean;
  tools?: any[];
}

export function parseOpenAIRequest(body: any): ParsedRequest {
  const model = body.model?.replace("cursor-kilo/", "") || "auto";
  const stream = body.stream === true;

  // Convert messages array to prompt string
  let prompt = "";
  if (Array.isArray(body.messages)) {
    const lines = body.messages.map((msg: any) => {
      const role = msg.role?.toUpperCase() || "USER";
      const content = typeof msg.content === "string" ? msg.content : "";
      return `${role}: ${content}`;
    });
    prompt = lines.join("\n\n");
  }

  return {
    model,
    prompt,
    stream,
    tools: body.tools
  };
}