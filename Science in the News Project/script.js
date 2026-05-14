/*
    Science in the News - Main Script
    ------------------------------------------------------------
    Handles:
    - localStorage progress saving/restoring
    - tab locking/unlocking
    - required-field completion checks
    - Source Matching drag/drop activity
    - Sentence Builder feedback
    - chatbot-use follow-up visibility
    - YouTube video completion gate
    - rubric scoring
    - AI advantages/disadvantages sorting activity
    - copy prompt buttons
    - collapsible helper panels
    - testing reset button
*/

/* ============================================================
    Configuration
   ============================================================ */

const STORAGE_KEYS = {
    lesson: "scienceInTheNewsProgressV1",
    videoGate: "scienceInTheNewsVideoGate",
    prosConsSort: "scienceInTheNewsProsConsSort"
};

const VIDEO_CONFIG = {
    youtubeId: "rwF-X5STYks",
    requiredProgress: 0.99,       // Treats 99% as full completion to avoid API end-of-video edge cases.
    requiredWatchSeconds: 120     // Hidden active-play timer: 2 minutes.
};

/* ============================================================
    Cached DOM Elements
   ============================================================ */

const form = document.getElementById("lessonForm");
const tabButtons = [...document.querySelectorAll("[data-tab-button]")];
const tabPanels = [...document.querySelectorAll("[data-tab]")];
const statusBoxes = [...document.querySelectorAll("[data-status]")];
const resetTestingButton = document.getElementById("resetTestingProgress");

/* ============================================================
    Global State
   ============================================================ */

let state = {
    activeTab: 0,
    unlockedTabs: [0],
    values: {}
};

let genaiPlayer;
let videoProgressTimer;
let requiredWatchTimer;
let remainingWatchSeconds = VIDEO_CONFIG.requiredWatchSeconds;
let watchTimerStarted = false;

/* ============================================================
    Utility Helpers
   ============================================================ */

function safeJsonParse(value, fallback = {}) {
    try {
        return JSON.parse(value) || fallback;
    } catch (error) {
        return fallback;
    }
}

function getCheckedValue(name) {
    return form.querySelector(`[name="${CSS.escape(name)}"]:checked`)?.value || "";
}

function isFilled(element) {
    if (element.type === "checkbox") return element.checked;
    if (element.type === "radio") return Boolean(getCheckedValue(element.name));
    return String(element.value || "").trim().length > 0;
}

/* ============================================================
    Progress Saving and Loading
   ============================================================ */

function saveState() {
    if (!form) return;

    const values = {};

    [...form.elements].forEach(element => {
        if (!element.name) return;

        if (element.type === "checkbox") {
            if (!values[element.name]) values[element.name] = [];
            if (element.checked) values[element.name].push(element.value || "checked");
            return;
        }

        if (element.type === "radio") {
            if (element.checked) values[element.name] = element.value;
            else if (!(element.name in values)) values[element.name] = "";
            return;
        }

        values[element.name] = element.value;
    });

    state.values = values;
    localStorage.setItem(STORAGE_KEYS.lesson, JSON.stringify(state));
}

function loadState() {
    if (!form) return;

    const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.lesson), null);
    if (saved) state = saved;

    Object.entries(state.values || {}).forEach(([name, value]) => {
        const fields = [...form.elements].filter(element => element.name === name);

        fields.forEach(element => {
            if (element.type === "checkbox") {
                element.checked = Array.isArray(value) && value.includes(element.value || "checked");
            } else if (element.type === "radio") {
                element.checked = element.value === value;
            } else {
                element.value = value;
            }
        });
    });
}

function resetTestingProgress() {
    const confirmed = confirm(
        "Reset testing progress? This will clear saved lesson progress and reload the page."
    );

    if (!confirmed) return;

    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    location.reload();
}

/* ============================================================
    Testing Helper
    Run debugTabRequirements(0), debugTabRequirements(1), etc.
   ============================================================ */

