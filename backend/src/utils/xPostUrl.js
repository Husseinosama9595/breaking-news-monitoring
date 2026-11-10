const X_POST_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

/** Return a canonical safe public X/Twitter URL, or null for anything else. */
export function safeXPostUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !X_POST_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}
