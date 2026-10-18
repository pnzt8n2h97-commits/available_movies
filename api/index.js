// Vercel serverless function: Stremio manifest + catalogs for movies and TV shows.
// Each user's settings travel in the install URL: /<base64url-json>/manifest.json
// Optional env fallbacks: TMDB_KEY, RPDB_KEY, REGION, DAYS_BACK

const crypto = require("crypto");

const PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p";
const WATCH_TYPES = "flatrate|free|ads|rent|buy";

// Genre label (shown in Stremio) -> TMDB genre id. Movies and TV use different lists.
const GENRE_IDS = {
  movie: {
    Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99,
    Drama: 18, Family: 10751, Fantasy: 14, History: 36, Horror: 27, Music: 10402,
    Mystery: 9648, Romance: 10749, "Science Fiction": 878, Thriller: 53, War: 10752, Western: 37,
  },
  tv: {
    "Action and Adventure": 10759, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99,
    Drama: 18, Family: 10751, Kids: 10762, Mystery: 9648, Reality: 10764,
    "Sci-Fi and Fantasy": 10765, Soap: 10766, Talk: 10767, "War and Politics": 10768, Western: 37,
  },
};

// Single-genre installs: one pick maps to a TMDB genre id per type (null = that type has no such genre).
const GENRE_PICK = {
  Action: { movie: 28, tv: 10759 }, Adventure: { movie: 12, tv: 10759 }, Animation: { movie: 16, tv: 16 },
  Comedy: { movie: 35, tv: 35 }, Crime: { movie: 80, tv: 80 }, Documentary: { movie: 99, tv: 99 },
  Drama: { movie: 18, tv: 18 }, Family: { movie: 10751, tv: 10751 }, Fantasy: { movie: 14, tv: 10765 },
  History: { movie: 36, tv: null }, Horror: { movie: 27, tv: null }, Kids: { movie: null, tv: 10762 },
  Music: { movie: 10402, tv: null }, Mystery: { movie: 9648, tv: 9648 }, Reality: { movie: null, tv: 10764 },
  Romance: { movie: 10749, tv: null }, "Science Fiction": { movie: 878, tv: 10765 },
  Thriller: { movie: 53, tv: null }, War: { movie: 10752, tv: 10768 }, Western: { movie: 37, tv: 37 },
};

// Genre helpers: a slug per genre (used in per-genre row ids like "digital-releases--comedy") and a short label.
const slug = (g) => g.toLowerCase().replace(/\s+/g, "-");
const SLUG_TO_GENRE = Object.fromEntries(Object.keys(GENRE_PICK).map((g) => [slug(g), g]));
const genreLabel = (sel) => (sel.length <= 3 ? sel.join(" + ") : `${sel.slice(0, 2).join(" + ")} + ${sel.length - 2} more`);

// Which parts are really on: the switches, minus types that none of the picked genres exist for.
function effective(cfg) {
  const picked = cfg.genres.map((g) => GENRE_PICK[g]);
  let movies = cfg.movies && (!picked.length || picked.some((g) => g.movie));
  let shows = cfg.shows && (!picked.length || picked.some((g) => g.tv));
  if (!movies && !shows && picked.length) {
    movies = picked.some((g) => g.movie);
    shows = picked.some((g) => g.tv);
  }
  return { movies, shows };
}

function parseConfig(b64) {
  let c = {};
  if (b64) {
    try {
      c = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    } catch {
      c = {};
    }
  }
  const tmdbKey = String(c.tmdbKey || process.env.TMDB_KEY || "").trim();
  const rpdbKey = String(c.rpdbKey || process.env.RPDB_KEY || "").trim();
  const region = /^[A-Za-z]{2}$/.test(c.region || "")
    ? c.region.toUpperCase()
    : process.env.REGION || "US";
  const days = Math.min(365, Math.max(1, Number(c.days) || Number(process.env.DAYS_BACK) || 90));
  const validRpdb = /^[\w-]+$/.test(rpdbKey) ? rpdbKey : "";
  const topKey = String(c.topKey || process.env.TOPPOSTERS_KEY || "").trim();
  const validTop = /^[\w.-]+$/.test(topKey) ? topKey : "";
  // Custom template, e.g. a poster URL pattern from ERDB, XRDB, Posters+ or Pictorium.
  const tpl = String(c.posterTemplate || "").trim();
  const posterTemplate =
    tpl.length <= 1500 && /^https:\/\/[\x21-\x7e]+$/.test(tpl) && /\{(imdb_id|tmdb_id)\}/.test(tpl)
      ? tpl
      : "";
  const posterProvider = ["tmdb", "rpdb", "topposters", "custom"].includes(c.posterProvider)
    ? c.posterProvider
    : validRpdb
    ? "rpdb"
    : "tmdb";
  // Movies and shows are on unless switched off; at least one must stay on.
  let movies = c.movies !== false;
  let shows = c.shows !== false;
  if (!movies && !shows) movies = shows = true;
  // Trash TV rows: keep only known ones; empty or invalid means all of them.
  const tp = Array.isArray(c.trashParts)
    ? [...new Set(c.trashParts.filter((p) => Object.prototype.hasOwnProperty.call(TRASH, p)))]
    : [];
  const mode = c.mode === "trash" ? "trash" : c.mode === "turkish" ? "turkish" : c.mode === "docs" ? "docs" : c.mode === "all" ? "all" : "releases";
  const ar = Array.isArray(c.allRows) ? [...new Set(c.allRows.filter((k) => ALL_SERVABLE.includes(k)))] : [];
  const allRows = ar.length ? ar : ALL_ROW_KEYS.slice();
  const dp = Array.isArray(c.docsParts) ? c.docsParts.filter((p) => DOCS_PARTS.includes(p)) : [];
  const docsParts = dp.length ? DOCS_PARTS.filter((p) => dp.includes(p)) : DOCS_PARTS.slice();
  const tkp = Array.isArray(c.turkishParts) ? c.turkishParts.filter((p) => TURKISH_PARTS.includes(p)) : [];
  const turkishParts = tkp.length ? TURKISH_PARTS.filter((p) => tkp.includes(p)) : TURKISH_PARTS.slice();
  // Genres picked on the Releases tab (older links carried a single "genre"). None picked means every genre.
  const pickedGenres = [...(Array.isArray(c.genres) ? c.genres : []), c.genre].filter(
    (g) => typeof g === "string" && Object.prototype.hasOwnProperty.call(GENRE_PICK, g)
  );
  const genres = Object.keys(GENRE_PICK).filter((g) => pickedGenres.includes(g));
  // Layout: one combined row, or a separate row for each pick. Releases default to one row, Trash TV to separate rows.
  const layout = mode === "releases" ? (c.layout === "each" ? "each" : "one") : (c.layout === "one" ? "one" : "each");
  const trashParts = tp.length ? Object.keys(TRASH).filter((id) => tp.includes(id)) : Object.keys(TRASH);
  return {
    mode,
    layout,
    genres,
    trashParts,
    turkishParts,
    docsParts,
    allRows,
    tmdbKey: /^[\w.-]+$/.test(tmdbKey) ? tmdbKey : "",
    rpdbKey: validRpdb,
    topKey: validTop,
    posterProvider,
    posterTemplate,
    name: String(c.name || "").trim().slice(0, 40),
    movies,
    shows,
    region,
    days,
  };
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 86400000));
const today = () => isoDate(new Date());

