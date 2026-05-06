
/* To rest the browser cache to reset the tab state to locked run these commands in the browser console:
    localStorage.removeItem("scienceInTheNewsProgressV1");
    location.reload();
 */



const STORAGE_KEY = "scienceInTheNewsProgressV1";
const form = document.getElementById("lessonForm");
const tabButtons = [...document.querySelectorAll("[data-tab-button]")];
const tabPanels = [...document.querySelectorAll("[data-tab]")];
const statusBoxes = [...document.querySelectorAll("[data-status]")];
const resetTestingButton = document.getElementById("resetTestingProgress");

if (resetTestingButton) {
    resetTestingButton.addEventListener("click", () => {
        const confirmed = confirm(
            "Reset testing progress? This will clear saved lesson progress and reload the page."
        );

        if (!confirmed) return;

        localStorage.removeItem("scienceInTheNewsProgressV1");
        localStorage.removeItem("scienceInTheNewsVideoGate");
        localStorage.removeItem("scienceInTheNewsChatTimer");
        location.reload();
    });
}

let state = { activeTab: 0, unlockedTabs: [0], values: {} };
let genaiPlayer;
let videoProgressTimer;
let requiredWatchTimer;
let requiredWatchSeconds = 120;
let remainingWatchSeconds = requiredWatchSeconds;
let watchTimerStarted = false;

function saveState() {
    const values = {};
    [...form.elements].forEach(el => {
        if (!el.name) return;
        if (el.type === "checkbox") {
            if (!values[el.name]) values[el.name] = [];
            if (el.checked) values[el.name].push(el.value || "checked");
        } else if (el.type === "radio") {
            if (el.checked) values[el.name] = el.value;
            else if (!(el.name in values)) values[el.name] = "";
        } else {
            values[el.name] = el.value;
        }
    });
    state.values = values;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) state = saved;
    } catch (e) { }
    Object.entries(state.values || {}).forEach(([name, value]) => {
        const fields = [...form.elements].filter(el => el.name === name);
        fields.forEach(el => {
            if (el.type === "checkbox") el.checked = Array.isArray(value) && value.includes(el.value || "checked");
            else if (el.type === "radio") el.checked = el.value === value;
            else el.value = value;
        });
    });
}

function isFilled(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "radio") return !!form.querySelector(`[name="${CSS.escape(el.name)}"]:checked`);
    return String(el.value || "").trim().length > 0;
}

function groupComplete(panel, groupName) {
    const group = panel.querySelector(`[data-required-group="${CSS.escape(groupName)}"]`);
    if (!group) return true;

    const namedFields = [...group.querySelectorAll(`[name="${CSS.escape(groupName)}"]`)];

    // Radio or checkbox group where the input name matches the group name
    if (namedFields.length > 0) {
        const hasCheckable = namedFields.some(el => el.type === "radio" || el.type === "checkbox");

        if (hasCheckable) {
            return namedFields.some(el => el.checked);
        }

        return namedFields.every(isFilled);
    }

    // Wrapper group containing required selects, textareas, inputs, etc.
    const requiredFields = [...group.querySelectorAll("[data-required], [data-required-check]")];

    if (requiredFields.length > 0) {
        return requiredFields.every(isFilled);
    }

    // If a group has no required fields inside, don't block progress.
    return true;
}

