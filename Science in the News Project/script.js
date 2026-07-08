/*
    Science in the News - Main Script
    ------------------------------------------------------------
    Handles lesson progress, tab locking, answer checks, autofill,
    drag/drop activities, feedback buttons, rubric scoring, video
    completion, accessibility, word counts, and print helpers.
*/

/* ============================================================
    Configuration
  ============================================================ */

const STORAGE_KEYS = {
    lesson: "scienceInTheNewsProgressV1",
    videoGate: "scienceInTheNewsVideoGate"
};

const VIDEO_CONFIG = {
    youtubeId: "sLtTLQcpvxI",
    requiredProgress: 0.99,
    requiredWatchSeconds: 98
};

/* ============================================================
    Cached DOM Elements
  ============================================================ */

const form = document.getElementById("lessonForm");
const tabButtons = [...document.querySelectorAll("[data-tab-button]")];
const tabPanels = [...document.querySelectorAll("[data-tab]")];
const statusBoxes = [...document.querySelectorAll("[data-status]")];

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
    General Utilities
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

function countWords(text) {
    return text
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
}

/* ============================================================
    Accessibility and Validation
  ============================================================ */

function initializeScreenReaderQuestionLabels() {
    if (!form) return;

    const questionSelector = ".callout.teal, legend";
    let accessibleLabelCounter = 0;

    function ensureId(element, prefix) {
        if (!element.id) {
            accessibleLabelCounter += 1;
            element.id = `${prefix}-${accessibleLabelCounter}`;
        }
        return element.id;
    }

    function getQuestionElement(fieldset) {
        const existingLegend = fieldset.querySelector("legend");
        if (existingLegend) return existingLegend;

        let sibling = fieldset.previousElementSibling;
        while (sibling) {
            if (sibling.matches(questionSelector)) return sibling;
            sibling = sibling.previousElementSibling;
        }

        return null;
    }

    function getOptionTextElement(label) {
        let textElement = label.querySelector(".screen-reader-option-text");
        if (textElement) return textElement;

        textElement = document.createElement("span");
        textElement.className = "screen-reader-option-text";

        [...label.childNodes]
            .filter(node => !(node.nodeType === Node.ELEMENT_NODE && node.matches("input")))
            .forEach(node => textElement.appendChild(node));

        label.appendChild(textElement);
        return textElement;
    }

    form.querySelectorAll("fieldset[data-required-group]").forEach(fieldset => {
        if (fieldset.closest(".rubric")) return;

        const questionElement = getQuestionElement(fieldset);
        if (!questionElement) return;

        const questionId = ensureId(questionElement, "question-text");
        fieldset.setAttribute("aria-labelledby", questionId);

        fieldset
            .querySelectorAll('label.option input[type="radio"], label.option input[type="checkbox"]')
            .forEach(input => {
                const label = input.closest("label.option");
                if (!label) return;

                const optionTextElement = getOptionTextElement(label);
                const optionTextId = ensureId(optionTextElement, "option-text");

                input.setAttribute("aria-labelledby", `${questionId} ${optionTextId}`);
            });
    });
}

function getTextFromIds(idList) {
    return String(idList || "")
        .split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
}

function getRequirementText(element) {
    if (!element) return "This field";

    const labelledText = getTextFromIds(element.getAttribute("aria-labelledby"));
    if (labelledText) return labelledText;

    const describedText = getTextFromIds(element.getAttribute("aria-describedby"));
    if (describedText) return describedText;

    const legend = element.querySelector?.("legend");
    if (legend?.textContent?.trim()) return legend.textContent.trim();

    const internalPrompt = element.querySelector?.(".callout.teal, .drag-instructions");
    if (internalPrompt?.textContent?.trim()) return internalPrompt.textContent.trim();

    if (element.id) {
        const explicitLabel = form?.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (explicitLabel?.textContent?.trim()) return explicitLabel.textContent.trim();
    }

    const wrappingLabel = element.closest?.("label");
    if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();

    let sibling = element.previousElementSibling;
    while (sibling) {
        if (sibling.matches(".callout.teal, label.callout, p.callout, h2, h3")) {
            return sibling.textContent.trim();
        }
        sibling = sibling.previousElementSibling;
    }

    return element.dataset?.requiredGroup || element.name || element.id || "This field";
}

function ensureValidationAnnouncementRegion() {
    let region = document.getElementById("nativeValidationAnnouncement");
    if (region) return region;

    region = document.createElement("div");
    region.id = "nativeValidationAnnouncement";
    region.className = "screen-reader-only";
    region.setAttribute("role", "alert");
    region.setAttribute("aria-live", "assertive");
    region.setAttribute("aria-atomic", "true");

    if (form) form.prepend(region);
    else document.body.prepend(region);

    return region;
}

function announceValidationMessage(message) {
    const region = ensureValidationAnnouncementRegion();
    region.textContent = "";

    window.setTimeout(() => {
        region.textContent = message;
    }, 10);
}

function clearValidationAnnouncement() {
    const region = document.getElementById("nativeValidationAnnouncement");
    if (region) region.textContent = "";
}

// Add concise, state-aware descriptions without replacing visible button names.
function getButtonDescription(button) {
    const tabIndex = Number(button.dataset.tabButton);

    if (Number.isInteger(tabIndex)) {
        if (button.classList.contains("active")) {
            return `You are currently viewing Tab ${tabIndex + 1}.`;
        }

        if (button.classList.contains("locked")) {
            return `Tab ${tabIndex + 1} is locked. Complete the required items in the current tab before selecting this button.`;
        }

        return `Select this button to open Tab ${tabIndex + 1}.`;
    }

    if (button.dataset.toggle) {
        const isOpen = button.getAttribute("aria-expanded") === "true";
        const action = isOpen ? "hide" : "show";

        if (button.dataset.toggle === "helpPanel") {
            return `Select this button to ${action} the video instructions.`;
        }

        return `Select this button to ${action} the keyboard instructions.`;
    }

    if (button.classList.contains("drag-token")) {
        return `Select ${button.textContent.trim()}, then select a matching drop zone.`;
    }

    if (button.classList.contains("back-to-top-button")) {
        return "Select this button to return to the top of the page.";
    }

    if (button.classList.contains("print-button")) {
        return "Select this button to open the print dialog and save or print your completed responses.";
    }

    if (button.classList.contains("reset-testing-button")) {
        return "Select this button to clear saved testing progress and reload the activity.";
    }

    if (button.id === "clearSourceMatches") {
        return "Select this button to clear all source-matching answers.";
    }

    if (button.id === "checkSourceMatches") {
        return "Select this button to check the source-matching answers and hear feedback.";
    }

    if (button.id === "checkSentenceBuilder") {
        return "Select this button to check the sentence answers and hear feedback.";
    }

    if (button.classList.contains("check-answer-button")) {
        return "Select this button to check your response and hear feedback.";
    }

    return `Select this button to activate ${button.textContent.trim()}.`;
}

