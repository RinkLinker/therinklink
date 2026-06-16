#!/usr/bin/env node
/**
 * generate-rink-pages.js
 * Generates one HTML file per rink → rinks/{slug}.html
 * Rewrites sitemap.xml from scratch
 * Reports slugless rinks (skipped) and orphaned HTML files (not deleted)
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=xxx node generate-rink-pages.js
 *
 * Optional flags:
 *   --dry-run   Fetch data and report, but write no files
 *   --limit N   Only generate first N rinks (for testing)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PAGE_SIZE    = 1000;
const RINKS_DIR    = path.join(__dirname, 'rinks');
const SITEMAP_PATH = path.join(__dirname, 'sitemap.xml');
const SITE_ORIGIN  = 'https://www.therinklink.com';
const STORES_RADIUS_MILES = 30;
const STORES_MAX   = 3;
const DRY_RUN      = process.argv.includes('--dry-run');
const LIMIT_IDX    = process.argv.indexOf('--limit');
const LIMIT        = LIMIT_IDX !== -1 ? parseInt(process.argv[LIMIT_IDX + 1], 10) : null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  Set SUPABASE_URL and SUPABASE_KEY environment variables.');
  process.exit(1);
}

// ─── Supabase fetch helpers ───────────────────────────────────────────────────

async function sbFetch(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase error ${res.status} on ${table}: ${body}`);
  }
  return res.json();
}

async function fetchAllRinks() {
  const all = [];
  let offset = 0;
  while (true) {
    const batch = await sbFetch(
      'rinks',
      `select=*&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`
    );
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function fetchAllStores() {
  const all = [];
  let offset = 0;
  while (true) {
    const batch = await sbFetch(
      'hockey_stores',
      `select=id,store_name,street_address,city,state,zip,phone,website,hours,sharpening,skate_fitting,pro_stock,latitude,longitude&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`
    );
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTruthy(val) {
  if (val == null || val === false || val === 0) return false;
  if (val === true || val === 1) return true;
  const s = String(val).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== 'no' && s !== '0';
}

function cleanNotes(raw) {
  if (!raw) return '';
  return raw
    .split('\n')
    .filter(line => !line.includes('⚠️'))
    .join('\n')
    .trim();
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hostname(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function formatPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10
    ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1')
      ? `+${digits}`
      : null;
}

function formatMonth(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } catch { return null; }
}

function isoDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  return dateStr.split('T')[0];
}

// Haversine distance in miles
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearbyStores(rink, allStores) {
  if (!rink.lat || !rink.lng) return [];
  return allStores
    .filter(s => s.latitude && s.longitude)
    .map(s => ({ ...s, dist: distanceMiles(rink.lat, rink.lng, s.latitude, s.longitude) }))
    .filter(s => s.dist <= STORES_RADIUS_MILES)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, STORES_MAX);
}

// ─── Badge builder ────────────────────────────────────────────────────────────

function buildBadges(r) {
  const badges = [];

  const add = (label) => badges.push(`<span class="badge">${esc(label)}</span>`);

  // Skate Rental
  if (isTruthy(r.skate_rentals)) add('Skate Rental');

  // Locker Rooms
  if (isTruthy(r.locker_rooms)) {
    const v = String(r.locker_rooms).trim().toLowerCase();
    const isPlain = ['true', '1', 'yes'].includes(v);
    add(isPlain ? 'Locker Rooms' : `Locker Rooms (${r.locker_rooms})`);
  }

  // Accessible
  if (isTruthy(r.accessible)) add('Accessible');

  // Year-Round
  if (isTruthy(r.year_round)) add('Year-Round');

  // Food — title-case the raw value
  if (r.food && r.food.trim()) {
    const foodVal = r.food.trim();
    const foodLabel = foodVal.charAt(0).toUpperCase() + foodVal.slice(1);
    add(foodLabel);
  }

  // Parking
  if (isTruthy(r.parking)) {
    const lc = String(r.parking).trim().toLowerCase();
    if (lc === 'free') add('Parking Free');
    else if (lc === 'paid') add('Parking Paid');
    else add('Parking');
  }

  // WiFi
  if (isTruthy(r.wifi)) add('WiFi');

  // LiveBarn
  if (isTruthy(r.livebarn)) add('LiveBarn');

  // Sharpening
  if (isTruthy(r.sharpening)) add('Sharpening');

  // On-Site Shop
  if (isTruthy(r.on_site_shops)) add('On-Site Shop');

  // Viewing
  if (isTruthy(r.viewing)) {
    const v = String(r.viewing).trim().toLowerCase();
    const isPlain = ['true', '1', 'yes'].includes(v);
    if (isPlain) {
      add('Viewing');
    } else {
      add(r.viewing.trim());
    }
  }

  // Seating type (if not already covered by viewing)
  if (r.seating_type && r.seating_type.trim() && !isTruthy(r.viewing)) {
    add(r.seating_type.trim());
  }

  return badges;
}

// ─── Pricing section ──────────────────────────────────────────────────────────

function buildPricingSection(r) {
  const rows = [];
  if (r.price_public_skate) rows.push({ label: 'Public Skate', val: r.price_public_skate });
  if (r.price_stick_puck)   rows.push({ label: 'Stick & Puck', val: r.price_stick_puck });
  if (r.price_dropin)       rows.push({ label: 'Drop-In Hockey', val: r.price_dropin });
  const clean = rows.filter(row => !row.val.includes('⚠️'));
  if (!clean.length) return '';

  return `
    <section class="pricing">
      <h2>Pricing</h2>
      <ul class="contact-list">
        ${clean.map(row => `<li><strong>${esc(row.label)}:</strong> ${esc(row.val)}</li>`).join('\n        ')}
      </ul>
    </section>`;
}

// ─── Nearby stores section ────────────────────────────────────────────────────

function buildStoresSection(stores) {
  if (!stores.length) return '';

  const cards = stores.map(s => {
    const storeBadges = [
      s.sharpening  ? 'Sharpening'   : null,
      s.skate_fitting ? 'Skate Fitting' : null,
      s.pro_stock   ? 'Pro Stock'    : null,
    ].filter(Boolean);

    const addressLine = [s.street_address, s.city, s.state].filter(Boolean).join(', ');
    const distLabel = s.dist < 1 ? 'Less than 1 mile away' : `${Math.round(s.dist)} miles away`;

    return `
    <div class="store-card">
      <div class="store-card-inner">
        <div class="sc-name">${esc(s.store_name)}</div>
        <div class="sc-dist">${esc(distLabel)}</div>
        ${addressLine ? `<div class="sc-address">${esc(addressLine)}</div>` : ''}
        ${s.phone    ? `<div class="sc-detail"><a href="tel:${formatPhone(s.phone) || esc(s.phone)}">${esc(s.phone)}</a></div>` : ''}
        ${s.hours    ? `<div class="sc-detail">${esc(s.hours)}</div>` : ''}
        ${storeBadges.length ? `<div class="sc-badges">${storeBadges.map(b => `<span class="badge">${esc(b)}</span>`).join('')}</div>` : ''}
        ${s.website  ? `<div class="sc-link"><a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(hostname(s.website))}</a></div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
<div class="footer-stores-block">
  <div class="footer-stores-inner">
    <h3>Nearby Hockey Stores</h3>
    <div class="store-cards">
      ${cards}
    </div>
  </div>
</div>`;
}

// ─── Social links ─────────────────────────────────────────────────────────────

function buildSocialLinks(r) {
  const links = [];
  if (r.facebook_url)  links.push(`<a href="${esc(r.facebook_url)}" target="_blank" rel="noopener">Facebook</a>`);
  if (r.instagram_url) links.push(`<a href="${esc(r.instagram_url)}" target="_blank" rel="noopener">Instagram</a>`);
  if (r.tiktok_url)    links.push(`<a href="${esc(r.tiktok_url)}" target="_blank" rel="noopener">TikTok</a>`);
  if (!links.length) return '';
  return `<li><strong>Social:</strong> ${links.join(' &middot; ')}</li>`;
}

// ─── Registration section ─────────────────────────────────────────────────────

function buildRegistrationRow(r) {
  if (!r.registration_url) return '';
  const label = r.registration_label || 'Register / Sign Up';
  return `<li><strong>Registration:</strong> <a href="${esc(r.registration_url)}" target="_blank" rel="noopener">${esc(label)}</a></li>`;
}

// ─── Spectator notes ──────────────────────────────────────────────────────────

function buildSpectatorSection(r) {
  if (!r.spectator_notes || !r.spectator_notes.trim()) return '';
  return `
    <section class="spectator-notes">
      <h2>Spectator Info</h2>
      <p>${esc(r.spectator_notes.trim())}</p>
    </section>`;
}

// ─── Claimed CTA ──────────────────────────────────────────────────────────────

function buildClaimedBanner(r) {
  if (isTruthy(r.claimed)) return '';
  return `
    <div class="claim-banner">
      <span>Is this your rink?</span>
      <a href="mailto:hello@therinklink.com?subject=Claim%20${encodeURIComponent(r.name || r.slug)}">Claim this page &rarr;</a>
    </div>`;
}

// ─── Schema JSON-LD ───────────────────────────────────────────────────────────

function buildSchema(r) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name: r.name,
    address: {
      '@type': 'PostalAddress',
      streetAddress: r.address,
      addressLocality: r.city,
      addressRegion: r.state,
      postalCode: r.zip,
      addressCountry: 'US',
    },
  };
  if (r.lat && r.lng) {
    schema.geo = { '@type': 'GeoCoordinates', latitude: r.lat, longitude: r.lng };
  }
  if (r.phone) schema.telephone = r.phone;
  if (r.website) schema.url = r.website;
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

// ─── Full page builder ────────────────────────────────────────────────────────

function buildPage(r, stores) {
  const slug      = r.slug;
  const name      = r.name || 'Ice Rink';
  const city      = r.city || '';
  const state     = r.state || '';
  const address   = r.address || '';
  const zip       = r.zip || '';

  const mapsUrl = r.lat && r.lng
    ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${address} ${city} ${state} ${zip}`)}`;

  const addressDisplay = [address, city, state].filter(Boolean).join(', ');
  const addressFull    = [address, city, state, zip].filter(Boolean).join(', ');
  const addressStreet  = address || addressDisplay; // just street for contact section

  const eyebrow = r.region
    ? `${r.region} &middot; ${city}${state ? ', ' + state : ''}`
    : `${city}${state ? ', ' + state : ''}`;

  const typeTag = r.type
    ? `<span class="tag">${esc(r.type.charAt(0).toUpperCase() + r.type.slice(1).toLowerCase())}</span>`
    : '';

  const sheetsTag = r.sheets
    ? `<span class="tag">${r.sheets} ${parseInt(r.sheets) === 1 ? 'Sheet' : 'Sheets'}</span>`
    : '';

  const appUrl    = `../?rink=${slug}`;
  const reviewUrl = `../?rink=${slug}&action=review`;

  const badges     = buildBadges(r);
  const notes      = cleanNotes(r.notes);
  const updatedAt  = formatMonth(r.updated_at);
  const isoUpdated = isoDate(r.updated_at);

  const phoneFormatted = r.phone ? formatPhone(r.phone) : null;
  const socialLinks    = buildSocialLinks(r);
  const regRow         = buildRegistrationRow(r);

  const ogImage = r.photo_url
    ? `<meta property="og:image" content="${esc(r.photo_url)}">`
    : '';

  const heroStyle = r.photo_url
    ? ` style="background-image: linear-gradient(to bottom, rgba(6,13,31,0.55) 0%, rgba(6,13,31,0.95) 100%), url('${esc(r.photo_url)}'); background-size: cover; background-position: center;"`
    : '';

  const nearStores = nearbyStores(r, stores);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(name)} — Ice Skating in ${esc(city)}, ${esc(state)} | The Rink Link</title>
  <meta name="description" content="Public skating info for ${esc(name)} in ${esc(city)}, ${esc(state)}. Hours, prices, amenities and more.">
  <link rel="canonical" href="${SITE_ORIGIN}/rinks/${slug}.html">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(name)} — Ice Skating in ${esc(city)}, ${esc(state)} | The Rink Link">
  <meta property="og:description" content="Public skating info for ${esc(name)} in ${esc(city)}, ${esc(state)}. Hours, prices, amenities and more.">
  <meta property="og:url" content="${SITE_ORIGIN}/rinks/${slug}.html">
  ${ogImage}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary${r.photo_url ? '_large_image' : ''}">
  <meta name="twitter:title" content="${esc(name)} — Ice Skating in ${esc(city)}, ${esc(state)}">
  <meta name="twitter:description" content="Public skating info for ${esc(name)} in ${esc(city)}, ${esc(state)}.">
  ${r.photo_url ? `<meta name="twitter:image" content="${esc(r.photo_url)}">` : ''}

  <!-- Favicons -->
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@400;500&family=Barlow+Condensed:wght@400;600;700;800&display=swap" rel="stylesheet">

  ${buildSchema(r)}

  <style>
    :root {
      --navy:   #060d1f;
      --navy2:  #0c1a35;
      --card:   #0e1e3a;
      --card2:  #112245;
      --ice:    #a8d4f5;
      --gold:   #e8b84b;
      --white:  #f0f4ff;
      --muted:  #7a8fb0;
      --border:  rgba(168,212,245,0.11);
      --border2: rgba(168,212,245,0.22);
      --r: 10px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--navy);
      color: var(--white);
      font-family: 'Barlow', sans-serif;
      font-size: 1rem;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    a { color: inherit; text-decoration: none; }

    /* ── Header ── */
    .site-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--navy2);
      border-bottom: 1px solid var(--border);
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.25rem;
    }

    .logo {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 1.35rem;
      letter-spacing: 0.03em;
      color: var(--white);
      white-space: nowrap;
    }

    .logo .rink-word { color: var(--ice); }

    .header-cta {
      display: inline-block;
      background: var(--gold);
      color: var(--navy);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.8rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.45rem 0.9rem;
      border-radius: 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .header-cta .full-text { display: inline; }
    .header-cta .short-text { display: none; }

    /* ── Hero ── */
    .rink-hero {
      max-width: 760px;
      margin: 0 auto;
      padding: 2.5rem 1.25rem 1.5rem;
    }

    .rink-hero-wrap {
      border-radius: var(--r);
      overflow: hidden;
      padding: 2.5rem 1.25rem 1.5rem;
    }

    .eyebrow {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 0.3rem;
    }

    .breadcrumb {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 0.9rem;
    }

    .breadcrumb a { color: var(--ice); }
    .breadcrumb a:hover { text-decoration: underline; }

    h1 {
      font-family: 'Bebas Neue', sans-serif;
      font-weight: 400;
      font-size: 2rem;
      line-height: 1.1;
      letter-spacing: 0.02em;
      color: var(--white);
      margin-bottom: 0.5rem;
    }

    .rink-location {
      font-size: 0.95rem;
      color: var(--muted);
      margin-bottom: 0.9rem;
    }

    .rink-location a {
      color: var(--ice);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .rink-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .tag {
      display: inline-block;
      background: var(--card2);
      border: 1px solid var(--border);
      color: var(--ice);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.8rem;
      letter-spacing: 0.04em;
      padding: 0.2rem 0.6rem;
      border-radius: 5px;
    }

    /* ── Body ── */
    .rink-body {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 1.25rem 4rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    /* ── Claim banner ── */
    .claim-banner {
      background: rgba(232,184,75,0.08);
      border: 1px solid rgba(232,184,75,0.25);
      border-radius: var(--r);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      font-size: 0.88rem;
      color: var(--muted);
    }

    .claim-banner a {
      color: var(--gold);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    /* ── Conversion card ── */
    .conversion-card {
      background: rgba(26,155,230,0.08);
      border: 1px solid var(--border2);
      border-radius: var(--r);
      padding: 1.25rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .conversion-card .cc-copy p {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 1.05rem;
      color: var(--ice);
    }

    .conversion-card .cc-copy .sub {
      font-family: 'Barlow', sans-serif;
      font-weight: 400;
      font-size: 0.85rem;
      color: var(--muted);
      margin-top: 0.2rem;
    }

    .btn-gold {
      display: inline-block;
      background: var(--gold);
      color: var(--navy);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.5rem 1.1rem;
      border-radius: 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Sections ── */
    section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--r);
      padding: 1.25rem 1.5rem;
    }

    section h2 {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--ice);
      margin-bottom: 0.85rem;
    }

    /* ── Amenity badges ── */
    .badge-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
    }

    .badge {
      display: inline-block;
      background: rgba(168,212,245,0.08);
      border: 1px solid var(--border);
      color: var(--ice);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.8rem;
      letter-spacing: 0.03em;
      padding: 0.28rem 0.65rem;
      border-radius: 6px;
    }

    /* ── Contact ── */
    .contact-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      font-size: 0.95rem;
    }

    .contact-list strong {
      color: var(--muted);
      font-weight: 500;
      margin-right: 0.3rem;
    }

    .contact-list a {
      color: var(--ice);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    /* ── Notes / spectator ── */
    .notes p, .spectator-notes p {
      font-size: 0.95rem;
      color: var(--white);
      line-height: 1.65;
    }

    /* ── Updated at ── */
    .updated-at {
      font-size: 0.78rem;
      color: var(--muted);
      margin-top: 0.75rem;
      font-style: italic;
    }

    /* ── Reviews ── */
    .reviews-empty {
      text-align: center;
      padding: 0.5rem 0 0.25rem;
    }

    .reviews-empty p {
      color: var(--muted);
      font-style: italic;
      font-size: 0.9rem;
      margin-bottom: 0.75rem;
    }

    .btn-outline-gold {
      display: inline-block;
      border: 1.5px solid var(--gold);
      color: var(--gold);
      background: transparent;
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.5rem 1.1rem;
      border-radius: 6px;
    }

    /* ── Footer stores ── */
    .footer-stores-block {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 1.25rem 2rem;
    }

    .footer-stores-block h3 {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }

    .store-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
    }

    .store-card {
      background: var(--card2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      padding: 1rem 1.2rem;
      transition: border-color 0.15s;
    }

    .store-card:hover { border-color: var(--border2); }

    .sc-name {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.95rem;
      color: var(--ice);
      margin-bottom: 0.15rem;
    }

    .sc-dist {
      font-size: 0.75rem;
      color: var(--gold);
      margin-bottom: 0.3rem;
    }

    .sc-address, .sc-detail {
      font-size: 0.8rem;
      color: var(--muted);
      line-height: 1.4;
      margin-bottom: 0.2rem;
    }

    .sc-detail a { color: var(--ice); text-decoration: underline; text-underline-offset: 2px; }

    .sc-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.4rem;
    }

    .sc-link {
      font-size: 0.8rem;
      margin-top: 0.4rem;
    }

    .sc-link a { color: var(--ice); text-decoration: underline; text-underline-offset: 2px; }

    /* ── Footer CTA block ── */
    .footer-cta-block {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 1.25rem 3rem;
    }

    .footer-cta-block h3 {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }

    .footer-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
    }

    .footer-card {
      background: var(--card2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      padding: 1rem 1.2rem;
      display: block;
      transition: border-color 0.15s;
    }

    .footer-card:hover { border-color: var(--border2); }

    .footer-card .fc-label {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 0.95rem;
      color: var(--ice);
      margin-bottom: 0.25rem;
    }

    .footer-card .fc-desc {
      font-size: 0.8rem;
      color: var(--muted);
      line-height: 1.4;
    }

    /* ── Site footer ── */
    .site-footer {
      background: var(--navy2);
      border-top: 1px solid var(--border);
      text-align: center;
      padding: 1.5rem 1.25rem;
    }

    .site-footer p {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }

    .site-footer a {
      color: var(--ice);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    /* ── Mobile ── */
    @media (max-width: 480px) {
      .header-cta .full-text { display: none; }
      .header-cta .short-text { display: inline; }
      .header-cta { font-size: 0.7rem; padding: 0.35rem 0.65rem; }
      h1 { font-size: 1.65rem; }
      .conversion-card { flex-direction: column; align-items: flex-start; }
      .claim-banner { flex-direction: column; align-items: flex-start; }
    }

    /* ── Print ── */
    @media print {
      .site-header, .conversion-card, .footer-cta-block, .footer-stores-block, .site-footer { display: none; }
      body { background: #fff; color: #000; }
      section { border: 1px solid #ccc; }
      a { color: #000; }
    }
  </style>
</head>
<body data-rink-slug="${esc(slug)}" data-lat="${esc(String(r.lat || ''))}" data-lng="${esc(String(r.lng || ''))}">

<header class="site-header">
  <a href="../index.html" class="logo">The <span class="rink-word">Rink</span> Link</a>
  <a href="${appUrl}" class="header-cta">
    <span class="full-text">&#11088; VIEW ICE TIMES &amp; SCHEDULES &rarr;</span>
    <span class="short-text">OPEN IN APP &rarr;</span>
  </a>
</header>

<main>

  <div class="rink-hero"${heroStyle}>
    <div class="eyebrow">${eyebrow}</div>
    <div class="breadcrumb">
      <a href="../index.html">All Rinks</a> &rsaquo;
      <span>${esc(state)}</span> &rsaquo;
      <span>${esc(city)}</span>
    </div>
    <h1>${esc(name)}</h1>
    <p class="rink-location">
      <a href="${mapsUrl}" target="_blank" rel="noopener">${esc(address || addressDisplay)}</a>
    </p>
    <div class="rink-meta">
      ${typeTag}
      ${sheetsTag}
    </div>
  </div>

  <div class="rink-body">

    ${buildClaimedBanner(r)}

    <div class="conversion-card">
      <div class="cc-copy">
        <p>See this rink live in The Rink Link</p>
        <p class="sub">Live weather, schedules, reviews &amp; save your home rink.</p>
      </div>
      <a href="${appUrl}" class="btn-gold">&#11088; View Ice Times &amp; Schedules &rarr;</a>
    </div>

    ${badges.length ? `
    <section class="amenities">
      <h2>Amenities</h2>
      <div class="badge-grid">
        ${badges.join('\n        ')}
      </div>
    </section>` : ''}

    ${buildPricingSection(r)}

    <section class="contact">
      <h2>Contact &amp; Info</h2>
      <ul class="contact-list">
        ${r.phone    ? `<li><strong>Phone:</strong> <a href="tel:${phoneFormatted || esc(r.phone)}">${esc(r.phone)}</a></li>` : ''}
        ${r.website  ? `<li><strong>Website:</strong> <a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(hostname(r.website))}</a></li>` : ''}
        ${r.email    ? `<li><strong>Email:</strong> <a href="mailto:${esc(r.email)}">${esc(r.email)}</a></li>` : ''}
        <li><strong>Address:</strong> <a href="${mapsUrl}" target="_blank" rel="noopener">${esc(addressStreet)}</a></li>
        ${socialLinks}
        ${regRow}
        ${updatedAt ? `<li class="updated-at">Last updated ${updatedAt}</li>` : ''}
      </ul>
    </section>

    ${buildSpectatorSection(r)}

    ${notes ? `
    <section class="notes">
      <h2>About this rink</h2>
      <p>${esc(notes)}</p>
    </section>` : ''}

    <section class="reviews">
      <h2>Reviews</h2>
      <div class="reviews-empty">
        <p>No reviews yet. Be the first to share your experience.</p>
        <a href="${reviewUrl}" class="btn-outline-gold">&#11088; Be the First to Review &rarr;</a>
      </div>
    </section>

    <!-- FUTURE: Ice Schedule section (data not yet stable) -->
    <!-- FUTURE: Around the Rink / restaurants section -->
    <!-- FUTURE: Teams & Resources section -->

  </div>

</main>

${buildStoresSection(nearStores)}

<div class="footer-cta-block">
  <h3>More on The Rink Link</h3>
  <div class="footer-cards">
    <a href="../index.html" class="footer-card">
      <div class="fc-label">It&rsquo;s not just rinks</div>
      <div class="fc-desc">Stores, sharpening, leagues, coaches &amp; more &rarr;</div>
    </a>
    <a href="../index.html" class="footer-card">
      <div class="fc-label">Know a great hockey coach?</div>
      <div class="fc-desc">Help us build the directory &rarr;</div>
    </a>
    <a href="../youth-hockey-gear-guide.html" class="footer-card">
      <div class="fc-label">New to hockey gear?</div>
      <div class="fc-desc">Skates, sticks, what to buy first &rarr;</div>
    </a>
  </div>
</div>

<footer class="site-footer">
  <p>&copy; ${new Date().getFullYear()} The Rink Link &middot; <a href="../index.html">Find a rink near you</a></p>
  <p>Know something we don&rsquo;t? <a href="mailto:hello@therinklink.com">Let us know</a></p>
</footer>

</body>
</html>`;
}

// ─── Sitemap builder ──────────────────────────────────────────────────────────

function buildSitemap(rinks) {
  const urls = rinks
    .filter(r => r.slug)
    .map(r => `
  <url>
    <loc>${SITE_ORIGIN}/rinks/${r.slug}.html</loc>
    <lastmod>${isoDate(r.updated_at)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏒  The Rink Link — Page Generator`);
  console.log(`    ${DRY_RUN ? '🔍 DRY RUN — no files will be written' : '✍️  Writing files'}`);
  if (LIMIT) console.log(`    ⚠️  Limited to first ${LIMIT} rinks`);
  console.log('');

  // 1. Fetch data
  console.log('📡 Fetching rinks from Supabase...');
  let rinks = await fetchAllRinks();
  console.log(`   ${rinks.length} rinks fetched.`);

  console.log('📡 Fetching hockey stores from Supabase...');
  const stores = await fetchAllStores();
  console.log(`   ${stores.length} stores fetched.\n`);

  // 2. Separate slugless rinks
  const slugless = rinks.filter(r => !r.slug);
  const withSlug = rinks.filter(r => r.slug);

  if (slugless.length) {
    console.log(`⚠️  Skipped (no slug): ${slugless.length} rinks`);
    slugless.forEach(r => console.log(`     - [id:${r.id}] ${r.name || '(unnamed)'} — ${r.city || ''}, ${r.state || ''}`));
    console.log('');
  }

  // 3. Apply limit if set
  const toGenerate = LIMIT ? withSlug.slice(0, LIMIT) : withSlug;

  // 4. Ensure output dir exists
  if (!DRY_RUN && !fs.existsSync(RINKS_DIR)) {
    fs.mkdirSync(RINKS_DIR, { recursive: true });
  }

  // 5. Generate pages
  console.log(`⚙️  Generating ${toGenerate.length} pages...`);
  let written = 0, errors = 0;
  const generatedSlugs = new Set();

  for (const rink of toGenerate) {
    try {
      const html  = buildPage(rink, stores);
      const fpath = path.join(RINKS_DIR, `${rink.slug}.html`);
      if (!DRY_RUN) fs.writeFileSync(fpath, html, 'utf8');
      generatedSlugs.add(rink.slug);
      written++;
      if (written % 100 === 0) console.log(`   ... ${written} pages written`);
    } catch (err) {
      errors++;
      console.error(`   ❌ Error on rink [id:${rink.id}] ${rink.name}: ${err.message}`);
    }
  }

  console.log(`   ✅ ${written} pages ${DRY_RUN ? 'would be ' : ''}written. ${errors ? `❌ ${errors} errors.` : ''}\n`);

  // 6. Orphan check
  if (fs.existsSync(RINKS_DIR)) {
    const existingFiles = fs.readdirSync(RINKS_DIR).filter(f => f.endsWith('.html'));
    const orphans = existingFiles.filter(f => !generatedSlugs.has(f.replace('.html', '')));
    if (orphans.length) {
      console.log(`🔍 Orphaned HTML files (not in Supabase, NOT deleted):`);
      orphans.forEach(f => console.log(`     - rinks/${f}`));
      console.log('');
    } else {
      console.log('✅ No orphaned HTML files found.\n');
    }
  }

  // 7. Sitemap
  console.log('🗺️  Writing sitemap.xml...');
  const sitemap = buildSitemap(withSlug);
  if (!DRY_RUN) fs.writeFileSync(SITEMAP_PATH, sitemap, 'utf8');
  console.log(`   ✅ sitemap.xml ${DRY_RUN ? 'would include' : 'includes'} ${withSlug.length} URLs.\n`);

  console.log('🏁 Done.\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
