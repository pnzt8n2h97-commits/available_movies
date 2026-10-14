# Digital Releases for Stremio

A Stremio add-on that lists movies you can rent or buy right now, plus new shows you can stream, with a genre filter on every catalog. It runs on Vercel's free plan and has no dependencies.

## Catalogs

- **Digitally Available:** movies with a digital release in your region.
- **New Shows Streaming:** shows that premiered recently and are on a streaming or rental service in your region.
- **New Episodes This Week:** shows with an episode airing in the last 7 days.

Movies and TV shows can each be switched off on the install page. By default you get the general install, where every catalog has a genre dropdown inside Stremio.

To install just one genre, tap it on the install page (for example Comedy). That install gets its own catalogs already filtered to the genre. Each setup has its own add-on ID, so you can install again with a different genre and they stack side by side. Some genres exist only for movies (Horror, Romance, Thriller, History, Music) or only for shows (Kids, Reality), and those installs include only the matching catalogs.

## Trash TV

The install page has a second tab, **Trash TV**. It installs its own separate add-on (not a genre of the main one) with four rows: Reality and Dating, Soaps and Telenovelas, Talk Shows and Tabloid (all showing what's on now), and Guilty-Pleasure Binges. Tap a row to turn it off. It can be installed alongside the Releases add-on.

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
| `REGION` | Default region, such as `US`. |
| `DAYS_BACK` | Default "released within" window in days. |

Keys belong in Vercel's environment variables, never in the repo.

## Poster styles

Plain TMDB posters, RPDB rating posters, or a custom URL pattern from another provider. Use `{imdb_id}`, `{tmdb_id}` and `{type}` (movie or tv) as placeholders in the pattern.

## Privacy

Your settings, including your keys, are encoded in the add-on link so Stremio can use them. The add-on doesn't store keys, but it passes them to TMDB (and your poster provider) to fetch titles, and hosting logs may record requested addresses, which include the link. Treat your link like a password and don't share it. If a key leaks, regenerate it with the provider.

## Credits

- Movie and TV data from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.
- Streaming availability data comes from JustWatch via TMDB.
- Rating posters from [RPDB](https://ratingposterdb.com) or the provider you choose.
- Not affiliated with Stremio.

## License

MIT. See `LICENSE`.