function debugTabRequirements(tabIndex = state.activeTab) {
    const panel = tabPanels[tabIndex];

    if (!panel) {
        console.warn(`No tab panel found for tab index ${tabIndex}.`);
        return;
    }

    const incomplete = [];

    const requiredGroups = [
        ...new Set(
            [...panel.querySelectorAll("[data-required-group]")]
                .map(group => group.dataset.requiredGroup)
        )
    ];

    requiredGroups.forEach(groupName => {
        const group = panel.querySelector(`[data-required-group="${CSS.escape(groupName)}"]`);
        const namedFields = [...group.querySelectorAll(`[name="${CSS.escape(groupName)}"]`)];
        const requiredFields = [...group.querySelectorAll("[data-required], [data-required-check]")];

        let complete = true;

        if (namedFields.length > 0) {
            const hasCheckable = namedFields.some(field =>
                field.type === "radio" || field.type === "checkbox"
            );

            if (hasCheckable) {
                complete = namedFields.some(field => field.checked);
            } else {
                complete = namedFields.every(isFilled);
            }
        } else if (requiredFields.length > 0) {
            complete = requiredFields.every(isFilled);
        }

        if (!complete) {
            incomplete.push({
                type: "group",
                name: groupName,
                message: `Required group "${groupName}" is incomplete.`
            });
        }
    });

    const groupedRequiredFields = new Set();

    panel.querySelectorAll("[data-required-group]").forEach(group => {
        group.querySelectorAll("[data-required], [data-required-check]").forEach(field => {
            groupedRequiredFields.add(field);
        });
    });

    const directRequired = [
        ...panel.querySelectorAll("[data-required], [data-required-check]")
    ].filter(field => !groupedRequiredFields.has(field));

    directRequired.forEach(field => {
        if (!isFilled(field)) {
            incomplete.push({
                type: "field",
                name: field.name || field.id || "(unnamed field)",
                id: field.id || "",
                tag: field.tagName.toLowerCase(),
                message: `Required field "${field.name || field.id || "(unnamed field)"}" is incomplete.`
            });
        }
    });

    if (tabIndex === 2) {
        for (let i = 1; i <= 5; i++) {
            if (!form.querySelector(`[name="rubric${i}"]:checked`)) {
                incomplete.push({
                    type: "rubric",
                    name: `rubric${i}`,
                    message: `Rubric row ${i} is incomplete.`
                });
            }
        }
    }

    if (incomplete.length === 0) {
        console.log(`✅ Tab ${tabIndex + 1} is complete.`);
    } else {
        console.table(incomplete);
        console.warn(`❌ Tab ${tabIndex + 1} has ${incomplete.length} incomplete requirement(s).`);
    }

    return incomplete;
}

/* ============================================================
    Required Completion and Tab Locking
   ============================================================ */

function groupComplete(panel, groupName) {
    const group = panel.querySelector(`[data-required-group="${CSS.escape(groupName)}"]`);
    if (!group) return true;

    const namedFields = [...group.querySelectorAll(`[name="${CSS.escape(groupName)}"]`)];

    // Radio/checkbox groups where all choices share the group name.
    if (namedFields.length > 0) {
        const hasCheckable = namedFields.some(element =>
            element.type === "radio" || element.type === "checkbox"
        );

        if (hasCheckable) return namedFields.some(element => element.checked);
        return namedFields.every(isFilled);
    }

    // Wrapper groups that contain required fields with their own names.
    const requiredFields = [...group.querySelectorAll("[data-required], [data-required-check]")];
    if (requiredFields.length > 0) return requiredFields.every(isFilled);

    return true;
}

