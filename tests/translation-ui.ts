/// <reference types="vite/client" />

import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../src/App";
import {
  emptyEntry,
  languages,
  type LanguageKey,
  type NewEntry,
  type VocabularyEntry,
} from "../src/lib/vocabulary";
import "../src/styles/base.css";

type TranslationCode = "ru" | "en" | "de" | "es" | "fr";
type RequestState = "pending" | "completed" | "failed";
type TranslationRequest = {
  id: number;
  text: string;
  sourceLanguage: TranslationCode;
  state: RequestState;
  resolve: (entry: NewEntry) => void;
  reject: (reason: string) => void;
};
type SaveRequest = {
  id: number;
  entry: NewEntry;
  state: RequestState;
  resolve?: (entry: VocabularyEntry) => void;
  reject?: (reason: string) => void;
};

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing fixture element: ${id}`);
  return target as T;
}

const translationRequests: TranslationRequest[] = [];
const saveRequests: SaveRequest[] = [];
const savedEntries: VocabularyEntry[] = [];
const root = createRoot(element("root"));
let mountRevision = 0;
let statusRequests = 0;
let listRequests = 0;
let modelsReady = true;
let saveMode = "success";
let lastEntryId = 0;

function translationsFor(request: TranslationRequest): NewEntry {
  const result = { ...emptyEntry };
  for (const language of languages) {
    result[language.key] =
      language.locale === request.sourceLanguage
        ? request.text.trim()
        : `[${language.code} reply ${request.id}] ${request.text.trim()}`;
  }
  return result;
}

function storedEntry(entry: NewEntry): VocabularyEntry {
  const saved = {
    ...entry,
    id: ++lastEntryId,
    created_at: new Date().toISOString(),
  };
  savedEntries.unshift(saved);
  return saved;
}

function requestCard(title: string, details: string): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "fixture-request";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = details;
  card.append(heading, body);
  return card;
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderControls() {
  element<HTMLOutputElement>("fixture-summary").textContent =
    `Translation calls: ${translationRequests.length}. Model status calls: ${statusRequests}. ` +
    `Collection reads: ${listRequests}. Save calls: ${saveRequests.length}. ` +
    `In-memory saved entries: ${savedEntries.length}.`;

  const translations = element("fixture-translation-requests");
  translations.replaceChildren();
  if (!translationRequests.length) {
    translations.textContent = "No translation requests yet.";
  }
  for (const request of translationRequests) {
    const card = requestCard(
      `Translation ${request.id}: ${request.state}`,
      `Source: ${request.sourceLanguage}\nText: ${request.text}`,
    );
    if (request.state === "pending") {
      const buttons = document.createElement("div");
      buttons.className = "fixture-controls";
      buttons.append(
        actionButton(`Complete translation ${request.id}`, () => {
          request.state = "completed";
          request.resolve(translationsFor(request));
          renderControls();
        }),
        actionButton(`Fail translation ${request.id}`, () => {
          request.state = "failed";
          request.reject(`Fixture translation ${request.id} failed.`);
          renderControls();
        }),
      );
      card.append(buttons);
    }
    translations.append(card);
  }

  const saves = element("fixture-save-requests");
  saves.replaceChildren();
  if (!saveRequests.length) saves.textContent = "No save requests yet.";
  for (const request of saveRequests) {
    const card = requestCard(
      `Save ${request.id}: ${request.state}`,
      languages
        .map(({ key, label }) => `${label}: ${request.entry[key]}`)
        .join("\n"),
    );
    if (request.state === "pending") {
      const buttons = document.createElement("div");
      buttons.className = "fixture-controls";
      buttons.append(
        actionButton(`Complete save ${request.id}`, () => {
          request.state = "completed";
          request.resolve?.(storedEntry(request.entry));
          renderControls();
        }),
        actionButton(`Fail save ${request.id}`, () => {
          request.state = "failed";
          request.reject?.(`Fixture save ${request.id} failed.`);
          renderControls();
        }),
      );
      card.append(buttons);
    }
    saves.append(card);
  }
}

// mockIPC replaces every backend call. isTauri() checks this separate flag in
// the installed Tauri API, so it must also be enabled in a browser fixture.
(globalThis as typeof globalThis & { isTauri: boolean }).isTauri = true;
mockIPC((command, payload) => {
  switch (command) {
    case "translation_status":
      statusRequests += 1;
      renderControls();
      return {
        ready: modelsReady,
        message: modelsReady
          ? "Fixture: local translation models are ready."
          : "Fixture: translation models are missing. Run npm run setup:translation.",
      };
    case "translate_text": {
      const { text, sourceLanguage } = payload as {
        text: string;
        sourceLanguage: TranslationCode;
      };
      return new Promise<NewEntry>((resolve, reject) => {
        translationRequests.push({
          id: translationRequests.length + 1,
          text,
          sourceLanguage,
          state: "pending",
          resolve,
          reject,
        });
        renderControls();
      });
    }
    case "list_entries":
      listRequests += 1;
      renderControls();
      return savedEntries.map((entry) => ({ ...entry }));
    case "add_entry": {
      const { entry } = payload as { entry: NewEntry };
      const request: SaveRequest = {
        id: saveRequests.length + 1,
        entry: { ...entry },
        state:
          saveMode === "held"
            ? "pending"
            : saveMode === "failure"
              ? "failed"
              : "completed",
      };
      saveRequests.push(request);
      if (saveMode === "held") {
        return new Promise<VocabularyEntry>((resolve, reject) => {
          request.resolve = resolve;
          request.reject = reject;
          renderControls();
        });
      }
      if (saveMode === "failure") {
        renderControls();
        return Promise.reject(`Fixture save ${request.id} failed.`);
      }
      const saved = storedEntry(request.entry);
      renderControls();
      return saved;
    }
    default:
      throw new Error(`Fixture has no mock for command: ${command}`);
  }
});

function mountApp() {
  root.render(
    createElement(
      StrictMode,
      null,
      createElement(App, { key: ++mountRevision }),
    ),
  );
}

element<HTMLSelectElement>("fixture-model-state").addEventListener(
  "change",
  (event) => {
    modelsReady = (event.target as HTMLSelectElement).value === "ready";
  },
);
element<HTMLSelectElement>("fixture-save-mode").addEventListener(
  "change",
  (event) => {
    saveMode = (event.target as HTMLSelectElement).value;
  },
);
element("fixture-remount").addEventListener("click", mountApp);
element("fixture-reset").addEventListener("click", () =>
  window.location.reload(),
);

function compositionInput(): HTMLInputElement | HTMLTextAreaElement {
  const key = element<HTMLSelectElement>("fixture-composition-language")
    .value as LanguageKey;
  const language = languages.find((candidate) => candidate.key === key)!;
  const accessibleName = `Translate ${language.label} ${language.code}`;
  const inputs = Array.from(
    element("root").querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    ),
  );
  const input = inputs.find((candidate) => {
    if (candidate.getAttribute("aria-label") === accessibleName) return true;
    return Array.from(candidate.labels ?? []).some(
      (label) =>
        (label.textContent ?? "").replace(/\s+/g, " ").trim() ===
        accessibleName,
    );
  });
  if (!input)
    throw new Error(
      `Could not find translation input named '${accessibleName}'.`,
    );
  return input;
}

function setComposingValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  composing: boolean,
) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: value,
      isComposing: composing,
    }),
  );
}

function compositionAction(
  action: (
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => void,
  label: string,
) {
  try {
    const input = compositionInput();
    const value = element<HTMLInputElement>("fixture-composition-text").value;
    action(input, value);
    element<HTMLOutputElement>("fixture-composition-status").textContent =
      label;
  } catch (error) {
    element<HTMLOutputElement>("fixture-composition-status").textContent =
      String(error);
  }
}

element("fixture-composition-start").addEventListener("click", () => {
  compositionAction((input) => {
    input.focus();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
  }, "Composition started. Pending older translations must be ignored.");
});
element("fixture-composition-update").addEventListener("click", () => {
  compositionAction((input, value) => {
    setComposingValue(input, value, true);
    input.dispatchEvent(
      new CompositionEvent("compositionupdate", { bubbles: true, data: value }),
    );
  }, "Composing input sent. No translation request should start yet.");
});
element("fixture-composition-end").addEventListener("click", () => {
  compositionAction((input, value) => {
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: value }),
    );
    setComposingValue(input, value, false);
  }, "Composition ended. The final text should translate once after the debounce.");
});

renderControls();
mountApp();