// COMPATIBILITY (so installed copies keep working and never need a reinstall):
// - Never rename or remove a catalog key below, or change the URL routes. Old installs call these exact ids.
//   Per-genre rows are "<catalog id>--<genre slug>" (see slug()); keep that pattern and the slugs stable.
// - Never remove or rename a config field in parseConfig. Old install links must keep decoding the same way,
//   and any new field needs a default so older links still work.
// - Never change how the manifest id is hashed in buildManifest: a new id installs as a duplicate.
// - Changing filters, sorting, date windows or posters is safe: it reaches every install automatically.
// - Adding or renaming catalogs, genre options or names changes the manifest, so Stremio only shows
//   them after a reinstall. Avoid doing this casually.
// Each catalog = how to query TMDB. Key is "<stremio type>/<catalog id>".
const CATALOGS = {
  "movie/digital-releases": (cfg) => ({
    kind: "movie",
    path: "/discover/movie",
    params: {
      region: cfg.region,
      with_release_type: "4", // 4 = Digital
      "release_date.gte": daysAgo(cfg.days),
      "release_date.lte": today(),
      sort_by: "popularity.desc",
    },
  }),
  // TV has no "digital release", so "available" means on a streaming/rental service in the region.
  "series/streaming-new": (cfg) => ({
    kind: "tv",
    path: "/discover/tv",
    params: {
      watch_region: cfg.region,
      with_watch_monetization_types: WATCH_TYPES,
      "first_air_date.gte": daysAgo(cfg.days),
      "first_air_date.lte": today(),
      sort_by: "popularity.desc",
    },
  }),
  "series/streaming-airing": (cfg) => ({
    kind: "tv",
    path: "/discover/tv",
    params: {
      watch_region: cfg.region,
      with_watch_monetization_types: WATCH_TYPES,
      "air_date.gte": daysAgo(7),
      "air_date.lte": today(),
      sort_by: "popularity.desc",
    },
  }),
};

// "Trash TV" is its own add-on mode: Bravo-style and far trashier reality (dating shows, reality drama, daytime
// chaos, train wrecks, Turkish dramas, telenovelas), not a genre of the main one.
// Franchises are matched by show name, so no TMDB network ids are needed. Edit these lists freely.
const FRANCHISES = [
  "Real Housewives", "Below Deck", "Vanderpump Rules", "Summer House", "Southern Charm",
  "Married to Medicine", "Million Dollar Listing", "Love Island", "Love Is Blind",
  "Too Hot to Handle", "Selling Sunset", "The Bachelor", "90 Day Fiance", "Jersey Shore",
];
const GROUPS = {
  dating: [
    "Love Island", "Love Is Blind", "Too Hot to Handle", "The Bachelor", "Bachelor in Paradise",
    "Temptation Island", "Perfect Match", "The Ultimatum", "Married at First Sight", "Love After Lockup",
    "FBoy Island", "Are You the One", "Ex on the Beach", "Dated and Related", "Naked Attraction",
  ],
  drama: [
    "Jersey Shore", "Geordie Shore", "Siesta Key", "Floribama Shore", "Teen Mom", "16 and Pregnant",
    "Dance Moms", "Love & Hip Hop", "Basketball Wives", "Mob Wives", "Growing Up Hip Hop",
    "Braxton Family Values", "The Kardashians", "Keeping Up with the Kardashians", "Catfish",
    "The Challenge", "Big Brother",
  ],
  daytime: [
    "The Jerry Springer Show", "Maury", "The Steve Wilkos Show", "Dr. Phil", "Ricki Lake", "Judge Judy",
    "Judge Mathis", "Divorce Court", "The Jeremy Kyle Show", "Trisha", "Wife Swap", "Hot Bench",
  ],
  tlc: [
    "My 600-lb Life", "Hoarders", "Dr. Pimple Popper", "Sister Wives", "Toddlers & Tiaras",
    "Here Comes Honey Boo Boo", "Counting On", "19 Kids and Counting", "Welcome to Plathville",
    "Extreme Cheapskates", "Say Yes to the Dress", "The Bad Girls Club",
  ],
};
const normName = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/\s+/g, " ").trim();
const matcher = (names) => {
  const n = names.map(normName);
  return (name) => {
    const x = normName(name);
    return n.some((f) => x.includes(f));
  };
};
const matchesFranchise = matcher(FRANCHISES);
const keyHash = (k) => crypto.createHash("sha1").update(String(k)).digest("hex").slice(0, 10);

// Tiny in-memory cache (per warm serverless instance) so paging doesn't repeat many TMDB calls.
const memo = new Map();
async function memoized(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  memo.set(key, { val, exp: Date.now() + ttlMs });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return val;
}

// "Guilty-pleasure" score: hugely watched but not well rated floats to the top.
const trashScore = (m) => {
  const r = m.vote_average > 0 ? m.vote_average : m.rating > 0 ? m.rating : 6; // TMDB or TVMaze rating, else neutral
  return (m.popularity || 0) * (11 - Math.min(10, r));
};
const byTrash = (a, b) => trashScore(b) - trashScore(a);

