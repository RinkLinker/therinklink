#!/usr/bin/env node
/**
 * Scrapes rink data from therinklink.com and outputs CSV.
 * Usage: node scrape-rinks.js [--local] > rinks.csv
 *   --local  Read from local index.html instead of fetching the live site
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const USE_LOCAL = process.argv.includes('--local');
const LOCAL_FILE = path.join(__dirname, 'index.html');

// ── helpers ────────────────────────────────────────────────────────────────────

function csvField(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').trim();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function row(cols) {
  return cols.map(csvField).join(',');
}

function extractZip(address) {
  if (!address) return '';
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b(?=[^0-9]|$)/g);
  return m ? m[m.length - 1].slice(0, 5) : '';
}

function hasAmenity(amenities, keyword) {
  if (!Array.isArray(amenities)) return false;
  return amenities.some(a => a.toLowerCase().includes(keyword.toLowerCase()));
}

function yesNo(val) {
  if (val === true || val === 'true') return 'yes';
  if (val === false || val === 'false') return 'no';
  return '';
}

// ── extract RINKS array from HTML ──────────────────────────────────────────────

function extractRinks(html) {
  // Grab everything between `const RINKS=[` and the closing `];`
  const start = html.indexOf('const RINKS=[');
  if (start === -1) throw new Error('Could not find RINKS array in HTML');

  // Walk forward to find the matching closing ];
  let depth = 0;
  let inStr = false;
  let strChar = '';
  let escape = false;
  let i = start + 'const RINKS='.length; // points at the opening [
  const end_search = html.length;
  let endIdx = -1;

  for (; i < end_search; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (inStr) {
      if (c === strChar) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; continue; }
    if (c === ']' || c === '}' || c === ')') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx === -1) throw new Error('Could not find end of RINKS array');

  const rinksSrc = html.slice(start, endIdx) + ';';

  // Evaluate safely in a sandboxed context
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(rinksSrc, sandbox);
  return sandbox.RINKS;
}

// ── map a rink object → CSV row ────────────────────────────────────────────────

const HEADERS = [
  'id', 'name', 'address', 'city', 'state', 'zip',
  'lat', 'lng', 'region', 'type', 'sheets',
  'sharpening', 'food', 'livebarn', 'wifi',
  'parking', 'locker_rooms', 'on_site_shops',
  'price_public_skate', 'price_stick_puck', 'price_dropin',
  'registration_label', 'registration_url',
  'website',
  'seating_type', 'viewing', 'accessible', 'spectator_notes',
  'facebook_url', 'instagram_url', 'tiktok_url',
  'photo_url', 'claimed', 'notes',
];

function mapRink(r) {
  const pi = r.parentInfo || {};
  const pricing = r.pricing || {};
  const locker = r.locker || {};
  const spt = r.stickPuckTimes || {};
  const amenities = r.amenities || [];
  const shops = Array.isArray(r.shops) ? r.shops : [];

  // on_site_shops: shop names where dist is "On-site" or "On site" or "on-site"
  const onSiteShops = shops
    .filter(s => /on.?site/i.test(s.dist || ''))
    .map(s => s.name)
    .join('; ');

  // food: tier label from parentInfo.food, else infer from amenities
  let foodVal = '';
  if (pi.food && pi.food.tier) {
    foodVal = pi.food.tier;
  } else if (hasAmenity(amenities, 'Restaurant') || hasAmenity(amenities, 'Grill') || hasAmenity(amenities, 'Bar')) {
    foodVal = 'restaurant';
  } else if (hasAmenity(amenities, 'Concession') || hasAmenity(amenities, 'Snack')) {
    foodVal = 'concessions';
  } else if (hasAmenity(amenities, 'Cafe') || hasAmenity(amenities, 'Coffee')) {
    foodVal = 'cafe';
  } else if (hasAmenity(amenities, 'Vending')) {
    foodVal = 'vending';
  }

  // livebarn
  const livebarnVal = pi.livebarn ? yesNo(pi.livebarn.available) : '';

  // wifi
  const wifiVal = pi.wifi ? yesNo(pi.wifi.available) : '';

  // sharpening: yes/no based on amenities or on-site shop
  const sharpeningVal = (
    hasAmenity(amenities, 'Sharpening') ||
    shops.some(s => /sharpen/i.test(s.detail || ''))
  ) ? 'yes' : '';

  // seating_type: infer from amenities
  let seatingType = '';
  const seatingAmenity = amenities.find(a => /seat|bleach|stand/i.test(a));
  if (seatingAmenity) {
    if (/bleach/i.test(seatingAmenity)) seatingType = 'bleachers';
    else if (/seat/i.test(seatingAmenity)) seatingType = 'seats';
    else seatingType = seatingAmenity;
  }

  // viewing: yes if there are seats or bleachers mentioned, or a food tier (implies spectator area)
  const viewingVal = (seatingType || foodVal) ? 'yes' : '';

  // registration fields
  const regUrl = spt.bookingUrl || '';
  const regLabel = regUrl ? 'Book Online' : '';

  // price_dropin: some rinks distinguish drop-in from stick & puck
  // Try to extract from notes or pricing; if same as stickPuck, use that
  const dropinPrice = pricing.dropin || pricing.dropInHockey || '';

  // spectator_notes: combine food name+details if available
  let spectatorNotes = '';
  if (pi.food && pi.food.name) {
    spectatorNotes = pi.food.name;
    if (pi.food.details) spectatorNotes += ': ' + pi.food.details;
  }

  return [
    r.id,
    r.name,
    r.address,
    r.city,
    r.state,
    extractZip(r.address),
    r.lat,
    r.lng,
    r.region,
    r.type,
    r.sheets,
    sharpeningVal,
    foodVal,
    livebarnVal,
    wifiVal,
    r.parking || '',
    locker.rooms != null ? locker.rooms : '',
    onSiteShops,
    pricing.publicSkate || '',
    pricing.stickPuck || '',
    dropinPrice,
    regLabel,
    regUrl,
    r.website || '',
    seatingType,
    viewingVal,
    r.accessible || '',
    spectatorNotes,
    r.facebook_url || r.facebookUrl || '',
    r.instagram_url || r.instagramUrl || '',
    r.tiktok_url || r.tiktokUrl || '',
    r.photo_url || r.photoUrl || '',
    r.claimed != null ? yesNo(r.claimed) : '',
    r.notes || '',
  ];
}

// ── fetch or read HTML ─────────────────────────────────────────────────────────

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (scraper)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    get(url);
  });
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  let html;
  if (USE_LOCAL) {
    process.stderr.write('Reading local index.html…\n');
    html = fs.readFileSync(LOCAL_FILE, 'utf8');
  } else {
    process.stderr.write('Fetching https://therinklink.com…\n');
    html = await fetchHtml('https://therinklink.com');
  }

  process.stderr.write('Extracting RINKS array…\n');
  const rinks = extractRinks(html);
  process.stderr.write(`Found ${rinks.length} rinks.\n`);

  const lines = [row(HEADERS)];
  for (const r of rinks) {
    lines.push(row(mapRink(r)));
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.stderr.write('Done.\n');
}

main().catch(err => {
  process.stderr.write('Error: ' + err.message + '\n');
  process.exit(1);
});