function initializeSourceMatching() {
    const tokens = [...document.querySelectorAll(".drag-token")];
    const zones = [...document.querySelectorAll(".drop-zone")];
    const clearButton = document.getElementById("clearSourceMatches");

    if (!tokens.length || !zones.length) return;

    let selectedValue = null;

    function setFeedback(zone, value) {
        const feedback = zone.parentElement.querySelector(".match-feedback");
        const correctAnswer = zone.dataset.correct;

        zone.classList.remove("correct", "incorrect");
        feedback.classList.remove("correct", "incorrect");

        if (!value) {
            feedback.textContent = "";
            return;
        }

        if (value === correctAnswer) {
            zone.classList.add("correct");
            feedback.classList.add("correct");
            feedback.textContent = "Correct";
        } else {
            zone.classList.add("incorrect");
            feedback.classList.add("incorrect");
            feedback.textContent = "Try again";
        }
    }

    function updateZoneDisplay(zone, value) {
        const label = zone.querySelector(".drop-zone-text");
        const input = zone.querySelector('input[type="hidden"]');

        input.value = value || "";

        zone.classList.remove("filled");
        if (value) {
            label.textContent = value;
            zone.classList.add("filled");
        } else {
            label.textContent = "Drop type here";
        }

        setFeedback(zone, value);
    }

    function clearExistingValue(value) {
        zones.forEach(zone => {
            const input = zone.querySelector('input[type="hidden"]');
            if (input.value === value) {
                updateZoneDisplay(zone, "");
            }
        });
    }

    function assignValueToZone(zone, value) {
        if (!value) return;

        clearExistingValue(value);
        updateZoneDisplay(zone, value);

        saveState();
        updateUnlocks();
    }

    function clearSelectedToken() {
        tokens.forEach(token => token.classList.remove("selected"));
        selectedValue = null;
    }

    tokens.forEach(token => {
        token.addEventListener("dragstart", e => {
            selectedValue = token.dataset.value;
            e.dataTransfer.setData("text/plain", selectedValue);
        });

        token.addEventListener("click", () => {
            tokens.forEach(t => t.classList.remove("selected"));
            token.classList.add("selected");
            selectedValue = token.dataset.value;
        });
    });

    zones.forEach(zone => {
        zone.addEventListener("dragover", e => {
            e.preventDefault();
            zone.classList.add("over");
        });

        zone.addEventListener("dragleave", () => {
            zone.classList.remove("over");
        });

        zone.addEventListener("drop", e => {
            e.preventDefault();
            zone.classList.remove("over");
            const droppedValue = e.dataTransfer.getData("text/plain") || selectedValue;
            assignValueToZone(zone, droppedValue);
            clearSelectedToken();
        });

        zone.addEventListener("click", () => {
            if (selectedValue) {
                assignValueToZone(zone, selectedValue);
                clearSelectedToken();
            }
        });

        zone.addEventListener("keydown", e => {
            if ((e.key === "Enter" || e.key === " ") && selectedValue) {
                e.preventDefault();
                assignValueToZone(zone, selectedValue);
                clearSelectedToken();
            }

            if (e.key === "Backspace" || e.key === "Delete") {
                updateZoneDisplay(zone, "");
                saveState();
                updateUnlocks();
            }
        });
    });

    if (clearButton) {
        clearButton.addEventListener("click", () => {
            zones.forEach(zone => updateZoneDisplay(zone, ""));
            clearSelectedToken();
            saveState();
            updateUnlocks();
        });
    }

    // Restore saved values after loadState()
    zones.forEach(zone => {
        const input = zone.querySelector('input[type="hidden"]');
        updateZoneDisplay(zone, input.value);
    });
}

function tabComplete(index) {
    const panel = tabPanels[index];
    if (!panel) return false;

    const requiredGroups = [
        ...new Set(
            [...panel.querySelectorAll("[data-required-group]")]
                .map(el => el.dataset.requiredGroup)
        )
    ];

    const groupedRequiredFields = new Set();

    panel.querySelectorAll("[data-required-group]").forEach(group => {
        group.querySelectorAll("[data-required], [data-required-check]").forEach(field => {
            groupedRequiredFields.add(field);
        });
    });

    const directRequired = [...panel.querySelectorAll("[data-required]")]
        .filter(field => !groupedRequiredFields.has(field));

    const requiredChecks = [...panel.querySelectorAll("[data-required-check]")]
        .filter(field => !groupedRequiredFields.has(field));

    const allDirect = directRequired.every(isFilled);
    const allChecks = requiredChecks.every(isFilled);
    const allGroups = requiredGroups.every(name => groupComplete(panel, name));

    if (index === 2) {
        const rubricDone = [1, 2, 3, 4, 5].every(num =>
            !!form.querySelector(`[name="rubric${num}"]:checked`)
        );

        return allDirect && allChecks && allGroups && rubricDone;
    }

    return allDirect && allChecks && allGroups;
}

function initializeYouTubeVideoGate() {
    const videoInput = document.getElementById("watchedVideo");
    const timerInput = document.getElementById("videoTimerComplete");
    const videoStatus = document.getElementById("videoStatus");

    if (!videoInput || !timerInput || !videoStatus || !document.getElementById("genaiVideo")) return;

    if (videoInput.value === "complete") {
        videoStatus.textContent = "Video complete. You can continue.";
        videoStatus.classList.add("complete");
    }

    if (!window.YT) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(tag);
    }

    window.onYouTubeIframeAPIReady = function () {
        genaiPlayer = new YT.Player("genaiVideo", {
            videoId: "rwF-X5STYks",
            playerVars: {
                rel: 0,
                modestbranding: 1
            },
            events: {
                onStateChange: handleGenAIVideoStateChange
            }
        });
    };
}

function handleGenAIVideoStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        startVideoProgressCheck();
        startRequiredWatchTimer();
    } else {
        stopVideoProgressCheck();

        // This makes the 90-second timer count active play time only.
        // Remove this line if you want the timer to keep running after the student pauses.
        stopRequiredWatchTimer();
    }

    if (event.data === YT.PlayerState.ENDED) {
        markVideoProgressComplete();
    }
}

