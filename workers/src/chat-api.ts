/**
 * Chat API handler
 *
 * Streams OpenAI responses back to the client via SSE.
 * Uses function calling so the LLM decides when and what to query
 * oddkit for, rather than blindly injecting context on every message.
 */

import { runOrchestrate, type Env } from "./orchestrate";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5-mini";

const SYSTEM_PROMPT = `You are the oddkit guide — a refined, helpful assistant whose purpose is to help people quickly understand and start using oddkit.

oddkit is an agent-first CLI and MCP server for ODD-governed repositories.

CONVERSATION RULES:
- Answer ONLY the user's latest message. Do not re-answer or revisit questions from earlier in the conversation.
- Treat each user message as the current focus. Prior messages are context, not questions to re-address.
- Keep responses focused and scannable — avoid repeating information already covered.

You have access to a "query_oddkit_docs" tool that searches the oddkit and ODD documentation. Use it when:
- The user asks about a concept, definition, or policy you haven't already looked up in this conversation
- You need to verify or cite specific documentation
- The user asks about getting started, commands, or workflows

Do NOT call the tool if:
- You already looked up this information earlier in the conversation
- The question is conversational and doesn't need documentation
- The user is asking a follow-up about something you already answered

When you use the tool, formulate a focused query for the specific concept needed — don't pass the user's raw message.

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

IMPORTANT: Ground your responses in documentation retrieved via the query_oddkit_docs tool. Never invent or assume definitions for terms like ODD, CST, canon, baseline, or any other concept — look them up first, then cite the source.`;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
}

/** Maximum time to wait for oddkit tool execution. */
const ODDKIT_TIMEOUT_MS = 5000;

/**
 * Maximum number of history messages to send to OpenAI.
 * Prevents context bloat from long conversations.
 */
const MAX_HISTORY_MESSAGES = 20;

/** Maximum time to wait for conversation summarization. */
const SUMMARY_TIMEOUT_MS = 4000;

/**
 * Minimum number of older messages (beyond the recent window)
 * before we bother summarizing. For 1-2 older messages, just
 * include them in full — not worth an extra API call.
 */
const SUMMARIZE_OLDER_THRESHOLD = 4;

/** OpenAI tool definition for oddkit documentation lookup. */
const ODDKIT_TOOL = {
  type: "function" as const,
  function: {
    name: "query_oddkit_docs",
    description:
      "Search oddkit and ODD documentation for definitions, concepts, how-to guides, constraints, and policy information. Formulate a focused search query for the specific concept or information you need.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description:
            "A focused search query (e.g., 'cognitive saturation threshold definition' or 'how to validate completion claims').",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Number of recent messages to keep in full (no summarization).
 * Preserves the last 2 exchanges so the model has complete
 * context for the immediate conversation.
 */
const RECENT_FULL_COUNT = 4;

/**
 * Summarize older conversation messages using the LLM.
 *
 * Instead of naively truncating (losing information), we ask the
 * model to produce a concise summary that preserves key facts,
 * definitions, citations, and user intent. This way the user's
 * early questions are still remembered in later turns.
 *
 * Returns null if summarization fails (caller should fall back
 * to including older messages as-is).
 */
async function summarizeOlderMessages(
  messages: ChatMessage[],
  env: Env
): Promise<string | null> {
  const transcript = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  try {
    const res = await Promise.race([
      fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content:
                "Summarize this conversation concisely. Preserve: (1) specific definitions and facts discussed, (2) document paths and citations referenced, (3) what the user asked about and the key answers given. Output only the summary.",
            },
            { role: "user", content: transcript },
          ],
          max_completion_tokens: 400,
        }),
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS)
      ),
    ]);

    if (!res || !("ok" in res) || !res.ok) return null;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Build conversation context for the OpenAI call.
 *
 * Strategy:
 *  - Cap total messages to MAX_HISTORY_MESSAGES
 *  - Split into older + recent (last RECENT_FULL_COUNT)
 *  - If few older messages: include them in full
 *  - If many older messages: summarize them into a single system
 *    message (preserving key facts without bloat)
 *  - Always keep recent messages in full
 *
 * Uses a SYSTEM message for the summary (per OpenAI cookbook
 * recommendation — avoids confusing the model into thinking
 * the summary is an assistant response).
 */
async function buildConversationContext(
  messages: ChatMessage[],
  env: Env
): Promise<Record<string, unknown>[]> {
  const capped = messages.slice(-MAX_HISTORY_MESSAGES);
  const splitAt = Math.max(0, capped.length - RECENT_FULL_COUNT);
  const older = capped.slice(0, splitAt);
  const recent = capped.slice(splitAt);

  const context: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Map ChatMessage to plain objects for Record<string, unknown>[] compatibility
  const toPlain = (msgs: ChatMessage[]) =>
    msgs.map((m) => ({ role: m.role, content: m.content }));

  if (older.length >= SUMMARIZE_OLDER_THRESHOLD) {
    // Enough older messages to warrant summarization
    const summary = await summarizeOlderMessages(older, env);
    if (summary) {
      context.push({
        role: "system",
        content: `Conversation so far:\n${summary}`,
      });
    } else {
      // Summarization failed — include older messages as-is
      context.push(...toPlain(older));
    }
  } else {
    // Few older messages — include them in full
    context.push(...toPlain(older));
  }

  context.push(...toPlain(recent));
  return context;
}

