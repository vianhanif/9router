/**
 * Dedup — Prevent duplicate memory entries.
 * 
 * Checks if an entry is a near-duplicate of an existing entry.
 * Uses simple string similarity (Jaccard on words) for fast comparison.
 */

/**
 * Check if a new entry is a near-duplicate of existing content.
 * 
 * @param {string} existingContent - current memory content
 * @param {string} newEntry - new entry to check
 * @param {number} threshold - similarity threshold (0.0 to 1.0), default 0.6
 * @returns {boolean} true if near-duplicate
 */
export function isNearDuplicate(existingContent, newEntry, threshold = 0.6) {
  if (!existingContent || !newEntry) return false;

  // Normalize for comparison
  const normalize = (text) =>
    text.toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const existingNormalized = normalize(existingContent);
  const newNormalized = normalize(newEntry);

  // Exact duplicate check
  if (existingNormalized === newNormalized) return true;

  // Word-level Jaccard similarity
  const existingWords = new Set(existingNormalized.split(" "));
  const newWords = new Set(newNormalized.split(" "));

  if (existingWords.size === 0 || newWords.size === 0) return false;

  // Intersection
  const intersection = new Set([...existingWords].filter(x => newWords.has(x)));
  // Union
  const union = new Set([...existingWords, ...newWords]);

  const similarity = intersection.size / union.size;
  return similarity >= threshold;
}

/**
 * Extract a list of entries from memory content.
 * Splits on § separator.
 * 
 * @param {string} content 
 * @returns {string[]}
 */
export function parseEntries(content) {
  if (!content) return [];
  return content.split("\n§\n").map(e => e.trim()).filter(Boolean);
}

/**
 * Check if an entry would be a duplicate in existing content.
 * 
 * @param {string} existingContent 
 * @param {string} newEntry 
 * @param {number} threshold 
 * @returns {boolean}
 */
export function wouldBeDuplicate(existingContent, newEntry, threshold = 0.6) {
  const entries = parseEntries(existingContent);
  return entries.some(entry => isNearDuplicate(entry, newEntry, threshold));
}
