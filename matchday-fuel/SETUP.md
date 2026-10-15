# Setting up Matchday Fuel online

This guide takes the site from your computer to a live address with online ordering through
Square and a schedule that follows your business calendar. Do the steps in order. Each one works
on its own: until Square is connected, the site shows sample prices and says ordering opens
soon; until a calendar is connected, it shows the stops in `public/data/schedule.json`.

## 1. Run it on your computer (optional)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd matchday-fuel
npm run dev
```

Open <http://localhost:8888>. To try Square or a calendar locally, copy `.env.example` to `.env`,
fill it in, and restart. Never commit `.env`; it holds your Square access token.

`npm test` runs the server tests.

## 2. Put it online with Netlify

1. Create a free account at [netlify.com](https://www.netlify.com) and choose **Add new site >
   Import an existing project**. Pick this GitHub repository.
2. Set **Base directory** to `matchday-fuel`. Netlify reads the rest (publish folder and
   functions) from `matchday-fuel/netlify.toml`.
3. Deploy. The site works right away in sample mode.
4. In **Site configuration > Environment variables**, add the variables from the steps below.
   Give each one the **Functions** scope. Redeploy after changing them.
5. Set `SITE_URL` to the site's public address, for example `https://matchdayfuel.com`. Square
   sends customers back to this address after they pay.

## 3. Connect Square

Square supplies prices, stock, and payment. Customers pay on Square's own checkout page, so card
details never touch this site.

### Set up the menu in Square

1. In the Square Dashboard, go to **Items** and create one item for each drink. The item names
   must match the site exactly:

   Stoppage Time, Power Play, Seventh-Inning Stretch, Hail Mary, Full Court Press, Golden Boot,
   Grand Slam, Red Zone, Buzzer Beater, Hat Trick

2. Give each item one variation with a fixed price.
3. Turn on inventory tracking for each variation and enter the stock you bring to the stand.
   The site shows "Only 3 left" at five or fewer and "Sold out" at zero. You can also mark an
   item sold out by hand in Square.
4. Make sure each item is available at the location you will use for online orders.

### Get your keys (test first)

1. Sign in at [developer.squareup.com](https://developer.squareup.com) with your Square account
   and create an application.
2. Under **Credentials**, switch to **Sandbox** and copy the sandbox access token. Under
   **Locations**, copy the sandbox location ID.
3. Set these environment variables:

   ```
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox access token>
   SQUARE_LOCATION_ID=<sandbox location ID>
   ```

4. Create the same ten items in the sandbox seller dashboard (open it from the developer
   console), place a test order on the site, and pay with one of Square's sandbox test cards.
   Use a real-format phone number; Square rejects 555 numbers.
5. Check that the order appears in the sandbox **Orders** page as a pickup order, and that the
   item's stock went down after payment.

### Go live

Switch the three variables to your production access token and production location ID, and set
`SQUARE_ENVIRONMENT=production`. Redeploy.

Things to know:

- Stock is checked when a customer starts checkout, but Square only takes it off the count when
  they pay. Two people can occasionally buy the last bottle at the same moment.
- Online orders show up in Square as pickup orders with the stop, venue, and pickup time in the
  note, so the stand can see them in the Square Point of Sale order list.
- Tax is added by Square at checkout using your location's tax settings. Tipping is off; to turn
  it on, set `allow_tipping` to `true` in `server/checkout.mjs`.
- Example stops (`"sample": true` in `schedule.json`) can be ordered in sandbox for testing, but
  not once `SQUARE_ENVIRONMENT=production`.

## 4. Connect your calendar

The schedule section can follow a calendar instead of a file. Use a calendar that holds **only
public stand stops**, because everything on it appears on the website.

1. Create a calendar named something like "Matchday Fuel Stand".
2. Add each stop as an event:
   - **Title**: what customers see, for example "Fall Classic Soccer Tournament"
   - **Location**: venue name, then a comma, then the street address, for example
     "Riverside Sports Complex, 1200 River Rd, Springfield"
   - **Time**: when the stand is open. Orders close 15 minutes before the end.
   - **Notes** (optional): shown under the stop, for example "Near the north gate"
   - Repeating events work, so a weekly rec-center night needs only one event.
3. Copy the calendar's private feed address and set it as `CALENDAR_ICS_URL`:
   - **Google Calendar**: Settings > your calendar > Integrate calendar > **Secret address in
     iCal format**.
   - **Apple iCloud Calendar**: Share the calendar as a **Public Calendar** and copy the link
     (`webcal://` links work).
   - **Outlook**: Settings > Calendar > Shared calendars > **Publish a calendar**, then copy the
     ICS link.
4. Set `BUSINESS_TIMEZONE` to your time zone, for example `America/Chicago`.
5. Optional: to share one calendar between private and public events, set `CALENDAR_KEYWORD`
   (for example `[stand]`) and put it in the title or notes of every public stop. Only those
   events appear, with the keyword removed.

Changes in the calendar show on the site within about five minutes. Events marked private in
your calendar app are never shown.

### No calendar?

Edit `public/data/schedule.json` and redeploy. Each stop has a title, venue, address, start and
end (local time, `YYYY-MM-DDTHH:MM`), and optional notes. Delete the example stops and remove
`"sample": true` from your real ones.

## 5. Before launch

- Replace the caffeine amounts in `public/index.html` with lab-tested values.
- Replace the example stops, or connect the calendar.
- Connect the venue booking form: set `FORM_ENDPOINT` in `public/js/booking.js`.
- Change `og:image` in `public/index.html` to a full address such as
  `https://matchdayfuel.com/assets/logo/matchday-fuel-1200.jpg` so link previews show the logo.
- Confirm with your supplier how you may use the Lotus name.
