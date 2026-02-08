/**
 * Tool Protocol - Prompt Injection for Tool Calling
 *
 * Since the Claude CLI --print mode doesn't expose tool_use blocks,
 * we implement tool calling by injecting tool definitions into the prompt
 * and parsing structured XML-tagged tool calls from the response.
 */
import { v4 as uuidv4 } from "uuid";

/**
 * Check if the request contains tool definitions
 */
export function hasTools(request) {
    return Array.isArray(request.tools) && request.tools.length > 0 &&
        request.tool_choice !== "none";
}

/**
 * Build tool instruction text to inject into the prompt.
 * Converts OpenAI tool definitions into a prompt section that instructs
 * Claude to use <tool_call> XML tags for tool invocations.
 */
export function buildToolInstructions(tools) {
    const toolDefs = tools.map((tool) => {
        const fn = tool.function;
        const params = fn.parameters
            ? JSON.stringify(fn.parameters, null, 2)
            : "{}";
        return `<tool>
<name>${fn.name}</name>
<description>${fn.description || ""}</description>
<parameters>${params}</parameters>
</tool>`;
    }).join("\n");

    return `<tools_available>
${toolDefs}
</tools_available>

<tool_call_instructions>
You have access to the tools listed above. When you need to use a tool, output a tool call using the following XML format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Rules:
- You may make multiple tool calls in a single response by using multiple <tool_call> blocks.
- The JSON inside <tool_call> must have "name" (string) and "arguments" (object) fields.
- Only call tools that are listed in <tools_available>.
- If you don't need to use any tool, respond normally without <tool_call> tags.
- When making a tool call, you may include brief text before the tool call(s) to explain your reasoning, but do not include text after the tool call(s).
</tool_call_instructions>`;
}

/**
 * Parse tool calls from Claude's response text.
 * Extracts <tool_call> XML blocks containing JSON.
 *
 * Returns { toolCalls, textContent } where:
 * - toolCalls: array of OpenAI-format tool calls (or empty)
 * - textContent: any text outside of tool_call blocks (or null if only tool calls)
 */
export function parseToolCalls(text) {
    const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    const toolCalls = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            toolCalls.push({
                id: parsed.id || `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
                type: "function",
                function: {
                    name: parsed.name,
                    arguments: typeof parsed.arguments === "string"
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments),
                },
            });
        } catch (e) {
            // Skip malformed tool calls
            console.error("[ToolProtocol] Failed to parse tool call JSON:", e.message);
        }
    }

    // Extract text content (everything outside <tool_call> blocks)
    const textContent = text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .trim() || null;

    return { toolCalls, textContent };
}

/**
 * Format tool result messages into XML blocks for the prompt.
 * Converts consecutive role:"tool" messages into a <tool_results> section.
 */
export function formatToolResults(toolMessages) {
    const results = toolMessages.map((msg) => {
        const content = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        return `<tool_result>
<tool_call_id>${msg.tool_call_id || "unknown"}</tool_call_id>
<output>${content}</output>
</tool_result>`;
    }).join("\n");

    return `<tool_results>\n${results}\n</tool_results>`;
}