// Builds a list from searching each franchise name; keeps only name matches, most popular first.
const searchList = (id, names) => {
  const match = matcher(names);
  return (cfg) =>
    memoized(`${id}:` + keyHash(cfg.tmdbKey), 600000, async () => {
      const lists = await Promise.all(
        names.map((f) =>
          tmdb(cfg.tmdbKey, "/search/tv", { query: f, include_adult: "false" })
            .then((d) => d.results.filter((m) => match(m.name)).slice(0, 6))
            .catch(() => [])
        )
      );
      const seen = new Set();
      return lists
        .flat()
        .filter((m) => !seen.has(m.id) && seen.add(m.id))
        .sort(byTrash)
        .slice(0, 60);
    });
};
const franchiseShows = searchList("fr", FRANCHISES);
const datingShows = searchList("dating", GROUPS.dating);
const dramaShows = searchList("drama", GROUPS.drama);
const daytimeShows = searchList("daytime", GROUPS.daytime);
const tlcShows = searchList("tlc", GROUPS.tlc);

// US reality shows with an episode in the last 14 days, filtered down to those franchises.
function franchiseOnNow(cfg) {
  return memoized("now:" + keyHash(cfg.tmdbKey), 600000, async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        tmdb(cfg.tmdbKey, "/discover/tv", {
          with_genres: "10764", // Reality
          with_origin_country: "US",
          "air_date.gte": daysAgo(14),
          "air_date.lte": today(),
          sort_by: "popularity.desc",
          page: String(page),
        })
      )
    );
    const seen = new Set();
    return pages
      .flatMap((d) => d.results)
      .filter((m) => matchesFranchise(m.name) && !seen.has(m.id) && seen.add(m.id));
  });
}

