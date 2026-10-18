import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import TranslationPanel from "../src/components/TranslationPanel";
import {
  emptyEntry,
  languages,
  type NewEntry,
  type VocabularyEntry,
} from "../src/lib/vocabulary";
import type { TranslationLanguage } from "../src/lib/translation";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ipc);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: string) => void;
};
type TranslationCall = {
  text: string;
  sourceLanguage: TranslationLanguage;
  deferred: Deferred<NewEntry>;
};
type SaveCall = { entry: NewEntry; deferred?: Deferred<VocabularyEntry> };

let translationCalls: TranslationCall[];
let saveCalls: SaveCall[];
let collection: VocabularyEntry[];
let modelsReady: boolean;
let saveMode: "success" | "failure" | "held";
let nextEntryId: number;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function replies(call: TranslationCall): NewEntry {
  const result = { ...emptyEntry };
  for (const language of languages) {
    result[language.key] =
      language.locale === call.sourceLanguage
        ? call.text.trim()
        : `[${language.code}] ${call.text.trim()}`;
  }
  return result;
}

function saved(entry: NewEntry): VocabularyEntry {
  const result = {
    ...entry,
    id: ++nextEntryId,
    created_at: "2026-10-14T00:00:00.000Z",
  };
  collection.unshift(result);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  translationCalls = [];
  saveCalls = [];
  collection = [];
  modelsReady = true;
  saveMode = "success";
  nextEntryId = 0;
  ipc.invoke.mockReset();
  ipc.isTauri.mockReset().mockReturnValue(true);
  ipc.invoke.mockImplementation(
    (command: string, payload?: Record<string, unknown>) => {
      switch (command) {
        case "translation_status":
          return Promise.resolve({
            ready: modelsReady,
            message: modelsReady
              ? "Offline translation is ready."
              : "Offline models are missing. Run npm run setup:translation.",
          });
        case "translate_text": {
          const call = {
            ...(payload as {
              text: string;
              sourceLanguage: TranslationLanguage;
            }),
            deferred: deferred<NewEntry>(),
          };
          translationCalls.push(call);
          return call.deferred.promise;
        }
        case "list_entries":
          return Promise.resolve(collection.map((entry) => ({ ...entry })));
        case "add_entry": {
          const call: SaveCall = { entry: { ...(payload!.entry as NewEntry) } };
          saveCalls.push(call);
          if (saveMode === "held") {
            call.deferred = deferred<VocabularyEntry>();
            return call.deferred.promise;
          }
          if (saveMode === "failure")
            return Promise.reject("Fixture save failed.");
          return Promise.resolve(saved(call.entry));
        }
        default:
          return Promise.reject(`Unexpected mocked IPC command: ${command}`);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
  });
}

async function renderPanel() {
  const onTransfer = vi.fn();
  const onEdit = vi.fn();
  const mounted = render(
    <StrictMode>
      <TranslationPanel canTransfer onTransfer={onTransfer} onEdit={onEdit} />
    </StrictMode>,
  );
  await flush();
  return { ...mounted, onTransfer, onEdit };
}

async function renderApp() {
  const mounted = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await flush();
  return mounted;
}

function translationInput(label: string): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement;
}

function copyButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /Use in word form/,
  }) as HTMLButtonElement;
}

function wordInput(language: string): HTMLInputElement {
  const form = screen.getByRole("region", { name: "A new word" });
  return within(form).getByRole("textbox", {
    name: new RegExp(`^${language}`),
  }) as HTMLInputElement;
}

async function completeTranslation(
  index: number,
  result = replies(translationCalls[index]),
) {
  await act(async () => {
    translationCalls[index].deferred.resolve(result);
  });
}

async function makeTranslation(text = "book") {
  fireEvent.change(translationInput("Translate English EN"), {
    target: { value: text },
  });
  await advance(500);
  const index = translationCalls.length - 1;
  await completeTranslation(index);
  return index;
}