function startVideoProgressCheck() {
    stopVideoProgressCheck();

    videoProgressTimer = setInterval(() => {
        if (!genaiPlayer || typeof genaiPlayer.getDuration !== "function") return;

        const duration = genaiPlayer.getDuration();
        const currentTime = genaiPlayer.getCurrentTime();

        if (!duration || currentTime == null) return;

        const percentWatched = currentTime / duration;
        const videoStatus = document.getElementById("videoStatus");

        if (percentWatched >= 0.95) {
            markVideoProgressComplete();
            stopVideoProgressCheck();
        }
    }, 1000);
}

function stopVideoProgressCheck() {
    if (videoProgressTimer) {
        clearInterval(videoProgressTimer);
        videoProgressTimer = null;
    }
}

function startRequiredWatchTimer() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (timerInput?.value === "complete") return;
    if (watchTimerStarted) return;

    watchTimerStarted = true;

    requiredWatchTimer = setInterval(() => {
        remainingWatchSeconds--;

        const timerStatus = document.getElementById("videoTimerStatus");

        if (timerStatus) {
            timerStatus.textContent = `Keep watching: ${remainingWatchSeconds} seconds remaining.`;
        }

        if (remainingWatchSeconds <= 0) {
            markRequiredWatchTimerComplete();
            stopRequiredWatchTimer();
        }

        saveVideoGateProgress();
    }, 1000);
}

function stopRequiredWatchTimer() {
    if (requiredWatchTimer) {
        clearInterval(requiredWatchTimer);
        requiredWatchTimer = null;
    }

    watchTimerStarted = false;
}

function markVideoProgressComplete() {
    const videoInput = document.getElementById("watchedVideo");
    const videoStatus = document.getElementById("videoStatus");

    if (!videoInput || !videoStatus) return;

    videoInput.value = "complete";
    videoStatus.textContent = "Video progress complete.";
    videoStatus.classList.add("complete");

    saveState();
    updateUnlocks();
}

function markRequiredWatchTimerComplete() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (!timerInput) return;

    timerInput.value = "complete";

    saveVideoGateProgress();
    saveState();
    updateUnlocks();
}

function saveVideoGateProgress() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (!timerInput) return;

    const existing = JSON.parse(localStorage.getItem("scienceInTheNewsVideoGate") || "{}");

    localStorage.setItem("scienceInTheNewsVideoGate", JSON.stringify({
        ...existing,
        remainingWatchSeconds,
        timerComplete: timerInput.value === "complete"
    }));
}

function loadVideoGateProgress() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (!timerInput) return;

    try {
        const saved = JSON.parse(localStorage.getItem("scienceInTheNewsVideoGate") || "{}");

        if (typeof saved.remainingWatchSeconds === "number") {
            remainingWatchSeconds = Math.max(0, saved.remainingWatchSeconds);
        }

        if (saved.timerComplete || remainingWatchSeconds <= 0) {
            timerInput.value = "complete";
        }
    } catch (e) {
        remainingWatchSeconds = requiredWatchSeconds;
    }
}

let chatTimerInterval;
const requiredChatSeconds = 8 * 60;

function initializeChatConversationTimer() {
    const copyButton = document.getElementById("copyHowItWritesPrompt");
    const timerInput = document.getElementById("chatConversationDone");
    const timerStatus = document.getElementById("chatTimerStatus");

    if (!copyButton || !timerInput || !timerStatus) return;

    const saved = loadChatTimerProgress();

    if (timerInput.value === "complete" || saved.complete) {
        markChatTimerComplete();
        return;
    }

    if (saved.startedAt) {
        updateChatTimerFromStart(saved.startedAt);
    }

    copyButton.addEventListener("click", () => {
        startChatConversationTimer();
    });
}

function startChatConversationTimer() {
    const timerInput = document.getElementById("chatConversationDone");
    const timerStatus = document.getElementById("chatTimerStatus");

    if (!timerInput || !timerStatus) return;
    if (timerInput.value === "complete") return;

    const saved = loadChatTimerProgress();

    // Prevent restarting the timer every time the student clicks Copy prompt.
    if (saved.startedAt) {
        updateChatTimerFromStart(saved.startedAt);
        return;
    }

    const startedAt = Date.now();

    localStorage.setItem("scienceInTheNewsChatTimer", JSON.stringify({
        startedAt,
        complete: false
    }));

    timerStatus.textContent = "Conversation timer is running. Keep working with your chatbot.";

    runChatTimer(startedAt);
}

