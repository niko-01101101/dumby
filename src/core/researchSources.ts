// Reddit was tried here and dropped: its unauthenticated listing endpoints
// are hard-blocked by Reddit's network policy regardless of User-Agent/OAuth
// scope, and even its more lenient search RSS endpoint escalates from
// rate-limited to a hard network-level block under real usage — not
// reliable enough to depend on for an unattended research command.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[ERROR] Missing required env var: ${name}`);
  return value;
}

const BROWSER_USER_AGENT = "Mozilla/5.0 (compatible; dumby-content-creator/1.0)";

// None of the fetch() calls below had any timeout — a stalled connection
// hangs the awaiting research command forever with no error, which looks
// from the AI loop's side like it just stopped mid-turn instead of failing.
const FETCH_TIMEOUT_MS = 20_000;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXmlEntities(stripCdata((m[1] ?? "").trim())) : "";
}

// ---- News (Google News RSS, keyless) ----

export async function searchNews(query: string, limit = 10): Promise<string> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`News search failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, limit)
    .map((m) => {
      const block = m[1] ?? "";
      const title = tagText(block, "title");
      const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "";
      return link ? `${title} - ${link}` : title;
    });

  return items.length ? items.join("\n") : "No results found";
}

// ---- Hacker News (Algolia search API, keyless) ----

interface AlgoliaHNHit {
  title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  objectID: string;
}
interface AlgoliaHNResponse { hits: AlgoliaHNHit[] }

function formatHNHits(hits: AlgoliaHNHit[]): string {
  if (!hits.length) return "No results found";
  return hits
    .map((h) => {
      const url = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
      return `${h.title ?? "(untitled)"} (${h.points ?? 0} pts, ${h.num_comments ?? 0} comments) - ${url}`;
    })
    .join("\n");
}

export async function searchHackerNews(query: string, limit = 10): Promise<string> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Hacker News search failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as AlgoliaHNResponse;
  return formatHNHits(data.hits.slice(0, limit));
}

export async function fetchHackerNewsTrends(limit = 10): Promise<string> {
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Hacker News trends failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as AlgoliaHNResponse;
  return formatHNHits(data.hits.slice(0, limit));
}

// ---- Google Trends (undocumented but stable RSS export, keyless) ----

export async function fetchGoogleTrends(geo = "US", limit = 10): Promise<string> {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google Trends request failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, limit)
    .map((m) => {
      const block = m[1] ?? "";
      const title = tagText(block, "title");
      const traffic = tagText(block, "ht:approx_traffic");
      const newsTitle = tagText(block, "ht:news_item_title");
      const newsUrl = tagText(block, "ht:news_item_url");
      const suffix = newsTitle ? ` — related: ${newsTitle}${newsUrl ? ` - ${newsUrl}` : ""}` : "";
      return `${title}${traffic ? ` (~${traffic} searches)` : ""}${suffix}`;
    });

  return items.length ? items.join("\n") : "No results found";
}

// ---- YouTube trending (official Data API v3, API key only) ----

interface YouTubeVideoItem {
  id: string;
  snippet: { title: string; channelTitle: string };
  statistics?: { viewCount?: string };
}
interface YouTubeVideosResponse { items: YouTubeVideoItem[] }

export async function fetchYouTubeTrending(regionCode = "US", limit = 10): Promise<string> {
  const apiKey = requireEnv("YOUTUBE_API_KEY");
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${encodeURIComponent(regionCode)}&maxResults=${limit}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`YouTube trending request failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as YouTubeVideosResponse;
  if (!data.items.length) return "No results found";
  return data.items
    .map((v) => `${v.snippet.title} (${v.snippet.channelTitle}, ${v.statistics?.viewCount ?? "?"} views) - https://youtube.com/watch?v=${v.id}`)
    .join("\n");
}
