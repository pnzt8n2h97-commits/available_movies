// Vercel serverless function: Stremio manifest + catalog.
// Each user's settings travel in the install URL: /<base64url-json>/manifest.json
// Optional env fallbacks: TMDB_KEY, RPDB_KEY, REGION, DAYS_BACK

const PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p";

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
  // Custom template, e.g. a poster URL pattern from ERDB, XRDB, Posters+ or Pictorium.
  const tpl = String(c.posterTemplate || "").trim();
  const posterTemplate =
    tpl.length <= 1500 && /^https:\/\/[\x21-\x7e]+$/.test(tpl) && /\{(imdb_id|tmdb_id)\}/.test(tpl)
      ? tpl
      : "";
  const posterProvider = ["tmdb", "rpdb", "custom"].includes(c.posterProvider)
    ? c.posterProvider
    : validRpdb
    ? "rpdb"
    : "tmdb";
  return {
    tmdbKey: /^[\w.-]+$/.test(tmdbKey) ? tmdbKey : "",
    rpdbKey: validRpdb,
    posterProvider,
    posterTemplate,
    region,
    days,
  };
}

function buildManifest(cfg) {
  return {
    id: "community.digital-releases",
    version: "1.1.0",
    name: "Digital Releases",
    description: `Movies with a digital release in ${cfg.region} over the last ${cfg.days} days.`,
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [
      {
        type: "movie",
        id: "digital-releases",
        name: "Digitally Available",
        extra: [{ name: "skip" }],
      },
    ],
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

// TMDB ids are global, so this cache is safe to share across users.
const imdbCache = new Map();
async function getImdbId(key, tmdbId) {
  if (imdbCache.has(tmdbId)) return imdbCache.get(tmdbId);
  try {
    const { imdb_id } = await tmdb(key, `/movie/${tmdbId}/external_ids`);
    imdbCache.set(tmdbId, imdb_id || null);
    return imdb_id || null;
  } catch {
    return null;
  }
}

const isoDate = (d) => d.toISOString().slice(0, 10);

// Falls back to the plain TMDB poster whenever the chosen provider isn't fully configured.
function posterUrl(cfg, imdb, m) {
  if (cfg.posterProvider === "rpdb" && cfg.rpdbKey) {
    // fallback=true makes RPDB return the plain poster if it has no rated version.
    return `https://api.ratingposterdb.com/${cfg.rpdbKey}/imdb/poster-default/${imdb}.jpg?fallback=true`;
  }
  if (cfg.posterProvider === "custom" && cfg.posterTemplate) {
    return cfg.posterTemplate
      .split("{imdb_id}").join(imdb)
      .split("{tmdb_id}").join(String(m.id))
      .split("{type}").join("movie");
  }
  return m.poster_path ? `${IMG}/w342${m.poster_path}` : undefined;
}

async function getCatalog(cfg, skip) {
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const now = new Date();
  const from = new Date(now.getTime() - cfg.days * 86400000);

  const data = await tmdb(cfg.tmdbKey, "/discover/movie", {
    region: cfg.region,
    with_release_type: "4", // 4 = Digital
    "release_date.gte": isoDate(from),
    "release_date.lte": isoDate(now),
    sort_by: "popularity.desc",
    include_adult: "false",
    page: String(page),
  });

  const metas = await Promise.all(
    data.results.map(async (m) => {
      const imdb = await getImdbId(cfg.tmdbKey, m.id);
      if (!imdb) return null;
      const poster = posterUrl(cfg, imdb, m);
      return {
        id: imdb,
        type: "movie",
        name: m.title,
        poster,
        background: m.backdrop_path ? `${IMG}/w780${m.backdrop_path}` : undefined,
        description: m.overview,
        releaseInfo: m.release_date ? m.release_date.slice(0, 4) : undefined,
      };
    })
  );
  return { metas: metas.filter(Boolean) };
}

// Decorative poster list for the landing page (plain TMDB posters, no IMDb lookups needed).
async function getShowcase(cfg) {
  const now = new Date();
  const from = new Date(now.getTime() - cfg.days * 86400000);
  const pages = await Promise.all(
    [1, 2].map((page) =>
      tmdb(cfg.tmdbKey, "/discover/movie", {
        region: cfg.region,
        with_release_type: "4",
        "release_date.gte": isoDate(from),
        "release_date.lte": isoDate(now),
        sort_by: "popularity.desc",
        include_adult: "false",
        page: String(page),
      })
    )
  );
  const posters = pages
    .flatMap((d) => d.results)
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
  const path = decodeURIComponent((req.url || "").split("?")[0]);
  // [/<config>]/manifest.json  or  [/<config>]/catalog/movie/digital-releases[/skip=20].json
  const m = path.match(
    /^(?:\/([^/]+))?\/(manifest\.json|showcase\.json|catalog\/movie\/digital-releases(?:\/(.+))?\.json)$/
  );
  if (!m) return send(res, 404, { error: "Not found" });

  const cfg = parseConfig(m[1]);

  if (m[2] === "showcase.json") {
    if (!cfg.tmdbKey) return send(res, 200, { posters: [] }, "public, max-age=60");
    try {
      return send(res, 200, await getShowcase(cfg), "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600");
    } catch {
      return send(res, 200, { posters: [] }, "public, max-age=60");
    }
  }

  if (m[2] === "manifest.json") {
    return send(res, 200, buildManifest(cfg), "public, max-age=300");
  }

  if (!cfg.tmdbKey) {
    return send(res, 400, { metas: [], error: "No valid TMDB key in this add-on's settings" });
  }
  const skip = Number(new URLSearchParams(m[3] || "").get("skip")) || 0;
  try {
    const catalog = await getCatalog(cfg, skip);
    return send(res, 200, catalog, "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
  } catch (err) {
    console.error(err.message);
    return send(res, 502, { metas: [], error: err.message });
  }
};