function updateButtonDescription(button) {
    const descriptionId = button.dataset.buttonDescriptionId;
    const description = descriptionId && document.getElementById(descriptionId);

    if (description) description.textContent = getButtonDescription(button);
}

function initializeButtonDescriptions() {
    const buttons = [...document.querySelectorAll("button")];
    if (!buttons.length) return;

    const descriptionContainer = document.createElement("div");
    descriptionContainer.id = "buttonDescriptions";
    descriptionContainer.className = "screen-reader-only";
    document.body.appendChild(descriptionContainer);

    buttons.forEach((button, index) => {
        const description = document.createElement("span");
        description.id = `button-description-${index + 1}`;
        description.textContent = getButtonDescription(button);
        descriptionContainer.appendChild(description);

        const existingIds = button.getAttribute("aria-describedby")?.trim();
        button.setAttribute(
            "aria-describedby",
            [existingIds, description.id].filter(Boolean).join(" ")
        );
        button.dataset.buttonDescriptionId = description.id;
    });
}

// Give assistive technology a useful question label instead of a generic
// browser message such as "Please fill out this field."
function getValidationMessage(control) {
    const group = control.closest("fieldset[data-required-group]");
    const requirementText = getRequirementText(group || control);

    if (control.validity.typeMismatch) {
        return `${requirementText} must contain a valid web address.`;
    }

    if (control.type === "checkbox") {
        return `${requirementText} is required. Select at least one option.`;
    }

    if (control.type === "radio") {
        return `${requirementText} is required. Select one option.`;
    }

    return `${requirementText} is required. Enter a response.`;
}

