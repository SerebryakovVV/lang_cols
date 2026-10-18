import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import TranslationPanel from "./components/TranslationPanel";
import {
  addEntry,
  emptyEntry,
  languages,
  listEntries,
  type NewEntry,
  type VocabularyEntry,
} from "./lib/vocabulary";
import "./App.css";

function Icon({
  name,
  className = "",
}: {
  name: "plus" | "search" | "book" | "close" | "check" | "arrow";
  className?: string;
}) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    book: (
      <>
        <path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z" />
        <path d="M12 6v14" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  };
  return (
    <svg
      className={`icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [entries, setEntries] = useState<VocabularyEntry[]>([]);
  const [draft, setDraft] = useState<NewEntry>(emptyEntry);
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingTranslation, setPendingTranslation] = useState<NewEntry | null>(
    null,
  );
  const firstInput = useRef<HTMLInputElement>(null);
  const ready = !loading && !loadError;
  const hasWord = languages.some(({ key }) => draft[key].trim());

  function useTranslation(entry: NewEntry) {
    setDraft({ ...entry });
    setFormOpen(true);
    setFormError("");
    setPendingTranslation(null);
    setNotice("Translations copied to the form. Review them before saving.");
    requestAnimationFrame(() => firstInput.current?.focus());
  }

  function requestTranslationTransfer(entry: NewEntry) {
    if (hasWord && languages.some(({ key }) => draft[key] !== entry[key])) {
      setPendingTranslation({ ...entry });
    } else {
      useTranslation(entry);
    }
  }

  async function loadCollection() {
    setLoading(true);
    setLoadError("");
    try {
      if (!isTauri())
        throw new Error(
          "Open the desktop app with npm run tauri dev to use your local vocabulary database.",
        );
      setEntries(await listEntries());
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCollection();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !ready) return;
    if (!hasWord) {
      setFormError("Enter a word in at least one language.");
      firstInput.current?.focus();
      return;
    }
    setSaving(true);
    setPendingTranslation(null);
    setFormError("");
    setNotice("");
    try {
      const entry = await addEntry(draft);
      setEntries((current) => [entry, ...current]);
      setDraft({ ...emptyEntry });
      setQuery("");
      setNotice("Word added to your collection.");
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
      requestAnimationFrame(() => firstInput.current?.focus());
    }
  }

  const search = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter((entry) =>
    languages.some(({ key }) =>
      entry[key].toLocaleLowerCase().includes(search),
    ),
  );
  const completeCount = entries.filter((entry) =>
    languages.every(({ key }) => entry[key].trim()),
  ).length;

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="#collection"
          aria-label="Lang Cols vocabulary collection"
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            lang<span className="brand-light">cols</span>
            <span className="brand-period">.</span>
          </span>
        </a>
        <div className="header-detail">
          <span className="status-dot" /> A little learning, every day
        </div>
        <span className="private-badge">
          <Icon name="book" /> My vocabulary
        </span>
      </header>
      <main id="collection">
        <section
          className="collection-intro"
          aria-labelledby="collection-title"
        >
          <div>
            <p className="eyebrow">ONE WORD. FIVE PERSPECTIVES.</p>
            <h1 id="collection-title">
              Words worth keeping<span>.</span>
            </h1>
            <p className="intro-copy">
              Your personal collection, across five languages.
            </p>
          </div>
          <button
            className="button button-primary add-button"
            onClick={() => {
              setFormOpen(true);
              requestAnimationFrame(() => firstInput.current?.focus());
            }}
            disabled={!ready || saving}
          >
            <Icon name="plus" /> Add a word
          </button>
        </section>
        {loadError && (
          <div className="error-banner" role="alert">
            <div>
              <strong>Couldn’t open your collection</strong>
              <p>{loadError}</p>
            </div>
            {isTauri() && (
              <button
                className="button button-secondary"
                onClick={() => void loadCollection()}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <TranslationPanel
          canTransfer={ready && !saving}
          onTransfer={requestTranslationTransfer}
          onEdit={() => setPendingTranslation(null)}
        />
        {pendingTranslation && (
          <div
            className="transfer-confirmation"
            role="group"
            aria-labelledby="transfer-heading"
          >
            <div>
              <strong id="transfer-heading">
                Replace the unsaved words in your form?
              </strong>
              <p>
                Copy all five translations into the form, replacing its current
                text.
              </p>
            </div>
            <div className="translation-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={saving}
                onClick={() => setPendingTranslation(null)}
              >
                Keep draft
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={saving}
                onClick={() => useTranslation(pendingTranslation)}
              >
                Replace draft
              </button>
            </div>
          </div>
        )}
        {formOpen && (
          <section className="entry-card" aria-labelledby="entry-heading">
            <div className="entry-heading">
              <div>
                <h2 id="entry-heading">A new word</h2>
                <p>
                  Add the translations you know. You can leave others blank.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close add-word form"
                onClick={() => setFormOpen(false)}
                disabled={saving}
              >
                <Icon name="close" />
              </button>
            </div>
            <form
              onSubmit={(event) => void handleSubmit(event)}
              aria-describedby="entry-help"
            >
              <fieldset disabled={saving || !ready}>
                <legend className="sr-only">Word translations</legend>
                <div className="entry-fields">
                  {languages.map((language, index) => (
                    <div
                      className="entry-field"
                      key={language.key}
                      style={
                        { "--language-color": language.color } as CSSProperties
                      }
                    >
                      <label htmlFor={`word-${language.key}`}>
                        <span className="language-dot" />
                        {language.label}
                        <span className="field-code">{language.code}</span>
                      </label>
                      <input
                        ref={index === 0 ? firstInput : undefined}
                        id={`word-${language.key}`}
                        name={language.key}
                        lang={language.locale}
                        maxLength={500}
                        value={draft[language.key]}
                        placeholder={language.placeholder}
                        autoComplete="off"
                        onChange={(event) => {
                          setPendingTranslation(null);
                          setDraft((current) => ({
                            ...current,
                            [language.key]: event.target.value,
                          }));
                          setFormError("");
                          setNotice("");
                        }}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="entry-footer">
                <p id="entry-help">
                  <span className="tiny-dot" /> A word or a short sentence · at
                  least one language
                </p>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={!ready || saving}
                >
                  {saving ? "Saving…" : "Save word"}
                  <Icon name="arrow" />
                </button>
              </div>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
            </form>
          </section>
        )}
        <div className="collection-toolbar">
          <div className="collection-label">
            <h2>Your collection</h2>
            <span className="count-badge">{entries.length}</span>
          </div>
          <div className="search-field">
            <Icon name="search" />
            <label className="sr-only" htmlFor="search">
              Search all five languages
            </label>
            <input
              id="search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a word in any language…"
              disabled={!ready}
            />
          </div>
        </div>
        <section
          className="collection-table"
          aria-label="Vocabulary in five languages"
          aria-busy={loading}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {languages.map((language) => (
                    <th
                      scope="col"
                      key={language.key}
                      style={
                        { "--language-color": language.color } as CSSProperties
                      }
                    >
                      <div className="column-title">
                        <span className="language-code">{language.code}</span>
                        <span>
                          {language.label}
                          <small lang={language.locale}>
                            {language.nativeName}
                          </small>
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => (
                  <tr key={entry.id}>
                    {languages.map((language) => (
                      <td key={language.key} lang={language.locale}>
                        {entry[language.key] || (
                          <span
                            className="missing-word"
                            aria-label="No translation yet"
                          >
                            —
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {!visibleEntries.length && (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      <div className="empty-state">
                        <span className="empty-icon">
                          <Icon name={search ? "search" : "book"} />
                        </span>
                        <h3>
                          {loading
                            ? "Opening your collection…"
                            : loadError
                              ? "Your collection is unavailable"
                              : search
                                ? "No words found"
                                : "Every language starts with a word."}
                        </h3>
                        <p>
                          {loading
                            ? "Getting your saved words ready."
                            : loadError
                              ? "Once the database is available, your words will appear here."
                              : search
                                ? "Try another spelling or search in a different language."
                                : "Add your first word above and start making connections."}
                        </p>
                        {search && (
                          <button
                            className="text-button"
                            onClick={() => setQuery("")}
                          >
                            Clear search <Icon name="arrow" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              {search
                ? `${visibleEntries.length} of ${entries.length}`
                : entries.length}{" "}
              {entries.length === 1 ? "word" : "words"}
              {search ? " shown" : " in your collection"}
            </span>
            <span>{completeCount} in all five languages</span>
          </div>
        </section>
        <footer className="app-footer">
          <span className="local-status">
            <span className={`status-dot ${!ready ? "status-muted" : ""}`} />
            {loading
              ? "Opening local collection"
              : ready
                ? "Saved locally on your computer"
                : "Local collection disconnected"}
          </span>
          <span>Small steps. More words. A wider world.</span>
        </footer>
        <div className="save-notice" role="status" aria-live="polite">
          {notice && (
            <>
              <Icon name="check" />
              {notice}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
