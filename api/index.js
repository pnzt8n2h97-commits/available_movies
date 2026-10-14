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

// Which parts are really on: the switches, minus types the picked genre doesn't exist for.
function effective(cfg) {
  const g = cfg.genre ? GENRE_PICK[cfg.genre] : null;
  let movies = cfg.movies && (!g || !!g.movie);
  let shows = cfg.shows && (!g || !!g.tv);
  if (!movies && !shows && g) {
    movies = !!g.movie;
    shows = !!g.tv;
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
  return {
    mode: c.mode === "trash" ? "trash" : "releases",
    trashParts: tp.length ? tp : Object.keys(TRASH),
    tmdbKey: /^[\w.-]+$/.test(tmdbKey) ? tmdbKey : "",
    rpdbKey: validRpdb,
    topKey: validTop,
    posterProvider,
    posterTemplate,
    name: String(c.name || "").trim().slice(0, 40),
    genre:
      typeof c.genre === "string" && Object.prototype.hasOwnProperty.call(GENRE_PICK, c.genre) ? c.genre : "",
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

// "Trash TV" is its own add-on mode: Bravo-style reality (Real Housewives, Below Deck, Vanderpump Rules...),
// not a genre of the main one. Franchises are matched by name, so no TMDB network ids are needed.
const FRANCHISES = [
  "Real Housewives", "Below Deck", "Vanderpump Rules", "Summer House", "Southern Charm",
  "Married to Medicine", "Million Dollar Listing", "Love Island", "Love Is Blind",
  "Too Hot to Handle", "Selling Sunset", "The Bachelor", "90 Day Fiance", "Jersey Shore",
];
const normName = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const matchesFranchise = (name) => FRANCHISES.some((f) => normName(name).includes(normName(f)));
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

// All matching shows, found by searching each franchise name; most popular first.
function franchiseShows(cfg) {
  return memoized("fr:" + keyHash(cfg.tmdbKey), 600000, async () => {
    const lists = await Promise.all(
      FRANCHISES.map((f) =>
        tmdb(cfg.tmdbKey, "/search/tv", { query: f, include_adult: "false" })
          .then((d) => d.results.filter((m) => matchesFranchise(m.name)).slice(0, 6))
          .catch(() => [])
      )
    );
    const seen = new Set();
    return lists
      .flat()
      .filter((m) => !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 60);
  });
}

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

const TRASH = {
  bravo: { name: "Bravo Universe" },
  bravonow: { name: "Bravo Universe: On Now" },
  reality: { name: "Reality: On Now" },
};
// "custom" rows are hand-built lists; the others are plain TMDB discover queries.
CATALOGS["series/trash-bravo"] = () => ({ kind: "tv", custom: franchiseShows });
CATALOGS["series/trash-bravonow"] = () => ({ kind: "tv", custom: franchiseOnNow });
CATALOGS["series/trash-reality"] = () => ({
  kind: "tv",
  path: "/discover/tv",
  params: {
    with_genres: "10764", // Reality
    with_origin_country: "US",
    "air_date.gte": daysAgo(14),
    "air_date.lte": today(),
    sort_by: "popularity.desc",
  },
});

function buildTrashManifest(cfg, cfgKey) {
  const suffix = "." + crypto.createHash("sha1").update(cfgKey || "").digest("hex").slice(0, 8);
  return {
    id: "community.trash-tv" + suffix,
    version: "1.5.0",
    name: cfg.name || "Trash TV",
    description: "Bravo-style reality TV: Real Housewives, Below Deck, Vanderpump Rules and more.",
    resources: ["catalog"],
    types: ["series"],
    catalogs: Object.keys(TRASH)
      .filter((id) => cfg.trashParts.includes(id))
      .map((id) => ({ type: "series", id: `trash-${id}`, name: TRASH[id].name, extra: [{ name: "skip" }] })),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// Stremio treats the manifest id as the add-on's identity: same id = replaces the installed copy.
// A short hash of the config makes every differently configured link install side by side.
function buildManifest(cfg, cfgKey) {
  if (cfg.mode === "trash") return buildTrashManifest(cfg, cfgKey);
  const suffix = cfgKey ? "." + crypto.createHash("sha1").update(cfgKey).digest("hex").slice(0, 8) : "";
  const movieExtra = [{ name: "genre", options: Object.keys(GENRE_IDS.movie) }, { name: "skip" }];
  const tvExtra = [{ name: "genre", options: Object.keys(GENRE_IDS.tv) }, { name: "skip" }];
  const { movies, shows } = effective(cfg);
  const g = cfg.genre;
  const prefix = g ? `${g}: ` : "";
  // A genre install is already filtered, so it doesn't need the genre dropdown.
  const mExtra = g ? [{ name: "skip" }] : movieExtra;
  const tExtra = g ? [{ name: "skip" }] : tvExtra;
  const catalogs = [];
  if (movies) {
    catalogs.push({ type: "movie", id: "digital-releases", name: prefix + "Digitally Available", extra: mExtra });
  }
  if (shows) {
    catalogs.push({ type: "series", id: "streaming-new", name: prefix + "New Shows Streaming", extra: tExtra });
    catalogs.push({ type: "series", id: "streaming-airing", name: prefix + "New Episodes This Week", extra: tExtra });
  }
  const what = movies && shows ? "Movies with a digital release and shows streaming now" : movies ? "Movies with a digital release" : "Shows streaming now";
  return {
    id: "community.digital-releases" + suffix,
    version: "1.3.0",
    name:
      cfg.name ||
      (g ? `Digital Releases: ${g} (${cfg.region})` : cfgKey ? `Digital Releases (${cfg.region})` : "Digital Releases"),
    description: `${what} in ${cfg.region}${g ? `, genre: ${g}` : ""}.`,
    resources: ["catalog"],
    types: [movies && "movie", shows && "series"].filter(Boolean),
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
  const res = await fetch(url, { headers });
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
  if (cfg.posterProvider === "rpdb" && cfg.rpdbKey) {
    // fallback=true makes RPDB return the plain poster if it has no rated version.
    return `https://api.ratingposterdb.com/${cfg.rpdbKey}/imdb/poster-default/${imdb}.jpg?fallback=true`;
  }
  if (cfg.posterProvider === "topposters" && cfg.topKey) {
    // fallback_url makes Top Posters redirect to the plain TMDB poster if it has no rated one.
    const q = m.poster_path ? `?fallback_url=${encodeURIComponent(`${IMG}/w342${m.poster_path}`)}` : "";
    return `https://api.top-posters.com/${cfg.topKey}/imdb/poster/${imdb}.jpg${q}`;
  }
  if (cfg.posterProvider === "custom" && cfg.posterTemplate) {
    return cfg.posterTemplate
      .split("{imdb_id}").join(imdb)
      .split("{tmdb_id}").join(String(m.id))
      .split("{type}").join(kind); // "movie" or "tv"
  }
  return m.poster_path ? `${IMG}/w342${m.poster_path}` : undefined;
}

async function getCatalog(cfg, key, skip, genre) {
  const def = CATALOGS[key](cfg);
  let results;
  if (def.custom) {
    // Hand-built lists (franchise searches) are paged in memory.
    results = (await def.custom(cfg)).slice(skip, skip + PAGE_SIZE);
  } else {
    const picked = cfg.genre && cfg.mode !== "trash" ? GENRE_PICK[cfg.genre] : null;
    const genreId = picked ? picked[def.kind === "tv" ? "tv" : "movie"] : GENRE_IDS[def.kind][genre];
    if (genreId) def.params.with_genres = String(genreId);
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
      const imdb = await getImdbId(cfg.tmdbKey, def.kind, m.id);
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
      : kind === "trash"
      ? [["series/trash-bravo", 1], ["series/trash-bravonow", 1], ["series/trash-reality", 1], ["series/trash-reality", 2]]
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
    .filter((m) => m.poster_path)
    .map((m) => `${IMG}/w342${m.poster_path}`);
  return { posters: [...new Set(posters)] };
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
    /^(?:\/([^/]+))?\/(manifest\.json|showcase(?:-tv)?\.json|catalog\/(movie|series)\/([\w-]+)(?:\/(.+))?\.json)$/
  );
  if (!m) return send(res, 404, { error: "Not found" });

  const cfg = parseConfig(m[1]);

  if (m[2] === "showcase.json" || m[2] === "showcase-tv.json") {
    if (!cfg.tmdbKey) return send(res, 200, { posters: [] }, "public, max-age=60");
    try {
      return send(res, 200, await getShowcase(cfg, m[2] === "showcase-tv.json" ? "tv" : cfg.mode === "trash" ? "trash" : "movie"), "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600");
    } catch {
      return send(res, 200, { posters: [] }, "public, max-age=60");
    }
  }

  if (m[2] === "manifest.json") {
    return send(res, 200, buildManifest(cfg, m[1]), "public, max-age=300");
  }

  const key = `${m[3]}/${m[4]}`;
  if (!CATALOGS[key]) return send(res, 404, { metas: [], error: "Unknown catalog" });
  const isTrashKey = key.startsWith("series/trash-");
  const trashOn = isTrashKey && cfg.mode === "trash" && cfg.trashParts.includes(key.slice(13));
  const eff = effective(cfg);
  const blocked = isTrashKey
    ? !trashOn
    : cfg.mode === "trash" || (m[3] === "movie" && !eff.movies) || (m[3] === "series" && !eff.shows);
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
    const catalog = await getCatalog(cfg, key, skip, genre);
    return send(res, 200, catalog, "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
  } catch (err) {
    console.error(err.message);
    return send(res, 502, { metas: [], error: err.message });
  }
};
