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
    const checkButton = document.getElementById("checkSourceMatches");
    const feedback = document.getElementById("sourceMatchingFeedback");

    if (!tokens.length || !zones.length) return;

    let selectedValue = null;

    function clearSourceMatchingFeedback() {
        zones.forEach(zone => {
            zone.classList.remove("correct", "incorrect", "needs-answer");
        });

        if (feedback) {
            feedback.textContent = "";
            feedback.className = "source-matching-feedback";
        }
    }

    function setSourceMatchingFeedback(type, message) {
        if (!feedback) return;

        feedback.className = `source-matching-feedback ${type}`;
        feedback.textContent = message;
    }

    function updateZoneDisplay(zone, value) {
        const label = zone.querySelector(".drop-zone-text");
        const input = zone.querySelector('input[type="hidden"]');

        if (!label || !input) return;

        input.value = value || "";
        label.textContent = value || "Drop type here";
        zone.classList.toggle("filled", Boolean(value));

        clearSourceMatchingFeedback();
        updateSourceTokenVisibility();
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

    function updateSourceTokenVisibility() {
        const placedValues = zones
            .map(zone => zone.querySelector('input[type="hidden"]')?.value)
            .filter(Boolean);

        tokens.forEach(token => {
            token.classList.toggle("is-placed", placedValues.includes(token.dataset.value));
        });
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

    checkButton?.addEventListener("click", () => {
        let unansweredCount = 0;
        let correctCount = 0;

        zones.forEach(zone => {
            const input = zone.querySelector('input[type="hidden"]');
            const value = input?.value || "";

            zone.classList.remove("correct", "incorrect", "needs-answer");

            if (!value) {
                unansweredCount += 1;
                zone.classList.add("needs-answer");
                return;
            }

            if (value === zone.dataset.correct) {
                correctCount += 1;
                zone.classList.add("correct");
            } else {
                zone.classList.add("incorrect");
            }
        });

        if (unansweredCount > 0) {
            setSourceMatchingFeedback(
                "needs-answer",
                `Match every source before checking. ${unansweredCount} ${unansweredCount === 1 ? "source still needs" : "sources still need"} an answer.`
            );
        } else if (correctCount === zones.length) {
            setSourceMatchingFeedback(
                "correct",
                "Nice work! You correctly matched each type of source. The original research article is a primary source, the news article is a secondary source because it explains that research, and your summary acts as a tertiary source by simplifying and organizing the information."
            );
        } else {
            setSourceMatchingFeedback(
                "incorrect",
                "It might help to review all three source types again. Reread the primary, secondary, and tertiary sources definitions. Think about how each one builds on the other and try again."
            );
        }

        saveState();
        updateUnlocks();
    });

    clearButton?.addEventListener("click", () => {
        zones.forEach(zone => updateZoneDisplay(zone, ""));
        clearSelectedToken();
        clearSourceMatchingFeedback();
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
    const feedback = document.getElementById("sentenceBuilderFeedback");
    const selects = [...document.querySelectorAll(".sentence-builder .sentence-select")];

    if (!checkButton || !feedback || !selects.length) return;

    function clearSentenceFeedback() {
        selects.forEach(select => {
            select.classList.remove("correct", "incorrect", "needs-answer");
        });

        feedback.textContent = "";
        feedback.className = "sentence-feedback";
    }

    function setSentenceFeedback(type, message) {
        feedback.className = `sentence-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const corrections = [];
        let unansweredCount = 0;
        let correctCount = 0;

        selects.forEach((select, index) => {
            const selectedOption = select.options[select.selectedIndex];
            select.classList.remove("correct", "incorrect", "needs-answer");

            if (!select.value) {
                unansweredCount += 1;
                select.classList.add("needs-answer");
                return;
            }

            if (selectedOption.dataset.correct === "true") {
                correctCount += 1;
                select.classList.add("correct");
            } else {
                select.classList.add("incorrect");
                corrections.push(
                    `${index + 1}. ${selectedOption.dataset.feedback || "Review what this source type usually does."}`
                );
            }
        });

        if (unansweredCount > 0) {
            setSentenceFeedback(
                "needs-answer",
                `Choose an answer for every sentence before checking. ${unansweredCount} ${unansweredCount === 1 ? "sentence still needs" : "sentences still need"} an answer.`
            );
        } else if (correctCount === selects.length) {
            setSentenceFeedback(
                "correct",
                "Nice work! You correctly identified how each type of scientific source is used. Tertiary sources help build background knowledge, primary sources present original research, and secondary sources analyze and interpret that research. This understanding will help you choose the right sources when reading and writing about science."
            );
        } else {
            setSentenceFeedback(
                "incorrect",
                "It might help to review all three source types again. Reread the primary, secondary, and tertiary sources definitions. Focus on their purpose: presenting original research, analyzing research, or providing background information. Then try again."
            );
        }

        saveState();
        updateUnlocks();
    });

    selects.forEach(select => {
        select.addEventListener("change", () => {
            clearSentenceFeedback();
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

function getRubricOverallRatingFromScore() {
    const score = Number(document.getElementById("rubricScore")?.textContent || 0);

    if (score >= 13 && score <= 15) return "nailed it";
    if (score >= 10 && score <= 12) return "pretty good";
    if (score >= 6 && score <= 9) return "needs improvement";
    return "not credible";
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
        correctFeedback: "Correct. Your summary is a tertiary source because it simplifies and organizes information from another source for a general audience.",
        feedbackByAnswer: {
            Primary: "Not quite. A primary source presents original research or firsthand data. Your summary is not the original research.",
            Secondary: "Not quite. A secondary source explains or interprets primary research. The news article is secondary, but your summary is one step further removed.",
            Tertiary: "Correct. Your summary is a tertiary source because it simplifies and organizes information from another source for a general audience."
        },
        incorrectFeedback: "Try again."
    },
    credibilityTraits: {
        correct: ["Clear evidence", "Reliable sources", "Easy to understand"],
        correctFeedback: "Nice work. Credibility comes from clear evidence, reliable sources, and writing that is easy to understand. This is your goal. Now, can AI do this?",
        missingFeedback: {
            "Clear evidence": "Your summary needs specific, accurate details from the research.",
            "Reliable sources": "Credibility depends on where the information comes from.",
            "Easy to understand": "A credible summary should be accessible."
        },
        addedFeedback: {
            "Personal opinions": "Personal opinions reduce credibility.",
            "Scientific jargon": "Too much jargon can confuse readers.",
            "Vague statements": "Statements that are generalized can create misconceptions.",
            "Confident tone": "Confidence doesn't mean the content is accurate."
        },
        incorrectFeedback: "Please try again."
    },
    aiDefinition: {
        correct: ["thinkingTasks"],
        correctFeedback: "You got it. AI refers to computer systems that can do tasks that typically require human thinking, such as analyzing information, recognizing patterns, making predictions, and solving problems.",
        feedbackByAnswer: {
            storage: "Please try again. This is close to something computers can do, but AI does more than collect or store data. It processes and analyzes information.",
            website: "Please try again. A website or search engine can help people find information, and some websites may use AI. However, AI goes beyond searching.",
            machine: "Please try again. This sounds more like a robot or a machine. Some robots use AI, but AI does not have to be a physical device. AI can also exist as software inside a computer, phone, app, or website.",
            thinkingTasks: "You got it. AI refers to computer systems that can do tasks that typically require human thinking, such as analyzing information, recognizing patterns, making predictions, and solving problems."
        },
        incorrectFeedback: "Try again."
    },
    genaiDefinition: {
        correct: ["creates"],
        correctFeedback: "You got it. Generative AI is trained on large amounts of data to create new content. It can write paragraphs and even draw pictures, given what it learns.",
        feedbackByAnswer: {
            creates: "You got it. Generative AI is trained on large amounts of data to create new content. It can write paragraphs and even draw pictures, given what it learns.",
            stores: "Please try again. Some technology stores and retrieves information, but generative AI creates something new using patterns learned from data.",
            steps: "Please try again. This describes a more traditional computer program. Generative AI learns by example. It does not follow only basic automation or fixed instructions.",
            typed: "Please try again. Generative AI can repeat past answers and generate new responses based on patterns in the data it was trained on."
        },
        incorrectFeedback: "Try again. Generative AI is known for creating new content."
    },
    promptFunction: {
        correct: ["guide"],
        correctFeedback: "You got it. Prompts are user inputs that tell the AI what to generate. They can be questions, statements, or instructions. ",
        feedbackByAnswer: {
            faster: "Please try again. Prompts do not influence system speed. The speed at which the system runs is determined by factors such as its memory and storage capacity. ",
            guide: "You got it. Prompts are user inputs that tell the AI what to generate. They can be questions, statements, or instructions. ",
            errors: "Please try again. Prompts are not used to fix errors. System errors are generally monitored, analyzed, and corrected by humans. ",
            vocab: "Please try again. Prompts cannot limit vocabulary; they initiate the generation process. Therefore, as new datasets are added, the system’s vocabulary is expected to grow."
        },
        incorrectFeedback: "Try again. A prompt tells the AI what kind of output to create."
    },
    summaryTruths: {
        correct: ["may contain errors", "may omit details", "depends on prompt"],
        correctFeedback: "Correct! AI summaries can be useful, but they still need human checking.",
        incorrectFeedback: "Try again. Choose the statements that show AI summaries can help but are not automatically perfect."
    },
    noticedSummaries: {
        correct: ["clearInstructions", "guideIt", "samePrompt"],
        correctFeedback: "Nice work. Think about how your feedback changed the AI’s response and what that reveals about how it works. AI can misinterpret feedback or apply it incorrectly, especially if the request is unclear.",
        missingFeedback: {
            clearInstructions: "Consider what happened when you gave more specific feedback. Did the response change? What does that suggest?",
            guideIt: "Think about your role in the interaction. Did the AI change based on what you said or asked?",
            samePrompt: "Think about whether the AI always gives the exact same response. What did you notice?"
        },
        addedFeedback: {
            appliesFeedback: "AI does not always understand and correctly apply all feedback.",
            improveResponses: "AI still needs human input to refine and improve responses."
        },
        incorrectFeedback: "Please try again."
    },
    feedbackChanged: {
        correct: ["decision", "feedback", "accurate"],
        correctFeedback: "Nice work. Think about how you stayed in control of your writing while using AI to support your thinking.",
        missingFeedback: {
            decision: "Reflect on who is responsible for the final version of your summary. Who decides what stays or changes?",
            feedback: "Consider how the AI helped you reflect. Did it change how you thought about your writing?",
            accurate: "Think about reliability. Did you need to verify what the AI suggested?"
        },
        addedFeedback: {
            copy: "Think about your role. Are you using AI to think, or letting it think for you?"
        },
        incorrectFeedback: "Please try again."
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
        correctFeedback: "Nice work. Think about how AI supported your thinking and helped you improve your work, rather than replacing it.",
        missingFeedback: {
            feedback: "Consider how AI can help you reflect on and strengthen your thinking. Did you use it that way?",
            explain: "How can AI help when something doesn’t make sense? Think about how you can use it to clarify ideas.",
            revising: "Reflect on how feedback can help improve your writing. Did you use AI to guide revisions?"
        },
        addedFeedback: {
            copying: "Think about your role as the writer. Are you using AI as a tool, or letting it do the work for you?",
            "replace thinking": "Consider what happens when you rely on AI instead of thinking through ideas yourself."
        },
        incorrectFeedback: "Please try again."
    },
    aiSummaryOverallRating: {
        dynamicCorrect: getRubricOverallRatingFromScore,
        correctFeedback: "You're right!",
        incorrectFeedback: "The total score doesn't fit in that range. Please try again."
    },
    sentenceWeakness: {
        anySelectionIsCorrect: true,
        correctFeedback: "Thank you for sharing.",
        incorrectFeedback: "Even if it's really strong, if you had to pick a category to work on, what would it be?"
    },
    summaryDirection: {
        anySelectionIsCorrect: true,
        correctFeedback: "Thank you for sharing.",
        incorrectFeedback: "Please share at least one of your observations."
    },

    aiToolStatement: {
        correct: ["helps thinking"],
        correctFeedback: "Nice work. AI is most powerful when it supports your thinking, helps you revise ideas, and strengthens your understanding.",
        feedbackByAnswer: {
            "helps thinking": "Nice work. AI is most powerful when it supports your thinking, helps you revise ideas, and strengthens your understanding.",
            "replaces understanding": " Think about whether understanding the topic still matters when using AI.",
            "does hard work": "Think about your role when using AI. Should you still review and evaluate the results?",
            "always accurate": "Reflect on what you learned about AI summaries. Are they always fully accurate?"
        },
        incorrectFeedback: "Try again. AI should support your learning, not replace your understanding."
    },
    scienceNewsEvaluation: {
        correct: ["original source"],
        correctFeedback: "Correct. Checking the original scientific source helps to verify the claims and understand the original context of the information shared. It is important in ensuring accuracy, preventing the spread of misinformation, and identifying any bias.",
        feedbackByAnswer: {
            headline: "Please try again. News article headlines can be misleading and used as clickbait, to promote financial gain, increase user engagement, push a specific narrative, or meet the pressures of the 24-hour news cycle.",
            "original source": "Correct. Checking the original scientific source helps to verify the claims and understand the original context of the information shared. It is important in ensuring accuracy, preventing the spread of misinformation, and identifying any bias.",
            "sounds interesting": "Please try again. Prioritizing emotional engagement with a news article over the facts is harmful. It can lead to misinformation, cognitive bias, and engagement in misleading arguments.",
            likes: "Please try again. Popularity on the internet is not proof that information is reliable because posts can spread quickly even when they contain mistakes, exaggerations, or false claims."
        },
        incorrectFeedback: "Please try again."
    },
    aiSummaryReadingApproach: {
        correct: ["question claims"],
        correctFeedback: "Nice work. This is a strong approach. You are engaging with the content while staying alert. Questioning claims and verifying details helps you avoid accepting false or incomplete information.",
        missingFeedback: {
            "question claims": "Questioning claims and checking key information is the strongest approach because it helps you avoid accepting false or incomplete information."
        },
        addedFeedback: {
            "sounds clear": "Clear writing can be misleading. AI-generated content is often polished, even when it contains errors or made-up information. Clarity alone is not a reliable signal of accuracy. Try again.",
            "ignore without sources": "Sources are helpful, but their presence alone does not guarantee accuracy. Some AI-generated content includes incorrect or fabricated references, so it is better to evaluate both the content and the sources. Try again."
        },
        incorrectFeedback: ""
    }
};

const CHECK_ANSWER_NO_KEY_FEEDBACK = "Good to know!";

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

        const feedback = document.createElement("span");
        feedback.className = `check-answer-feedback ${type}`;
        feedback.setAttribute("role", "status");
        feedback.textContent = message;

        const button = fieldset.querySelector(".check-answer-button");

        if (button) {
            let row = fieldset.querySelector(".check-answer-row");

            if (!row) {
                row = document.createElement("div");
                row.className = "check-answer-row";
                button.parentNode.insertBefore(row, button);
                row.appendChild(button);
            }

            row.appendChild(feedback);
        } else {
            fieldset.appendChild(feedback);
        }
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
                const blankMessage =
                    name === "chatbotUse"
                        ? "Please select an option, even if you haven't used a chatbot!"
                        : config?.incorrectFeedback || "Please select an option before checking.";

                addGroupFeedback(fieldset, "needs-answer", blankMessage);
                return;
            }

            if (!config) {
                addGroupFeedback(fieldset, "neutral", CHECK_ANSWER_NO_KEY_FEEDBACK);
                saveState();
                updateUnlocks();
                return;
            }

            const correctValues = config.dynamicCorrect
                ? [config.dynamicCorrect()]
                : (config.correct || []);

            const isCorrect = config.anySelectionIsCorrect
                ? selectedValues.length > 0
                : arraysMatch(selectedValues, correctValues);
            const selectedAnswer = selectedValues[0];

            let message =
                config.feedbackByAnswer?.[selectedAnswer] ||
                (isCorrect ? config.correctFeedback : config.incorrectFeedback);

            if (!isCorrect && (config.missingFeedback || config.addedFeedback)) {
                const missingCorrectAnswers = config.correct.filter(
                    answer => !selectedValues.includes(answer)
                );

                const addedIncorrectAnswers = selectedValues.filter(
                    answer => !config.correct.includes(answer)
                );

                const feedbackParts = [];

                missingCorrectAnswers.forEach(answer => {
                    if (config.missingFeedback?.[answer]) {
                        feedbackParts.push(config.missingFeedback[answer]);
                    }
                });

                addedIncorrectAnswers.forEach(answer => {
                    if (config.addedFeedback?.[answer]) {
                        feedbackParts.push(config.addedFeedback[answer]);
                    }
                });

                if (feedbackParts.length > 0) {
                    message = `${feedbackParts.join(" ")} ${config.incorrectFeedback || ""}`.trim();
                }
            }

            addGroupFeedback(
                fieldset,
                isCorrect ? "correct" : "incorrect",
                message
            );;

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
        console.warn("Summary comparison autofill is missing one or more required fields.", {
            studentSummarySource,
            aiSummarySource,
            studentSummaryComparison,
            aiSummaryComparison
        });
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
    const destination = document.getElementById("studentSummaryForRevision");

    if (!source || !destination) return;

    function syncOriginalSummary() {
        destination.value = source.value;
        saveState();
        updateUnlocks();
    }

    source.addEventListener("input", syncOriginalSummary);
    syncOriginalSummary();
}

function initializeArticleLinkTextAutofill() {
    const source = document.getElementById("articleLink");
    const destination = document.getElementById("selectedArticleLinkText");

    if (!source || !destination) return;

    function syncArticleLinkText() {
        const link = source.value.trim();

        if (link) {
            destination.textContent = link;
        } else {
            destination.textContent = "Not entered yet.";
        }
    }

    source.addEventListener("input", syncArticleLinkText);
    syncArticleLinkText();
}

function initializeSummaryNotesFeedback() {
    const notes = document.getElementById("aiSummaryNotes");
    const checkButton = document.getElementById("checkSummaryNotes");
    const feedback = document.getElementById("summaryNotesFeedback");

    if (!notes || !checkButton || !feedback) return;

    function clearNotesFeedback() {
        feedback.textContent = "";
        feedback.className = "notes-feedback";
    }

    function setNotesFeedback(type, message) {
        feedback.className = `notes-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const notesText = notes.value.trim();

        if (!notesText) {
            setNotesFeedback(
                "needs-answer",
                "Please add in your notes from your review."
            );
            return;
        }

        setNotesFeedback(
            "correct",
            "Thanks!"
        );

        saveState();
        updateUnlocks();
    });

    notes.addEventListener("input", () => {
        clearNotesFeedback();
        saveState();
        updateUnlocks();
    });
}

function initializeRevisionPromptFeedback() {
    const revisionPrompt = document.getElementById("revisionPrompt");
    const checkButton = document.getElementById("checkRevisionPrompt");
    const feedback = document.getElementById("revisionPromptFeedback");

    if (!revisionPrompt || !checkButton || !feedback) return;

    function clearRevisionFeedback() {
        feedback.textContent = "";
        feedback.className = "revision-feedback";
    }

    function setRevisionFeedback(type, message) {
        feedback.className = `revision-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const revisionText = revisionPrompt.value.trim();

        if (!revisionText) {
            setRevisionFeedback(
                "needs-answer",
                "Please paste in the revised AI summary."
            );
            saveState();
            updateUnlocks();
            return;
        }

        setRevisionFeedback(
            "correct",
            "Received!"
        );

        saveState();
        updateUnlocks();
    });

    revisionPrompt.addEventListener("input", () => {
        clearRevisionFeedback();
        saveState();
        updateUnlocks();
    });
}

function initializeReflectionFeedback() {
    const checkButton = document.getElementById("checkReflectionResponses");
    const feedback = document.getElementById("reflectionFeedback");

    const reflectionFields = [
        document.getElementById("studentOrganizationReflection"),
        document.getElementById("aiOrganizationReflection"),
        document.getElementById("combinedStrengthsReflection")
    ];

    if (!checkButton || !feedback || reflectionFields.some(field => !field)) return;

    function clearReflectionFeedback() {
        feedback.textContent = "";
        feedback.className = "reflection-feedback";
    }

    function setReflectionFeedback(type, message) {
        feedback.className = `reflection-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const emptyFields = reflectionFields.filter(field => !field.value.trim());

        if (emptyFields.length > 0) {
            setReflectionFeedback(
                "needs-answer",
                `Please answer all reflection questions before submitting. ${emptyFields.length} ${emptyFields.length === 1 ? "question still needs" : "questions still need"} a response.`
            );
            return;
        }

        setReflectionFeedback(
            "correct",
            "Reflections submitted. Nice work comparing your summary with the AI summary and thinking about how to strengthen the final version."
        );

        saveState();
        updateUnlocks();
    });

    reflectionFields.forEach(field => {
        field.addEventListener("input", () => {
            clearReflectionFeedback();
            saveState();
            updateUnlocks();
        });
    });
}

function initializeFinalSummaryRevisionAutofill() {
    const source = document.getElementById("revisionPrompt");
    const destination = document.getElementById("finalSummaryRevision")

    if (!source || !destination) return;

    function fillRevisionIfEmpty() {
        const originalSummary = source.value.trim();
        const currentRevision = destination.value.trim();

        if (!currentRevision && originalSummary) {
            destination.value = originalSummary;
            saveState();
            updateUnlocks();
        }
    }

    source.addEventListener("input", fillRevisionIfEmpty);
    fillRevisionIfEmpty();
}

function initializeFinalSummaryRevisionDiff() {
    const original = document.getElementById("revisionPrompt");
    const revision = document.getElementById("finalSummaryRevision");
    const button = document.getElementById("showRevisionChanges");
    const preview = document.getElementById("revisionPreview");
    const feedback = document.getElementById("revisionChangesFeedback");

    if (!original || !revision || !button || !preview || !feedback) return;

    function escapeHtml(text) {
        return text.replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        }[character]));
    }

    function getWords(text) {
        return text.trim().split(/\s+/).filter(Boolean);
    }

    function buildSimpleDiff(originalText, revisedText) {
        const originalWords = getWords(originalText);
        const revisedWords = getWords(revisedText);

        const rows = originalWords.length + 1;
        const cols = revisedWords.length + 1;
        const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

        for (let i = originalWords.length - 1; i >= 0; i--) {
            for (let j = revisedWords.length - 1; j >= 0; j--) {
                if (originalWords[i] === revisedWords[j]) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
        }

        let i = 0;
        let j = 0;
        const output = [];

        while (i < originalWords.length && j < revisedWords.length) {
            if (originalWords[i] === revisedWords[j]) {
                output.push(escapeHtml(revisedWords[j]));
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                output.push(`<del>${escapeHtml(originalWords[i])}</del>`);
                i++;
            } else {
                output.push(`<ins>${escapeHtml(revisedWords[j])}</ins>`);
                j++;
            }
        }

        while (i < originalWords.length) {
            output.push(`<del>${escapeHtml(originalWords[i])}</del>`);
            i++;
        }

        while (j < revisedWords.length) {
            output.push(`<ins>${escapeHtml(revisedWords[j])}</ins>`);
            j++;
        }

        return output.join(" ");
    }

    button.addEventListener("click", () => {
        const originalText = original.value.trim();
        const revisedText = revision.value.trim();

        if (!originalText || !revisedText) {
            feedback.className = "revision-feedback needs-answer";
            feedback.textContent = "Please revise some part of your review based off the AI feedback";
            preview.innerHTML = "";
            return;
        }

        feedback.className = "revision-feedback correct";
        feedback.textContent = "Received!";
        preview.innerHTML = buildSimpleDiff(originalText, revisedText);

        saveState();
        updateUnlocks();
    });

    revision.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "revision-feedback";
        preview.innerHTML = "";
    });
}