describe("live translation requests", () => {
  it("debounces edits, preserves the exact source, and never translates returned fields again", async () => {
    await renderPanel();
    const english = translationInput("Translate English EN");
    fireEvent.change(english, { target: { value: "book" } });
    await advance(499);
    expect(translationCalls).toHaveLength(0);
    fireEvent.change(english, { target: { value: "  café\nplease  " } });
    await advance(499);
    expect(translationCalls).toHaveLength(0);
    await advance(1);
    expect(translationCalls).toHaveLength(1);
    expect(translationCalls[0].text).toBe("  café\nplease  ");
    expect(translationCalls[0].sourceLanguage).toBe("en");
    expect(copyButton().disabled).toBe(true);
    await completeTranslation(0);
    expect(english.value).toBe("  café\nplease  ");
    expect(translationInput("Translate Russian RU").value).toBe(
      "[RU] café\nplease",
    );
    expect(copyButton().disabled).toBe(false);
    await advance(1000);
    expect(translationCalls).toHaveLength(1);
  });

  it("keeps only the newest queued input and ignores the older result across source-language changes", async () => {
    await renderPanel();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "first" },
    });
    await advance(500);
    fireEvent.change(translationInput("Translate Russian RU"), {
      target: { value: "второй" },
    });
    await advance(500);
    fireEvent.change(translationInput("Translate German DE"), {
      target: { value: "  Grüße!  " },
    });
    await advance(500);
    expect(translationCalls).toHaveLength(1);
    await completeTranslation(0);
    expect(translationCalls).toHaveLength(2);
    expect(translationCalls[1].text).toBe("  Grüße!  ");
    expect(translationCalls[1].sourceLanguage).toBe("de");
    expect(translationInput("Translate English EN").value).toBe("");
    expect(translationInput("Translate Russian RU").value).toBe("");
    expect(translationInput("Translate German DE").value).toBe("  Grüße!  ");
    expect(copyButton().disabled).toBe(true);
    await completeTranslation(1);
    expect(translationInput("Translate English EN").value).toBe("[EN] Grüße!");
    expect(translationInput("Translate German DE").value).toBe("  Grüße!  ");
    expect(copyButton().disabled).toBe(false);
  });

  it("ignores a stale failure and still dispatches the latest queued input", async () => {
    await renderPanel();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "old" },
    });
    await advance(500);
    fireEvent.change(translationInput("Translate Spanish ES"), {
      target: { value: "nuevo" },
    });
    await advance(500);
    await act(async () => {
      translationCalls[0].deferred.reject("Old request failed.");
    });
    expect(screen.queryByText("Old request failed.")).toBeNull();
    expect(translationCalls).toHaveLength(2);
    expect(translationCalls[1].sourceLanguage).toBe("es");
    expect(translationInput("Translate Spanish ES").value).toBe("nuevo");
    expect(copyButton().disabled).toBe(true);
    await completeTranslation(1);
    expect(copyButton().disabled).toBe(false);
  });

  it("clears pending work and prevents its result from restoring cleared fields", async () => {
    await renderPanel();
    fireEvent.change(translationInput("Translate French FR"), {
      target: { value: "bonjour" },
    });
    await advance(500);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await completeTranslation(0);
    for (const language of languages) {
      expect(
        translationInput(`Translate ${language.label} ${language.code}`).value,
      ).toBe("");
    }
    expect(copyButton().disabled).toBe(true);
    expect(screen.getByText("Type in any field to get started")).toBeTruthy();
    await advance(1000);
    expect(translationCalls).toHaveLength(1);
  });

  it("invalidates old replies during IME composition and translates final text exactly once", async () => {
    await renderPanel();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "old" },
    });
    await advance(500);
    const russian = translationInput("Translate Russian RU");
    fireEvent.compositionStart(russian);
    fireEvent.change(russian, { target: { value: "нов" } });
    await advance(700);
    expect(translationCalls).toHaveLength(1);
    await completeTranslation(0);
    expect(russian.value).toBe("нов");
    expect(translationInput("Translate English EN").value).toBe("");
    fireEvent.change(russian, { target: { value: "новое слово" } });
    await advance(700);
    expect(translationCalls).toHaveLength(1);
    fireEvent.compositionEnd(russian, { data: "новое слово" });
    fireEvent.input(russian, {
      target: { value: "новое слово" },
      isComposing: false,
    });
    await advance(499);
    expect(translationCalls).toHaveLength(1);
    await advance(1);
    expect(translationCalls).toHaveLength(2);
    expect(translationCalls[1].text).toBe("новое слово");
    expect(translationCalls[1].sourceLanguage).toBe("ru");
    await completeTranslation(1);
    expect(russian.value).toBe("новое слово");
    expect(copyButton().disabled).toBe(false);
    await advance(1000);
    expect(translationCalls).toHaveLength(2);
  });

  it("does not dispatch a queued translation after unmount", async () => {
    const mounted = await renderPanel();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "old" },
    });
    await advance(500);
    fireEvent.change(translationInput("Translate German DE"), {
      target: { value: "neu" },
    });
    await advance(500);
    mounted.unmount();
    await completeTranslation(0);
    expect(translationCalls).toHaveLength(1);
  });

  it("keeps the source after a current failure and retries it explicitly", async () => {
    await renderPanel();
    fireEvent.change(translationInput("Translate French FR"), {
      target: { value: "bonjour" },
    });
    await advance(500);
    await act(async () => {
      translationCalls[0].deferred.reject("Current translation failed.");
    });
    expect(screen.getByText("Current translation failed.")).toBeTruthy();
    expect(translationInput("Translate French FR").value).toBe("bonjour");
    expect(copyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry translation" }));
    await advance(500);
    expect(translationCalls).toHaveLength(2);
    expect(translationCalls[1].text).toBe("bonjour");
    await completeTranslation(1);
    expect(screen.queryByText("Current translation failed.")).toBeNull();
    expect(copyButton().disabled).toBe(false);
  });

  it("shows setup feedback and translates preserved input after models become available", async () => {
    modelsReady = false;
    await renderPanel();
    expect(
      screen.getByText(
        "Offline models are missing. Run npm run setup:translation.",
      ),
    ).toBeTruthy();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "preserved" },
    });
    await advance(1000);
    expect(translationCalls).toHaveLength(0);
    modelsReady = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    await advance(500);
    expect(translationCalls).toHaveLength(1);
    expect(translationCalls[0].text).toBe("preserved");
    await completeTranslation(0);
    expect(copyButton().disabled).toBe(false);
    expect(
      screen.queryByText(
        "Offline models are missing. Run npm run setup:translation.",
      ),
    ).toBeNull();
  });

  it("blocks transfer when a model expands a target beyond the database limit", async () => {
    const mounted = await renderPanel();
    fireEvent.change(translationInput("Translate English EN"), {
      target: { value: "short source" },
    });
    await advance(500);
    const output = replies(translationCalls[0]);
    output.german = "ä".repeat(501);
    await completeTranslation(0, output);
    expect(translationInput("Translate German DE").value).toBe(output.german);
    expect(translationInput("Translate English EN").value).toBe("short source");
    expect(
      screen.getByText(
        "A translation is longer than 500 characters. Try a shorter source sentence.",
      ),
    ).toBeTruthy();
    expect(copyButton().disabled).toBe(true);
    fireEvent.click(copyButton());
    expect(mounted.onTransfer).not.toHaveBeenCalled();
  });
});