// ---- TVMaze: real TV schedules (free, no key; CC BY-SA, so the page credits TVMaze) ----
// Used for the two "On Now" rows. If TVMaze is slow, rate-limited or down, those rows fall back to TMDB.
async function tvmazeGet(path) {
  const res = await fetch(`https://api.tvmaze.com${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`TVMaze error ${res.status}`);
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Main language of each region, used to recognise region-less streaming shows.
const LANG_BY_REGION = {
  US: "English", GB: "English", CA: "English", AU: "English", DE: "German", FR: "French", ES: "Spanish",
  IT: "Italian", NL: "Dutch", SE: "Swedish", BR: "Portuguese", MX: "Spanish", IN: "Hindi",
  JP: "Japanese", KR: "Korean", TR: "Turkish",
};

// Shows that aired in the last 7 days in a region (broadcast TV and streaming).
// 14 requests in two bursts keeps us under TVMaze's ~20 calls per 10 seconds; the result is cached per region.
function tvmazeRecent(region) {
  return memoized("tvmaze:recent:" + region, 1800000, async () => {
    const jobs = [];
    for (let i = 0; i < 7; i++) {
      const d = daysAgo(i);
      jobs.push(`/schedule?country=${region}&date=${d}`);
      jobs.push(`/schedule/web?date=${d}&country=${region}`);
    }
    const lists = [];
    for (let i = 0; i < jobs.length; i += 7) {
      lists.push(...(await Promise.all(jobs.slice(i, i + 7).map((j) => tvmazeGet(j).catch(() => [])))));
      if (i + 7 < jobs.length) await sleep(1100);
    }
    const byId = new Map();
    for (const list of lists) {
      for (const ep of Array.isArray(list) ? list : []) {
        const show = ep.show || (ep._embedded && ep._embedded.show);
        if (!show || !show.id || byId.has(show.id)) continue;
        const img = show.image && (show.image.medium || show.image.original);
        const net = show.network || show.webChannel || {};
        byId.set(show.id, {
          id: show.id,
          name: show.name,
          imdbId: show.externals && show.externals.imdb,
          posterUrl: img ? String(img).replace(/^http:/, "https:") : undefined,
          overview: String(show.summary || "").replace(/<[^>]*>/g, "").trim(),
          first_air_date: show.premiered,
          popularity: show.weight || 0,
          rating: show.rating && show.rating.average,
          type: String(show.type || "").toLowerCase(),
          language: show.language,
          network: net.name || "",
          country: net.country && net.country.code,
        });
      }
    }
    if (!byId.size) throw new Error("TVMaze returned no shows"); // throwing means this isn't cached
    return [...byId.values()];
  });
}

// TMDB version of "reality shows from this region airing lately" (fallback, and used to top rows up).
function tmdbRealityOnNow(cfg) {
  return memoized("rnow:" + cfg.region + ":" + keyHash(cfg.tmdbKey), 600000, async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        tmdb(cfg.tmdbKey, "/discover/tv", {
          with_genres: "10764", // Reality
          with_origin_country: cfg.region,
          "air_date.gte": daysAgo(14),
          "air_date.lte": today(),
          sort_by: "popularity.desc",
          page: String(page),
        })
      )
    );
    const seen = new Set();
    return pages.flatMap((d) => d.results).filter((m) => !seen.has(m.id) && seen.add(m.id));
  });
}

// Tops a thin list up from extra sources (skipping repeats by name) so rows don't shrink between seasons.
// Extras are only fetched if they're needed.
async function padList(primary, extras, min = 20) {
  const seen = new Set(primary.map((m) => normName(m.name)));
  const out = [...primary];
  for (const get of extras) {
    if (out.length >= min) break;
    const list = await get().catch(() => []);
    for (const m of list) {
      const k = normName(m.name);
      if (out.length < min && !seen.has(k)) {
        seen.add(k);
        out.push(m);
      }
    }
  }
  return out;
}
const trashSorted = (list) => list.slice().sort(byTrash);

// Bravo's own recent shows plus reality franchises airing elsewhere, then topped up with recent and popular franchise shows.
async function bravoOnNow(cfg) {
  const shows = await tvmazeRecent(cfg.region).catch(() => []);
  const primary = shows
    .filter((x) => x.imdbId && (x.network === "Bravo" || (x.type === "reality" && matchesFranchise(x.name))))
    .sort(byTrash);
  return padList(primary, [() => franchiseOnNow(cfg).then(trashSorted), () => franchiseShows(cfg)], 20);
}
// Reality shows from the chosen region that aired lately, topped up from TMDB.
async function realityOnNow(cfg) {
  const shows = await tvmazeRecent(cfg.region).catch(() => []);
  const lang = LANG_BY_REGION[cfg.region];
  const primary = shows
    .filter((x) => x.imdbId && x.type === "reality" && (x.country === cfg.region || (!x.country && lang && x.language === lang)))
    .sort(byTrash)
    .slice(0, 60);
  return padList(primary, [() => tmdbRealityOnNow(cfg).then(trashSorted)], 20);
}

const TRASH = {
  bravo: { name: "Bravo Universe" },
  bravonow: { name: "Bravo Universe: On Now" },
  reality: { name: "Reality: On Now" },
  dating: { name: "Dating and Love Shows" },
  drama: { name: "Reality Drama" },
  daytime: { name: "Daytime Chaos" },
  tlc: { name: "Train Wrecks" },
  novelas: { name: "Telenovelas" },
};
// "custom" rows are hand-built lists; the others are plain TMDB discover queries.
CATALOGS["series/trash-bravo"] = () => ({ kind: "tv", custom: franchiseShows });
CATALOGS["series/trash-bravonow"] = () => ({ kind: "tv", custom: bravoOnNow });
CATALOGS["series/trash-reality"] = () => ({ kind: "tv", custom: realityOnNow });
CATALOGS["series/trash-dating"] = () => ({ kind: "tv", custom: datingShows });
CATALOGS["series/trash-drama"] = () => ({ kind: "tv", custom: dramaShows });
CATALOGS["series/trash-daytime"] = () => ({ kind: "tv", custom: daytimeShows });
CATALOGS["series/trash-tlc"] = () => ({ kind: "tv", custom: tlcShows });
// Turkish dizi: made in Turkey, in Turkish, tagged Drama or Soap.
CATALOGS["series/trash-turkish"] = () => ({
  kind: "tv",
  path: "/discover/tv",
  params: {
    with_origin_country: "TR",
    with_original_language: "tr",
    with_genres: "18|10766",
    "vote_count.gte": "5",
    sort_by: "popularity.desc",
  },
});
// Telenovelas: Spanish-language soaps.
CATALOGS["series/trash-novelas"] = () => ({
  kind: "tv",
  path: "/discover/tv",
  params: {
    with_original_language: "es",
    with_genres: "10766", // Soap
    "vote_count.gte": "5",
    sort_by: "popularity.desc",
  },
});

// One combined Trash TV row: shows from each picked row, taken in turn so every row gets a fair share.
async function partList(cfg, id) {
  const def = CATALOGS[`series/trash-${id}`](cfg);
  if (def.custom) return def.custom(cfg);
  const pages = await Promise.all(
    [1, 2].map((page) => tmdb(cfg.tmdbKey, def.path, { ...def.params, include_adult: "false", page: String(page) }))
  );
  return pages.flatMap((d) => d.results);
}
function trashMix(cfg) {
  const parts = cfg.trashParts;
  return memoized(`mix:${cfg.region}:${keyHash(cfg.tmdbKey)}:${parts.join(",")}`, 600000, async () => {
    const lists = await Promise.all(parts.map((id) => partList(cfg, id).catch(() => [])));
    const seen = new Set();
    const out = [];
    for (let i = 0; out.length < 120 && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const m = l[i];
        if (!m) continue;
        const k = normName(m.name);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    }
    return out;
  });
}
CATALOGS["series/trash-mix"] = () => ({ kind: "tv", custom: trashMix });

// Names say what's in each copy (picked rows, one combined row), so stacked copies are easy to tell apart in Stremio.
function trashName(cfg) {
  const names = cfg.trashParts.map((id) => TRASH[id].name);
  const subset = cfg.trashParts.length === Object.keys(TRASH).length ? "" : names.length <= 2 ? names.join(" + ") : `${names.length} rows`;
  const bits = [subset, cfg.layout === "one" ? "one row" : ""].filter(Boolean).join(", ");
  return `Trash TV${bits ? ": " + bits : ""}${cfg.region === "US" ? "" : ` (${cfg.region})`}`;
}

// ---- Turkish TV: its own add-on (movies, series, reality). Always Turkey, so the region setting doesn't apply. ----
const TURKISH_PARTS = ["movies", "series", "reality"];
const TURKISH_NAMES = { movies: "Turkish Movies", series: "Turkish Series", reality: "Turkish Reality" };
const turkishKey = { movies: "movie/turkish-movies", series: "series/turkish-series", reality: "series/turkish-reality" };
CATALOGS["movie/turkish-movies"] = () => ({
  kind: "movie",
  path: "/discover/movie",
  params: { with_origin_country: "TR", with_original_language: "tr", "vote_count.gte": "20", sort_by: "popularity.desc" },
});
CATALOGS["series/turkish-series"] = () => ({
  kind: "tv",
  path: "/discover/tv",
  params: { with_origin_country: "TR", with_original_language: "tr", with_genres: "18", "vote_count.gte": "20", sort_by: "popularity.desc" },
});
CATALOGS["series/turkish-reality"] = () => ({ kind: "tv", custom: turkishReality });

// Turkish reality is thin on TMDB alone, so recent Turkish reality from TVMaze's schedule tops it up.
function turkishReality(cfg) {
  return memoized("tr-reality:" + keyHash(cfg.tmdbKey), 600000, async () => {
    const base = await tmdb(cfg.tmdbKey, "/discover/tv", {
      with_origin_country: "TR",
      with_original_language: "tr",
      with_genres: "10764",
      "vote_count.gte": "3",
      sort_by: "popularity.desc",
    })
      .then((d) => d.results)
      .catch(() => []);
    const extra = await tvmazeRecent("TR")
      .then((l) => l.filter((x) => x.type === "reality" && x.imdbId))
      .catch(() => []);
    const seen = new Set();
    const out = [];
    for (const m of [...base, ...extra.sort(byTrash)]) {
      const k = normName(m.name);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(m);
      }
    }
    return out.slice(0, 60);
  });
}

// ---- Documentaries: its own add-on. Documentary films and series, plus true crime (Crime + Documentary together). ----
const DOCS_PARTS = ["docmovies", "docseries", "crimeseries", "crimemovies", "dochistory", "docmusic", "docwar", "docwarseries"];
const DOCS_NAMES = {
  docmovies: "Documentary Movies",
  docseries: "Documentary Series",
  crimeseries: "True Crime Series",
  crimemovies: "True Crime Movies",
  dochistory: "History Documentaries",
  docmusic: "Music Documentaries",
  docwar: "War Documentaries",
  docwarseries: "War and Politics Documentary Series",
};
const docsKey = {
  docmovies: "movie/docs-movies",
  docseries: "series/docs-series",
  crimeseries: "series/crime-series",
  crimemovies: "movie/crime-movies",
  dochistory: "movie/docs-history",
  docmusic: "movie/docs-music",
  docwar: "movie/docs-war",
  docwarseries: "series/docs-war-series",
};
// TMDB genre ids: 99 Documentary, 80 Crime. A comma means "both genres"; a pipe would mean "either".
CATALOGS["movie/docs-movies"] = () => ({ kind: "movie", path: "/discover/movie", params: { with_genres: "99", "vote_count.gte": "20", sort_by: "popularity.desc" } });
CATALOGS["series/docs-series"] = () => ({ kind: "tv", path: "/discover/tv", params: { with_genres: "99", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["series/crime-series"] = () => ({ kind: "tv", path: "/discover/tv", params: { with_genres: "80,99", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["movie/crime-movies"] = () => ({ kind: "movie", path: "/discover/movie", params: { with_genres: "80,99", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["movie/docs-history"] = () => ({ kind: "movie", path: "/discover/movie", params: { with_genres: "99,36", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["movie/docs-music"] = () => ({ kind: "movie", path: "/discover/movie", params: { with_genres: "99,10402", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["movie/docs-war"] = () => ({ kind: "movie", path: "/discover/movie", params: { with_genres: "99,10752", "vote_count.gte": "10", sort_by: "popularity.desc" } });
CATALOGS["series/docs-war-series"] = () => ({ kind: "tv", path: "/discover/tv", params: { with_genres: "99,10768", "vote_count.gte": "10", sort_by: "popularity.desc" } });

// Both families share one builder. "Separate rows" uses each row's own catalog id (unchanged from before).
// "One combined row" makes one row per type (Stremio rows hold a single type, so movies and series can't share one).
const FAMILIES = {
  turkish: {
    modeName: "turkish",
    partsKey: "turkishParts",
    baseName: "Turkish TV",
    id: "community.turkish-tv",
    version: "1.10.0",
    description: "Turkish movies, series and reality TV.",
    parts: TURKISH_PARTS,
    names: TURKISH_NAMES,
    keyOf: turkishKey,
    typeOf: { movies: "movie", series: "series", reality: "series" },
    labelOf: { movies: "Movies", series: "Series", reality: "Reality" },
    mixOf: { movie: "movie/turkish-mix-movies", series: "series/turkish-mix-series" },
  },
  docs: {
    modeName: "docs",
    partsKey: "docsParts",
    baseName: "Documentaries",
    id: "community.documentaries",
    version: "1.10.0",
    description: "Documentary films and series, plus true crime.",
    parts: DOCS_PARTS,
    names: DOCS_NAMES,
    keyOf: docsKey,
    typeOf: { docmovies: "movie", docseries: "series", crimeseries: "series", crimemovies: "movie", dochistory: "movie", docmusic: "movie", docwar: "movie", docwarseries: "series" },
    labelOf: DOCS_NAMES,
    mixOf: { movie: "movie/docs-mix-movies", series: "series/docs-mix-series" },
  },
};

// Combined rows: one per type, mixing that type's picks in turn (like the Trash TV mix).
async function partListByKey(cfg, key) {
  const def = CATALOGS[key](cfg);
  if (def.custom) return def.custom(cfg);
  const pages = await Promise.all(
    [1, 2].map((page) => tmdb(cfg.tmdbKey, def.path, { ...def.params, include_adult: "false", page: String(page) }))
  );
  return pages.flatMap((d) => d.results);
}
function familyMix(fam, cfg, type) {
  const parts = cfg[fam.partsKey].filter((p) => fam.typeOf[p] === type);
  return memoized(`mix:${fam.modeName}:${type}:${parts.join(",")}:${keyHash(cfg.tmdbKey)}`, 600000, async () => {
    const lists = await Promise.all(parts.map((p) => partListByKey(cfg, fam.keyOf[p]).catch(() => [])));
    const seen = new Set();
    const out = [];
    for (let i = 0; out.length < 120 && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const m = l[i];
        if (!m) continue;
        const k = normName(m.name);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    }
    return out;
  });
}
for (const fam of Object.values(FAMILIES)) {
  for (const type of ["movie", "series"]) {
    CATALOGS[fam.mixOf[type]] = () => ({
      kind: type === "movie" ? "movie" : "tv",
      custom: (cfg) => familyMix(fam, cfg, type),
    });
  }
}

function familyName(fam, cfg) {
  const picks = cfg[fam.partsKey];
  const one = cfg.layout === "one" ? ", one row" : "";
  if (picks.length === fam.parts.length) return fam.baseName + one;
  return `${fam.baseName}: ${picks.map((p) => fam.labelOf[p]).join(" + ")}${one}`;
}

function familyManifest(fam, cfg, cfgKey) {
  const suffix = "." + crypto.createHash("sha1").update(cfgKey || "").digest("hex").slice(0, 8);
  const picks = cfg[fam.partsKey];
  let catalogs;
  if (cfg.layout === "one") {
    catalogs = ["movie", "series"]
      .filter((t) => picks.some((p) => fam.typeOf[p] === t))
      .map((t) => {
        const [type, id] = fam.mixOf[t].split("/");
        const name = picks.filter((p) => fam.typeOf[p] === t).map((p) => fam.names[p]).join(" + ");
        return { type, id, name, extra: [{ name: "skip" }] };
      });
  } else {
    catalogs = picks.map((p) => {
      const [type, id] = fam.keyOf[p].split("/");
      return { type, id, name: fam.names[p], extra: [{ name: "skip" }] };
    });
  }
  return {
    id: fam.id + suffix,
    version: fam.version,
    name: cfg.name || familyName(fam, cfg),
    description: fam.description,
    resources: ["catalog"],
    types: [...new Set(catalogs.map((c) => c.type))],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// Which requests a family install may serve: its own tab only, and only the layout it was installed with.
function familyBlocked(fam, cfg, key, slugPart) {
  if (cfg.mode !== fam.modeName || slugPart) return true;
  const picks = cfg[fam.partsKey];
  const mixType = Object.keys(fam.mixOf).find((t) => fam.mixOf[t] === key);
  if (mixType) return cfg.layout !== "one" || !picks.some((p) => fam.typeOf[p] === mixType);
  if (cfg.layout === "one") return true;
  const part = Object.keys(fam.keyOf).find((p) => fam.keyOf[p] === key);
  return !part || !picks.includes(part);
}

// ---- Everything: one add-on with every row from every tab, in the order you choose on the page. ----
const RELEASE_NAMES = {
  "movie/digital-releases": "Digitally Available",
  "series/streaming-new": "New Shows Streaming",
  "series/streaming-airing": "New Episodes This Week",
};
const ALL_ROW_KEYS = [
  "movie/digital-releases", "series/streaming-new", "series/streaming-airing",
  "series/trash-bravo", "series/trash-bravonow", "series/trash-reality", "series/trash-dating",
  "series/trash-drama", "series/trash-daytime", "series/trash-tlc", "series/trash-novelas",
  ...Object.values(turkishKey),
  ...Object.values(docsKey),
];
// Combined rows (one per type, from a tab set to "one combined row"). Everything can include these instead of the separate rows.
const ALL_MIX_KEYS = ["series/trash-mix", "movie/turkish-mix-movies", "series/turkish-mix-series", "movie/docs-mix-movies", "series/docs-mix-series"];
const ALL_SERVABLE = [...ALL_ROW_KEYS, ...ALL_MIX_KEYS];
const MIX_NAMES = {
  "series/trash-mix": "Trash TV: one combined row",
  "movie/turkish-mix-movies": "Turkish Movies, one row",
  "series/turkish-mix-series": "Turkish Series and Reality, one row",
  "movie/docs-mix-movies": "Documentary Movies, one row",
  "series/docs-mix-series": "Documentary Series, one row",
};
function rowName(key) {
  if (MIX_NAMES[key]) return MIX_NAMES[key];  if (RELEASE_NAMES[key]) return RELEASE_NAMES[key];
  const trash = key.match(/^series\/trash-(\w+)$/);
  if (trash && TRASH[trash[1]]) return TRASH[trash[1]].name;
  const tk = Object.keys(turkishKey).find((p) => turkishKey[p] === key);
  if (tk) return TURKISH_NAMES[tk];
  const dk = Object.keys(docsKey).find((p) => docsKey[p] === key);
  if (dk) return DOCS_NAMES[dk];
  return key;
}
function buildAllManifest(cfg, cfgKey) {
  const suffix = "." + crypto.createHash("sha1").update(cfgKey || "").digest("hex").slice(0, 8);
  const catalogs = cfg.allRows.map((key) => {
    const [type, id] = key.split("/");
    return { type, id, name: rowName(key), extra: [{ name: "skip" }] };
  });
  return {
    id: "community.everything" + suffix,
    version: "1.11.0",
    name: cfg.name || (cfg.region === "US" ? "Everything" : `Everything (${cfg.region})`),
    description: "Every row from Releases, Trash TV, Turkish TV and Documentaries, in your order.",
    resources: ["catalog"],
    types: [...new Set(catalogs.map((c) => c.type))],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

function buildTrashManifest(cfg, cfgKey) {
  const suffix = "." + crypto.createHash("sha1").update(cfgKey || "").digest("hex").slice(0, 8);
  const skipOnly = [{ name: "skip" }];
  const catalogs =
    cfg.layout === "one"
      ? [{ type: "series", id: "trash-mix", name: "Trash TV Mix", extra: skipOnly }]
      : Object.keys(TRASH)
          .filter((id) => cfg.trashParts.includes(id))
          .map((id) => ({ type: "series", id: `trash-${id}`, name: TRASH[id].name, extra: skipOnly }));
  return {
    id: "community.trash-tv" + suffix,
    version: "1.7.0",
    name: cfg.name || trashName(cfg),
    description: "Bravo-style reality TV: Real Housewives, Below Deck, Vanderpump Rules and more.",
    resources: ["catalog"],
    types: ["series"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// Stremio treats the manifest id as the add-on's identity: same id = replaces the installed copy.
// A short hash of the config makes every differently configured link install side by side.
function buildManifest(cfg, cfgKey) {
  if (cfg.mode === "all") return buildAllManifest(cfg, cfgKey);
  if (cfg.mode === "trash") return buildTrashManifest(cfg, cfgKey);
  if (cfg.mode === "turkish") return familyManifest(FAMILIES.turkish, cfg, cfgKey);
  if (cfg.mode === "docs") return familyManifest(FAMILIES.docs, cfg, cfgKey);
  const suffix = cfgKey ? "." + crypto.createHash("sha1").update(cfgKey).digest("hex").slice(0, 8) : "";
  const movieExtra = [{ name: "genre", options: Object.keys(GENRE_IDS.movie) }, { name: "skip" }];
  const tvExtra = [{ name: "genre", options: Object.keys(GENRE_IDS.tv) }, { name: "skip" }];
  const skipOnly = [{ name: "skip" }];
  const { movies, shows } = effective(cfg);
  const sel = cfg.genres;
  const each = cfg.layout === "each";
  const gl = genreLabel(sel);
  const typeWord = cfg.movies && !cfg.shows ? "Movies" : !cfg.movies && cfg.shows ? "Shows" : "";
  // Names carry the genres, any movies-only / shows-only choice, and the layout, so stacked copies are easy to tell apart.
  const label = [[gl, typeWord].filter(Boolean).join(" "), each ? "separate rows" : ""].filter(Boolean).join(", ");
  let catalogs = [];
  if (each) {
    // A row for every picked genre (every genre if none were picked).
    for (const g of sel.length ? sel : Object.keys(GENRE_PICK)) {
      const gp = GENRE_PICK[g];
      const sg = slug(g);
      if (movies && gp.movie) {
        catalogs.push({ type: "movie", id: `digital-releases--${sg}`, name: `${g}: Digitally Available`, extra: skipOnly });
      }
      if (shows && gp.tv) {
        catalogs.push({ type: "series", id: `streaming-new--${sg}`, name: `${g}: New Shows Streaming`, extra: skipOnly });
        catalogs.push({ type: "series", id: `streaming-airing--${sg}`, name: `${g}: New Episodes This Week`, extra: skipOnly });
      }
    }
  } else {
    // One combined row per catalog. With genres picked it's already filtered; otherwise Stremio gets a genre dropdown.
    const prefix = sel.length ? `${gl}: ` : "";
    const mExtra = sel.length ? skipOnly : movieExtra;
    const tExtra = sel.length ? skipOnly : tvExtra;
    if (movies) {
      catalogs.push({ type: "movie", id: "digital-releases", name: prefix + "Digitally Available", extra: mExtra });
    }
    if (shows) {
      catalogs.push({ type: "series", id: "streaming-new", name: prefix + "New Shows Streaming", extra: tExtra });
      catalogs.push({ type: "series", id: "streaming-airing", name: prefix + "New Episodes This Week", extra: tExtra });
    }
  }
  catalogs = catalogs.slice(0, 60); // keep the manifest and Stremio's home screen sane
  const what = movies && shows ? "Movies with a digital release and shows streaming now" : movies ? "Movies with a digital release" : "Shows streaming now";
  return {
    id: "community.digital-releases" + suffix,
    version: "1.7.0",
    name:
      cfg.name ||
      (label ? `Digital Releases: ${label} (${cfg.region})` : cfgKey ? `Digital Releases (${cfg.region})` : "Digital Releases"),
    description: `${what} in ${cfg.region}${sel.length ? `, genres: ${sel.join(", ")}` : ""}.`,
    resources: ["catalog"],
    types: [...new Set(catalogs.map((c) => c.type))],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// TMDB accepts either a v3 API key or a v4 read access token (starts with "eyJ").
async function tmdb(key, path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const headers = {};
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else params = { ...params, api_key: key };
  url.search = new URLSearchParams(params);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (res.status === 401) throw new Error("TMDB rejected the key");
  if (!res.ok) throw new Error(`TMDB error ${res.status}`);
  return res.json();
}

// TMDB movie and TV ids overlap, so the cache key includes the kind.
const imdbCache = new Map();
async function getImdbId(key, kind, tmdbId) {
  const ck = `${kind}:${tmdbId}`;
  if (imdbCache.has(ck)) return imdbCache.get(ck);
  try {
    const { imdb_id } = await tmdb(key, `/${kind}/${tmdbId}/external_ids`);
    imdbCache.set(ck, imdb_id || null);
    return imdb_id || null;
  } catch {
    return null;
  }
}

// Falls back to the plain TMDB poster whenever the chosen provider isn't fully configured.
function posterUrl(cfg, imdb, m, kind) {
  const plain = m.poster_path ? `${IMG}/w342${m.poster_path}` : m.posterUrl; // TMDB, or TVMaze for schedule rows
  if (cfg.posterProvider === "rpdb" && cfg.rpdbKey) {
    // fallback=true makes RPDB return the plain poster if it has no rated version.
    return `https://api.ratingposterdb.com/${cfg.rpdbKey}/imdb/poster-default/${imdb}.jpg?fallback=true`;
  }
  if (cfg.posterProvider === "topposters" && cfg.topKey) {
    // fallback_url makes Top Posters redirect to the plain TMDB poster if it has no rated one.
    const q = plain ? `?fallback_url=${encodeURIComponent(plain)}` : "";
    return `https://api.top-posters.com/${cfg.topKey}/imdb/poster/${imdb}.jpg${q}`;
  }
  if (cfg.posterProvider === "custom" && cfg.posterTemplate) {
    return cfg.posterTemplate
      .split("{imdb_id}").join(imdb)
      .split("{tmdb_id}").join(String(m.id))
      .split("{type}").join(kind); // "movie" or "tv"
  }
  return plain;
}