function tabComplete(index) {
    const panel = tabPanels[index];
    if (!panel) return false;

    const requiredGroups = [
        ...new Set(
            [...panel.querySelectorAll("[data-required-group]")]
                .map(group => group.dataset.requiredGroup)
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

    const directRequiredChecks = [...panel.querySelectorAll("[data-required-check]")]
        .filter(field => !groupedRequiredFields.has(field));

    const allDirectRequiredComplete = directRequired.every(isFilled);
    const allDirectChecksComplete = directRequiredChecks.every(isFilled);
    const allGroupsComplete = requiredGroups.every(groupName => groupComplete(panel, groupName));

    // Tab 3, index 2, includes the rubric, which is required but does not use data-required.
    if (index === 2) {
        const rubricComplete = [1, 2, 3, 4, 5].every(num =>
            Boolean(form.querySelector(`[name="rubric${num}"]:checked`))
        );

        return allDirectRequiredComplete && allDirectChecksComplete && allGroupsComplete && rubricComplete;
    }

    return allDirectRequiredComplete && allDirectChecksComplete && allGroupsComplete;
}

function updateUnlocks() {
    for (let i = 0; i < tabPanels.length - 1; i++) {
        if (tabComplete(i) && !state.unlockedTabs.includes(i + 1)) {
            state.unlockedTabs.push(i + 1);
        }
    }

    state.unlockedTabs = [...new Set(state.unlockedTabs)].sort((a, b) => a - b);

    tabButtons.forEach((button, index) => {
        const unlocked = state.unlockedTabs.includes(index);
        button.classList.toggle("locked", !unlocked);
        button.disabled = !unlocked;
    });

    statusBoxes.forEach(box => {
        const index = Number(box.dataset.status);
        const complete = tabComplete(index);
        const isLastTab = index === tabPanels.length - 1;

        box.classList.toggle("complete", complete);

        if (complete && !isLastTab) {
            box.textContent = `Tab ${index + 1} complete. Tab ${index + 2} is unlocked.`;
        }

        if (complete && isLastTab) {
            box.textContent = "Lesson complete. You can print or save your work as a PDF.";
        }
    });

    saveState();
}

function showTab(index, shouldScroll = true) {
    if (!state.unlockedTabs.includes(index)) return;

    state.activeTab = index;

    tabButtons.forEach((button, buttonIndex) => {
        button.classList.toggle("active", buttonIndex === index);
    });

    tabPanels.forEach((panel, panelIndex) => {
        panel.classList.toggle("active", panelIndex === index);
    });

    saveState();

    if (shouldScroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
}

/* ============================================================
    Source Matching Activity
   ============================================================ */

function initializeSourceMatching() {
    const tokens = [...document.querySelectorAll(".drag-token")];
    const zones = [...document.querySelectorAll(".drop-zone")];
    const clearButton = document.getElementById("clearSourceMatches");

    if (!tokens.length || !zones.length) return;

    let selectedValue = null;

    function setFeedback(zone, value) {
        const feedback = zone.parentElement.querySelector(".match-feedback");
        const correctAnswer = zone.dataset.correct;

        if (!feedback) return;

        zone.classList.remove("correct", "incorrect");
        feedback.classList.remove("correct", "incorrect");

        if (!value) {
            feedback.textContent = "";
            return;
        }

        const isCorrect = value === correctAnswer;
        zone.classList.add(isCorrect ? "correct" : "incorrect");
        feedback.classList.add(isCorrect ? "correct" : "incorrect");
        feedback.textContent = isCorrect ? "Correct" : "Try again";
    }

    function updateZoneDisplay(zone, value) {
        const label = zone.querySelector(".drop-zone-text");
        const input = zone.querySelector('input[type="hidden"]');

        if (!label || !input) return;

        input.value = value || "";
        label.textContent = value || "Drop type here";
        zone.classList.toggle("filled", Boolean(value));

        setFeedback(zone, value);
    }

    function clearExistingValue(value) {
        zones.forEach(zone => {
            const input = zone.querySelector('input[type="hidden"]');
            if (input?.value === value) updateZoneDisplay(zone, "");
        });
    }

    function clearSelectedToken() {
        tokens.forEach(token => token.classList.remove("selected"));
        selectedValue = null;
    }

    function assignValueToZone(zone, value) {
        if (!value) return;

        clearExistingValue(value);
        updateZoneDisplay(zone, value);
        clearSelectedToken();
        saveState();
        updateUnlocks();
    }

    tokens.forEach(token => {
        token.addEventListener("dragstart", event => {
            selectedValue = token.dataset.value;
            event.dataTransfer.setData("text/plain", selectedValue);
        });

        token.addEventListener("click", () => {
            tokens.forEach(item => item.classList.remove("selected"));
            token.classList.add("selected");
            selectedValue = token.dataset.value;
        });
    });

    zones.forEach(zone => {
        zone.addEventListener("dragover", event => {
            event.preventDefault();
            zone.classList.add("over");
        });

        zone.addEventListener("dragleave", () => zone.classList.remove("over"));

        zone.addEventListener("drop", event => {
            event.preventDefault();
            zone.classList.remove("over");
            assignValueToZone(zone, event.dataTransfer.getData("text/plain") || selectedValue);
        });

        zone.addEventListener("click", () => assignValueToZone(zone, selectedValue));

        zone.addEventListener("keydown", event => {
            if ((event.key === "Enter" || event.key === " ") && selectedValue) {
                event.preventDefault();
                assignValueToZone(zone, selectedValue);
            }

            if (event.key === "Backspace" || event.key === "Delete") {
                updateZoneDisplay(zone, "");
                saveState();
                updateUnlocks();
            }
        });
    });

    clearButton?.addEventListener("click", () => {
        zones.forEach(zone => updateZoneDisplay(zone, ""));
        clearSelectedToken();
        saveState();
        updateUnlocks();
    });

    // Restore saved hidden input values after loadState().
    zones.forEach(zone => {
        const input = zone.querySelector('input[type="hidden"]');
        updateZoneDisplay(zone, input?.value || "");
    });
}

/* ============================================================
    Sentence Builder Activity
   ============================================================ */

function initializeSentenceBuilderFeedback() {
    const checkButton = document.getElementById("checkSentenceBuilder");
    const selects = [...document.querySelectorAll(".sentence-builder .sentence-select")];

    if (!checkButton || !selects.length) return;

    function clearSentenceFeedback(select) {
        const sentence = select.closest(".sentence-item");
        const oldFeedback = sentence?.querySelector(".sentence-feedback");

        select.classList.remove("correct", "incorrect", "needs-answer");
        oldFeedback?.remove();
    }

    function addSentenceFeedback(select, type, message) {
        const sentence = select.closest(".sentence-item");
        if (!sentence) return;

        clearSentenceFeedback(select);
        select.classList.add(type);

        const feedback = document.createElement("span");
        feedback.className = `sentence-feedback ${type}`;
        feedback.textContent = message;
        sentence.appendChild(feedback);
    }

    checkButton.addEventListener("click", () => {
        selects.forEach(select => {
            const selectedOption = select.options[select.selectedIndex];

            if (!select.value) {
                addSentenceFeedback(select, "needs-answer", "Choose an answer before checking.");
                return;
            }

            if (selectedOption.dataset.correct === "true") {
                addSentenceFeedback(select, "correct", "Correct");
            } else {
                addSentenceFeedback(
                    select,
                    "incorrect",
                    selectedOption.dataset.feedback || "Try again. Review what this source type usually does."
                );
            }
        });

        saveState();
        updateUnlocks();
    });

    selects.forEach(select => {
        select.addEventListener("change", () => {
            clearSentenceFeedback(select);
            saveState();
            updateUnlocks();
        });
    });
}

/* ============================================================
    Chatbot Use Follow-Up Question
   ============================================================ */

function initializeChatbotUseFollowup() {
    const radios = [...document.querySelectorAll('input[name="chatbotUse"]')];
    const followup = document.getElementById("chatbotExperienceFollowup");
    const followupTextarea = document.getElementById("chatbotObservations");

    if (!radios.length || !followup || !followupTextarea) return;

    function updateFollowupVisibility() {
        const selected = document.querySelector('input[name="chatbotUse"]:checked');
        const shouldHide = selected && ["heard", "unknown"].includes(selected.value);

        followup.classList.toggle("is-hidden", shouldHide);

        if (shouldHide) {
            followupTextarea.value = "";
            followupTextarea.removeAttribute("data-required");
        } else {
            followupTextarea.setAttribute("data-required", "");
        }

        saveState();
        updateUnlocks();
    }

    radios.forEach(radio => radio.addEventListener("change", updateFollowupVisibility));
    updateFollowupVisibility();
}

/* ============================================================
    YouTube Video Gate
   ============================================================ */

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
            videoId: VIDEO_CONFIG.youtubeId,
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
        return;
    }

    stopVideoProgressCheck();
    stopRequiredWatchTimer(); // Hidden timer only counts active play time.

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

        if (currentTime / duration >= VIDEO_CONFIG.requiredProgress) {
            markVideoProgressComplete();
            stopVideoProgressCheck();
        }
    }, 1000);
}