describe("reviewing translations before saving", () => {
  it("copies all five fields without saving and requires explicit replacement of an unsaved draft", async () => {
    await renderApp();
    await makeTranslation();
    expect(saveCalls).toHaveLength(0);
    fireEvent.change(wordInput("Russian"), {
      target: { value: "ручной черновик" },
    });
    fireEvent.click(copyButton());
    expect(
      screen.getByText("Replace the unsaved words in your form?"),
    ).toBeTruthy();
    expect(wordInput("Russian").value).toBe("ручной черновик");
    expect(wordInput("English").value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(
      screen.queryByText("Replace the unsaved words in your form?"),
    ).toBeNull();
    expect(wordInput("Russian").value).toBe("ручной черновик");
    fireEvent.click(copyButton());
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    for (const language of languages) {
      expect(wordInput(language.label).value).toBe(
        replies(translationCalls[0])[language.key],
      );
    }
    expect(saveCalls).toHaveLength(0);
  });

  it("protects a closed form's draft and reopens the form only after explicit replacement", async () => {
    await renderApp();
    await makeTranslation();
    fireEvent.change(wordInput("English"), {
      target: { value: "manual draft" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Close add-word form" }),
    );
    fireEvent.click(copyButton());
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a word" }));
    expect(wordInput("English").value).toBe("manual draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Close add-word form" }),
    );
    fireEvent.click(copyButton());
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    expect(wordInput("English").value).toBe("book");
    expect(saveCalls).toHaveLength(0);
  });

  it("dismisses a replacement request when either draft is edited", async () => {
    await renderApp();
    await makeTranslation();
    fireEvent.change(wordInput("English"), {
      target: { value: "manual draft" },
    });
    fireEvent.click(copyButton());
    fireEvent.change(wordInput("French"), { target: { value: "manuel" } });
    expect(
      screen.queryByText("Replace the unsaved words in your form?"),
    ).toBeNull();
    fireEvent.click(copyButton());
    fireEvent.change(translationInput("Translate Russian RU"), {
      target: { value: "новый" },
    });
    expect(
      screen.queryByText("Replace the unsaved words in your form?"),
    ).toBeNull();
    expect(wordInput("English").value).toBe("manual draft");
    expect(wordInput("French").value).toBe("manuel");
  });

  it("keeps the copied draft when saving fails", async () => {
    await renderApp();
    await makeTranslation();
    fireEvent.click(copyButton());
    saveMode = "failure";
    fireEvent.click(screen.getByRole("button", { name: "Save word" }));
    await flush();
    expect(screen.getByText("Fixture save failed.")).toBeTruthy();
    expect(saveCalls).toHaveLength(1);
    for (const language of languages) {
      expect(wordInput(language.label).value).toBe(
        saveCalls[0].entry[language.key],
      );
    }
    expect(collection).toHaveLength(0);
    expect(copyButton().disabled).toBe(false);
  });

  it("blocks copying during a pending save and preserves the draft if that save fails", async () => {
    await renderApp();
    await makeTranslation();
    fireEvent.click(copyButton());
    saveMode = "held";
    fireEvent.click(screen.getByRole("button", { name: "Save word" }));
    expect(saveCalls).toHaveLength(1);
    expect(copyButton().disabled).toBe(true);
    expect(wordInput("English").disabled).toBe(false);
    expect(wordInput("English").closest("fieldset")!.disabled).toBe(true);
    fireEvent.click(copyButton());
    expect(wordInput("English").value).toBe("book");
    await act(async () => {
      saveCalls[0].deferred!.reject("Held save failed.");
    });
    expect(screen.getByText("Held save failed.")).toBeTruthy();
    expect(wordInput("English").value).toBe("book");
    expect(wordInput("English").closest("fieldset")!.disabled).toBe(false);
    expect(copyButton().disabled).toBe(false);
    expect(collection).toHaveLength(0);
  });

  it("saves only after the explicit save action and then clears the reviewed draft", async () => {
    await renderApp();
    await makeTranslation();
    fireEvent.click(copyButton());
    expect(saveCalls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save word" }));
    await flush();
    expect(saveCalls).toHaveLength(1);
    expect(collection).toHaveLength(1);
    for (const language of languages)
      expect(wordInput(language.label).value).toBe("");
    expect(screen.getByText("Word added to your collection.")).toBeTruthy();
    expect(screen.getByRole("table").textContent).toContain("[RU] book");
  });
});
