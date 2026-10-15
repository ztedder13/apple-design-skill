# Matchday Fuel build spec (v2)

Shared contract for everyone building this site. Paths are relative to `matchday-fuel/`.
Requirements come from the owner. Do not change file names, API shapes, or drink data without
updating this file.

## Owner requirements

1. White page background that matches the logo's background.
2. Realistic images of the drinks as they will look in real life: clear plastic 16.9 fl oz
   (500 mL) bottles with an aluminum can-style top (a "bottle can": straight-walled clear PET
   cylinder with a seamed can end and pull tab).
3. Every bottle carries a label with the drink's name and flavor. Each label uses the Matchday
   Fuel logo redrawn with that drink's sport ball (soccer ball, baseball, football, basketball,
   hockey puck) instead of always the soccer ball.
4. Apple-website-style scroll features, especially for the products.
5. A "where and when" schedule the owner can update, ideally fed by the business calendar.
6. Online ordering for grab-and-go pickup at the stand, using Square for prices, inventory, and
   payment.

## Layout

```
matchday-fuel/
  public/                 static site, the Netlify publish directory
    index.html  styles.css
    js/                   ES modules, no build step (app.js is the entry)
    data/schedule.json    hand-edited schedule, used when no calendar feed is set
    assets/logo/          brand logo and sport variants
    assets/drinks/        product renders
    assets/sequence/golden-boot/  360-degree frames for the scroll scene
  server/                 request handlers shared by Netlify Functions and the dev server
    test/                 node:test suites, run with `npm test`
  netlify/functions/      thin wrappers: menu.mjs, schedule.mjs, checkout.mjs
  tools/render/           three.js render pipeline for assets/drinks and assets/sequence
  tools/logos/            Pillow script that builds the sport logo variants
  package.json  netlify.toml  .env.example  README.md  SETUP.md
```

Runtime code (server/, netlify/, public/js/) has zero npm dependencies and runs on Node 20+.
Tools may use devDependencies (three).

## Brand

- Page background `#FFFFFF`. Ink `#1C130C`, secondary ink `#5F4A39`, accent brew `#7A3410`
  (actions only), panel `#F6F3EF`. Light appearance only (owner asked for white).
- Display face: Archivo (Google Fonts, variable, `wdth` 100–125, `wght` 600–900), set wide
  and uppercase for names. Body: the system font stack.
- Original logo: `/root/.claude/uploads/3460222a-b333-5208-8308-094eb58b7dae/e6ac454a-image.png`
  (1254 px square, paper color about `#F9F1E1`).

## Drinks (single source of truth)

Every bottle is 16.9 fl oz (500 mL). Caffeine values are recipe targets (placeholders).
`key` is the URL-safe id used in file names, HTML `data-drink`, and the menu API.

| key | Name | Line | Sport | Flavor (label text) | Liquid color | Look |
| --- | --- | --- | --- | --- | --- | --- |
| stoppage-time | Stoppage Time | Cold brew | soccer | Classic Black | #241208 | near-opaque black coffee, amber at thin edges |
| power-play | Power Play | Cold brew | hockey | Maple Oat Milk | #A97B55 | opaque, milky |
| seventh-inning-stretch | Seventh-Inning Stretch | Cold brew | baseball | Vanilla Sweet Cream | #C29A72 | opaque, creamy |
| hail-mary | Hail Mary | Cold brew | football | Salted Caramel | #9B6438 | opaque, milky |
| full-court-press | Full Court Press | Cold brew | basketball | Sea Salt Mocha | #5A3220 | opaque, chocolate |
| golden-boot | Golden Boot | Lotus energy | soccer | Mango Passionfruit | #F2A81D | translucent, sparkling |
| grand-slam | Grand Slam | Lotus energy | baseball | Blue Raspberry Lemonade | #2F74D0 | translucent, sparkling |
| red-zone | Red Zone | Lotus energy | football | Strawberry Watermelon | #E0384B | translucent, sparkling |
| buzzer-beater | Buzzer Beater | Lotus energy | basketball | Peach Orange | #F27A2E | translucent, sparkling |
| hat-trick | Hat Trick | Lotus energy | hockey | Triple Berry | #7B3FA6 | translucent, sparkling |

Caffeine (mg): stoppage-time 300, power-play 200, seventh-inning-stretch 180, hail-mary 190,
full-court-press 200, golden-boot 160, grand-slam 160, red-zone 160, buzzer-beater 120,
hat-trick 160.

Label line for the product type: "COLD BREW COFFEE" or "LOTUS ENERGY DRINK".
Sample prices (preview only): cold brew $6.00, Lotus energy $6.50.

## Asset contract

All images sit on pure white `#FFFFFF` unless noted. WebP unless noted.

| File | Size | Content |
| --- | --- | --- |
| `public/assets/logo/matchday-fuel.webp` | 960 px square | Original logo, paper corrected to white |
| `public/assets/logo/matchday-fuel-480.webp` | 480 px | Same, small |
| `public/assets/logo/matchday-fuel-1200.jpg` | 1200 px | Social preview |
| `public/assets/logo/apple-touch-icon.png` | 180 px | Home-screen icon |
| `public/assets/logo/sport-{soccer,baseball,football,basketball,hockey}.webp` | 960 px | Logo variant with that sport's ball |
| `public/assets/logo/sport-{sport}-720.webp`, `-480.webp` | 720, 480 px | Same, smaller (also `matchday-fuel-720.webp`) |
| `tools/logos/out/sport-{sport}.png` | 1254 px | Lossless masters, also used for label art |
| `public/assets/drinks/{key}.webp` | 1200x1500 | Product shot, 3/4 front view, label facing camera |
| `public/assets/drinks/{key}-600.webp` | 600x750 | Same, small |
| `public/assets/sequence/golden-boot/000.webp` … `071.webp` (and `720/` at 720x900 for phones) | 1000x1250 | Golden Boot turning 360 degrees in 5-degree steps; frame 000 shows the label front, same framing every frame |
| `public/assets/lineup.webp` | 2400x1000 | All ten bottles in one row, cold brews left, Lotus right, same order as the table |
| `public/assets/lineup-1200.webp` | 1200x500 | Same, small |