function stopVideoProgressCheck() {
    if (!videoProgressTimer) return;
    clearInterval(videoProgressTimer);
    videoProgressTimer = null;
}

function startRequiredWatchTimer() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (timerInput?.value === "complete" || watchTimerStarted) return;

    watchTimerStarted = true;

    requiredWatchTimer = setInterval(() => {
        remainingWatchSeconds--;

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
    videoStatus.textContent = "Video complete. You can continue.";
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

    localStorage.setItem(STORAGE_KEYS.videoGate, JSON.stringify({
        remainingWatchSeconds,
        timerComplete: timerInput.value === "complete",
        requiredWatchSeconds: VIDEO_CONFIG.requiredWatchSeconds,
        requiredProgress: VIDEO_CONFIG.requiredProgress
    }));
}

function loadVideoGateProgress() {
    const timerInput = document.getElementById("videoTimerComplete");
    if (!timerInput) return;

    const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.videoGate), {});

    const configChanged =
        saved.requiredWatchSeconds !== undefined &&
        (
            saved.requiredWatchSeconds !== VIDEO_CONFIG.requiredWatchSeconds ||
            saved.requiredProgress !== VIDEO_CONFIG.requiredProgress
        );

    if (configChanged) {
        remainingWatchSeconds = VIDEO_CONFIG.requiredWatchSeconds;
        timerInput.value = "";
        localStorage.removeItem(STORAGE_KEYS.videoGate);
        return;
    }

    if (typeof saved.remainingWatchSeconds === "number") {
        remainingWatchSeconds = Math.max(0, saved.remainingWatchSeconds);
    }

    if (saved.timerComplete || remainingWatchSeconds <= 0) {
        timerInput.value = "complete";
    }
}

