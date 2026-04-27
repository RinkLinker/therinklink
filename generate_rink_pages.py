"""
RinkLinker — Static Rink Page Generator
Run: python generate_rink_pages.py
Output: /rinks/*.html  (one file per rink)
Also generates: sitemap.xml
"""

import pandas as pd
import os
import re
from math import isnan

# ── CONFIG ──────────────────────────────────────────────────────────────────
CSV_PATH = "rinks_enriched_working.csv"
OUTPUT_DIR = "rinks"
SITE_URL = "https://www.therinklink.com"  # ← update if different
# ────────────────────────────────────────────────────────────────────────────

def slugify(name, city, state):
    raw = f"{name}-{city}-{state}".lower()
    raw = re.sub(r"[^a-z0-9\s-]", "", raw)
    raw = re.sub(r"\s+", "-", raw.strip())
    raw = re.sub(r"-+", "-", raw)
    return raw[:80]

def val(v):
    """Return clean string or empty string for NaN/None."""
    if v is None:
        return ""
    try:
        if isnan(float(v)):
            return ""
    except (TypeError, ValueError):
        pass
    return str(v).strip()

def bool_badge(v, label):
    """Return a badge span if True, empty string otherwise."""
    s = val(v).lower()
    if s in ("true", "1", "yes"):
        return f'<span class="badge badge-yes">{label}</span>'
    return ""

def price_rows(label, value):
    v = val(value)
    if not v:
        return ""
    items = v.split("|")
    rows = ""
    for item in items:
        item = item.strip()
        if item:
            rows += f"<li>{item}</li>"
    return f"""
    <div class="price-block">
      <h3>{label}</h3>
      <ul>{rows}</ul>
    </div>"""

def social_links(rink):
    links = ""
    fb = val(rink.get("facebook_url"))
    ig = val(rink.get("instagram_url"))
    tt = val(rink.get("tiktok_url"))
    if fb:
        links += f'<a href="{fb}" class="social-link" target="_blank" rel="noopener">Facebook</a>'
    if ig:
        links += f'<a href="{ig}" class="social-link" target="_blank" rel="noopener">Instagram</a>'
    if tt:
        links += f'<a href="{tt}" class="social-link" target="_blank" rel="noopener">TikTok</a>'
    return links

def amenity_badges(rink):
    checks = [
        ("skate_rentals",  "Skate Rental"),
        ("sharpening",     "Skate Sharpening"),
        ("locker_rooms",   "Locker Rooms"),
        ("wifi",           "WiFi"),
        ("livebarn",       "LiveBarn"),
        ("on_site_shops",  "Pro Shop"),
        ("viewing",        "Spectator Area"),
        ("accessible",     "Accessible"),
        ("year_round",     "Year-Round"),
    ]
    badges = ""
    for field, label in checks:
        v = val(rink.get(field, "")).lower()
        # locker_rooms is a count, not a boolean
        if field == "locker_rooms":
            count = val(rink.get("locker_rooms"))
            if count and count not in ("0", ""):
                badges += f'<span class="badge badge-yes">Locker Rooms ({count})</span>'
        else:
            if v in ("true", "1", "yes"):
                badges += f'<span class="badge badge-yes">{label}</span>'
    food = val(rink.get("food"))
    if food:
        badges += f'<span class="badge badge-yes">{food.title()}</span>'
    parking = val(rink.get("parking"))
    if parking:
        badges += f'<span class="badge badge-info" title="{parking}">Parking</span>'
    return badges or '<span class="badge badge-neutral">Details coming soon</span>'

