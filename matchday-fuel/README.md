# Matchday Fuel website

The website for Matchday Fuel: cold brew coffee and Lotus energy drinks named for moments in
soccer, baseball, football, basketball, and hockey, sold at sports venues in clear 16.9 fl oz
bottles with can-style tops. Customers can see the lineup, find where the stand will be, and
order ahead for pickup, with prices, stock, and payment handled by Square. It was designed with
the Apple Design Skill in this repository (`SKILL.md` and `references/hig/`).

To put it online and connect Square and your calendar, follow [SETUP.md](SETUP.md).

## Preview

```bash
cd matchday-fuel
npm run dev        # http://localhost:8888
```

Without Square keys the site runs in sample mode: sample prices and stock, a note saying online
ordering opens soon, and a checkout button that explains nothing was charged. Opening
`public/index.html` straight from disk also works, with the same samples.

## What's where

| Path | Role |
| --- | --- |
| `public/index.html` | The page, including the ten drinks (names, flavors, caffeine) |
| `public/styles.css` | Color and type tokens at the top, then each section |
| `public/js/` | Page behavior: `app.js` starts everything; `scenes.js` runs the scroll scenes; `lineup.js`, `schedule.js`, and `order.js` handle the menu, stops, and ordering |
| `public/data/schedule.json` | Stops shown when no calendar is connected |
| `public/assets/` | Logo and sport variants, product renders, the 360-degree frames |
| `server/` | Menu, schedule, and checkout handlers, plus a local dev server and tests |
| `netlify/functions/` | Wrappers that run the handlers on Netlify |
| `tools/render/` | Regenerates the product renders (`npm install`, then `npm run render`) |
| `tools/logos/` | Regenerates the sport logo variants (`npm run logos`, needs Python and Pillow) |
| `SPEC.md` | The build contract: drink data, file names, and API shapes |

## Changing drinks

A drink's name, flavor, sport, and color appear in four places, so change them together:

1. Its card in the lineup in `public/index.html` (and its pair in the sport scene).
2. The drink list in `tools/render/drinks.js` (and the table in `SPEC.md`).
3. Re-render the images: `npm install`, then `npm run logos` and `npm run render`. Rendering
   uses Playwright's Chromium (`npx playwright install chromium` once) and takes several minutes.
4. The item name in Square, which must match the name on the site.

## Design decisions

How the skill's guidance shaped the page, with the guideline each choice follows:

- **White page, light appearance only.** The owner asked for a white background to match the
  logo, so the page commits to one appearance. The logo's paper is color-corrected to pure white
  so it sits on the page with no visible edge. This departs from `dark-mode.md › Best practices`
  ("Ensure that your app looks good in both appearance modes") at the owner's request; a dark
  appearance can be added later by redefining the color tokens.
- **One accent, used only for actions.** Brew brown marks links and primary buttons and nothing
  else. `branding.md › Best practices`: "use it intentionally for primary actions or status
  indicators." `color.md › Best practices`: "Avoid using the same color to mean different things."
- **Contrast measured, not estimated.** Body text is 18.3:1 and secondary text 8.3:1 on white,
  with values commented in `styles.css`. `accessibility.md › Vision` sets the 4.5:1 floor.
- **Custom display face, system body face.** Archivo, stretched wide, echoes the logo's FUEL
  lettering in headlines and drink names; body copy and controls use the system font at 17 px.
  `branding.md › Best practices`: "use a custom font for headlines and subheadings while using
  system fonts for body copy and captions."
- **Scroll scenes that respect Reduce Motion.** The sport scene and the 360-degree bottle pin
  while you scroll, the way Apple's product pages do. With Reduce Motion on, or without script,
  the same content appears as ordinary sections. `motion.md › Best practices`: "Make motion
  optional." `accessibility.md › Cognitive` asks apps to reduce "automatic and repetitive
  animations, including zooming, scaling, and peripheral motion."
- **Glass only on the floating navigation bar and its menu,** with an opaque fallback for Reduce
  Transparency and Increase Contrast. `liquid-glass.md › Where the material belongs`.
- **The logo appears once at full size.** The navigation and footer use a small text wordmark,
  and the sport variants live on the labels and in the sport scene. `branding.md › Best
  practices`: "Resist the temptation to display your logo throughout your app or game."
- **Familiar controls.** The drink filter is a segmented control built from a native radio
  group; quantities use steppers whose buttons name the drink for screen readers; the pickup stop
  is a radio list. Every target is at least 44 by 44 px (`accessibility.md › Mobility`), and
  buttons have a press state (`buttons.md › Best practices`).
- **Labels say what happens.** "Order Ahead", "Add to Order", "Continue to Payment", in title
  case for buttons and sentence case for headings. Errors sit next to the field and say how to
  fix it. `writing.md › Best practices`.
- **Honest states.** Sample prices, example stops, and an unconnected checkout each say so in
  plain words instead of pretending to work. `design-principles.md › Responsibility`: "Be fully
  transparent about what your product does and why."
- **Layout follows available width.** The lineup scrolls sideways as a shelf on phones and
  becomes five columns on wide screens, with the same content and actions at every size.
  `layout.md › Size classes`.
