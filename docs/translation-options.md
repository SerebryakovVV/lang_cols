# Translation options for Lang Cols

Research date: 14 October 2026. This is the earlier provider overview. Lang Cols now implements the local Argos option; see the README for setup and current behavior.

The app needs Russian, English, German, Spanish, and French, usually for a single word or sentence. A new entry already supplies one language, so translating into all five normally means producing four translations.

## Recommended choices

| Option                                 | Account/card                                                         | Why it fits                                                                                  | Main tradeoff                                                                            |
| -------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local Argos Translate / LibreTranslate | Neither for local use                                                | Offline translation covering all five languages; a local HTTP API is easy to call from Tauri | Model downloads, Python/service packaging, and variable translation quality              |
| Local multilingual LLM with Ollama     | Neither for local models                                             | Can suggest all four translations together and later explain meanings, gender, or examples   | Larger downloads and memory needs; models can produce plausible but wrong translations   |
| Yandex Cloud Translate                 | Account, API authentication, billing; Russian-issued cards supported | Hosted translation with all five languages and RUB billing                                   | Payment setup and sending text to the cloud                                              |
| MyMemory API                           | No card/key for anonymous use                                        | A lightweight way to experiment with occasional words and short sentences                    | Request/quota limits, mixed translation-memory quality; access from Russia needs testing |

### 1. Argos Translate, optionally behind LibreTranslate

[Argos Translate](https://github.com/argosopentech/argos-translate) is an open-source offline translation library. Its supported languages include all five needed here. Download the relevant language packages first; translations then run on your own computer without an account, payment details, or sending vocabulary to a server.

If a direct language pair is unavailable, Argos can automatically translate through an intermediate language. For example, Russian → English → French needs two models and can lose meaning compared with a good direct model. Installed packages determine which routes are available.

[LibreTranslate](https://docs.libretranslate.com/) wraps Argos in a web API and can be self-hosted locally. The practical integration would be a small service bound to localhost, called through Rust. This is distinct from the public `libretranslate.com` hosted service, which requires a purchased API key. Public third-party LibreTranslate instances have their own availability and quotas.

**Best first candidate if avoiding accounts and cards is the priority.** Before integrating it, test a small set of your own words and sentences for every language pair. Packaging the local engine and its models is more work than calling a hosted API.

### 2. Ollama with a local multilingual model

[Ollama](https://docs.ollama.com/faq) can run downloaded models locally. Its documentation states that local prompts and responses are not sent to Ollama; choose a local model rather than a cloud model. Model downloads initially require internet access.

For example, [Qwen3's official language list](https://qwenlm.github.io/blog/qwen3/) includes Russian, English, German, Spanish, and French. A multilingual model could return the four target translations in one request. [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) can constrain the response to the expected JSON fields, but do not guarantee correct meanings.

This option becomes more useful if the app later adds examples, parts of speech, gender, or explanations of multiple meanings. Download size, RAM, speed, and accuracy depend on the selected model and your hardware. CPU-only use is possible but needs benchmarking on this computer.

**Best if vocabulary explanations will matter as much as translation.** Keep generated text reviewable; small models can silently choose the wrong sense or use unnatural phrasing.

### 3. Yandex Cloud Translate

[Yandex Cloud supports all five languages](https://aistudio.yandex.ru/en/docs/translate/concepts/supported-languages). Its [individual registration guide](https://yandex.cloud/ru/docs/getting-started/individuals/registration) explicitly supports Russian-issued bank cards and RUB billing, making it a more practical hosted candidate for this situation than relying on foreign billing systems. It still requires cloud authentication and a billing account.

The [published RUB price](https://aistudio.yandex.ru/ru/docs/translate/pricing) at the research date is **500.4 ₽ per million source characters, including VAT**. Translating one source into four targets multiplies the source-character usage by four. Check the current price and onboarding requirements before signing up; do not assume a permanent free allowance or a trial.

**Best hosted candidate if a Russian card and cloud setup are acceptable.** Text leaves the computer, and API credentials should remain in the Rust/backend layer rather than the React bundle.

### 4. MyMemory API

[MyMemory's official limits](https://mymemory.translated.net/doc/usagelimits.php) permit **5,000 characters per day anonymously**, or **50,000 with an email address**. Its [API specification](https://mymemory.translated.net/doc/spec.php) permits requests without a key and limits each query to **500 UTF-8 bytes**. That is fewer than 500 characters for Cyrillic or accented text, so a sentence may need a length check. Four target languages consume four requests and more of the daily allowance.

The API uses translation-memory matches and machine translation. Results can vary in quality and context. This is a convenient experiment, but reachability from the user's Russian connection has not been verified. The text is sent to a third party; anonymous access does not imply private or offline translation.

**Best for a small, no-card hosted experiment**, with quota and error handling if selected later.

## Other options

- **NLLB-200 locally:** its [official model card](https://huggingface.co/facebook/nllb-200-distilled-600M) describes multilingual single-sentence translation, which fits the input size. However, it uses CC-BY-NC 4.0 and is described as a research model not released for production deployment. It is a possible personal experiment, with extra model-runtime integration work and licensing limits if the app is later distributed commercially.
- **DeepL:** its [developer page](https://www.deepl.com/en/developers) currently advertises API Free without a credit card, so a blanket claim that it always requires one is outdated. However, Russia is explicitly listed on its [Restricted Territories page](https://www.deepl.com/en/restricted-territories). It is not a dependable recommendation for this situation.
- **Manual translation:** copying translations into the existing form works immediately and requires no API setup. Automating the scraping of consumer translator websites would be brittle and dependent on changing website behavior.

## Suggested future flow

Let the user choose the source language, enter a word or one sentence, and request translations for the other four fields. Prefer translating from the original source directly. Use an English intermediate only when a local model's installed language pairs require it.

Show editable suggestions before saving. Single words are ambiguous: an optional example sentence can distinguish a financial bank from a riverbank and help all five columns express the same meaning. Preserve language articles where useful, such as `das Buch`, `el libro`, and `le livre`.

Keep the translation engine separate from SQLite persistence so the app can switch between offline and hosted providers later. Spaced repetition can then use the reviewed, saved entries rather than temporary translation output.
