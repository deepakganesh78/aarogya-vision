import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import {
    addCard,
    BoardStoreError,
    loadBoard,
    moveCard,
} from "./board-store.mjs";

const canvasId = "aarogya-vision-feature-kanban";
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const instances = new Map();
const statuses = ["todo", "in_progress", "done"];
const inputSchema = {
    type: "object",
    properties: {
        workspacePath: {
            type: "string",
            minLength: 1,
            description: "Absolute path to the Aarogya-Vision workspace.",
        },
    },
    required: ["workspacePath"],
    additionalProperties: false,
};

function requireWorkspacePath(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || typeof input.workspacePath !== "string" || input.workspacePath.length === 0) {
        throw new CanvasError("INVALID_INPUT", "Provide the absolute workspacePath for the Aarogya-Vision workspace.");
    }
    if (!path.isAbsolute(input.workspacePath)) {
        throw new CanvasError("INVALID_INPUT", "workspacePath must be an absolute path.");
    }
    return input.workspacePath;
}

async function resolveWorkspaceRoot(input) {
    const workspacePath = requireWorkspacePath(input);
    try {
        const workspaceRoot = await realpath(workspacePath);
        const details = await stat(workspaceRoot);
        if (!details.isDirectory()) {
            throw new CanvasError("INVALID_INPUT", "workspacePath must refer to a directory.");
        }
        return workspaceRoot;
    } catch (error) {
        if (error instanceof CanvasError) {
            throw error;
        }
        throw new CanvasError("INVALID_INPUT", `Cannot open workspacePath: ${error.message}`);
    }
}

function toCanvasError(error, fallbackCode, fallbackMessage) {
    if (error instanceof CanvasError) {
        return error;
    }
    if (error instanceof BoardStoreError) {
        return new CanvasError(error.code, error.message);
    }
    return new CanvasError(fallbackCode, fallbackMessage);
}

function summarize(board) {
    const counts = { todo: 0, in_progress: 0, done: 0 };
    for (const card of board.cards) {
        counts[card.status] += 1;
    }
    return {
        updatedAt: board.updatedAt,
        counts,
        cards: board.cards,
    };
}

function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
    const contentType = request.headers["content-type"]?.split(";")[0].trim();
    if (contentType !== "application/json") {
        throw Object.assign(new Error("Content-Type must be application/json."), { statusCode: 415 });
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) {
            tooLarge = true;
        } else if (!tooLarge) {
            chunks.push(chunk);
        }
    }
    if (tooLarge) {
        throw Object.assign(new Error("Request body exceeds the 8 KB limit."), { statusCode: 413 });
    }

    let value;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw Object.assign(new Error("Request body must be a JSON object."), { statusCode: 400 });
    }
    return value;
}

function validateStatus(status) {
    if (!statuses.includes(status)) {
        throw Object.assign(new Error("Choose To do, In progress, or Done."), { statusCode: 400 });
    }
    return status;
}

function validateFields(value, allowed, required) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw Object.assign(new Error(`Unknown field: ${key}.`), { statusCode: 400 });
        }
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) {
            throw Object.assign(new Error(`Missing field: ${key}.`), { statusCode: 400 });
        }
    }
}

async function createRequestHandler(workspaceRoot) {
    const [page, stylesheet, clientScript] = await Promise.all([
        readFile(path.join(extensionDirectory, "page.html")),
        readFile(path.join(extensionDirectory, "board.css")),
        readFile(path.join(extensionDirectory, "board-client.js")),
    ]);

    return async (request, response) => {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        try {
            if (request.method === "GET" && pathname === "/") {
                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'",
                    "X-Content-Type-Options": "nosniff",
                });
                response.end(page);
                return;
            }
            if (request.method === "GET" && pathname === "/board.css") {
                response.writeHead(200, {
                    "Content-Type": "text/css; charset=utf-8",
                    "Cache-Control": "no-cache",
                    "X-Content-Type-Options": "nosniff",
                });
                response.end(stylesheet);
                return;
            }
            if (request.method === "GET" && pathname === "/board-client.js") {
                response.writeHead(200, {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Cache-Control": "no-cache",
                    "X-Content-Type-Options": "nosniff",
                });
                response.end(clientScript);
                return;
            }
            if (request.method === "GET" && pathname === "/api/board") {
                sendJson(response, 200, summarize(await loadBoard(workspaceRoot)));
                return;
            }
            if (request.method === "POST" && pathname === "/api/move-card") {
                const body = await readJsonBody(request);
                validateFields(body, ["cardId", "status"], ["cardId", "status"]);
                if (typeof body.cardId !== "string") {
                    throw Object.assign(new Error("cardId must be a string."), { statusCode: 400 });
                }
                const board = await moveCard(workspaceRoot, body.cardId, validateStatus(body.status));
                sendJson(response, 200, summarize(board));
                return;
            }
            if (request.method === "POST" && pathname === "/api/add-card") {
                const body = await readJsonBody(request);
                validateFields(body, ["title", "description", "status"], ["title", "description", "status"]);
                const board = await addCard(workspaceRoot, {
                    title: body.title,
                    description: body.description,
                    status: validateStatus(body.status),
                });
                sendJson(response, 201, summarize(board));
                return;
            }
            sendJson(response, 404, { error: "Not found." });
        } catch (error) {
            const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            sendJson(response, statusCode, { error: error.message || "Unable to update the feature board." });
        }
    };
}

