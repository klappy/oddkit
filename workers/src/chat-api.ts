/**
 * Chat API handler
 *
 * Streams OpenAI responses back to the client via SSE.
 * Always enriches the system prompt with oddkit documentation context
 * from oddkit.klappy.dev — dogfooding the governance system itself.
 */

import { runOrchestrate, type Env } from "./orchestrate";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5-mini";

const SYSTEM_PROMPT = `You are the oddkit guide — a refined, helpful assistant whose purpose is to help people quickly understand and start using oddkit.

oddkit is an agent-first CLI and MCP server for ODD-governed repositories. Your knowledge about ODD, oddkit, and its concepts comes exclusively from the oddkit documentation context provided below — never invent or assume definitions. If no documentation context is available for a question, say so honestly rather than guessing.

Your primary goals:
- Help users understand what oddkit is and why it matters
- Show how to get started simply (CLI, MCP, or remote worker)
- Explain the value: policy retrieval, completion validation, documentation discovery
- Guide users to the right commands and workflows
- Make governance feel approachable, not bureaucratic

Your communication style:
- Warm but precise — like a knowledgeable concierge
- Lead with the practical; follow with the conceptual
- Use concrete examples and real commands
- When citing documentation, use backtick-wrapped paths
- Format responses with clean markdown
- Keep answers focused and scannable

Key oddkit actions:
- **Librarian**: Ask policy questions, get answers with citations
- **Validate**: Claim completion, get verified or see what evidence is missing
- **Catalog**: Discover available documentation
- **Preflight**: Get guidance before implementing something

Quick start paths:
- CLI: \`npx oddkit librarian --query "your question"\`
- MCP in Claude Code: \`npx oddkit init --claude\`
- Remote: Connect to oddkit.klappy.dev as a remote MCP server

IMPORTANT: Always ground your responses in the oddkit documentation context provided below. The context is retrieved live from the project's governing documentation. Never hardcode or assume definitions for terms like ODD, canon, baseline, or any other concept — use exactly what the documentation says, and cite the source.`;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
}

/**
 * Fetch oddkit context for the user's latest message.
 * Always attempts retrieval — this assistant dogfoods oddkit.
 */
async function getOddkitContext(
  message: string,
  env: Env
): Promise<string | null> {
  try {
    const result = await runOrchestrate({
      message,
      env,
    });

    if (result.assistant_text && result.action !== "error") {
      return `[oddkit ${result.action} context]\n${result.assistant_text}`;
    }
  } catch {
    // Context enrichment is best-effort; don't block the response.
  }
  return null;
}

/**
 * Handle POST /api/chat
 *
 * Accepts { messages: ChatMessage[] } and streams back SSE
 * in the same format as the OpenAI streaming API.
 */
export async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!body || !Array.isArray(body.messages)) {
    return new Response(
      JSON.stringify({ error: "messages must be an array" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Only allow user and assistant roles — drop any client-injected system messages
  const userMessages = body.messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  const lastUserMsg = [...userMessages].reverse().find((m) => m.role === "user");

  // Always enrich with oddkit context — this assistant dogfoods oddkit
  let system = SYSTEM_PROMPT;

  if (lastUserMsg) {
    const ctx = await getOddkitContext(lastUserMsg.content, env);
    if (ctx) {
      system += `\n\n---\n\n${ctx}`;
    }
  }

  // Build the messages array for OpenAI
  const openaiMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...userMessages,
  ];

  // Call OpenAI with streaming
  const openaiRes = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: openaiMessages,
      stream: true,
      max_completion_tokens: 2048,
    }),
  });

  if (!openaiRes.ok) {
    const detail = await openaiRes.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: "OpenAI API error", status: openaiRes.status, detail }),
      { status: openaiRes.status, headers: { "Content-Type": "application/json" } }
    );
  }

  // Proxy the SSE stream directly to the client
  return new Response(openaiRes.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
