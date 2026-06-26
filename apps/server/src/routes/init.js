import { initTranslators } from "@9router/core/translator/index.js";

let initialized = false;

/**
 * Initialize translators once.
 */
export async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}