function initializeRubricRowCheck() {
    const checkButton = document.getElementById("checkRubricRows");
    const feedback = document.getElementById("rubricFeedback");

    if (!checkButton || !feedback) return;

    const rubricGroups = ["rubric1", "rubric2", "rubric3", "rubric4", "rubric5"];

    function clearRubricFeedback() {
        feedback.textContent = "";
        feedback.className = "rubric-feedback";
    }

    function setRubricFeedback(type, message) {
        feedback.className = `rubric-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const unansweredRows = rubricGroups.filter(groupName => {
            return !document.querySelector(`input[name="${groupName}"]:checked`);
        });

        if (unansweredRows.length > 0) {
            setRubricFeedback(
                "needs-answer",
                "Please make sure to select an option from each row."
            );
            return;
        }

        setRubricFeedback(
            "correct",
            "Thank you for reviewing each category."
        );

        saveState();
        updateUnlocks();
    });

    rubricGroups.forEach(groupName => {
        document.querySelectorAll(`input[name="${groupName}"]`).forEach(input => {
            input.addEventListener("change", () => {
                clearRubricFeedback();
                saveState();
                updateUnlocks();
            });
        });
    });
}

function initializeChatbotSuggestionsFeedback() {
    const suggestions = document.getElementById("chatbotSuggestions");
    const checkButton = document.getElementById("checkChatbotSuggestions");
    const feedback = document.getElementById("chatbotSuggestionsFeedback");

    if (!suggestions || !checkButton || !feedback) return;

    function clearSuggestionsFeedback() {
        feedback.textContent = "";
        feedback.className = "suggestions-feedback";
    }

    function setSuggestionsFeedback(type, message) {
        feedback.className = `suggestions-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const suggestionsText = suggestions.value.trim();

        if (!suggestionsText) {
            setSuggestionsFeedback(
                "needs-answer",
                "Please add in the suggestions AI gave you."
            );
            return;
        }

        setSuggestionsFeedback(
            "correct",
            "Thanks!"
        );

        saveState();
        updateUnlocks();
    });

    suggestions.addEventListener("input", () => {
        clearSuggestionsFeedback();
        saveState();
        updateUnlocks();
    });
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
    initializeFinalSummaryRevisionDiff();

    initializeChatbotUseFollowup();
    initializeSentenceBuilderFeedback();
    initializeCheckAnswerButtons();
    initializeSourceMatching();
    initializeSummaryNotesFeedback();
    initializeRubricRowCheck();
    initializeRevisionPromptFeedback();
    initializeChatbotSuggestionsFeedback();
    initializeReflectionFeedback();
    initializeProsConsSort();
    initializeSummaryComparisonAutofill();
    initializeOriginalSummaryAutofill();
    initializeArticleLinkTextAutofill();
    initializeFinalSummaryRevisionAutofill();
    initializeYouTubeVideoGate();

    updateRubricScore();
    updateUnlocks();
    showTab(state.unlockedTabs.includes(state.activeTab) ? state.activeTab : 0, false);
}

initializeLesson();