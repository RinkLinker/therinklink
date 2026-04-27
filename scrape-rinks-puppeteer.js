#!/usr/bin/env node
/**
 * Scrapes rink data from therinklink.com using Puppeteer.
 * Loads the live page, clicks each rink card via openModal(), and writes rinks.csv.
 *
 * Usage:
 *   node scrape-rinks-puppeteer.js
 *   node scrape-rinks-puppeteer.js --out my-rinks.csv
 *   node scrape-rinks-puppeteer.js --headless false   (watch the browser)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const outFile = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : path.join(__dirname, 'rinks.csv');
const headless = (args.includes('--headless') && args[args.indexOf('--headless') + 1] === 'false')
  ? false
  : 'new';

// ── CSV helpers ────────────────────────────────────────────────────────────────

function csvField(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n|\r/g, ' ').trim();
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function csvRow(cols) {
  return cols.map(csvField).join(',');
}

// ── Extract RINKS array from raw HTML (same technique as scrape-rinks.js) ──────

function extractRinks(html) {
  const start = html.indexOf('const RINKS=[');
  if (start === -1) throw new Error('Could not find RINKS array in HTML');

  let depth = 0, inStr = false, strChar = '', escape = false;
  let i = start + 'const RINKS='.length;
  let endIdx = -1;

  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (inStr) { if (c === strChar) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; continue; }
    if (c === ']' || c === '}' || c === ')') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx === -1) throw new Error('Could not find end of RINKS array');

  // Strip 'const' so the assignment lands on the sandbox object (vm ignores const-scoped vars)
  const src = 'RINKS=' + html.slice(start + 'const RINKS='.length, endIdx) + ';';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.RINKS;
}

// ── Map a RINKS entry to Supabase column names ────────────────────────────────

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

function yesNo(val) {
  if (val === true) return 'true';
  if (val === false) return 'false';
  return '';
}

function extractZip(address) {
  if (!address) return '';
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b/g);
  return m ? m[m.length - 1].slice(0, 5) : '';
}

function hasAmenity(amenities, keyword) {
  return Array.isArray(amenities) && amenities.some(a => a.toLowerCase().includes(keyword.toLowerCase()));
}

function mapRink(r) {
  const p = r.parentInfo || {};
  const pr = r.pricing || {};
  const spt = r.stickPuckTimes || {};
  const amenities = r.amenities || [];
  const shops = Array.isArray(r.shops) ? r.shops : [];

  // on_site_shops: boolean — true only for actual pro/skate shops, not rental-only counters
  const onSiteShopList = shops
    .filter(s => /on.?site|on campus|in arena/i.test(s.dist || ''))
    .filter(s => !/rental|rent booth|skate rent|warming shelter|concession area|limited on-?site|^on-?site$/i.test((s.name || '').trim()))
    .map(s => s.name);
  const onSiteShops = onSiteShopList.length ? 'true' : '';

  // food tier label
  let food = '';
  if (p.food && p.food.tier) {
    food = { restaurant: 'restaurant', snackbar: 'snackbar', vending: 'vending', none: 'none' }[p.food.tier] || p.food.tier;
  } else if (hasAmenity(amenities, 'Restaurant') || hasAmenity(amenities, 'Grill') || hasAmenity(amenities, 'Bar')) {
    food = 'restaurant';
  } else if (hasAmenity(amenities, 'Concession') || hasAmenity(amenities, 'Snack')) {
    food = 'concessions';
  } else if (hasAmenity(amenities, 'Vending')) {
    food = 'vending';
  }

  // sharpening
  const sharpening = (hasAmenity(amenities, 'Sharpening') || shops.some(s => /sharpen/i.test(s.detail || ''))) ? 'true' : '';

  // wifi
  const wifi = p.wifi != null ? yesNo(p.wifi.available) : '';

  // livebarn
  const livebarn = p.livebarn != null ? yesNo(p.livebarn.available) : '';

  // seating_type from amenities
  let seatingType = '';
  const seatAm = amenities.find(a => /seat|bleach|stand/i.test(a));
  if (seatAm) seatingType = /bleach/i.test(seatAm) ? 'bleachers' : 'seats';

  // viewing: yes if seating or food present
  const viewing = (seatingType || food) ? 'true' : '';

  // registration
  const regUrl = spt.bookingUrl || '';
  const regLabel = regUrl ? 'Book Online' : '';

  // spectator_notes: food name + details
  let spectatorNotes = '';
  if (p.food && p.food.name) {
    spectatorNotes = p.food.name;
    if (p.food.details) spectatorNotes += ': ' + p.food.details;
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
    sharpening,
    food,
    livebarn,
    wifi,
    r.parking || '',
    r.locker ? (r.locker.rooms != null ? r.locker.rooms : '') : '',
    onSiteShops,
    pr.publicSkate || '',
    pr.stickPuck || '',
    pr.dropin || pr.dropInHockey || '',
    regLabel,
    regUrl,
    r.website || '',
    seatingType,
    viewing,
    r.accessible || '',
    spectatorNotes,
    r.facebook_url || r.facebookUrl || '',
    r.instagram_url || r.instagramUrl || '',
    r.tiktok_url || r.tiktokUrl || '',
    r.photo_url || r.photoUrl || '',
    r.claimed != null ? yesNo(r.claimed) : '',
    [r.notes || '', onSiteShopList.length ? 'On-site shop: ' + onSiteShopList.join(', ') : ''].filter(Boolean).join(' | '),
  ];
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await puppeteer.launch({ headless });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.on('console', () => {});
  page.on('pageerror', () => {});

  log('Navigating to https://therinklink.com …');
  await page.goto('https://therinklink.com', { waitUntil: 'networkidle2' });

  log('Extracting RINKS from page HTML …');
  const html = await page.content();
  const rinks = extractRinks(html);
  log(`Found ${rinks.length} rinks.`);

  // Click each card via openModal() to verify interactive rendering
  log('Clicking each rink card …');
  for (let i = 0; i < rinks.length; i++) {
    const r = rinks[i];
    const pct = Math.round(((i + 1) / rinks.length) * 100);
    process.stderr.write(`\r  ${i + 1}/${rinks.length} (${pct}%)  ${r.name.slice(0, 48).padEnd(48)}`);

    try {
      await page.evaluate((id) => { if (typeof openModal === 'function') openModal(id); }, r.id);
      await page.waitForSelector('#modal-ov.open', { timeout: 2000 }).catch(() => {});
      await page.evaluate(() => { if (typeof closeModal === 'function') closeModal(); });
    } catch (_) { /* non-fatal */ }
  }
  process.stderr.write('\n');

  // Write CSV
  const rows = [csvRow(HEADERS), ...rinks.map(mapRink).map(csvRow)];
  fs.writeFileSync(outFile, rows.join('\n') + '\n', 'utf8');

  await browser.close();
  log(`Saved ${rinks.length} rinks → ${outFile}`);
}

function log(msg) { process.stderr.write(msg + '\n'); }

main().catch(err => {
  process.stderr.write('\nError: ' + err.message + '\n');
  process.exit(1);
});
