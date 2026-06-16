# Rink Page Generation Plan — June 15, 2026

Script: `generate-rink-pages.js` (Node.js, no new dependencies — built-in `fetch` + `fs`)

## What it does

1. Fetches all rinks from Supabase as the single source of truth (not the JS `RINKS` array in `index.html`)
2. Paginates at 1,000 rows per request until all rinks are fetched
3. Writes one HTML file per rink to `rinks/{slug}.html`
4. Rewrites `sitemap.xml` from scratch using the fetched slug list
5. Reports rinks with no slug (skipped, not written)
6. Reports orphaned HTML files on disk that have no matching Supabase record — does NOT delete them automatically

## Supabase → HTML field mappings

| HTML element | Supabase field(s) |
|---|---|
| `<title>`, meta description, OG tags | `name`, `city`, `state` |
| `<link rel="canonical">` | `slug` |
| Schema.org JSON-LD | `name`, `address`, `city`, `state`, `zip`, `website`, `phone` |
| Breadcrumb | `state`, `city` |
| Address + Maps link | `address` + `city` + `state` + `zip` (constructed — `address` is street only), `lat`, `lng` |
| Type / sheet count tags | `type` (normalize case), `sheets` |
| Amenity badges | `locker_rooms`, `viewing`, `year_round`, `food`, `skate_rentals`, `sharpening`, `wifi`, `livebarn`, `on_site_shops`, `accessible`, `parking` |
| Pricing section | `price_public_skate`, `price_stick_puck`, `price_dropin` (pipe-delimited → `<li>` items) |
| Contact section | `phone`, `email`, `website` |
| Social links | `facebook_url`, `instagram_url`, `tiktok_url` |
| Registration button | `registration_url`, `registration_label` |
| About section | `notes` (after stripping — see below) |

## Key things to handle

### 1. `isTruthy()` helper for inconsistent boolean fields

`viewing` and `wifi` are stored as strings like `"True"`, `"TRUE"`, or descriptive text like `"Excellent lobby viewing"` rather than proper booleans. Any non-empty, non-`"false"` string should be treated as yes.

```js
function isTruthy(val) {
  if (val == null || val === false || val === 0) return false;
  if (val === true || val === 1) return true;
  const s = String(val).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== 'no' && s !== '0';
}
```

Fields that need this: `viewing`, `wifi`, `livebarn`, `sharpening`, `skate_rentals`, `on_site_shops`, `accessible`, `year_round`.

### 2. `food` as free-text badge label

`food` is a free-text string with values like `"concessions"`, `"Snack Bar"`, `"Concessions + vending"`. Use the value directly as the badge label — do not hardcode `"Concessions"`.

```js
if (r.food) badges.push(`<span class="badge badge-yes">${esc(r.food)}</span>`);
```

### 3. Strip ⚠️ lines from `notes` before rendering

Many `notes` values contain internal data-quality warnings added during bulk imports, e.g.:
- `"⚠️ Phone and website unverified."`
- `"⚠️ PLACEHOLDER URL — update during data-fill pass."`

These must not appear publicly on the live pages. Strip any line containing `⚠️` before rendering.

```js
function cleanNotes(raw) {
  if (!raw) return '';
  return raw
    .split('\n')
    .filter(line => !line.includes('⚠️'))
    .join('\n')
    .trim();
}
```

Apply `cleanNotes()` before passing `notes` to the HTML template. If the result is empty after stripping, omit the About section entirely.

## Context

- HTML pages were last generated from the JS `RINKS` array on **2026-04-27**
- As of 2026-05-29: **1,122 of 1,126** Supabase rinks have been updated since that date
- **4 rinks** exist in Supabase with no HTML page: Orbit Ice Arena (Palatine IL), Motto McLean Ice Arena (Omaha NE), Campbell County Ice Arena (Gillette WY), Bountiful Ice Ribbon Outdoor (Bountiful UT)
- Known data drift example: Acord Ice Center website in HTML is `wvc-ut.gov`; Supabase has `slco.org/acord-ice/`
- Do NOT deploy a blank/deleted state to Netlify before running this script — keep current pages live until the regenerated ones are ready to replace them
