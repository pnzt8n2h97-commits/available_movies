# Digital Releases for Stremio

A Stremio add-on that lists movies you can rent or buy right now, plus new shows you can stream, with a genre filter on every catalog. It runs on Vercel's free plan and has no dependencies.

## Catalogs

- **Digitally Available:** movies with a digital release in your region.
- **New Shows Streaming:** shows that premiered recently and are on a streaming or rental service in your region.
- **New Episodes This Week:** shows with an episode airing in the last 7 days.

Movies and TV shows can each be switched off on the install page. By default you get the general install: every genre, with a genre dropdown inside Stremio.

**Pick genres:** tap as many genres as you like on the install page. With genres picked, the install only includes those genres. Shows and movies are filtered to the genres that exist for each type (Horror is movies-only, Kids is shows-only, and so on).

**Layout:** choose how the picks appear in Stremio.
- **One combined row (default):** each catalog combines the picked genres into one row, such as "Comedy + Horror: Digitally Available".
- **Separate row per genre:** every picked genre gets its own rows, such as "Comedy: Digitally Available" and "Horror: Digitally Available". With nothing picked, this makes a row for every genre, which is a lot of rows, so it's best with a few genres picked.

Each choice produces its own add-on ID and name, so you can install again with different genres or layouts and they stack side by side. Older single-genre links still work and come back as one pick.

To install just one genre, tap it on the install page (for example Comedy). That install gets its own catalogs already filtered to the genre. Each setup has its own add-on ID, so you can install again with a different genre and they stack side by side. Some genres exist only for movies (Horror, Romance, Thriller, History, Music) or only for shows (Kids, Reality), and those installs include only the matching catalogs.

## Turkish TV

The install page has a third tab, **Turkish TV**, with its own add-on. It has three separate rows, each one picked or left out with the chips:

- **Turkish Movies:** Turkish-language films made in Turkey.
- **Turkish Series:** Turkish-language dramas (Drama genre, with a minimum vote count so obscure titles don't dominate).
- **Turkish Reality:** Turkish reality shows, topped up with recent Turkish reality from TVMaze's schedule because TMDB alone has few.

Turkish TV is always about Turkey, so the region setting doesn't apply. Turkish Dramas used to be a row on Trash TV; it now lives here.

## Trash TV

The install page has a second tab, **Trash TV**. It installs its own separate add-on (not a genre of the main one) with eight rows of trashy TV:

- **Bravo Universe:** popular shows from franchises like Real Housewives, Below Deck, Vanderpump Rules, Summer House and Southern Charm.
- **Bravo Universe: On Now:** shows that aired on Bravo in the last 7 days (from TVMaze's real TV schedule), plus those franchises airing elsewhere, such as on streaming.
- **Reality: On Now:** reality shows from your chosen region that aired in the last 7 days, from TVMaze's schedule. If TVMaze is slow or down, both On Now rows fall back to TMDB (episodes in the last 14 days).
- **Dating and Love Shows:** Love Island, Love Is Blind, Too Hot to Handle, The Bachelor, Temptation Island, Married at First Sight and more.
- **Reality Drama:** Jersey Shore, Teen Mom, Dance Moms, Love & Hip Hop, Basketball Wives, The Kardashians, Catfish and more.
- **Daytime Chaos:** Jerry Springer, Maury, Dr. Phil, Judge Judy, Divorce Court and more.
- **Train Wrecks:** My 600-lb Life, Hoarders, Dr. Pimple Popper, Sister Wives, Toddlers & Tiaras and more.
- **Telenovelas:** Spanish-language soaps.

**Region:** pick a region on the Trash TV tab (for example Turkey, the UK or Australia) and the On Now rows show what's actually airing there, using TVMaze's schedules by country. The default is the US.

**Smarter rows:** the On Now rows are topped up with recent and popular shows when a quiet part of the season would leave them thin. The franchise rows (Bravo Universe, Dating and Love Shows, Reality Drama, Daytime Chaos, Train Wrecks) and the On Now rows are sorted by a guilty-pleasure score: shows that are hugely watched but not well rated come first. Turkish Dramas and Telenovelas stay in plain popularity order.

Most rows are matched by show name (see `FRANCHISES` and `GROUPS` in `api/index.js`), so you can add or remove names there. Install every row together (the default), or tap any number of rows to pick them. Choose **one combined row** (the picks are mixed into a single row, taking shows from each in turn) or **separate rows** (the default, one per pick). Each choice gets its own name (for example "Trash TV: Dating and Love Shows + Turkish Dramas"), so you can stack several side by side. It can also be installed alongside the Releases add-on.

## Deploy your own

1. Get a free API key at [themoviedb.org](https://www.themoviedb.org/settings/api).
2. Fork or copy this repo, then import it into [Vercel](https://vercel.com) with the **Other** framework preset.
3. Optional: add environment variables in Vercel (Settings, Environment Variables), then redeploy.
4. Open your Vercel address, enter your settings, and tap **Install in Stremio**.

### Environment variables (all optional)

| Name | What it does |
| --- | --- |
| `TMDB_KEY` | Fallback TMDB key. Also fills the decorative poster strips for every visitor. |
| `RPDB_KEY` | Fallback key for Rating Poster Database posters. |
| `TOPPOSTERS_KEY` | Fallback key for Top Posters. |
| `REGION` | Default region, such as `US`. |
| `DAYS_BACK` | Default "released within" window in days. |

Keys belong in Vercel's environment variables, never in the repo.

If you share your deployment widely, set up Vercel's usage alerts so a burst of visitors doesn't surprise you.

## Poster styles

Plain TMDB posters, [RPDB](https://ratingposterdb.com) rating posters, [Top Posters](https://top-posters.com/api) rating posters, or a custom URL pattern from another provider. Use `{imdb_id}`, `{tmdb_id}` and `{type}` (movie or tv) as placeholders in the custom pattern.

Top Posters needs your own API key (free keys include 10,000 requests a month). Badge style and language are set in your Top Posters dashboard. The add-on asks Top Posters for the poster by IMDb ID and passes the plain TMDB poster as a fallback.

## Checking your setup

The **Check my setup** button on the install page tests your settings with one tap: whether your TMDB key works, whether TVMaze answers (on the Trash TV tab), and whether your chosen poster provider's images load. Poster tests run in your browser, so the server never fetches a URL you typed in, and no key is ever shown in the results. The server side of the check is `/<settings>/check.json`.

## Updating without breaking installs

Stremio only re-reads an add-on's manifest when it is installed, and it can't auto-update configurable add-ons. So:

**Safe (everyone gets it automatically, no reinstall):**
- Changing filters, sorting, date windows or how titles are picked inside the existing rows
- Poster logic, bug fixes, and everything on the install page
- Adding a new optional setting, as long as it has a default so older links still work

**Needs a reinstall (avoid unless it's worth it):**
- Adding, renaming or removing catalogs or rows
- Changing the genre options or the add-on's name or types

**Never do this:**
- Rename or remove a catalog id or change the URL routes
- Remove or rename a setting that old install links contain
- Change how the add-on id is generated (it would install as a duplicate)

A reinstall is one tap: open your install page (or Stremio's Configure button, which opens it with your settings filled in) and press Install again. Reinstalling the same link replaces your copy.

## Privacy

Your settings, including your keys, are encoded in the add-on link so Stremio can use them. The add-on doesn't store keys, but it passes them to TMDB (and your poster provider) to fetch titles, and hosting logs may record requested addresses, which include the link. Treat your link like a password and don't share it. If a key leaks, regenerate it with the provider.

## Credits

- Rating posters from [Top Posters](https://top-posters.com) when you choose it.
- TV schedules from [TVMaze](https://www.tvmaze.com), licensed CC BY-SA 4.0. It's free and needs no key, with a limit of about 20 calls per 10 seconds, so results are cached.
- Movie and TV data from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.
- Streaming availability data comes from JustWatch via TMDB.
- Rating posters from [RPDB](https://ratingposterdb.com) or the provider you choose.
- Not affiliated with Stremio.

## License

MIT. See `LICENSE`.
