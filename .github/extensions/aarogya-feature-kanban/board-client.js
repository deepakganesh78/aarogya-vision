const STATUS_LABELS = {
    todo: "To do",
    in_progress: "In progress",
    done: "Done",
};

const LANES = [
    { status: "todo", title: "To do" },
    { status: "in_progress", title: "In progress" },
    { status: "done", title: "Done" },
];

const lanesElement = document.getElementById("lanes");
const countsElement = document.getElementById("counts");
const statusMessage = document.getElementById("status-message");

function announce(message, isError = false) {
    statusMessage.textContent = message;
    statusMessage.dataset.error = String(isError);
}

async function requestJson(url, options) {
    const response = await fetch(url, options);
    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error("The feature board returned an unreadable response.");
    }
    if (!response.ok) {
        throw new Error(body.error || "The feature board request failed.");
    }
    return body;
}

function makeSelect(card) {
    const select = document.createElement("select");
    select.name = "status";
    select.setAttribute("aria-label", `Move ${card.title} to a column`);
    for (const [value, label] of Object.entries(STATUS_LABELS)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === card.status;
        select.append(option);
    }
    return select;
}

function makeCard(card) {
    const article = document.createElement("article");
    article.className = "card";

    const title = document.createElement("h3");
    title.textContent = card.title;
    article.append(title);

    const description = document.createElement("p");
    description.className = "card-description";
    description.textContent = card.description;
    article.append(description);

    const source = document.createElement("p");
    source.className = "card-source";
    source.textContent = card.source;
    article.append(source);

    const form = document.createElement("form");
    form.className = "move-form";
    const select = makeSelect(card);
    const button = document.createElement("button");
    button.className = "button";
    button.type = "submit";
    button.textContent = "Move";
    form.append(select, button);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        announce(`Moving "${card.title}"...`);
        try {
            const board = await requestJson("/api/move-card", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cardId: card.id, status: select.value }),
            });
            renderBoard(board);
            announce(`Moved "${card.title}" to ${STATUS_LABELS[select.value]}.`);
        } catch (error) {
            announce(error.message, true);
            button.disabled = false;
        }
    });
    article.append(form);
    return article;
}

function renderBoard(board) {
    const counts = { todo: 0, in_progress: 0, done: 0 };
    for (const card of board.cards) {
        counts[card.status] += 1;
    }

    countsElement.replaceChildren();
    for (const lane of LANES) {
        const chip = document.createElement("div");
        chip.className = "count-chip";
        const number = document.createElement("strong");
        number.textContent = String(counts[lane.status]);
        const label = document.createElement("span");
        label.textContent = lane.title;
        chip.append(number, label);
        countsElement.append(chip);
    }

    lanesElement.replaceChildren();
    for (const laneInfo of LANES) {
        const lane = document.createElement("section");
        lane.className = "lane";
        lane.setAttribute("aria-labelledby", `lane-${laneInfo.status}`);

        const header = document.createElement("div");
        header.className = "lane-header";
        const heading = document.createElement("h2");
        heading.id = `lane-${laneInfo.status}`;
        heading.textContent = laneInfo.title;
        const count = document.createElement("span");
        count.className = "lane-count";
        count.textContent = String(counts[laneInfo.status]);
        count.setAttribute("aria-label", `${counts[laneInfo.status]} cards`);
        header.append(heading, count);
        lane.append(header);

        const cards = document.createElement("div");
        cards.className = "cards";
        const laneCards = board.cards.filter((card) => card.status === laneInfo.status);
        if (laneCards.length === 0) {
            const empty = document.createElement("p");
            empty.className = "empty-state";
            empty.textContent = "No features in this column.";
            cards.append(empty);
        } else {
            for (const card of laneCards) {
                cards.append(makeCard(card));
            }
        }
        lane.append(cards);
        lanesElement.append(lane);
    }
}

document.getElementById("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const input = {
        title: formData.get("title"),
        description: formData.get("description"),
        status: formData.get("status"),
    };
    submitButton.disabled = true;
    announce("Adding feature...");
    try {
        const board = await requestJson("/api/add-card", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        });
        renderBoard(board);
        form.reset();
        announce(`Added "${input.title}" to the board.`);
    } catch (error) {
        announce(error.message, true);
    } finally {
        submitButton.disabled = false;
    }
});

try {
    const board = await requestJson("/api/board");
    renderBoard(board);
    announce(`Progress loaded. Last updated ${new Date(board.updatedAt).toLocaleString()}.`);
} catch (error) {
    announce(error.message, true);
}