function focusCustomRequirement(item) {
    if (!item?.focusTarget) return;

    item.focusTarget.focus({ preventScroll: false });

    if (typeof item.focusTarget.scrollIntoView === "function") {
        item.focusTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

function getCustomIncompleteRequirement(panel) {
    if (!panel) return null;

    const videoInput = panel.querySelector("#watchedVideo");
    const timerInput = panel.querySelector("#videoTimerComplete");
    const videoStatus = document.getElementById("videoStatus");

    if ((videoInput && !isFilled(videoInput)) || (timerInput && !isFilled(timerInput))) {
        if (videoStatus) {
            videoStatus.setAttribute("tabindex", "-1");
            videoStatus.setAttribute("aria-invalid", "true");
        }

        return {
            focusTarget: videoStatus || panel,
            message: "The video is required. Watch the video before continuing."
        };
    }

    const emptyHiddenRequired = [...panel.querySelectorAll('input[type="hidden"][data-required]')]
        .filter(input => !isFilled(input));

    if (emptyHiddenRequired.length) {
        const firstHiddenInput = emptyHiddenRequired[0];
        const dropZone = panel.querySelector(`[data-target="${CSS.escape(firstHiddenInput.id)}"]`);
        const activity = firstHiddenInput.closest(".matching-activity, .drag-match-activity, [data-required-group]");
        const activityText = getRequirementText(activity || firstHiddenInput);
        const message = `${activityText} is required. Complete this activity before continuing.`;
        const focusTarget = dropZone || activity || panel;

        if (focusTarget) {
            focusTarget.setAttribute("tabindex", focusTarget.getAttribute("tabindex") || "-1");
            focusTarget.setAttribute("aria-invalid", "true");
        }

        return {
            focusTarget,
            message
        };
    }

    return null;
}

function initializeNativeRequiredValidation() {
    if (!form) return;

    ensureValidationAnnouncementRegion();

    // Native required works well for text fields, textareas, selects, URLs, and radio groups.
    form.querySelectorAll("[data-required], [data-required-check]").forEach(field => {
        if (field.type === "hidden") return;

        field.required = true;
        field.setAttribute("aria-required", "true");

        field.addEventListener("input", () => {
            field.setCustomValidity("");
            field.setAttribute("aria-invalid", "false");
            clearValidationAnnouncement();
        });

        field.addEventListener("change", () => {
            field.setCustomValidity("");
            field.setAttribute("aria-invalid", "false");
            clearValidationAnnouncement();
        });
    });

    form.querySelectorAll("fieldset[data-required-group]").forEach(group => {
        const radios = [...group.querySelectorAll('input[type="radio"]')];
        const checkboxes = [...group.querySelectorAll('input[type="checkbox"]')];

        group.setAttribute("aria-invalid", "false");

        // Radio groups: native required works when each radio in the group is marked required.
        radios.forEach(radio => {
            radio.required = true;
            radio.addEventListener("change", () => {
                group.setAttribute("aria-invalid", "false");
                radios.forEach(item => item.setAttribute("aria-invalid", "false"));
                clearValidationAnnouncement();
            });
        });

        // Checkbox groups: native required alone would require every checkbox.
        // Custom validity on the first checkbox gives native browser validation for "select at least one."
        if (checkboxes.length) {
            const errorMessage = `${getRequirementText(group)} is required. Select at least one option.`;

            function updateCheckboxGroupValidity() {
                const hasCheckedOption = checkboxes.some(checkbox => checkbox.checked);

                group.setAttribute("aria-invalid", String(!hasCheckedOption));

                checkboxes.forEach((checkbox, index) => {
                    checkbox.setAttribute("aria-invalid", String(!hasCheckedOption));

                    if (index === 0) {
                        checkbox.setCustomValidity(hasCheckedOption ? "" : errorMessage);
                    } else {
                        checkbox.setCustomValidity("");
                    }
                });

                if (hasCheckedOption) clearValidationAnnouncement();
            }

            checkboxes.forEach(checkbox => {
                checkbox.addEventListener("change", updateCheckboxGroupValidity);
            });

            updateCheckboxGroupValidity();
        }
    });

    form.addEventListener("invalid", event => {
        event.target.setAttribute("aria-invalid", "true");

        const group = event.target.closest("fieldset[data-required-group]");
        if (group) group.setAttribute("aria-invalid", "true");
    }, true);
}

function reportActiveTabValidity(requestedTabIndex) {
    const panel = tabPanels[state.activeTab];
    if (!panel) return true;

    const controls = [...panel.querySelectorAll("input, textarea, select")]
        .filter(control =>
            control.type !== "hidden" &&
            !control.disabled &&
            control.offsetParent !== null
        );

    const firstInvalidControl = controls.find(control => !control.checkValidity());

    if (firstInvalidControl) {
        firstInvalidControl.setAttribute("aria-invalid", "true");

        const group = firstInvalidControl.closest("fieldset[data-required-group]");
        if (group) group.setAttribute("aria-invalid", "true");

        const destination = Number.isInteger(requestedTabIndex)
            ? `Cannot open Tab ${requestedTabIndex + 1}. `
            : "Cannot continue. ";

        firstInvalidControl.focus();
        firstInvalidControl.reportValidity();
        announceValidationMessage(destination + getValidationMessage(firstInvalidControl));
        return false;
    }

    const customMissing = getCustomIncompleteRequirement(panel);
    if (customMissing) {
        const destination = Number.isInteger(requestedTabIndex)
            ? `Cannot open Tab ${requestedTabIndex + 1}. `
            : "Cannot continue. ";

        focusCustomRequirement(customMissing);
        announceValidationMessage(destination + customMissing.message);
        return false;
    }

    return true;
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

/* ============================================================
    Required Completion and Tab Locking
  ============================================================ */

function groupComplete(panel, groupName) {
    const group = panel.querySelector(`[data-required-group="${CSS.escape(groupName)}"]`);
    if (!group) return true;

    const namedFields = [...group.querySelectorAll(`[name="${CSS.escape(groupName)}"]`)];

    if (namedFields.length > 0) {
        const hasCheckable = namedFields.some(element =>
            element.type === "radio" || element.type === "checkbox"
        );

        if (hasCheckable) return namedFields.some(element => element.checked);
        return namedFields.every(isFilled);
    }

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

    if (index === 2) {
        const rubricComplete = [1, 2, 3, 4, 5].every(num =>
            Boolean(form.querySelector(`[name="rubric${num}"]:checked`))
        );

        return allDirectRequiredComplete && allDirectChecksComplete && allGroupsComplete && rubricComplete;
    }

    return allDirectRequiredComplete && allDirectChecksComplete && allGroupsComplete;
}

function updateUnlocks() {
    const unlockedTabs = [0];

    for (let i = 0; i < tabPanels.length - 1; i++) {
        if (tabComplete(i)) unlockedTabs.push(i + 1);
        else break;
    }

    state.unlockedTabs = [...new Set(unlockedTabs)].sort((a, b) => a - b);

    if (!state.unlockedTabs.includes(state.activeTab)) {
        state.activeTab = state.unlockedTabs[state.unlockedTabs.length - 1] || 0;
        showTab(state.activeTab, false);
    }

    tabButtons.forEach((button, index) => {
        const unlocked = state.unlockedTabs.includes(index);
        button.classList.toggle("locked", !unlocked);
        button.disabled = false;
        button.setAttribute("aria-disabled", String(!unlocked));
        updateButtonDescription(button);
    });

    tabPanels.forEach((panel, index) => {
        panel.classList.toggle("active", index === state.activeTab);
    });

    statusBoxes.forEach(box => {
        const index = Number(box.dataset.status);
        const complete = tabComplete(index);
        const isLastTab = index === tabPanels.length - 1;

        box.classList.toggle("complete", complete);

        if (complete && !isLastTab) {
            box.textContent = `Tab ${index + 1} complete. Tab ${index + 2} is unlocked.`;
        } else if (complete && isLastTab) {
            box.textContent = "Lesson complete. You can print or save your work as a PDF.";
        } else if (!complete && !isLastTab) {
            box.textContent = `Complete everything in this tab to unlock Tab ${index + 2}.`;
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

    resizeVisibleTextareas();
    setTimeout(resizeVisibleTextareas, 50);
    setTimeout(resizeVisibleTextareas, 150);

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
    const status = document.getElementById("sourceMatchingStatus");

    if (!tokens.length || !zones.length) return;

    let selectedValue = null;

    function announceSourceMatchingStatus(message) {
        if (!status) return;

        status.textContent = "";
        window.setTimeout(() => {
            status.textContent = message;
        }, 10);
    }

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

    function updateSourceTokenVisibility() {
        const placedValues = zones
            .map(zone => zone.querySelector('input[type="hidden"]')?.value)
            .filter(Boolean);

        tokens.forEach(token => {
            token.classList.toggle("is-placed", placedValues.includes(token.dataset.value));
        });
    }

    function updateZoneDisplay(zone, value) {
        const label = zone.querySelector(".drop-zone-text");
        const input = zone.querySelector('input[type="hidden"]');

        if (!label || !input) return;

        input.value = value || "";
        label.textContent = value || "Drop type here";
        zone.classList.toggle("filled", Boolean(value));

        zone.classList.remove("correct", "incorrect", "needs-answer");

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

    function assignValueToZone(zone, value) {
        if (!value) return;

        clearExistingValue(value);
        updateZoneDisplay(zone, value);
        clearSelectedToken();
        announceSourceMatchingStatus(`${value} placed. ${zone.getAttribute("aria-label")}.`);
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
            announceSourceMatchingStatus(
                `${selectedValue} selected. Press Tab to move to a drop zone, then press Enter or Space to place it.`
            );
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
                const removedValue = zone.querySelector('input[type="hidden"]')?.value;
                updateZoneDisplay(zone, "");
                announceSourceMatchingStatus(
                    removedValue ? `${removedValue} removed from this drop zone.` : "This drop zone is already empty."
                );
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
                "Review the definitions for primary, secondary, and tertiary sources. Think about how each one builds on the other and try again."
            );
        }

        saveState();
        updateUnlocks();
    });

    clearButton?.addEventListener("click", () => {
        zones.forEach(zone => updateZoneDisplay(zone, ""));
        clearSelectedToken();
        clearSourceMatchingFeedback();
        announceSourceMatchingStatus("All source-matching answers were cleared.");
        saveState();
        updateUnlocks();
    });

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
        let unansweredCount = 0;
        let correctCount = 0;

        selects.forEach(select => {
            const selectedOption = select.options[select.selectedIndex];
            const sentenceItem = select.closest(".sentence-item");

            select.classList.remove("correct", "incorrect", "needs-answer");
            sentenceItem?.classList.remove("is-correct", "is-incorrect", "needs-answer");

            if (!select.value) {
                unansweredCount += 1;
                select.classList.add("needs-answer");
                sentenceItem?.classList.add("needs-answer");
                return;
            }

            if (selectedOption.dataset.correct === "true") {
                correctCount += 1;
                select.classList.add("correct");
                sentenceItem?.classList.add("is-correct");
            } else {
                select.classList.add("incorrect");
                sentenceItem?.classList.add("is-incorrect");
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
                "Nice work! You correctly identified how each type of scientific source is used. Primary sources present original research, secondary sources analyze and interpret that research, and tertiary sources help build background knowledge. This understanding will help you choose the right sources when reading and writing about science."
            );
        } else {
            setSentenceFeedback(
                "incorrect",
                "Review the definitions for primary, secondary, and tertiary sources. Focus on their purposes: presenting original research, analyzing research, and compiling and summarizing information. Then try again."
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
    YouTube Video Gate
  ============================================================ */

function initializeAccessibleVideoFocus() {
    const videoElement = document.getElementById("genaiVideo");
    const videoStatus = document.getElementById("videoStatus");

    if (!videoElement) return null;

    let wrapper = videoElement.closest(".video-accessible-wrapper");

    if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.className = "video-accessible-wrapper";

        videoElement.parentNode.insertBefore(wrapper, videoElement);
        wrapper.appendChild(videoElement);
    }

    let instructions = document.getElementById("videoKeyboardInstructions");

    if (!instructions) {
        instructions = document.createElement("p");
        instructions.id = "videoKeyboardInstructions";
        instructions.className = "video-accessible-instructions";
        instructions.textContent = "Video. Press Tab again to enter the video controls.";

        wrapper.insertBefore(instructions, wrapper.firstChild);
    }

    wrapper.setAttribute("tabindex", "0");
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-labelledby", "videoKeyboardInstructions");

    if (videoStatus) {
        wrapper.setAttribute("aria-describedby", "videoStatus");
        videoStatus.setAttribute("role", "status");
        videoStatus.setAttribute("aria-live", "polite");
        videoStatus.setAttribute("aria-atomic", "true");
    }

    wrapper.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;

        const iframe = wrapper.querySelector("iframe");

        if (iframe) {
            event.preventDefault();
            iframe.focus();
        }
    });

    return wrapper;
}

function initializeLocalVideoAnnouncements() {
    const video = document.getElementById("howToVideo");
    const status = document.getElementById("howToVideoStatus");

    if (!video || !status) return;

    function announce(message) {
        status.textContent = "";

        window.setTimeout(() => {
            status.textContent = message;
        }, 10);
    }

    video.addEventListener("play", () => {
        announce("Video is playing.");
    });

    video.addEventListener("pause", () => {
        if (!video.ended) {
            announce("Video is paused.");
        }
    });

    video.addEventListener("ended", () => {
        announce("Video has ended.");
    });
}

function initializeYouTubeVideoGate() {
    const videoInput = document.getElementById("watchedVideo");
    const timerInput = document.getElementById("videoTimerComplete");
    const videoStatus = document.getElementById("videoStatus");

    if (!document.getElementById("genaiVideo")) return;

    initializeAccessibleVideoFocus();

    if (!videoInput || !timerInput || !videoStatus) return;

    updateVideoStatusMessage();

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
    stopRequiredWatchTimer();

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

    if (!videoInput) return;

    videoInput.value = "complete";

    updateVideoStatusMessage();
    saveState();
    updateUnlocks();
}

function markRequiredWatchTimerComplete() {
    const timerInput = document.getElementById("videoTimerComplete");

    if (!timerInput) return;

    timerInput.value = "complete";

    updateVideoStatusMessage();
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

function updateVideoStatusMessage() {
    const videoInput = document.getElementById("watchedVideo");
    const timerInput = document.getElementById("videoTimerComplete");
    const videoStatus = document.getElementById("videoStatus");

    if (!videoInput || !timerInput || !videoStatus) return;

    const progressComplete = videoInput.value === "complete";
    const timerComplete = timerInput.value === "complete";

    if (progressComplete && timerComplete) {
        videoStatus.textContent = "Video complete. You can continue.";
        videoStatus.classList.add("complete");
    } else if (progressComplete && !timerComplete) {
        videoStatus.textContent = "Keep watching a little longer to complete the video.";
        videoStatus.classList.remove("complete");
    } else {
        videoStatus.textContent = "Watch the video to continue.";
        videoStatus.classList.remove("complete");
    }
}

/* ============================================================
    Rubric Scoring and Rubric Completion Check
  ============================================================ */

function updateRubricScore() {
    const scoreOutput = document.getElementById("rubricScore");
    if (!scoreOutput) return;

    let total = 0;

    for (let i = 1; i <= 5; i++) {
        const selected = form.querySelector(`[name="rubric${i}"]:checked`);
        if (selected) total += Number(selected.value);
    }

    scoreOutput.textContent = total;
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
            setRubricFeedback("needs-answer", "Please make sure to select an option from each row.");
            return;
        }

        setRubricFeedback("correct", "Thank you for reviewing each category.");
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

/* ============================================================
    Multiple Choice / Multiple Select Answer Checks
  ============================================================ */

const CHECK_ANSWER_CONFIG = {
    credibilityTraits: {
        correct: ["Clear evidence", "Reliable sources", "Easy to understand"],
        correctFeedback: "Nice work. Credibility comes from clear evidence, reliable sources, and writing that is easy to understand. This is your goal. Now, can AI do this?",
        missingFeedback: {
            "Clear evidence": "Your summary needs specific, accurate details from the research.",
            "Reliable sources": "Credibility depends on which sources the information comes from.",
            "Easy to understand": "A credible summary should be clear and well-written."
        },
        addedFeedback: {
            "Personal opinions": " Personal opinions can introduce bias and reduce credibility.",
            "Scientific jargon": "Too much jargon can confuse readers.",
            "Vague statements": "Statements that are overly generalized can cause confusion and create misconceptions",
            "Confident tone": "Confidence doesn't mean the content is accurate."
        },
        incorrectFeedback: "Please try again."
    },
    aiDefinition: {
        correct: ["thinkingTasks"],
        correctFeedback: "You got it. AI refers to computer systems that can do tasks that typically require human thinking, such as analyzing information, recognizing patterns, making predictions, and solving problems.",
        feedbackByAnswer: {
            storage: " Please try again. This is close to something computers can do, but AI does more than just collect or store data. It also processes and analyzes information.",
            website: "Please try again. A website or search engine can help people find information, and some websites may use AI. However, AI goes beyond just searching for information.",
            machine: "Please try again. Some mechanical devices (such as robots or other machines) use AI, but AI does not have to be a physical device. AI can also exist as software inside a computer, phone, app, or website.",
            thinkingTasks: "You got it. AI refers to computer systems that can do tasks that typically require human thinking, such as analyzing information, recognizing patterns, making predictions, and solving problems."
        },
        incorrectFeedback: "Try again."
    },
    chatbotUse: {
        anySelectionIsCorrect: true,
        correctFeedback: "Good to know!"
    },
    genaiDefinition: {
        correct: ["creates"],
        correctFeedback: "You got it. GenAI is trained on large amounts of data to create new content. It can generate text, images, etc., given what it learns.",
        feedbackByAnswer: {
            creates: "You got it. GenAI is trained on large amounts of data to create new content. It can generate text, images, etc., given what it learns.",
            stores: "Please try again. Some technology stores and retrieves information, but GenAI creates something new using patterns learned from data.",
            steps: "Please try again. GenAI learns by example. It does not follow basic automation or fixed instructions like more traditional computer programs.",
            typed: "Please try again. GenAI can repeat past answers and generate new responses based on patterns in the data it was trained on."
        },
        incorrectFeedback: "Try again. GenAI is known for creating new content."
    },
    promptFunction: {
        correct: ["guide"],
        correctFeedback: "You got it. Prompts are user inputs that tell the AI what to generate. They can be questions, statements, or instructions. ",
        feedbackByAnswer: {
            faster: "Please try again. Prompts can help the system work more efficiently. But they can’t make the system run faster than its normal limits, which are determined by factors such as the system’s memory and storage capacity.",
            guide: "You got it. Prompts are user inputs that tell the AI what to generate. They can be questions, statements, or instructions. ",
            errors: "Please try again. Prompts can help people diagnose, analyze, and correct system errors. But they usually do not fix the errors on their own.",
            vocab: "Please try again. Prompts can be used to limit the vocabulary the AI uses in specific responses. But they do not typically change the AI’s stored vocabulary. As new data are added, the system’s vocabulary is expected to grow."
        },
        incorrectFeedback: "Try again. A prompt tells the AI what kind of output to create."
    },
    aiSummaryOverallRating: {
        anySelectionIsCorrect: true,

        feedbackByAnswer: {
            "ready to publish": "The chatbot summary is accurate, well-supported, and reliable. It clearly represents the article’s main ideas, uses strong evidence, and includes trustworthy sources. It is ready to be shared on a student website.",

            "needs minor revisions": "The chatbot summary is mostly strong and could be publishable after a few improvements. It includes the main ideas, evidence, and reliable sources, but some parts may need to be clarified, strengthened, or checked more carefully before publication.",

            "needs major revisions": "The chatbot summary is not ready to publish yet because it has an important issue with the main ideas, evidence, or source reliability. These problems could affect how accurately or responsibly the science is shared, so the summary needs significant revision before publication."
        },

        feedbackTypeByAnswer: {
            "ready to publish": "correct",
            "needs minor revisions": "warning",
            "needs major revisions": "incorrect"
        },

        correctFeedback: "Thank you for your rating."
    },
    sentenceWeakness: {
        anySelectionIsCorrect: true,
        correctFeedback: "Thank you for sharing.",
        incorrectFeedback: "Even if the summary is really strong, if you had to pick a category to work on, what would it be?"
    },
    summaryDirection: {
        anySelectionIsCorrect: true,
        correctFeedback: "Thank you for sharing.",
        noSelectionFeedback: "Please share at least one of your observations.",
        noSelectionFeedbackType: "incorrect"
    },
    noticedSummaries: {
        correct: ["clearInstructions", "guideIt"],
        correctFeedback: "Nice work. Think about how your feedback changed the chatbot’s response and what that reveals about how it works. AI can misinterpret feedback or apply it incorrectly, especially if the request is unclear.",
        missingFeedback: {
            clearInstructions: "Consider what happened when you gave more specific feedback to the chatbot. Did the response change? What does that suggest?",
            guideIt: "Think about your role in the interaction. Did the chatbot’s response change based on what you said or asked?",
        },
        addedFeedback: {
            appliesFeedback: "AI does not always understand and correctly apply all feedback.",
            improveResponses: "Reflect on your experience. Would the chatbot have given the same responses without your guidance?"
        },
        incorrectFeedback: "Please try again."
    },
    feedbackChanged: {
        correct: ["decision", "feedback", "accurate"],
        correctFeedback: "Nice work. Think about how you stayed in control of your writing while using AI to support your thinking.",
        missingFeedback: {
            decision: "Reflect on who is responsible for the final version of your summary. Who decides what stays or changes?",
            feedback: "Consider how the AI helped you reflect. Did it change what you thought about in your writing?",
            accurate: "Think about reliability. Did you need to verify what the AI suggested?"
        },
        addedFeedback: {
            copy: "Think about your role. Are you using AI to think, or letting it think for you?"
        },
        incorrectFeedback: "Please try again."
    },
    aiToolStatement: {
        correct: ["helps thinking"],
        correctFeedback: "Nice work. AI is most powerful when it supports your thinking, helps you revise ideas, and strengthens your understanding.",
        feedbackByAnswer: {
            "helps thinking": "Nice work. AI is most powerful when it supports your thinking, helps you revise ideas, and strengthens your understanding.",
            "replaces understanding": " Think about whether understanding the topic still matters when using AI.",
            "does hard work": "Think about your role when using AI. Should you still review and evaluate the results?",
            "always accurate": " Reflect on what you learned about AI-generated summaries. Are they always fully accurate?"
        },
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
    scienceNewsEvaluation: {
        correct: ["original source"],
        correctFeedback: "Correct. Checking the original scientific source helps to verify the claims and understand the original context of the information shared. It is important in ensuring accuracy, preventing the spread of misinformation, and identifying any biases.",
        feedbackByAnswer: {
            headline: "Please try again. News article headlines can be misleading and used as clickbait, to promote financial gain, increase user engagement, push a specific narrative, or meet the pressures of the 24-hour news cycle.",
            "original source": "Correct. Checking the original scientific source helps to verify the claims and understand the original context of the information shared. It is important in ensuring accuracy, preventing the spread of misinformation, and identifying any bias.",
            "sounds interesting": "Please try again. Prioritizing emotional engagement with a news article over the facts can lead to misinformation, cognitive bias, and engagement in misleading arguments.",
            likes: "Please try again. Popularity on the internet is not proof that information is reliable because posts can spread quickly even when they contain mistakes, exaggerations, or false claims."
        },
        incorrectFeedback: "Please try again."
    },
    aiSummaryReadingApproach: {
        correct: ["question claims"],
        correctFeedback: "Nice work. This is a strong approach. You are engaging with the content while staying alert. Questioning claims and verifying details helps you avoid accepting false or incomplete information.",
        feedbackByAnswer: {
            "sounds clear": "Clarity alone does not always mean accuracy. AI-generated content is often polished, even when it contains errors or made-up information. Try again.",
            "question claims": "Nice work. This is a strong approach. You are engaging with the content while staying alert. Questioning claims and verifying details helps you avoid accepting false or incomplete information.",
            "ignore without sources": "Sources are helpful, but their presence alone does not guarantee accuracy. Some AI-generated content includes incorrect or fabricated references, so it is better to evaluate both the content and the sources. Try again."
        },
        incorrectFeedback: "Please try again."
    }
};

const CHECK_ANSWER_NO_KEY_FEEDBACK = "Good to know!";

function initializeCheckAnswerButtons() {
    if (!form) return;

    const groupedNames = [
        ...new Set(
            [...form.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
                .map(input => input.name)
                .filter(Boolean)
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
        fieldset.classList.remove(
            "answer-correct",
            "answer-incorrect",
            "answer-needs-answer",
            "answer-neutral",
            "answer-warning"
        );

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
        const groupsWithoutCheckButton = [];

        if (groupsWithoutCheckButton.includes(name)) return;

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
                    config?.noSelectionFeedback ||
                    (name === "sentenceWeakness"
                        ? "Even if the summary is really strong, if you had to pick a category to work on, what would it be?"
                        : "Please answer the question.");

                const blankType = config?.noSelectionFeedbackType || "needs-answer";

                addGroupFeedback(fieldset, blankType, blankMessage);
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
                const missingCorrectAnswers = correctValues.filter(
                    answer => !selectedValues.includes(answer)
                );

                const addedIncorrectAnswers = selectedValues.filter(
                    answer => !correctValues.includes(answer)
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

            const feedbackType =
                config.feedbackTypeByAnswer?.[selectedAnswer] ||
                (isCorrect ? "correct" : "incorrect");

            addGroupFeedback(fieldset, feedbackType, message);
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
    Feedback Buttons for Text Entry Sections
  ============================================================ */

function initializeAiSummaryDraftFeedback() {
    const aiSummary = document.getElementById("aiSummaryDraft");
    const checkButton = document.getElementById("checkAiSummaryDraft");
    const feedback = document.getElementById("aiSummaryDraftFeedback");

    if (!aiSummary || !checkButton || !feedback) return;

    function setAiSummaryFeedback(type, message) {
        feedback.className = `ai-summary-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const summaryText = aiSummary.value.trim();

        if (!summaryText) {
            setAiSummaryFeedback("needs-answer", "Please paste in the AI summary.");
            return;
        }

        setAiSummaryFeedback("correct", "Got it!");
        saveState();
        updateUnlocks();
    });

    aiSummary.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "ai-summary-feedback";
        saveState();
        updateUnlocks();
    });
}

function initializeSummaryNotesFeedback() {
    const notes = document.getElementById("aiSummaryNotes");
    const checkButton = document.getElementById("checkSummaryNotes");
    const feedback = document.getElementById("summaryNotesFeedback");

    if (!notes || !checkButton || !feedback) return;

    function setNotesFeedback(type, message) {
        feedback.className = `notes-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const notesText = notes.value.trim();

        if (!notesText) {
            setNotesFeedback("needs-answer", "Please add in your notes from your review.");
            return;
        }

        setNotesFeedback("correct", "Thanks!");
        saveState();
        updateUnlocks();
    });

    notes.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "notes-feedback";
        saveState();
        updateUnlocks();
    });
}

function initializeRevisionPromptFeedback() {
    const revisionPrompt = document.getElementById("revisionPrompt");
    const checkButton = document.getElementById("checkRevisionPrompt");
    const feedback = document.getElementById("revisionPromptFeedback");

    if (!revisionPrompt || !checkButton || !feedback) return;

    function setRevisionFeedback(type, message) {
        feedback.className = `revision-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const revisionText = revisionPrompt.value.trim();

        if (!revisionText) {
            setRevisionFeedback("needs-answer", "Please paste in the revised AI summary.");
            saveState();
            updateUnlocks();
            return;
        }

        setRevisionFeedback("correct", "Received!");
        saveState();
        updateUnlocks();
    });

    revisionPrompt.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "revision-feedback";
        saveState();
        updateUnlocks();
    });
}

function initializeChatbotSuggestionsFeedback() {
    const suggestions = document.getElementById("chatbotSuggestions");
    const checkButton = document.getElementById("checkChatbotSuggestions");
    const feedback = document.getElementById("chatbotSuggestionsFeedback");

    if (!suggestions || !checkButton || !feedback) return;

    function setSuggestionsFeedback(type, message) {
        feedback.className = `suggestions-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const suggestionsText = suggestions.value.trim();

        if (!suggestionsText) {
            setSuggestionsFeedback("incorrect", "Please add in the suggestions the chatbot gave you.");
            saveState();
            updateUnlocks();
            return;
        }

        setSuggestionsFeedback("correct", "Thanks!");
        saveState();
        updateUnlocks();
    });

    suggestions.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "suggestions-feedback";
        saveState();
        updateUnlocks();
    });
}

function initializeFinalSummaryRevisionFeedback() {
    const original = document.getElementById("studentSummaryForRevision");
    const revision = document.getElementById("finalSummaryRevision");
    const checkButton = document.getElementById("checkFinalSummaryRevision");
    const feedback = document.getElementById("finalSummaryRevisionFeedback");

    if (!original || !revision || !checkButton || !feedback) return;

    function normalizeText(text) {
        return text.trim().replace(/\s+/g, " ");
    }

    function setFinalRevisionFeedback(type, message) {
        feedback.className = `revision-feedback ${type}`;
        feedback.textContent = message;
    }

    checkButton.addEventListener("click", () => {
        const originalText = normalizeText(original.value);
        const revisionText = normalizeText(revision.value);

        if (!revisionText || revisionText === originalText) {
            setFinalRevisionFeedback(
                "incorrect",
                "Please revise some part of your summary based off the chatbot feedback."
            );

            saveState();
            updateUnlocks();
            return;
        }

        setFinalRevisionFeedback("correct", "Received!");

        saveState();
        updateUnlocks();
    });

    revision.addEventListener("input", () => {
        feedback.textContent = "";
        feedback.className = "revision-feedback";

        saveState();
        updateUnlocks();
    });
}

/* ============================================================
    Autofill Helpers
  ============================================================ */

function initializeSummaryComparisonAutofill() {
    const studentSummarySource = document.getElementById("studentSummary");
    const aiSummarySource = document.getElementById("revisionPrompt");

    const studentSummaryComparison = document.getElementById("studentSummaryComparison");
    const aiSummaryComparison = document.getElementById("aiSummaryComparison");

    if (!studentSummarySource || !aiSummarySource || !studentSummaryComparison || !aiSummaryComparison) {
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

        resizeTextareaToFit(studentSummaryComparison);
        resizeTextareaToFit(aiSummaryComparison);

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

    if (!source || !destination) {
        console.warn("Original summary revision autofill is missing one or more required fields.", {
            source,
            destination
        });
        return;
    }

    function syncOriginalSummary() {
        destination.value = source.value;

        resizeTextareaToFit(destination);

        destination.dispatchEvent(new Event("input", { bubbles: true }));

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
        destination.textContent = link || "Not entered yet.";
    }

    source.addEventListener("input", syncArticleLinkText);
    syncArticleLinkText();
}

function initializeFinalSummaryRevisionAutofill() {
    const source = document.getElementById("studentSummaryForRevision");
    const originalSource = document.getElementById("studentSummary");
    const destination = document.getElementById("finalSummaryRevision");

    if (!source || !originalSource || !destination) return;

    function fillRevisionIfEmptyOrPartial() {
        const sourceText = source.value.trim() || originalSource.value.trim();
        const currentRevision = destination.value.trim();

        if (!sourceText) return;

        const currentLooksPartial =
            currentRevision &&
            sourceText.startsWith(currentRevision) &&
            currentRevision.length < sourceText.length;

        if (!currentRevision || currentLooksPartial) {
            destination.value = sourceText;

            resizeTextareaToFit(destination);

            destination.dispatchEvent(new Event("input", { bubbles: true }));

            saveState();
            updateUnlocks();
        }
    }

    source.addEventListener("input", fillRevisionIfEmptyOrPartial);
    originalSource.addEventListener("input", fillRevisionIfEmptyOrPartial);

    fillRevisionIfEmptyOrPartial();
}

/* ============================================================
    Final Revision Diff Preview
  ============================================================ */

function initializeFinalSummaryRevisionDiff() {
    const original = document.getElementById("studentSummaryForRevision");
    const revision = document.getElementById("finalSummaryRevision");
    const preview = document.getElementById("revisionPreview");

    if (!original || !revision || !preview) return;

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
                dp[i][j] = originalWords[i] === revisedWords[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
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

    function updateLiveRevisionPreview() {
        const originalText = original.value.trim();
        const revisedText = revision.value.trim();

        if (!originalText || !revisedText) {
            preview.textContent = "Start revising your summary above to see your changes here.";
            return;
        }

        if (originalText === revisedText) {
            preview.textContent = "No revisions yet. Changes will appear here as you edit.";
            return;
        }

        preview.innerHTML = buildSimpleDiff(originalText, revisedText);

        saveState();
        updateUnlocks();
    }

    original.addEventListener("input", updateLiveRevisionPreview);
    revision.addEventListener("input", updateLiveRevisionPreview);

    updateLiveRevisionPreview();
}

/* ============================================================
    Auto Size Textareas and Print Copies
  ============================================================ */

function resizeTextareaToFit(textarea) {
    if (!textarea) return;

    textarea.style.height = "auto";

    requestAnimationFrame(() => {
        textarea.style.height = `${textarea.scrollHeight + 16}px`;
    });
}

function resizeVisibleTextareas() {
    document.querySelectorAll(".tab-panel.active textarea").forEach(textarea => {
        resizeTextareaToFit(textarea);
    });
}

function initializeAutoResizeTextareas() {
    const textareas = [...document.querySelectorAll("textarea")];

    if (!textareas.length) return;

    function resizeAllTextareas() {
        textareas.forEach(resizeTextareaToFit);
    }

    textareas.forEach(textarea => {
        resizeTextareaToFit(textarea);

        textarea.addEventListener("input", () => {
            resizeTextareaToFit(textarea);
        });

        textarea.addEventListener("change", () => {
            resizeTextareaToFit(textarea);
        });
    });

    setTimeout(resizeAllTextareas, 100);
    setTimeout(resizeAllTextareas, 500);
}

function initializePrintTextareaCopies() {
    function removeOldPrintCopies() {
        document.querySelectorAll(".print-textarea-copy").forEach(copy => copy.remove());
    }

    function createPrintCopies() {
        removeOldPrintCopies();

        document.querySelectorAll("textarea").forEach(textarea => {
            resizeTextareaToFit(textarea);

            const copy = document.createElement("div");
            copy.className = "print-textarea-copy";

            const text = textarea.value.trim();
            copy.textContent = text || "No response entered.";

            textarea.insertAdjacentElement("afterend", copy);
        });
    }

    window.addEventListener("beforeprint", createPrintCopies);
    window.addEventListener("afterprint", removeOldPrintCopies);

    const printButton = document.querySelector(".print-button");

    printButton?.addEventListener("click", event => {
        event.preventDefault();

        createPrintCopies();

        setTimeout(() => {
            window.print();
        }, 150);
    });
}

function initializePrintTitleCleanup() {
    const originalTitle = document.title;

    window.addEventListener("beforeprint", () => {
        document.title = "";
    });

    window.addEventListener("afterprint", () => {
        document.title = originalTitle;
    });
}

function initializeResetTestingButton() {
    const resetButton = document.querySelector(".reset-testing-button");
    if (!resetButton) return;

    resetButton.addEventListener("click", () => {
        const confirmed = window.confirm(
            "Reset testing progress? This clears saved answers, tab progress, and video completion for this activity."
        );

        if (!confirmed) return;

        localStorage.removeItem(STORAGE_KEYS.lesson);
        localStorage.removeItem(STORAGE_KEYS.videoGate);
        form?.reset();
        window.location.reload();
    });
}


/* ============================================================
    Generic UI Handlers
  ============================================================ */

function initializeTabs() {
    tabButtons.forEach((button, index) => {
        button.addEventListener("click", () => {
            const unlocked = state.unlockedTabs.includes(index);

            if (!unlocked) {
                reportActiveTabValidity(index);
                return;
            }

            showTab(index, true);
        });
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

function initializeTogglePanels() {
    document.querySelectorAll("[data-toggle]").forEach(button => {
        button.addEventListener("click", () => {
            const panel = document.getElementById(button.dataset.toggle);
            if (!panel) return;

            const isOpen = panel.classList.toggle("open");
            button.setAttribute("aria-expanded", String(isOpen));
            updateButtonDescription(button);

            if (button.dataset.toggle === "helpPanel") {
                const video = document.getElementById("howToVideo");
                if (!video) return;

                if (isOpen) video.play().catch(() => { });
                else video.pause();
            }
        });
    });
}

function initializeWordCounts() {
    const counters = [...document.querySelectorAll("[data-word-count-for]")];
    if (!counters.length) return;

    counters.forEach(counter => {
        const textareaId = counter.dataset.wordCountFor;
        const textarea = document.getElementById(textareaId);
        const output = counter.querySelector("span");

        if (!textarea || !output) return;

        function updateWordCount() {
            output.textContent = countWords(textarea.value);
        }

        textarea.addEventListener("input", updateWordCount);
        textarea.addEventListener("change", updateWordCount);
        updateWordCount();
    });
}

function initializeBackToTopButtons() {
    document.querySelectorAll(".back-to-top-button").forEach(button => {
        button.addEventListener("click", () => {
            window.scrollTo({
                top: 0,
                behavior: "smooth"
            });

            // Return keyboard and screen-reader users to the active tab in the
            // lesson navigation instead of leaving focus at the bottom.
            tabButtons[state.activeTab]?.focus({ preventScroll: true });
        });
    });
}

/* ============================================================
    Startup
  ============================================================ */

function initializeLesson() {
    // Restore persisted values before initializing controls that depend on them.
    loadState();
    loadVideoGateProgress();

    // Core navigation and shared interface behavior.
    initializeTabs();
    initializeFormListeners();
    initializeTogglePanels();
    initializeBackToTopButtons();

    // Activities and their feedback controls.
    initializeSentenceBuilderFeedback();
    initializeSourceMatching();
    initializeCheckAnswerButtons();
    initializeAiSummaryDraftFeedback();
    initializeSummaryNotesFeedback();
    initializeRubricRowCheck();
    initializeRevisionPromptFeedback();
    initializeChatbotSuggestionsFeedback();
    initializeFinalSummaryRevisionFeedback();

    // Keep repeated lesson content synchronized automatically.
    initializeSummaryComparisonAutofill();
    initializeOriginalSummaryAutofill();
    initializeArticleLinkTextAutofill();
    initializeFinalSummaryRevisionAutofill();
    initializeFinalSummaryRevisionDiff();

    // Accessibility runs after dynamic answer buttons have been created.
    initializeScreenReaderQuestionLabels();
    initializeNativeRequiredValidation();
    initializeButtonDescriptions();

    // Video, text sizing, and print helpers.
    initializeYouTubeVideoGate();
    initializeLocalVideoAnnouncements();
    initializeWordCounts();
    initializeAutoResizeTextareas();
    initializePrintTextareaCopies();
    initializePrintTitleCleanup();
    initializeResetTestingButton();

    // Derive the initial interface state after every control is ready.
    updateRubricScore();
    updateUnlocks();
    showTab(state.unlockedTabs.includes(state.activeTab) ? state.activeTab : 0, false);
}

initializeLesson();