def render_page(rink):
    name      = val(rink.get("name")) or "Ice Rink"
    city      = val(rink.get("city"))
    state     = val(rink.get("state"))
    address   = val(rink.get("address"))
    phone     = val(rink.get("phone"))
    email     = val(rink.get("email"))
    website   = val(rink.get("website"))
    rink_type = val(rink.get("type"))
    sheets    = val(rink.get("sheets"))
    region    = val(rink.get("region"))
    notes     = val(rink.get("notes"))
    spec_notes= val(rink.get("spectator_notes"))
    reg_label = val(rink.get("registration_label")) or "Register / Book"
    reg_url   = val(rink.get("registration_url"))
    lat       = val(rink.get("lat"))
    lng       = val(rink.get("lng"))
    rink_id   = val(rink.get("id"))
    slug      = slugify(name, city, state)

    location_str = f"{city}, {state}" if city and state else state or city
    title_tag = f"{name} — Ice Skating in {location_str} | RinkLinker"
    meta_desc = f"Public skating info for {name} in {location_str}. Hours, prices, amenities and more."

    maps_url = ""
    if lat and lng:
        maps_url = f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"
    elif address:
        maps_url = f"https://www.google.com/maps/search/?api=1&query={address.replace(' ', '+')}"

    prices_html = ""
    prices_html += price_rows("Public Skating", rink.get("price_public_skate"))
    prices_html += price_rows("Stick & Puck / Drop-in Hockey", rink.get("price_stick_puck"))
    prices_html += price_rows("Drop-in (Other)", rink.get("price_dropin"))

    schema = f"""{{
    "@context": "https://schema.org",
    "@type": "SportsActivityLocation",
    "name": "{name.replace('"', '')}",
    "address": {{
      "@type": "PostalAddress",
      "streetAddress": "{address}",
      "addressLocality": "{city}",
      "addressRegion": "{state}"
    }}{f', "telephone": "{phone}"' if phone else ''}{f', "url": "{website}"' if website else ''}
  }}"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title_tag}</title>
  <meta name="description" content="{meta_desc}">
  <link rel="canonical" href="{SITE_URL}/rinks/{slug}.html">
  <meta property="og:title" content="{name} — RinkLinker">
  <meta property="og:description" content="{meta_desc}">
  <meta property="og:url" content="{SITE_URL}/rinks/{slug}.html">
  <meta property="og:type" content="website">
  <link rel="stylesheet" href="../rink-page.css">
  <script type="application/ld+json">{schema}</script>
</head>
<body>

<header class="site-header">
  <a href="../index.html" class="logo">&#x2744; RinkLinker</a>
  <nav>
    <a href="../index.html">Find a Rink</a>
  </nav>
</header>

<main class="rink-page">

  <div class="rink-hero">
    <div class="breadcrumb">
      <a href="../index.html">All Rinks</a> &rsaquo;
      <span>{state}</span> &rsaquo;
      <span>{city}</span>
    </div>
    <h1>{name}</h1>
    <p class="rink-location">
      {f'<a href="{maps_url}" target="_blank" rel="noopener">' if maps_url else ''}{address}{f'</a>' if maps_url else ''}
      {f'&nbsp;&middot;&nbsp; {region}' if region else ''}
    </p>
    <div class="rink-meta">
      {f'<span class="tag">{rink_type}</span>' if rink_type else ''}
      {f'<span class="tag">{sheets} sheet{"s" if sheets != "1" else ""}</span>' if sheets else ''}
    </div>
  </div>

  <div class="rink-body">

    <section class="amenities">
      <h2>Amenities</h2>
      <div class="badge-grid">
        {amenity_badges(rink)}
      </div>
    </section>

    {f'''<section class="pricing">
      <h2>Pricing</h2>
      {prices_html}
    </section>''' if prices_html.strip() else ''}

    <section class="contact">
      <h2>Contact & Info</h2>
      <ul class="contact-list">
        {f'<li><strong>Phone:</strong> <a href="tel:{phone}">{phone}</a></li>' if phone else ''}
        {f'<li><strong>Email:</strong> <a href="mailto:{email}">{email}</a></li>' if email else ''}
        {f'<li><strong>Website:</strong> <a href="{website}" target="_blank" rel="noopener">{website}</a></li>' if website else ''}
        {f'<li><strong>Address:</strong> <a href="{maps_url}" target="_blank" rel="noopener">{address}</a></li>' if address else ''}
      </ul>
      {f'<div class="social-links">{social_links(rink)}</div>' if social_links(rink) else ''}
      {f'<a href="{reg_url}" class="btn-register" target="_blank" rel="noopener">{reg_label}</a>' if reg_url else ''}
    </section>

    {f'<section class="notes"><h2>About this rink</h2><p>{notes}</p></section>' if notes else ''}
    {f'<section class="notes"><h2>Spectator info</h2><p>{spec_notes}</p></section>' if spec_notes else ''}

    {f'''<section class="map-section">
      <h2>Location</h2>
      <a href="{maps_url}" target="_blank" rel="noopener" class="map-link">Open in Google Maps &rarr;</a>
    </section>''' if maps_url else ''}

  </div>

</main>

<footer class="site-footer">
  <p>&copy; 2025 RinkLinker &middot; <a href="../index.html">Find a rink near you</a></p>
  <p class="footer-small">Know something we don&rsquo;t? <a href="mailto:hello@therinklink.com">Let us know</a></p>
</footer>

</body>
</html>"""

def generate_sitemap(slugs):
    urls = [f"  <url><loc>{SITE_URL}/rinks/{s}.html</loc></url>" for s in slugs]
    urls.insert(0, f"  <url><loc>{SITE_URL}/</loc></url>")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{chr(10).join(urls)}
</urlset>"""

def main():
    print(f"Reading {CSV_PATH}...")
    df = pd.read_csv(CSV_PATH)
    total = len(df)
    print(f"Found {total} rinks.")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    slugs = []
    errors = []

    for i, row in df.iterrows():
        rink = row.to_dict()
        name  = val(rink.get("name")) or f"rink-{rink.get('id')}"
        city  = val(rink.get("city"))
        state = val(rink.get("state"))
        slug  = slugify(name, city, state)

        # Handle duplicate slugs
        base_slug = slug
        counter = 2
        while slug in slugs:
            slug = f"{base_slug}-{counter}"
            counter += 1

        slugs.append(slug)
        filepath = os.path.join(OUTPUT_DIR, f"{slug}.html")

        try:
            html = render_page(rink)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(html)
            if (i + 1) % 100 == 0:
                print(f"  {i+1}/{total} generated...")
        except Exception as e:
            errors.append((rink.get("id"), name, str(e)))

    # Sitemap
    sitemap = generate_sitemap(slugs)
    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write(sitemap)
    print(f"\nDone! {total - len(errors)} pages in /{OUTPUT_DIR}/")
    print(f"sitemap.xml generated with {len(slugs)+1} URLs")
    if errors:
        print(f"\nErrors ({len(errors)}):")
        for eid, ename, err in errors:
            print(f"  ID {eid} {ename}: {err}")

if __name__ == "__main__":
    main()
