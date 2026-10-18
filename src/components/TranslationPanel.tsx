import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  emptyEntry,
  languages,
  type LanguageKey,
  type NewEntry,
} from "../lib/vocabulary";
import {
  translateText,
  translationStatus,
  type TranslationLanguage,
} from "../lib/translation";

type Request = { revision: number; text: string; source: LanguageKey };
type Props = {
  canTransfer: boolean;
  onTransfer: (entry: NewEntry) => void;
  onEdit: () => void;
};

export default function TranslationPanel({
  canTransfer,
  onTransfer,
  onEdit,
}: Props) {
  const [values, setValues] = useState<NewEntry>({ ...emptyEntry });
  const [source, setSource] = useState<LanguageKey | null>(null);
  const [revision, setRevision] = useState(0);
  const [composing, setComposing] = useState(false);
  const [engine, setEngine] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [engineError, setEngineError] = useState("");
  const [engineAttempt, setEngineAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [translated, setTranslated] = useState(false);
  const [error, setError] = useState("");
  const currentRevision = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef<Request | null>(null);
  const mounted = useRef(true);
  const text = source ? values[source] : "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queued.current = null;
      currentRevision.current++;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEngine("loading");
    setEngineError("");
    async function initialize() {
      try {
        if (!isTauri())
          throw new Error("Open the desktop app to use offline translation.");
        const status = await translationStatus();
        if (cancelled) return;
        setEngine(status.ready ? "ready" : "error");
        setEngineError(status.ready ? "" : status.message);
      } catch (failure) {
        if (cancelled) return;
        setEngine("error");
        setEngineError(String(failure));
      }
    }
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [engineAttempt]);

  async function dispatch(request: Request) {
    if (!mounted.current || request.revision !== currentRevision.current)
      return;
    inFlight.current = true;
    try {
      const locale = languages.find(({ key }) => key === request.source)!
        .locale as TranslationLanguage;
      const result = await translateText(request.text, locale);
      if (!mounted.current || request.revision !== currentRevision.current)
        return;
      setValues({ ...result, [request.source]: request.text });
      if (languages.some(({ key }) => [...result[key]].length > 500)) {
        setError(
          "A translation is longer than 500 characters. Try a shorter source sentence.",
        );
        setTranslated(false);
      } else {
        setTranslated(true);
        setError("");
      }
      setBusy(false);
    } catch (failure) {
      if (!mounted.current || request.revision !== currentRevision.current)
        return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setTranslated(false);
      setBusy(false);
    } finally {
      inFlight.current = false;
      const next = queued.current;
      queued.current = null;
      if (next && mounted.current && next.revision === currentRevision.current)
        void dispatch(next);
    }
  }

  useEffect(() => {
    if (!source || !text.trim() || composing || engine !== "ready") return;
    const request: Request = {
      revision: currentRevision.current,
      text,
      source,
    };
    const timer = setTimeout(() => {
      if (request.revision !== currentRevision.current) return;
      // Keep just the latest waiting input while the local engine is working.
      if (inFlight.current) queued.current = request;
      else void dispatch(request);
    }, 500);
    return () => clearTimeout(timer);
    // Result fields do not schedule another translation; only an explicit edit does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, composing, engine]);

  function invalidate() {
    currentRevision.current++;
    queued.current = null;
    setRevision(currentRevision.current);
    setTranslated(false);
    setError("");
    onEdit();
  }

  function edit(key: LanguageKey, value: string) {
    invalidate();
    setSource(value.trim() ? key : null);
    setValues({ ...emptyEntry, [key]: value });
    setBusy(Boolean(value.trim()));
  }

  function clear() {
    invalidate();
    setValues({ ...emptyEntry });
    setSource(null);
    setBusy(false);
  }

  const statusText =
    engine === "loading"
      ? "Loading the local translator…"
      : engine === "error"
        ? "Local translator unavailable"
        : error
          ? "Translation needs another try"
          : busy
            ? "Translating…"
            : translated
              ? "Ready to review and save"
              : "Type in any field to get started";

  return (
    <section className="translation-card" aria-labelledby="translation-heading">
      <div className="entry-heading">
        <div>
          <h2 id="translation-heading">Try a translation</h2>
          <p>Type in any language. The other four will follow.</p>
        </div>
        <span className="offline-badge">
          <span className="status-dot" /> Argos · offline
        </span>
      </div>
      <div className="entry-fields">
        {languages.map((language, index) => (
          <div
            className={`entry-field translation-field ${source === language.key ? "is-source" : ""}`}
            key={language.key}
            style={{ "--language-color": language.color } as CSSProperties}
          >
            <label htmlFor={`translate-${language.key}`}>
              <span className="language-dot" />
              {language.label}
              <span className="field-code">
                {source === language.key ? "SOURCE" : language.code}
              </span>
            </label>
            <textarea
              id={`translate-${language.key}`}
              aria-label={`Translate ${language.label} ${language.code}`}
              lang={language.locale}
              rows={3}
              maxLength={500}
              value={values[language.key]}
              placeholder={language.placeholder}
              spellCheck={false}
              autoFocus={index === 0}
              onChange={(event) => edit(language.key, event.target.value)}
              onCompositionStart={() => {
                invalidate();
                setComposing(true);
                setBusy(true);
              }}
              onCompositionEnd={(event) => {
                setComposing(false);
                edit(language.key, event.currentTarget.value);
              }}
            />
          </div>
        ))}
      </div>
      <div className="translation-footer">
        <p className="translation-status" role="status" aria-live="polite">
          <span
            className={
              engine === "loading" || (busy && engine === "ready")
                ? "translation-spinner"
                : "tiny-dot"
            }
            aria-hidden="true"
          />
          {statusText}
        </p>
        <div className="translation-actions">
          <button
            type="button"
            className="text-button"
            onClick={clear}
            disabled={!languages.some(({ key }) => values[key])}
          >
            Clear
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={
              !canTransfer ||
              !translated ||
              busy ||
              composing ||
              engine !== "ready"
            }
            onClick={() => onTransfer({ ...values })}
          >
            Use in word form <span aria-hidden="true">↓</span>
          </button>
        </div>
      </div>
      {engineError && (
        <div className="translation-error" role="alert">
          <p>{engineError}</p>
          <button
            className="text-button"
            type="button"
            onClick={() => setEngineAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {error && (
        <div className="translation-error" role="alert">
          <p>{error}</p>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              invalidate();
              setBusy(Boolean(text.trim()));
            }}
          >
            Retry translation
          </button>
        </div>
      )}
    </section>
  );
}
