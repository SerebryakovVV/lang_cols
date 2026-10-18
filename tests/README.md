# Translation UI fixture

The automated component suite runs with `npm test`. `translation.test.tsx` uses Vitest, jsdom, and React Testing Library to mount the real components, mock only the Tauri IPC boundary, and control requests with fake timers. It needs no browser permissions, Python process, network access, or SQLite file.

Run the frontend with `npm run dev`, then open [the fixture](http://localhost:1420/tests/translation-ui.html) in a browser. It mounts the real `App` with Tauri's official `mockIPC` helper. All translation requests and saves are handled in memory: Python and the project's SQLite file are never used. The fixture is a separate Vite HTML entry and is excluded from the normal app bundle.

The app uses its usual 500 ms debounce. Each translation call appears in the fixture controls with its source text and language. Complete or fail requests in any order. Successful replies use `[RU reply 1]`, `[EN reply 1]`, etc. prefixes so stale output is easy to identify; the source field keeps the original text.

Useful checks:

- Type in one translation field, wait for request 1, then edit the same or another field and wait at least 500 ms. The app serializes calls: complete or fail request 1, verify that its stale result/error is ignored, then complete the newly started request 2. The inputs, status, and copy button must describe request 2. Make several edits while request 1 is pending to verify that only the newest waiting input becomes request 2. If calls become concurrent in a later implementation, complete request 2 before request 1 to verify the same stale-response protection.
- Clear the source field while its request is pending. Completing the old request must leave the fields empty and the copy button unavailable.
- Start an IME composition while a request is pending, update **Composing text**, and press **Update composing text**. No new translation should be requested during composition, and an old reply must not overwrite the composing input. **End composition** should schedule one request with the final text.
- After a completed translation, press **Use in word form**. Verify all five fields transfer. Add a different manual draft first, including when the word form is closed, and verify **Keep draft** preserves it while **Replace draft** explicitly replaces it.
- Choose **Hold saves** before saving a draft. While the save is pending, copying translations must be unavailable. Complete or fail the held save to verify that the UI resumes correctly and a failed save preserves the draft.
- Choose **Unavailable** under **Models**, then **Remount app**. Verify useful setup feedback, preserved translation source input, and an available way to check/retry after selecting **Ready**. Remounting resets app component state, while the fixture's mock collection and request history remain available.

**Reset fixture** reloads the page and clears all mock entries and requests. **Remount app** only resets the app's state. React Strict Mode is enabled to match development behavior, so model-status/collection reads can occur twice on initial mounting.

The IME helpers send DOM composition/input events through the real translation input. They exercise the component's event handlers; a real IME session is still useful for confirming platform-specific browser event ordering.
