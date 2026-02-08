/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import { buildToolInstructions, formatToolResults, hasTools as checkHasTools } from "./tool-protocol.js";
const MODEL_MAP = {
    // Direct model names
    "claude-opus-4": "opus",
    "claude-opus-4-6": "opus",
    "claude-sonnet-4": "sonnet",
    "claude-sonnet-4-5": "sonnet",
    "claude-haiku-4": "haiku",
    // With provider prefix (claude-code-cli)
    "claude-code-cli/claude-opus-4": "opus",
    "claude-code-cli/claude-opus-4-6": "opus",
    "claude-code-cli/claude-sonnet-4": "sonnet",
    "claude-code-cli/claude-haiku-4": "haiku",
    // With provider prefix (openai)
    "openai/claude-opus-4": "opus",
    "openai/claude-opus-4-6": "opus",
    "openai/claude-sonnet-4": "sonnet",
    "openai/claude-sonnet-4-5": "sonnet",
    "openai/claude-haiku-4": "haiku",
    // Aliases
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",
};
/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model) {
    // Try direct lookup
    if (MODEL_MAP[model]) {
        return MODEL_MAP[model];
    }
    // Try stripping provider prefix
    const stripped = model.replace(/^(claude-code-cli|openai)\//, "");
    if (MODEL_MAP[stripped]) {
        return MODEL_MAP[stripped];
    }
    // Default to opus (Claude Max subscription)
    return "opus";
}
/**
 * Extract text from message content regardless of format.
 * Handles: plain string, array of content parts (OpenAI multi-part), or object.
 */
function extractText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    }
    if (content !== null && typeof content === "object") {
        return content.text || JSON.stringify(content);
    }
    return String(content);
}
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 *
 * When tools are provided, tool instructions are prepended and tool-related
 * messages (role: "tool", assistant with tool_calls) are formatted appropriately.
 */
export function messagesToPrompt(messages, tools) {
    const parts = [];

    // Prepend tool instructions if tools are provided
    if (tools && tools.length > 0) {
        parts.push(buildToolInstructions(tools));
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        switch (msg.role) {
            case "system": {
                const text = extractText(msg.content);
                parts.push(`<system>\n${text}\n</system>\n`);
                break;
            }
            case "user": {
                const text = extractText(msg.content);
                parts.push(text);
                break;
            }
            case "assistant": {
                // Check if this assistant message has tool_calls
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    // Reconstruct the assistant response with <tool_call> blocks
                    let assistantText = "";
                    if (msg.content) {
                        assistantText += extractText(msg.content) + "\n";
                    }
                    for (const tc of msg.tool_calls) {
                        assistantText += `<tool_call>\n${JSON.stringify({
                            id: tc.id,
                            name: tc.function.name,
                            arguments: JSON.parse(tc.function.arguments),
                        }, null, 2)}\n</tool_call>\n`;
                    }
                    parts.push(`<previous_response>\n${assistantText.trim()}\n</previous_response>\n`);
                } else {
                    const text = extractText(msg.content);
                    parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
                }
                break;
            }
            case "tool": {
                // Collect consecutive tool messages into a single <tool_results> block
                const toolMessages = [msg];
                while (i + 1 < messages.length && messages[i + 1].role === "tool") {
                    i++;
                    toolMessages.push(messages[i]);
                }
                parts.push(formatToolResults(toolMessages));
                break;
            }
        }
    }
    return parts.join("\n").trim();
}
/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request) {
    const tools = checkHasTools(request) ? request.tools : null;
    return {
        prompt: messagesToPrompt(request.messages, tools),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
        hasTools: !!tools,
    };
}
//# sourceMappingURL=openai-to-cli.js.map