/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, cliResultToOpenaiWithTools, buildToolCallChunks, createDoneChunk, } from "../adapter/cli-to-openai.js";
import { parseToolCalls } from "../adapter/tool-protocol.js";
/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Convert to CLI input format
        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();
        if (cliInput.hasTools) {
            // Tool-aware path: buffer response to detect tool calls
            await handleToolAwareResponse(req, res, subprocess, cliInput, requestId, stream);
        }
        else if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message,
                    type: "server_error",
                    code: null,
                },
            });
        }
    }
}
/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    // CRITICAL: Flush headers immediately to establish SSE connection
    // Without this, headers are buffered and client times out waiting
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    return new Promise((resolve, reject) => {
        let isFirst = true;
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        // Handle actual client disconnect (response stream closed)
        res.on("close", () => {
            if (!isComplete) {
                // Client disconnected before response completed - kill subprocess
                subprocess.kill();
            }
            resolve();
        });
        // Handle streaming content deltas
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) {
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{
                            index: 0,
                            delta: {
                                role: isFirst ? "assistant" : undefined,
                                content: text,
                            },
                            finish_reason: null,
                        }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
            }
        });
        // Handle final assistant message (for model name)
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });
        subprocess.on("result", (_result) => {
            isComplete = true;
            if (!res.writableEnded) {
                // Send final done chunk with finish_reason
                const doneChunk = createDoneChunk(requestId, lastModel);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            // Subprocess exited - ensure response is closed
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    // Abnormal exit without result - send error
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
                    })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        }).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
    });
}
/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId) {
    return new Promise((resolve) => {
        let finalResult = null;
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        // Start the subprocess
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        })
            .catch((error) => {
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
    });
}
/**
 * Handle tool-aware response (buffered)
 *
 * When tools are present in the request, we MUST buffer the entire response
 * before sending anything to the client. This is because we need to inspect
 * the full response for <tool_call> blocks to determine the correct
 * finish_reason ("tool_calls" vs "stop"). We can't retroactively change
 * finish_reason mid-stream.
 */
async function handleToolAwareResponse(req, res, subprocess, cliInput, requestId, stream) {
    return new Promise((resolve, reject) => {
        let bufferedText = "";
        let lastModel = "claude-sonnet-4";
        let finalResult = null;
        let isComplete = false;

        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete) {
                subprocess.kill();
            }
            resolve();
        });

        // Buffer all content deltas instead of streaming them
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text) {
                bufferedText += text;
            }
        });

        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });

        subprocess.on("result", (result) => {
            finalResult = result;
        });

        subprocess.on("error", (error) => {
            isComplete = true;
            console.error("[ToolAware] Error:", error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            }
            resolve();
        });

        subprocess.on("close", (code) => {
            isComplete = true;

            // Use the result text, falling back to buffered content deltas
            const responseText = finalResult?.result || bufferedText;

            if (!responseText && !res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
                resolve();
                return;
            }

            // Parse for tool calls
            const { toolCalls, textContent } = parseToolCalls(responseText);

            if (stream) {
                // Streaming mode with tools: send buffered chunks
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("X-Request-Id", requestId);
                res.flushHeaders();
                res.write(":ok\n\n");

                if (toolCalls.length > 0) {
                    // Send tool call chunks
                    const chunks = buildToolCallChunks(toolCalls, textContent, requestId, lastModel);
                    for (const chunk of chunks) {
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                } else {
                    // No tool calls — send as normal text chunks
                    const textChunk = {
                        id: `chatcmpl-${requestId}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: lastModel,
                        choices: [{
                            index: 0,
                            delta: { role: "assistant", content: responseText },
                            finish_reason: null,
                        }],
                    };
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
                    }
                    // Send done chunk
                    const doneChunk = createDoneChunk(requestId, lastModel);
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                    }
                }

                if (!res.writableEnded) {
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
            } else {
                // Non-streaming mode with tools
                if (finalResult) {
                    res.json(cliResultToOpenaiWithTools(finalResult, requestId));
                } else if (toolCalls.length > 0) {
                    // Build response from buffered text
                    res.json({
                        id: `chatcmpl-${requestId}`,
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: lastModel,
                        choices: [{
                            index: 0,
                            message: {
                                role: "assistant",
                                content: textContent,
                                tool_calls: toolCalls,
                            },
                            finish_reason: "tool_calls",
                        }],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    });
                } else {
                    res.json({
                        id: `chatcmpl-${requestId}`,
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: lastModel,
                        choices: [{
                            index: 0,
                            message: { role: "assistant", content: responseText },
                            finish_reason: "stop",
                        }],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    });
                }
            }

            resolve();
        });

        // Start the subprocess
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        }).catch((err) => {
            console.error("[ToolAware] Subprocess start error:", err);
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: err.message, type: "server_error", code: null },
                });
            }
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            {
                id: "claude-opus-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-sonnet-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-haiku-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
        ],
    });
}
/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
//# sourceMappingURL=routes.js.map