async function getCatalog(cfg, key, skip, genre, rowGenre) {
  const def = CATALOGS[key](cfg);
  let results;
  if (def.custom) {
    // Hand-built lists (franchise searches) are paged in memory.
    results = (await def.custom(cfg)).slice(skip, skip + PAGE_SIZE);
  } else {
    // Which TMDB genres filter this row: one genre's own row, the genres picked at install, or (general installs) Stremio's dropdown.
    const kindKey = def.kind === "tv" ? "tv" : "movie";
    const chosen = rowGenre ? [rowGenre] : cfg.mode === "releases" ? cfg.genres : [];
    if (chosen.length) {
      const ids = [...new Set(chosen.map((g) => GENRE_PICK[g][kindKey]).filter(Boolean))];
      if (ids.length) def.params.with_genres = ids.join("|"); // "|" means any of these genres
    } else if (cfg.mode === "releases" && genre) {
      const id = GENRE_IDS[def.kind][genre];
      if (id) def.params.with_genres = String(id);
    }
    const page = Math.floor(skip / PAGE_SIZE) + 1;
    const data = await tmdb(cfg.tmdbKey, def.path, {
      ...def.params,
      include_adult: "false",
      page: String(page),
    });
    results = data.results;
  }

  const metas = await Promise.all(
    results.map(async (m) => {
      const imdb = m.imdbId || (await getImdbId(cfg.tmdbKey, def.kind, m.id));
      if (!imdb) return null;
      const date = m.release_date || m.first_air_date;
      return {
        id: imdb,
        type: def.kind === "tv" ? "series" : "movie",
        name: m.title || m.name,
        poster: posterUrl(cfg, imdb, m, def.kind),
        background: m.backdrop_path ? `${IMG}/w780${m.backdrop_path}` : undefined,
        description: m.overview,
        releaseInfo: date ? date.slice(0, 4) : undefined,
      };
    })
  );
  return { metas: metas.filter(Boolean) };
}

