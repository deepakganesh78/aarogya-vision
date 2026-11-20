import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBoard, moveCard, BoardStoreError } from "./board-store.mjs";

async function createRoots() {
    const root = await mkdtemp(path.join(os.tmpdir(), "aarogya-board-test-"));
    return {
        root,
        home: path.join(root, "copilot-home"),
        workspace: path.join(root, "workspace"),
        otherWorkspace: path.join(root, "other-workspace"),
    };
}

test("initializes a workspace board and persists card progress across reloads", async () => {
    const roots = await createRoots();
    try {
        const initial = await loadBoard(roots.workspace, roots.home);
        assert.equal(initial.cards.find((card) => card.id === "cloud-run-validation").status, "in_progress");

        await moveCard(roots.workspace, "cloud-run-validation", "done", roots.home);
        const reloaded = await loadBoard(roots.workspace, roots.home);
        assert.equal(reloaded.cards.find((card) => card.id === "cloud-run-validation").status, "done");
    } finally {
        await rm(roots.root, { recursive: true, force: true });
    }
});

test("keeps boards for separate workspaces isolated", async () => {
    const roots = await createRoots();
    try {
        const first = await loadBoard(roots.workspace, roots.home);
        const second = await loadBoard(roots.otherWorkspace, roots.home);
        assert.notEqual(first.workspaceRoot, second.workspaceRoot);

        await moveCard(roots.workspace, "cloud-run-validation", "done", roots.home);
        const otherReloaded = await loadBoard(roots.otherWorkspace, roots.home);
        assert.equal(otherReloaded.cards.find((card) => card.id === "cloud-run-validation").status, "in_progress");
    } finally {
        await rm(roots.root, { recursive: true, force: true });
    }
});

test("reports corrupt saved state without replacing it", async () => {
    const roots = await createRoots();
    try {
        const board = await loadBoard(roots.workspace, roots.home);
        const identity = await import("node:crypto").then(({ createHash }) =>
            createHash("sha256").update(roots.workspace).digest("hex"));
        const filePath = path.join(roots.home, "extension-data", "aarogya-vision-feature-kanban", `${identity}.json`);
        const invalid = "{broken";
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, invalid, "utf8");

        await assert.rejects(loadBoard(roots.workspace, roots.home), (error) =>
            error instanceof BoardStoreError && error.code === "BOARD_DATA_INVALID");
        assert.equal(await readFile(filePath, "utf8"), invalid);
        assert.ok(board.cards.length > 0);
    } finally {
        await rm(roots.root, { recursive: true, force: true });
    }
});
