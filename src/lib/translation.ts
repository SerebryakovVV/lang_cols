import { invoke } from "@tauri-apps/api/core";
import type { NewEntry } from "./vocabulary";

export type TranslationLanguage = "ru" | "en" | "de" | "es" | "fr";
export type TranslationStatus = { ready: boolean; message: string };

export function translationStatus() {
  return invoke<TranslationStatus>("translation_status");
}

export function translateText(
  text: string,
  sourceLanguage: TranslationLanguage,
) {
  return invoke<NewEntry>("translate_text", { text, sourceLanguage });
}