// Decorative poster list for the landing page (plain TMDB posters).
// "movie" = new digital releases; "tv" = new shows plus shows with episodes this week; "trash" = Trash TV rows.
async function getShowcase(cfg, kind) {
  const sources =
    kind === "tv"
      ? [["series/streaming-new", 1], ["series/streaming-new", 2], ["series/streaming-airing", 1]]
      : kind === "docs"
      ? [["series/docs-series", 1], ["movie/docs-movies", 1], ["series/crime-series", 1], ["movie/crime-movies", 1]]
      : kind === "turkish"
      ? [["series/turkish-series", 1], ["movie/turkish-movies", 1], ["series/turkish-reality", 1]]
      : kind === "trash"
      ? [["series/trash-bravo", 1], ["series/trash-dating", 1], ["series/trash-reality", 1], ["series/trash-turkish", 1], ["series/trash-novelas", 1]]
      : [["movie/digital-releases", 1], ["movie/digital-releases", 2]];
  const lists = await Promise.all(
    sources.map(async ([key, page]) => {
      const def = CATALOGS[key](cfg);
      if (def.custom) return (await def.custom(cfg)).slice(0, 24);
      const d = await tmdb(cfg.tmdbKey, def.path, { ...def.params, include_adult: "false", page: String(page) });
      return d.results;
    })
  );
  const posters = lists
    .flat()
    .filter((m) => m.poster_path || m.posterUrl)
    .map((m) => (m.poster_path ? `${IMG}/w342${m.poster_path}` : m.posterUrl));
  return { posters: [...new Set(posters)] };
}