/* ============================================================
    Rubric Scoring
   ============================================================ */

function updateRubricScore() {
    const scoreOutput = document.getElementById("rubricScore");

    if (!scoreOutput) return;

    let total = 0;

    for (let i = 1; i <= 5; i++) {
        const selected = form.querySelector(`[name="rubric${i}"]:checked`);

        if (selected) {
            total += Number(selected.value);
        }
    }

    scoreOutput.textContent = total;
}

/* ============================================================
    AI Advantages / Disadvantages Sort Activity
   ============================================================ */

function initializeProsConsSort() {
    const activity = document.getElementById("aiProsConsActivity");
    if (!activity) return;

    const tokens = [...activity.querySelectorAll(".category-token")];
    const zones = [...activity.querySelectorAll(".category-drop-zone")];
    const completeInput = document.getElementById("aiProsConsComplete");
    const clearButton = document.getElementById("clearProsConsSort");

    let selectedTokenValue = null;

    function getSavedSort() {
        return safeJsonParse(localStorage.getItem(STORAGE_KEYS.prosConsSort), {});
    }

    function saveSort() {
        const sortState = {};

        zones.forEach(zone => {
            sortState[zone.dataset.category] = [...zone.querySelectorAll(".placed-category-token")]
                .map(item => ({
                    value: item.dataset.value,
                    correct: item.dataset.correct
                }));
        });

        localStorage.setItem(STORAGE_KEYS.prosConsSort, JSON.stringify(sortState));
    }

    function updateCompletion() {
        const placedCount = activity.querySelectorAll(".placed-category-token").length;
        if (completeInput) completeInput.value = placedCount === tokens.length ? "complete" : "";

        saveSort();
        saveState();
        updateUnlocks();
    }

    function updateEmptyText(zone) {
        const emptyText = zone.querySelector(".empty-category-text");
        const hasItems = zone.querySelectorAll(".placed-category-token").length > 0;
        if (emptyText) emptyText.style.display = hasItems ? "none" : "block";
    }

    function updateTokenVisibility() {
        const placedValues = [...activity.querySelectorAll(".placed-category-token")]
            .map(item => item.dataset.value);

        tokens.forEach(token => {
            token.classList.toggle("is-placed", placedValues.includes(token.dataset.value));
        });
    }

    function removePlacedToken(value) {
        activity.querySelectorAll(".placed-category-token").forEach(item => {
            if (item.dataset.value === value) item.remove();
        });
    }

    function createPlacedToken(value, correctCategory, droppedCategory) {
        const button = document.createElement("button");
        const isCorrect = correctCategory === droppedCategory;

        button.type = "button";
        button.className = `placed-category-token ${isCorrect ? "correct" : "incorrect"}`;
        button.draggable = true;
        button.dataset.value = value;
        button.dataset.correct = correctCategory;
        button.innerHTML = `
            <span>${value}</span>
            <span class="feedback">${isCorrect ? "Correct" : "Try again"}</span>
        `;

        button.addEventListener("dragstart", event => {
            selectedTokenValue = value;
            event.dataTransfer.setData("text/plain", value);
        });

        // Click an already placed item to return it to the word bank.
        button.addEventListener("click", () => {
            removePlacedToken(value);
            updateTokenVisibility();
            zones.forEach(updateEmptyText);
            updateCompletion();
        });

        return button;
    }

    function placeTokenInZone(value, zone) {
        if (!value || !zone) return;

        const originalToken = tokens.find(token => token.dataset.value === value);
        if (!originalToken) return;

        removePlacedToken(value);

        const placedToken = createPlacedToken(
            value,
            originalToken.dataset.correct,
            zone.dataset.category
        );

        zone.appendChild(placedToken);

        selectedTokenValue = null;
        tokens.forEach(token => token.classList.remove("selected"));

        updateTokenVisibility();
        zones.forEach(updateEmptyText);
        updateCompletion();
    }

    tokens.forEach(token => {
        token.addEventListener("dragstart", event => {
            selectedTokenValue = token.dataset.value;
            event.dataTransfer.setData("text/plain", selectedTokenValue);
        });

        token.addEventListener("click", () => {
            tokens.forEach(item => item.classList.remove("selected"));
            token.classList.add("selected");
            selectedTokenValue = token.dataset.value;
        });
    });

    zones.forEach(zone => {
        zone.addEventListener("dragover", event => {
            event.preventDefault();
            zone.classList.add("over");
        });

        zone.addEventListener("dragleave", () => zone.classList.remove("over"));

        zone.addEventListener("drop", event => {
            event.preventDefault();
            zone.classList.remove("over");
            placeTokenInZone(event.dataTransfer.getData("text/plain") || selectedTokenValue, zone);
        });

        zone.addEventListener("click", () => placeTokenInZone(selectedTokenValue, zone));

        zone.addEventListener("keydown", event => {
            if ((event.key === "Enter" || event.key === " ") && selectedTokenValue) {
                event.preventDefault();
                placeTokenInZone(selectedTokenValue, zone);
            }
        });
    });

    clearButton?.addEventListener("click", () => {
        activity.querySelectorAll(".placed-category-token").forEach(item => item.remove());
        tokens.forEach(token => token.classList.remove("selected", "is-placed"));
        selectedTokenValue = null;
        if (completeInput) completeInput.value = "";

        localStorage.removeItem(STORAGE_KEYS.prosConsSort);
        zones.forEach(updateEmptyText);
        saveState();
        updateUnlocks();
    });

    function restoreSavedSort() {
        const saved = getSavedSort();

        Object.entries(saved).forEach(([category, items]) => {
            const zone = zones.find(item => item.dataset.category === category);
            if (!zone || !Array.isArray(items)) return;

            items.forEach(item => placeTokenInZone(item.value, zone));
        });

        updateTokenVisibility();
        zones.forEach(updateEmptyText);
        updateCompletion();
    }

    restoreSavedSort();
}