/**
 * Execute an oddkit documentation query with timeout.
 */
async function executeOddkitQuery(query: string, env: Env): Promise<string> {
  try {
    const result = await Promise.race([
      runOrchestrate({ message: query, env }).catch(() => null),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), ODDKIT_TIMEOUT_MS)
      ),
    ]);
    if (result?.assistant_text && result.action !== "error") {
      return result.assistant_text;
    }
  } catch {
    // Best-effort — return fallback below.
  }
  return "No relevant documentation found for this query.";
}

/**
 * Send an SSE error event to the client.
 */
async function writeSSEError(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await writer.write(
    encoder.encode(
      `data: ${JSON.stringify({ error: true, message, ...extra })}\n\n`
    )
  );
}

/**
 * Pipe a ReadableStream directly to the SSE writer (raw byte passthrough).
 */
async function pipeStream(
  body: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<void> {
  const reader = body.getReader();
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

/**
 * Handle POST /api/chat
 *
 * Flow:
 *  1. Send user messages + oddkit tool definition to OpenAI (streaming)
 *  2. Parse the stream: if the model produces content, forward to client
 *  3. If the model calls query_oddkit_docs, execute it, then make a
 *     second OpenAI call with the tool result and stream that response
 *
 * This lets the LLM decide when documentation context is needed
 * and formulate focused queries, instead of blind injection.
 */
export async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // --- Fast validation (before opening the stream) ---

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

  // --- Stream setup: return SSE headers immediately ---

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Async pipeline — runs after the Response is returned to the client.
  const pipeline = (async () => {
    try {
      // Build context: summarize older messages, keep recent in full
      const baseMessages = await buildConversationContext(userMessages, env);

      // --- First OpenAI call: model decides whether to use the tool ---

      const firstRes = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: baseMessages,
          tools: [ODDKIT_TOOL],
          stream: true,
          max_completion_tokens: 2048,
        }),
      });

      if (!firstRes.ok) {
        const detail = await firstRes.text().catch(() => "");
        await writeSSEError(writer, encoder, "OpenAI API error", {
          status: firstRes.status,
          detail,
        });
        return;
      }

      // Parse the SSE stream to detect content vs tool_calls
      let hasContent = false;
      let toolCallId = "";
      let toolCallName = "";
      let toolCallArgs = "";
      let finishReason = "";

      const reader = firstRes.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          const choices = chunk.choices as
            | Array<Record<string, unknown>>
            | undefined;
          const choice = choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason)
            finishReason = choice.finish_reason as string;

          const delta = choice.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Content delta → forward to client immediately
          if (delta.content) {
            hasContent = true;
            await writer.write(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
            );
          }

          // Tool call delta → buffer (don't send to client)
          if (delta.tool_calls) {
            const tcs = delta.tool_calls as Array<Record<string, unknown>>;
            for (const tc of tcs) {
              if (tc.id) toolCallId = tc.id as string;
              const fn = tc.function as
                | Record<string, unknown>
                | undefined;
              if (fn?.name) toolCallName = fn.name as string;
              if (fn?.arguments) toolCallArgs += fn.arguments as string;
            }
          }
        }
      }
      reader.releaseLock();

      // --- Handle the result ---

      if (
        finishReason === "tool_calls" &&
        toolCallName === "query_oddkit_docs"
      ) {
        // Model wants to look up documentation — execute the tool
        let query = "";
        try {
          query = (JSON.parse(toolCallArgs) as { query: string }).query || "";
        } catch {
          // Malformed args — proceed with empty query
        }

        const toolResult = await executeOddkitQuery(query, env);

        // Second call: include the tool result so the model can answer
        const followUpMessages: Record<string, unknown>[] = [
          ...baseMessages,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: { name: toolCallName, arguments: toolCallArgs },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResult,
          },
        ];

        const secondRes = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: followUpMessages,
            stream: true,
            max_completion_tokens: 2048,
          }),
        });

        if (!secondRes.ok) {
          const detail = await secondRes.text().catch(() => "");
          await writeSSEError(writer, encoder, "OpenAI API error", {
            status: secondRes.status,
            detail,
          });
          return;
        }

        // Pipe the second response directly to the client
        if (secondRes.body) {
          await pipeStream(secondRes.body, writer);
        }
      } else if (hasContent) {
        // Content was already streamed in the first pass — send [DONE]
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } else {
        await writeSSEError(writer, encoder, "No response from model");
      }
    } catch (err) {
      try {
        await writeSSEError(
          writer,
          encoder,
          err instanceof Error ? err.message : "Internal error"
        );
      } catch {
        // Writer already closed (client disconnected).
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed or aborted.
      }
    }
  })();

  pipeline.catch(() => {});

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
