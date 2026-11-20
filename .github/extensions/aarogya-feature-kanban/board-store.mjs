import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FORMAT = "aarogya-vision-feature-kanban";
const VERSION = 1;
const STATUS = new Set(["todo", "in_progress", "done"]);

export class BoardStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "BoardStoreError";
        this.code = code;
    }
}

function copilotHome() {
    return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

function boardFilePath(workspaceRoot, home = copilotHome()) {
    const identity = createHash("sha256").update(workspaceRoot).digest("hex");
    return path.join(home, "extension-data", FORMAT, `${identity}.json`);
}

function defaultCards() {
    return [
        {
            id: "worker-intake-offline-sync",
            title: "ASHA capture and offline sync",
            description: "Photo, voice, or text intake; consent and danger switch; encrypted offline queue with automatic sync.",
            status: "done",
            source: "KNOWLEDGE.md: locally verified, including end-to-end coverage.",
        },
        {
            id: "young-infant-triage",
            title: "Young-infant deterministic triage",
            description: "Shared 0-59 day danger-sign rules set the urgency floor; AI findings can raise but never lower urgency.",
            status: "done",
            source: "KNOWLEDGE.md: 21 synthetic safety cases, zero under-triage.",
        },
        {
            id: "gemini-intake-autofill",
            title: "Gemini intake and source-tagged autofill",
            description: "Structured multimodal intake, range-checked reported values, provenance tags, and failure routing to human review.",
            status: "done",
            source: "KNOWLEDGE.md: mock workflow and SDK request/response tests verified; live Gemini evaluation remains open.",
        },
        {
            id: "doctor-review-handoff",
            title: "Doctor review and worker reply",
            description: "List-detail review, source-labelled case summary, doctor decision, and translated reply with original text retained.",
            status: "done",
            source: "KNOWLEDGE.md: end-to-end mock flow verified.",
        },
        {
            id: "privacy-audit-analytics",
            title: "Privacy, audit, and de-identified analytics",
            description: "Consent enforcement, media minimisation, hashed audit events, retention policy, and de-identified analytics.",
            status: "done",
            source: "KNOWLEDGE.md: unit tests verified; real Google Cloud services are not yet verified.",
        },
        {
            id: "cloud-run-validation",
            title: "Cloud Run and Google Cloud validation",
            description: "Deploy in asia-south1 and validate Vertex AI, Firestore, Cloud Storage, secrets, and production configuration.",
            status: "in_progress",
            source: "KNOWLEDGE.md: deployment script is syntax-checked; real Cloud integration remains unverified.",
        },
        {
            id: "live-gemini-evaluation",
            title: "Live Gemini safety evaluation",
            description: "Run the 21-case evaluation against the live model and verify model availability and behavior.",
            status: "in_progress",
            source: "KNOWLEDGE.md: live evaluation with an API key is still open.",
        },
        {
            id: "submission-deck-evidence",
            title: "Submission deck evidence and citations",
            description: "Update screenshots and product story; add dated sources for headline statistics; export a PDF under 5 MB.",
            status: "in_progress",
            source: "KNOWLEDGE.md: listed as a pre-submission task.",
        },
        {
            id: "clinical-language-review",
            title: "Clinician sign-off and language review",
            description: "Obtain clinician sign-off on rules and guideline wording, plus native-speaker review of Hindi and Tamil.",
            status: "todo",
            source: "KNOWLEDGE.md: post-buildathon open item.",
        },
        {
            id: "offline-gemma",
            title: "On-device Gemma support",
            description: "Explore on-device transcription and field filling for genuinely offline AI assistance.",
            status: "todo",
            source: "KNOWLEDGE.md: roadmap.",
        },
        {
            id: "gemini-live-followups",
            title: "Gemini Live follow-up questions",
            description: "Add hands-free spoken follow-up questions for worker intake.",
            status: "todo",
            source: "KNOWLEDGE.md: roadmap.",
        },
        {
            id: "urgent-pubsub-alerts",
            title: "Urgent-case push alerts",
            description: "Add Pub/Sub-backed alerts for urgent cases after the core flow is validated.",
            status: "todo",
            source: "KNOWLEDGE.md: roadmap.",
        },
        {
            id: "fhir-abdm-integration",
            title: "FHIR R4 and ABDM integration",
            description: "Evaluate FHIR R4 records through Cloud Healthcare API as a future interoperability step.",
            status: "todo",
            source: "KNOWLEDGE.md: roadmap.",
        },
        {
            id: "pilot-expansion",
            title: "Languages, conditions, and pilot expansion",
            description: "Expand beyond the initial infant scenario and prepare a district pilot with a regulatory pathway.",
            status: "todo",
            source: "KNOWLEDGE.md: post-buildathon roadmap.",
        },
    ];
}

function validateBoard(board, workspaceRoot) {
    if (!board || typeof board !== "object"
        || board.format !== FORMAT
        || board.version !== VERSION
        || board.workspaceRoot !== workspaceRoot
        || typeof board.updatedAt !== "string"
        || Number.isNaN(Date.parse(board.updatedAt))
        || !Array.isArray(board.cards)
        || board.cards.length > 100) {
        throw new BoardStoreError("BOARD_DATA_INVALID", "Feature board data has an unsupported format or invalid shape; it was left unchanged.");
    }

    const ids = new Set();
    for (const card of board.cards) {
        if (!card || typeof card !== "object"
            || typeof card.id !== "string"
            || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.id)
            || ids.has(card.id)
            || typeof card.title !== "string"
            || card.title.length < 1
            || card.title.length > 100
            || typeof card.description !== "string"
            || card.description.length < 1
            || card.description.length > 500
            || typeof card.source !== "string"
            || card.source.length > 300
            || !STATUS.has(card.status)) {
            throw new BoardStoreError("BOARD_DATA_INVALID", "Feature board contains an invalid card; it was left unchanged.");
        }
        ids.add(card.id);
    }
    return board;
}