/* ============================================================
    Multiple Choice / Multiple Select Answer Checks
   ============================================================ */

const CHECK_ANSWER_CONFIG = {
    summarySourceType: {
        correct: ["Tertiary"],
        correctFeedback: "Correct! Your summary is a tertiary source because it explains information for a general audience.",
        incorrectFeedback: "Try again. Think about which source type gives a broad explanation for readers."
    },
    credibilityTraits: {
        correct: ["Clear evidence", "Reliable sources", "Easy to understand"],
        correctFeedback: "Correct! These traits help readers trust a science summary.",
        incorrectFeedback: "Try again. Choose traits that build trust instead of opinions, vague claims, or unnecessary jargon."
    },
    aiDefinition: {
        correct: ["thinkingTasks"],
        correctFeedback: "Correct! AI systems perform tasks that usually require human thinking.",
        incorrectFeedback: "Try again. Look for the choice that focuses on tasks usually connected to human thinking."
    },
    genaiDefinition: {
        correct: ["creates"],
        correctFeedback: "Correct! Generative AI creates new content based on learned patterns.",
        incorrectFeedback: "Try again. Generative AI is known for creating new content."
    },
    promptFunction: {
        correct: ["guide"],
        correctFeedback: "Correct! Prompts are inputs that guide what the AI produces.",
        incorrectFeedback: "Try again. A prompt tells the AI what kind of output to create."
    },
    summaryTruths: {
        correct: ["may contain errors", "may omit details", "depends on prompt"],
        correctFeedback: "Correct! AI summaries can be useful, but they still need human checking.",
        incorrectFeedback: "Try again. Choose the statements that show AI summaries can help but are not automatically perfect."
    },
    noticedSummaries: {
        correct: ["sound correct", "simplify", "leave out details"],
        correctFeedback: "Correct! AI summaries can be helpful, but they still need review.",
        incorrectFeedback: "Try again. Avoid choices that say AI summaries are always accurate or should always be trusted."
    },
    feedbackChanged: {
        correct: ["clearer", "accurate", "directions"],
        correctFeedback: "Correct! Feedback can help AI revise toward your goals.",
        incorrectFeedback: "Try again. Select changes that usually happen when feedback gives clearer direction."
    },
    feedbackTells: {
        correct: ["clear instructions", "guided", "different results"],
        correctFeedback: "Correct! AI output changes based on the guidance you provide.",
        incorrectFeedback: "Try again. Focus on how human guidance affects AI responses."
    },
    studentRole: {
        correct: ["final decisions", "rethink", "check"],
        correctFeedback: "Correct! You should stay in charge, rethink ideas, and check accuracy.",
        incorrectFeedback: "Try again. Choose the options where the student stays responsible for the work."
    },
    aiToolStatement: {
        correct: ["helps thinking"],
        correctFeedback: "Correct! AI is a tool that can support your thinking and writing.",
        incorrectFeedback: "Try again. AI should support your learning, not replace your understanding."
    },
    strongUses: {
        correct: ["feedback", "explain", "revising"],
        correctFeedback: "Correct! These are strong ways to use AI while keeping your own thinking involved.",
        incorrectFeedback: "Try again. Choose uses that help you improve your own work instead of replacing your thinking."
    }
};