// Powers the page's "Check my setup" button. Only calls fixed services; never echoes keys.
async function runCheck(cfg) {
  const out = { mode: cfg.mode, region: cfg.region };
  if (!cfg.tmdbKey) {
    out.tmdb = { ok: false, message: "No valid TMDB key in these settings" };
  } else {
    try {
      await tmdb(cfg.tmdbKey, "/configuration");
      out.tmdb = { ok: true, message: "TMDB key works" };
    } catch (e) {
      out.tmdb = { ok: false, message: e.message };
    }
  }
  try {
    await tvmazeGet("/shows/1");
    out.tvmaze = { ok: true, message: "TVMaze is reachable" };
  } catch (e) {
    out.tvmaze = { ok: false, message: e.message };
  }
  return out;
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  // Match on the raw path; the extra segment (e.g. genre=Sci-Fi%20and%20Fantasy&skip=20) is decoded by URLSearchParams.
  const path = (req.url || "").split("?")[0];
  // [/<config>]/manifest.json | showcase(-tv).json | catalog/<movie|series>/<id>[/<extra>].json
  const m = path.match(
    /^(?:\/([^/]+))?\/(manifest\.json|check\.json|showcase(?:-tv)?\.json|catalog\/(movie|series)\/([\w-]+)(?:\/(.+))?\.json)$/
  );
  if (!m) return send(res, 404, { error: "Not found" });

  const cfg = parseConfig(m[1]);

  if (m[2] === "check.json") return send(res, 200, await runCheck(cfg), "no-store");

  if (m[2] === "showcase.json" || m[2] === "showcase-tv.json") {
    if (!cfg.tmdbKey) return send(res, 200, { posters: [] }, "public, max-age=60");
    try {
      return send(res, 200, await getShowcase(cfg, m[2] === "showcase-tv.json" ? "tv" : cfg.mode === "trash" ? "trash" : cfg.mode === "turkish" ? "turkish" : cfg.mode === "docs" ? "docs" : "movie"), "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600");
    } catch {
      return send(res, 200, { posters: [] }, "public, max-age=60");
    }
  }

  if (m[2] === "manifest.json") {
    return send(res, 200, buildManifest(cfg, m[1]), "public, max-age=300");
  }

  // Row ids: "digital-releases", "trash-dating", "trash-mix", or "digital-releases--comedy" (one genre's own row).
  const [baseId, slugPart] = m[4].split("--");
  const key = `${m[3]}/${baseId}`;
  if (!CATALOGS[key]) return send(res, 404, { metas: [], error: "Unknown catalog" });
  const isTrashKey = key.startsWith("series/trash-");
  const isTurkishKey = /^(movie|series)\/turkish-/.test(key);
  const isDocsKey = /^(movie|series)\/(docs|crime)-/.test(key);
  const eff = effective(cfg);
  let rowGenre = "";
  let blocked;
  if (cfg.mode === "all") {
    blocked = !ALL_SERVABLE.includes(key) || !cfg.allRows.includes(key) || !!slugPart;
  } else if (isDocsKey) {
    blocked = familyBlocked(FAMILIES.docs, cfg, key, slugPart);
  } else if (isTurkishKey) {
    blocked = familyBlocked(FAMILIES.turkish, cfg, key, slugPart);
  } else if (isTrashKey) {
    const part = baseId.slice(6); // after "trash-"
    blocked =
      cfg.mode !== "trash" ||
      !!slugPart ||
      (part === "mix" ? cfg.layout !== "one" : cfg.layout !== "each" || !cfg.trashParts.includes(part));
  } else {
    blocked = cfg.mode !== "releases" || (m[3] === "movie" && !eff.movies) || (m[3] === "series" && !eff.shows);
    if (slugPart) {
      rowGenre = SLUG_TO_GENRE[slugPart] || "";
      const gp = rowGenre && GENRE_PICK[rowGenre];
      blocked =
        blocked ||
        !gp ||
        cfg.layout !== "each" ||
        (cfg.genres.length > 0 && !cfg.genres.includes(rowGenre)) ||
        !gp[m[3] === "movie" ? "movie" : "tv"];
    } else if (cfg.layout === "each") {
      blocked = true; // "separate rows" installs only offer the per-genre rows
    }
  }
  if (blocked) {
    return send(res, 200, { metas: [] }, "public, max-age=300");
  }
  if (!cfg.tmdbKey) {
    return send(res, 400, { metas: [], error: "No valid TMDB key in this add-on's settings" });
  }
  const extra = new URLSearchParams(m[5] || "");
  const skip = Number(extra.get("skip")) || 0;
  const genre = extra.get("genre") || "";
  try {
    const catalog = await getCatalog(cfg, key, skip, genre, rowGenre);
    return send(res, 200, catalog, "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
  } catch (err) {
    console.error(err.message);
    return send(res, 502, { metas: [], error: err.message });
  }
};
