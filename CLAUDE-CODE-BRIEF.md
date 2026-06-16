# Claude Code Session Brief — Rink Page Generator Test Run

## What we're doing
Testing `generate-rink-pages.js` before running it on all 1,126 rinks.
The script generates one static HTML file per rink → `rinks/{slug}.html` and rewrites `sitemap.xml`.

## Step 1 — Environment check
Make sure these environment variables are set before running anything:
- `SUPABASE_URL` — the Supabase project URL (https://xxx.supabase.co)
- `SUPABASE_KEY` — the Supabase anon/service key

If they're not set, stop and ask me for them.

Also confirm Node.js version is 18 or higher:
```bash
node --version
```

## Step 2 — Dry run first (no files written)
```bash
SUPABASE_URL=<url> SUPABASE_KEY=<key> node generate-rink-pages.js --dry-run --limit 5
```
Tell me what it reports — how many rinks fetched, how many stores fetched, any errors.

## Step 3 — Generate 10 real pages
```bash
SUPABASE_URL=<url> SUPABASE_KEY=<key> node generate-rink-pages.js --limit 10
```
This will create `rinks/` directory and write 10 HTML files.

## Step 4 — Audit the output
After generating, please check the following for each of the 10 files:

1. **File exists and is non-empty** — `ls -lh rinks/*.html`
2. **Valid HTML structure** — scan for obvious broken tags or missing closing elements
3. **Key fields populated** — open 2-3 files and confirm:
   - `<title>` contains rink name, city, state
   - `<h1>` matches the rink name
   - Address appears and links to Google Maps
   - At least one amenity badge renders (if data exists)
   - Contact section has phone/website (if data exists)
   - No literal `undefined`, `null`, or `[object Object]` text anywhere in the page
   - No `⚠️` characters in the rendered notes
4. **Nearby stores** — check if any of the 10 rinks have store cards in the footer. If none do, report the distances so we can adjust the radius if needed.
5. **Sitemap** — confirm `sitemap.xml` was written and contains 10 `<url>` entries

## Step 5 — Report back
Give me a summary:
- ✅ What looks good
- ⚠️ Anything that looks wrong or off (even minor)
- The full content of one page's `<head>` section so I can verify meta tags
- The full content of one page's contact section and amenities section

## Step 6 — Wait for my go-ahead
Do NOT run the full 1,126-rink generation until I review your report and say "go".

## Context / gotchas
- The script uses native `fetch` — no npm install needed, Node 18+ only
- `rinks/` directory will be created automatically if it doesn't exist
- Slugless rinks are skipped and reported in the console — that's expected behavior
- Some rinks will have thin data (lots of NULLs) — that's fine, sections are omitted gracefully
- The `--limit` flag takes the first N rinks by Supabase ID order, not alphabetically
- Orphaned HTML files (old pages not in Supabase) are reported but NOT deleted — flag them for me
