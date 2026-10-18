import { invoke } from "@tauri-apps/api/core";

export const languages = [
  {
    key: "russian",
    label: "Russian",
    nativeName: "Русский",
    code: "RU",
    locale: "ru",
    color: "#a16f83",
    placeholder: "книга",
  },
  {
    key: "english",
    label: "English",
    nativeName: "English",
    code: "EN",
    locale: "en",
    color: "#6587a3",
    placeholder: "book",
  },
  {
    key: "german",
    label: "German",
    nativeName: "Deutsch",
    code: "DE",
    locale: "de",
    color: "#b49760",
    placeholder: "das Buch",
  },
  {
    key: "spanish",
    label: "Spanish",
    nativeName: "Español",
    code: "ES",
    locale: "es",
    color: "#bf8064",
    placeholder: "el libro",
  },
  {
    key: "french",
    label: "French",
    nativeName: "Français",
    code: "FR",
    locale: "fr",
    color: "#849a7c",
    placeholder: "le livre",
  },
] as const;

export type LanguageKey = (typeof languages)[number]["key"];
export type NewEntry = Record<LanguageKey, string>;
export type VocabularyEntry = NewEntry & { id: number; created_at: string };
export const emptyEntry: NewEntry = {
  russian: "",
  english: "",
  german: "",
  spanish: "",
  french: "",
};

export function listEntries() {
  return invoke<VocabularyEntry[]>("list_entries");
}
export function addEntry(entry: NewEntry) {
  return invoke<VocabularyEntry>("add_entry", { entry });
}