function loadChatTimerProgress() {
    try {
        return JSON.parse(localStorage.getItem("scienceInTheNewsChatTimer") || "{}");
    } catch (e) {
        return {};
    }
}

function updateChatTimerFromStart(startedAt) {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

    if (elapsedSeconds >= requiredChatSeconds) {
        markChatTimerComplete();
    } else {
        const timerStatus = document.getElementById("chatTimerStatus");

        if (timerStatus) {
            timerStatus.textContent = "Conversation timer is running. Keep working with your chatbot.";
        }

        runChatTimer(startedAt);
    }
}

function runChatTimer(startedAt) {
    clearInterval(chatTimerInterval);

    chatTimerInterval = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

        if (elapsedSeconds >= requiredChatSeconds) {
            clearInterval(chatTimerInterval);
            markChatTimerComplete();
        }
    }, 1000);
}

function markChatTimerComplete() {
    const timerInput = document.getElementById("chatConversationDone");
    const timerStatus = document.getElementById("chatTimerStatus");

    if (!timerInput || !timerStatus) return;

    timerInput.value = "complete";
    timerStatus.textContent = "Conversation timer complete. You can continue.";
    timerStatus.classList.add("complete");

    localStorage.setItem("scienceInTheNewsChatTimer", JSON.stringify({
        startedAt: null,
        complete: true
    }));

    saveState();
    updateUnlocks();
}

function updateUnlocks() {
    for (let i = 0; i < tabPanels.length - 1; i++) {
        if (tabComplete(i) && !state.unlockedTabs.includes(i + 1)) state.unlockedTabs.push(i + 1);
    }
    state.unlockedTabs = [...new Set(state.unlockedTabs)].sort((a, b) => a - b);
    tabButtons.forEach((button, i) => {
        const unlocked = state.unlockedTabs.includes(i);
        button.classList.toggle("locked", !unlocked);
        button.disabled = !unlocked;
    });
    statusBoxes.forEach(box => {
        const i = Number(box.dataset.status);
        const complete = tabComplete(i);
        box.classList.toggle("complete", complete);
        if (complete && i < 3) box.textContent = `Tab ${i + 1} complete. Tab ${i + 2} is unlocked.`;
        if (complete && i === 3) box.textContent = "Lesson complete. You can print or save your work as a PDF.";
    });
    saveState();
}

function showTab(index, shouldScroll = true) {
    if (!state.unlockedTabs.includes(index)) return;

    state.activeTab = index;

    tabButtons.forEach((b, i) => b.classList.toggle("active", i === index));
    tabPanels.forEach((p, i) => p.classList.toggle("active", i === index));

    saveState();

    if (shouldScroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
}

function updateRubricScore() {
    let total = 0;
    let answered = 0;
    for (let i = 1; i <= 5; i++) {
        const selected = form.querySelector(`[name="rubric${i}"]:checked`);
        if (selected) { total += Number(selected.value); answered++; }
    }
    document.getElementById("rubricScore").textContent = total;
    const overall = document.getElementById("rubricOverall");
    if (answered < 5) overall.textContent = "Not complete yet";
    else if (total >= 17) overall.textContent = "Nailed it";
    else if (total >= 13) overall.textContent = "Pretty Good";
    else if (total >= 9) overall.textContent = "Needs Improvement";
    else overall.textContent = "Not Credible";
}

tabButtons.forEach((button, i) => {
    button.addEventListener("click", () => showTab(i, true));
});

form.addEventListener("input", () => { updateRubricScore(); updateUnlocks(); });
form.addEventListener("change", () => { updateRubricScore(); updateUnlocks(); });

document.querySelectorAll("[data-copy]").forEach(button => {
    button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copy);
        try {
            await navigator.clipboard.writeText(target.textContent.trim());
            button.textContent = "Copied!";
            setTimeout(() => button.textContent = "Copy prompt", 1400);
        } catch (e) {
            alert("Copy did not work in this browser. Highlight the prompt and copy it manually.");
        }
    });
});

document.querySelectorAll("[data-toggle]").forEach(button => {
    button.addEventListener("click", () => {
        const panel = document.getElementById(button.dataset.toggle);
        const isOpen = panel.classList.toggle("open");
        button.setAttribute("aria-expanded", String(isOpen));
        if (button.dataset.toggle === "helpPanel") {
            const video = document.getElementById("howToVideo");
            if (video) isOpen ? video.play().catch(() => { }) : video.pause();
        }
    });
});

loadState();
initializeChatConversationTimer();
initializeSourceMatching();
initializeYouTubeVideoGate();
updateRubricScore();
updateUnlocks();
showTab(state.unlockedTabs.includes(state.activeTab) ? state.activeTab : 0, false);