const CHECK_ANSWER_NO_KEY_FEEDBACK = "Answer saved. This question is based on your own work or experience, so there is no single correct answer to check.";

function initializeCheckAnswerButtons() {
    if (!form) return;

    const excludedNames = new Set(["openedChatbot"]);
    const groupedNames = [
        ...new Set(
            [...form.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
                .map(input => input.name)
                .filter(Boolean)
                .filter(name => !excludedNames.has(name))
                .filter(name => !name.startsWith("rubric"))
        )
    ];

    function getGroupInputs(name) {
        return [...form.querySelectorAll(`input[name="${CSS.escape(name)}"]`)]
            .filter(input => input.type === "radio" || input.type === "checkbox");
    }

    function getSelectedValues(inputs) {
        return inputs.filter(input => input.checked).map(input => input.value || "checked");
    }

    function arraysMatch(selectedValues, correctValues) {
        if (selectedValues.length !== correctValues.length) return false;

        const selected = [...selectedValues].sort();
        const correct = [...correctValues].sort();

        return selected.every((value, index) => value === correct[index]);
    }

    function clearGroupFeedback(fieldset) {
        fieldset.classList.remove("answer-correct", "answer-incorrect", "answer-needs-answer", "answer-neutral");
        fieldset.querySelector(".check-answer-feedback")?.remove();
    }

    function addGroupFeedback(fieldset, type, message) {
        clearGroupFeedback(fieldset);
        fieldset.classList.add(`answer-${type}`);

        const feedback = document.createElement("p");
        feedback.className = `check-answer-feedback ${type}`;
        feedback.setAttribute("role", "status");
        feedback.textContent = message;
        fieldset.appendChild(feedback);
    }

    groupedNames.forEach(name => {
        const inputs = getGroupInputs(name);
        if (inputs.length < 2) return;

        const fieldset = inputs[0].closest("fieldset");
        if (!fieldset || fieldset.querySelector(".check-answer-button")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button check-answer-button";
        button.textContent = "Check My Answer";
        button.dataset.checkAnswerGroup = name;

        button.addEventListener("click", () => {
            const selectedValues = getSelectedValues(inputs);
            const config = CHECK_ANSWER_CONFIG[name];

            if (selectedValues.length === 0) {
                addGroupFeedback(fieldset, "needs-answer", "Choose an answer before checking.");
                return;
            }

            if (!config) {
                addGroupFeedback(fieldset, "neutral", CHECK_ANSWER_NO_KEY_FEEDBACK);
                saveState();
                updateUnlocks();
                return;
            }

            const isCorrect = arraysMatch(selectedValues, config.correct);
            addGroupFeedback(
                fieldset,
                isCorrect ? "correct" : "incorrect",
                isCorrect ? config.correctFeedback : config.incorrectFeedback
            );

            saveState();
            updateUnlocks();
        });

        inputs.forEach(input => {
            input.addEventListener("change", () => clearGroupFeedback(fieldset));
        });

        fieldset.appendChild(button);
    });
}

/* ============================================================
    Generic UI Handlers
   ============================================================ */

function initializeTabs() {
    tabButtons.forEach((button, index) => {
        button.addEventListener("click", () => showTab(index, true));
    });
}

function initializeFormListeners() {
    if (!form) return;

    form.addEventListener("input", () => {
        updateRubricScore();
        updateUnlocks();
    });

    form.addEventListener("change", () => {
        updateRubricScore();
        updateUnlocks();
    });
}

function initializeCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach(button => {
        button.addEventListener("click", async () => {
            const target = document.getElementById(button.dataset.copy);
            if (!target) return;

            try {
                await navigator.clipboard.writeText(target.textContent.trim());
                const originalText = button.textContent;
                button.textContent = "Copied!";
                setTimeout(() => {
                    button.textContent = originalText;
                }, 1400);
            } catch (error) {
                alert("Copy did not work in this browser. Highlight the prompt and copy it manually.");
            }
        });
    });
}

function initializeTogglePanels() {
    document.querySelectorAll("[data-toggle]").forEach(button => {
        button.addEventListener("click", () => {
            const panel = document.getElementById(button.dataset.toggle);
            if (!panel) return;

            const isOpen = panel.classList.toggle("open");
            button.setAttribute("aria-expanded", String(isOpen));

            if (button.dataset.toggle === "helpPanel") {
                const video = document.getElementById("howToVideo");
                if (!video) return;

                if (isOpen) video.play().catch(() => { });
                else video.pause();
            }
        });
    });
}

function initializeTestingReset() {
    resetTestingButton?.addEventListener("click", resetTestingProgress);
}

function initializeSummaryComparisonAutofill() {
    const studentSummarySource = document.getElementById("studentSummary");
    const aiSummarySource = document.getElementById("aiSummaryDraft");

    const studentSummaryComparison = document.getElementById("studentSummaryComparison");
    const aiSummaryComparison = document.getElementById("aiSummaryComparison");

    if (
        !studentSummarySource ||
        !aiSummarySource ||
        !studentSummaryComparison ||
        !aiSummaryComparison
    ) {
        return;
    }

    function syncSummaryComparisonFields() {
        studentSummaryComparison.value = studentSummarySource.value;
        aiSummaryComparison.value = aiSummarySource.value;

        saveState();
        updateUnlocks();
    }

    studentSummarySource.addEventListener("input", syncSummaryComparisonFields);
    aiSummarySource.addEventListener("input", syncSummaryComparisonFields);

    syncSummaryComparisonFields();
}

function initializeOriginalSummaryAutofill() {
    const source = document.getElementById("studentSummary");
    const destination = document.getElementById("originalSummaryForRevision");

    if (!source || !destination) return;

    function syncOriginalSummary() {
        destination.value = source.value;
        saveState();
        updateUnlocks();
    }

    source.addEventListener("input", syncOriginalSummary);
    syncOriginalSummary();
}

/* ============================================================
    Startup
   ============================================================ */

function initializeLesson() {
    loadState();
    loadVideoGateProgress();

    initializeTestingReset();
    initializeTabs();
    initializeFormListeners();
    initializeCopyButtons();
    initializeTogglePanels();

    initializeChatbotUseFollowup();
    initializeSentenceBuilderFeedback();
    initializeCheckAnswerButtons();
    initializeSourceMatching();
    initializeProsConsSort();
    initializeSummaryComparisonAutofill();
    initializeOriginalSummaryAutofill();
    initializeYouTubeVideoGate();

    updateRubricScore();
    updateUnlocks();
    showTab(state.unlockedTabs.includes(state.activeTab) ? state.activeTab : 0, false);
}

initializeLesson();