async function startServer(workspaceRoot) {
    const handler = await createRequestHandler(workspaceRoot);
    const server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise((resolve) => server.close(resolve));
        throw new CanvasError("SERVER_START_FAILED", "Could not determine the feature board server address.");
    }
    return { server, url: `http://127.0.0.1:${address.port}/`, workspaceRoot };
}

async function stopServer(entry) {
    await new Promise((resolve, reject) => {
        entry.server.close((error) => error ? reject(error) : resolve());
        entry.server.closeAllConnections();
    });
}

async function boardForAction(input) {
    const workspaceRoot = await resolveWorkspaceRoot(input);
    try {
        return { workspaceRoot, board: await loadBoard(workspaceRoot) };
    } catch (error) {
        throw toCanvasError(error, "BOARD_LOAD_FAILED", "Unable to load the feature board.");
    }
}

await joinSession({
    canvases: [
        createCanvas({
            id: canvasId,
            displayName: "Aarogya-Vision Feature Board",
            description: "Track implemented, active, and planned Aarogya-Vision features in a persistent kanban board.",
            inputSchema,
            actions: [
                {
                    name: "get_board",
                    description: "Read the current Aarogya-Vision feature board and progress counts.",
                    inputSchema,
                    handler: async (context) => {
                        const { board } = await boardForAction(context.input);
                        return summarize(board);
                    },
                },
                {
                    name: "move_card",
                    description: "Move an existing feature card to To do, In progress, or Done.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspacePath: inputSchema.properties.workspacePath,
                            cardId: { type: "string", minLength: 1 },
                            status: { type: "string", enum: statuses },
                        },
                        required: ["workspacePath", "cardId", "status"],
                        additionalProperties: false,
                    },
                    handler: async (context) => {
                        const input = context.input;
                        const workspaceRoot = await resolveWorkspaceRoot(input);
                        try {
                            return summarize(await moveCard(workspaceRoot, input.cardId, input.status));
                        } catch (error) {
                            throw toCanvasError(error, "BOARD_UPDATE_FAILED", "Unable to move the feature card.");
                        }
                    },
                },
                {
                    name: "add_card",
                    description: "Add a feature or milestone to the Aarogya-Vision board.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspacePath: inputSchema.properties.workspacePath,
                            title: { type: "string", minLength: 1, maxLength: 100 },
                            description: { type: "string", minLength: 1, maxLength: 500 },
                            status: { type: "string", enum: statuses },
                        },
                        required: ["workspacePath", "title", "description", "status"],
                        additionalProperties: false,
                    },
                    handler: async (context) => {
                        const workspaceRoot = await resolveWorkspaceRoot(context.input);
                        try {
                            return summarize(await addCard(workspaceRoot, context.input));
                        } catch (error) {
                            throw toCanvasError(error, "BOARD_UPDATE_FAILED", "Unable to add the feature card.");
                        }
                    },
                },
            ],
            open: async (context) => {
                const workspaceRoot = await resolveWorkspaceRoot(context.input);
                try {
                    await loadBoard(workspaceRoot);
                } catch (error) {
                    throw toCanvasError(error, "BOARD_LOAD_FAILED", "Unable to load the feature board.");
                }

                const existing = instances.get(context.instanceId);
                if (existing?.workspaceRoot === workspaceRoot) {
                    return { title: "Aarogya-Vision Feature Board", url: existing.url };
                }
                if (existing) {
                    instances.delete(context.instanceId);
                    await stopServer(existing);
                }

                let entry;
                try {
                    entry = await startServer(workspaceRoot);
                } catch (error) {
                    throw toCanvasError(error, "SERVER_START_FAILED", "Unable to start the feature board server.");
                }
                instances.set(context.instanceId, entry);
                return { title: "Aarogya-Vision Feature Board", url: entry.url };
            },
            onClose: async (context) => {
                const entry = instances.get(context.instanceId);
                if (entry) {
                    instances.delete(context.instanceId);
                    await stopServer(entry);
                }
            },
        }),
    ],
});