## API contract

All JSON. Handlers live in `server/` as `async (request: Request, env: object) => Response`
and are wired up in `netlify/functions/*.mjs` (Netlify Functions 2.0, `export default` plus
`export const config = { path: "/api/..." }`) and in `server/dev-server.mjs`.

### GET /api/menu

```json
{
  "mode": "square",
  "currency": "USD",
  "items": [
    { "key": "stoppage-time", "name": "Stoppage Time", "variationId": "ABC123",
      "priceCents": 600, "available": 24, "soldOut": false }
  ]
}
```

- `mode` is `"square"` when `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` are set, else
  `"sample"` with the sample prices and sample stock (one drink sold out, one with 3 left).
- `key` is the item name slugified (lowercase, runs of non-alphanumerics become `-`). Square
  item names must match the drink names in the table.
- `available` is the IN_STOCK count at the location, or `null` when Square does not track
  inventory for that variation. `soldOut` is true when the count is 0 or less or the location
  override marks it sold out.

### GET /api/schedule

```json
{
  "mode": "calendar",
  "timezone": "America/New_York",
  "events": [
    { "id": "stable-id", "title": "Fall Classic Soccer Tournament",
      "venue": "Riverside Sports Complex", "address": "1200 River Rd, Springfield",
      "start": "2026-10-24T13:00:00.000Z", "end": "2026-10-24T20:00:00.000Z",
      "notes": "", "sample": false }
  ]
}
```

- `mode` is `"calendar"` when `CALENDAR_ICS_URL` is set (any iCal feed: Google Calendar secret
  address, iCloud public calendar, Outlook published calendar). Otherwise `"file"`, read from
  the site's own `/data/schedule.json`.
- Events that have not ended, starting within the next 90 days, sorted by start, at most 50.
- From iCal: SUMMARY is the title; LOCATION is split at the first comma into venue and address;
  DESCRIPTION becomes notes. Recurring events (RRULE) are expanded. If `CALENDAR_KEYWORD` is
  set, only events whose summary or description contains it are shown, with the keyword
  removed from the displayed text.
- `public/data/schedule.json` format: `{ "timezone": "...", "events": [ { "id", "title",
  "venue", "address", "start": "2026-10-24T09:00", "end": "2026-10-24T16:00", "notes",
  "sample": true } ] }` where start and end are wall-clock times in that timezone.

### POST /api/checkout

Request:

```json
{
  "eventId": "stable-id",
  "pickupTime": "asap",
  "items": [ { "variationId": "ABC123", "quantity": 2 } ],
  "customer": { "name": "Sam Lee", "email": "sam@example.com", "phone": "+15555550123" }
}
```

`pickupTime` is `"asap"` or an ISO time inside the event window. Responses:

- `200 { "checkoutUrl": "https://...", "orderId": "..." }`: send the buyer to Square's hosted
  checkout. After paying, Square returns them to `{SITE_URL}/?order=placed` (no `#` fragment:
  Square may append its own query parameters, and the page scrolls to the order section itself).
- `400 { "error": "…", "code": "INVALID", "field": "customer.email" }`
- `409 { "error": "…", "code": "OUT_OF_STOCK", "items": [ { "variationId", "available" } ] }`
- `409 { "error": "…", "code": "EVENT_CLOSED" }` when the stop has ended or is past the cutoff
- `503 { "error": "Online ordering isn't connected to Square yet.", "code": "NOT_CONNECTED" }`
  in sample mode
- `502 { "error": "…", "code": "SQUARE_ERROR" }`

Rules: 1–10 distinct lines, each quantity an integer 1–12, at most 24 bottles per order;
every variationId must exist in the live menu and not be sold out; name 1–60 characters; an
email or a phone number is required and validated; the event must exist in the schedule and
orders close `ORDER_CUTOFF_MINUTES` (default 15) before it ends. Prices always come from
Square, never from the request. The order notes the stop's title, venue, and pickup time.

### Environment

```
SQUARE_ACCESS_TOKEN=        # secret; server only
SQUARE_LOCATION_ID=
SQUARE_ENVIRONMENT=sandbox  # or production
SITE_URL=https://matchdayfuel.example   # used for the return link after payment
CALENDAR_ICS_URL=           # optional; secret iCal address of a dedicated public calendar
CALENDAR_KEYWORD=           # optional filter, e.g. [stand]
BUSINESS_TIMEZONE=America/New_York
ORDER_CUTOFF_MINUTES=15
```

## Front end (summary)

Sections, in order: navigation, hero (logo, headline, lineup render), "Every sport, its own
ball" pinned scroll scene (logo variants with each sport's two drinks), "The bottle" pinned
360-degree scrub (sequence frames on a canvas, captions per range), lineup grid (product
renders, flavor labels, caffeine, live price and stock, Add to Order), "Find us" schedule,
"Order ahead" (pickup stop and time, drinks, contact, summary, Continue to Payment), venue
booking, footer. If `/api/*` is unreachable (file preview), the page falls back to
`data/schedule.json` and then to built-in samples, and says so.