async function writeAtomic(filePath, board) {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${JSON.stringify(board, null, 2)}\n`, { flag: "wx" });
        await rename(temporaryPath, filePath);
    } catch (error) {
        let cleanupError;
        try {
            await unlink(temporaryPath);
        } catch (cleanup) {
            if (cleanup.code !== "ENOENT") {
                cleanupError = cleanup;
            }
        }
        const detail = cleanupError
            ? `${error.message}; temporary-file cleanup also failed: ${cleanupError.message}`
            : error.message;
        throw new BoardStoreError("BOARD_STORAGE_FAILED", `Unable to save feature board data: ${detail}`);
    }
}

export async function loadBoard(workspaceRoot, home = copilotHome()) {
    const filePath = boardFilePath(workspaceRoot, home);
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw new BoardStoreError("BOARD_STORAGE_FAILED", `Unable to read feature board data: ${error.message}`);
        }
        const initial = {
            format: FORMAT,
            version: VERSION,
            workspaceRoot,
            updatedAt: new Date().toISOString(),
            cards: defaultCards(),
        };
        validateBoard(initial, workspaceRoot);
        try {
            await mkdir(path.dirname(filePath), { recursive: true });
        } catch (mkdirError) {
            throw new BoardStoreError("BOARD_STORAGE_FAILED", `Unable to create feature board storage: ${mkdirError.message}`);
        }
        await writeAtomic(filePath, initial);
        return initial;
    }

    let board;
    try {
        board = JSON.parse(raw);
    } catch (error) {
        throw new BoardStoreError("BOARD_DATA_INVALID", `Feature board data is corrupt and was left unchanged: ${error.message}`);
    }
    return validateBoard(board, workspaceRoot);
}

async function saveBoard(workspaceRoot, board, home) {
    board.updatedAt = new Date().toISOString();
    validateBoard(board, workspaceRoot);
    const filePath = boardFilePath(workspaceRoot, home);
    try {
        await mkdir(path.dirname(filePath), { recursive: true });
    } catch (error) {
        throw new BoardStoreError("BOARD_STORAGE_FAILED", `Unable to create feature board storage: ${error.message}`);
    }
    await writeAtomic(filePath, board);
    return board;
}

export async function moveCard(workspaceRoot, cardId, status, home = copilotHome()) {
    if (typeof cardId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cardId) || !STATUS.has(status)) {
        throw new BoardStoreError("INVALID_INPUT", "Provide a valid cardId and status.");
    }
    const board = await loadBoard(workspaceRoot, home);
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) {
        throw new BoardStoreError("CARD_NOT_FOUND", `No feature card exists with id '${cardId}'.`);
    }
    card.status = status;
    return saveBoard(workspaceRoot, board, home);
}

export async function addCard(workspaceRoot, input, home = copilotHome()) {
    if (!input || typeof input !== "object"
        || typeof input.title !== "string"
        || input.title.trim().length < 1
        || input.title.length > 100
        || typeof input.description !== "string"
        || input.description.trim().length < 1
        || input.description.length > 500
        || !STATUS.has(input.status)) {
        throw new BoardStoreError("INVALID_INPUT", "A title, description, and valid status are required.");
    }
    const board = await loadBoard(workspaceRoot, home);
    if (board.cards.length >= 100) {
        throw new BoardStoreError("BOARD_LIMIT_REACHED", "The feature board can contain at most 100 cards.");
    }
    let id = input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60)
        .replace(/-$/g, "");
    if (!id) {
        id = "feature";
    }
    const baseId = id;
    let suffix = 2;
    while (board.cards.some((card) => card.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
    }
    board.cards.push({
        id,
        title: input.title.trim(),
        description: input.description.trim(),
        status: input.status,
        source: "Added from the feature board.",
    });
    return saveBoard(workspaceRoot, board, home);
}
