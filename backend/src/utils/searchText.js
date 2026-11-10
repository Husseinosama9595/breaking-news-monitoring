/** Escape user input before embedding it in a MongoDB regular expression. */
export function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize a search term, treating a leading X-style @ as optional. */
export function normalizeSearchTerm(value) {
  return value.trim().replace(/^@/, '').trim();
}
