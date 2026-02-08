/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import { parseToolCalls } from "./tool-protocol.js";
/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message) {
    return message.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
}
/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(message, requestId, isFirst = false) {
    const text = extractTextContent(message);
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(message.message.model),
        choices: [
            {
                index: 0,
                delta: {
                    role: isFirst ? "assistant" : undefined,
                    content: text,
                },
                finish_reason: message.message.stop_reason ? "stop" : null,
            },
        ],
    };
}
/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId, model) {
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(model),
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: "stop",
            },
        ],
    };
}
/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(result, requestId) {
    // Get model from modelUsage or default
    const modelName = result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : "claude-sonnet-4";
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(modelName),
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: result.result,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        },
    };
}
/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
function normalizeModelName(model) {
    if (model.includes("opus"))
        return "claude-opus-4";
    if (model.includes("sonnet"))
        return "claude-sonnet-4";
    if (model.includes("haiku"))
        return "claude-haiku-4";
    return model;
}
/**
 * Convert Claude CLI result to OpenAI response, parsing for tool calls.
 * Used when the request included tools — checks for <tool_call> blocks.
 */
export function cliResultToOpenaiWithTools(result, requestId) {
    const modelName = result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : "claude-sonnet-4";

    const { toolCalls, textContent } = parseToolCalls(result.result || "");

    if (toolCalls.length > 0) {
        return {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: normalizeModelName(modelName),
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: textContent,
                        tool_calls: toolCalls,
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage: {
                prompt_tokens: result.usage?.input_tokens || 0,
                completion_tokens: result.usage?.output_tokens || 0,
                total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
            },
        };
    }

    // No tool calls found — return as normal response
    return cliResultToOpenai(result, requestId);
}

/**
 * Build SSE chunks for a streaming tool call response.
 * When tools are present we buffer the full response, then emit chunks.
 */
export function buildToolCallChunks(toolCalls, textContent, requestId, model) {
    const chunks = [];
    const now = Math.floor(Date.now() / 1000);
    const normalizedModel = normalizeModelName(model);

    // First chunk: role + optional text content
    if (textContent) {
        chunks.push({
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: now,
            model: normalizedModel,
            choices: [{
                index: 0,
                delta: { role: "assistant", content: textContent },
                finish_reason: null,
            }],
        });
    }

    // Tool call chunks: send each tool call
    for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        chunks.push({
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: now,
            model: normalizedModel,
            choices: [{
                index: 0,
                delta: {
                    role: i === 0 && !textContent ? "assistant" : undefined,
                    tool_calls: [{
                        index: i,
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        },
                    }],
                },
                finish_reason: null,
            }],
        });
    }

    // Final chunk: finish_reason
    chunks.push({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: now,
        model: normalizedModel,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
        }],
    });

    return chunks;
}
//# sourceMappingURL=cli-to-openai.js.map