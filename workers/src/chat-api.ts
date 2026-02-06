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

/** Maximum time to wait for oddkit context before proceeding without it. */
const CONTEXT_TIMEOUT_MS = 5000;

/**
 * Fetch oddkit context for the user's latest message.
 * Always attempts retrieval — this assistant dogfoods oddkit.
 * Bounded by CONTEXT_TIMEOUT_MS to keep TTFT reasonable.
 */
async function getOddkitContext(
  message: string,
  env: Env
): Promise<string | null> {
  try {
    const result = await Promise.race([
      runOrchestrate({ message, env }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS)),
    ]);

    if (result?.assistant_text && result.action !== "error") {
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
 * Accepts { messages: ChatMessage[] } and streams back SSE.
 *
 * Returns the SSE response immediately (reducing TTFT) and pipes
 * OpenAI tokens through asynchronously.  The oddkit context fetch
 * and OpenAI call happen inside the stream so the HTTP connection
 * is open before any slow network work begins.
 */
export async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // --- Fast, synchronous validation (before opening the stream) ---

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

  // --- Stream setup: return SSE headers immediately ---

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Async pipeline — runs after the Response is returned to the client.
  // The worker stays alive as long as the writable side is open.
  const pipeline = (async () => {
    try {
      // Enrich with oddkit context (bounded by CONTEXT_TIMEOUT_MS)
      let system = SYSTEM_PROMPT;
      if (lastUserMsg) {
        const ctx = await getOddkitContext(lastUserMsg.content, env);
        if (ctx) {
          system += `\n\n---\n\n${ctx}`;
        }
      }

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
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ error: true, message: "OpenAI API error", status: openaiRes.status, detail })}\n\n`
          )
        );
        return;
      }

      // Pipe OpenAI SSE stream through to the client
      if (openaiRes.body) {
        const reader = openaiRes.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
    } catch (err) {
      // Send error as SSE event so the client can display it
      try {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ error: true, message: err instanceof Error ? err.message : "Internal error" })}\n\n`
          )
        );
      } catch {
        // Writer already closed (client disconnected) — nothing to do.
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed or aborted.
      }
    }
  })();

  // Prevent unhandled-rejection warnings if the pipeline throws after
  // all catch blocks (shouldn't happen, but belt-and-suspenders).
  pipeline.catch(() => {});

  // Return SSE response immediately — tokens will arrive via the pipeline.
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
