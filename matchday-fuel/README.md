# Matchday Fuel website

A one-page site for Matchday Fuel: cold brew coffee and Lotus energy drinks named for moments in
soccer, baseball, football, basketball, and hockey, sold at sports venues in clear 16.9 fl oz
bottles with can-style tops. It was designed with the Apple Design Skill in this repository
(`SKILL.md` and `references/hig/`).

## Preview

Open `index.html` in a browser, or serve the folder:

```bash
npx serve matchday-fuel
```

It is plain HTML, CSS, and JavaScript with no build step, so any static host works (GitHub Pages,
Netlify, Cloudflare Pages).

## Files

| Path | Role |
| --- | --- |
| `index.html` | Page content, including the ten drinks and the shared bottle and sport-icon drawings |
| `styles.css` | Color and type tokens at the top, then layout by section |
| `main.js` | Booking form validation and sending |
| `assets/` | The logo at web sizes, a social preview image, the favicon, and the home-screen icon |

## Before launch

- **Caffeine amounts are placeholders.** Each drink's caffeine figure in `index.html` is a
  recipe target. Replace them with lab-tested values.
- **Connect the booking form.** Set `FORM_ENDPOINT` in `main.js` to a form service URL. Until
  then, the form validates and then tells people their request wasn't sent.
- **Check the Lotus name.** Lotus is another company's trademark. Confirm with your supplier how
  you may name the "Lotus energy" line, and keep the footer notice.
- **Social preview.** `og:image` needs a full URL (`https://your-domain/assets/logo-1200.jpg`)
  once the site has a domain.

To add a drink, copy one `<li class="drink">` block, then change `--liquid` (the drink color),
`--liquid-alpha` (lower for translucent drinks), the sport icon, and the text. Energy drinks also
get `<use href="#bubbles"/>` inside the bottle drawing. The shelf holds five per row on wide
screens.

## Design decisions

How the skill's guidance shaped the page, with the guideline each choice follows:

- **One accent, used only for actions.** Brew brown marks links and primary buttons and nothing
  else. `branding.md › Best practices`: "use it intentionally for primary actions or status
  indicators." `color.md › Best practices`: "Avoid using the same color to mean different things."
- **Light and dark from the system setting, with no switch on the page.** `dark-mode.md › Best
  practices`: "Avoid offering an app-specific appearance setting." In dark mode the logo sits on
  a cream disc and is dimmed slightly, per `dark-mode.md › Dark Mode colors`: "Soften the color of
  white backgrounds."
- **Contrast measured, not estimated.** Every text pairing clears 4.5:1 and most clear 7:1 in both
  appearances; the values are commented in `styles.css`. `accessibility.md › Vision` sets the
  4.5:1 floor, and `dark-mode.md › Dark Mode colors` says "strive for a contrast ratio of 7:1,
  especially in small text."
- **Custom display face, system body face.** Archivo, stretched wide, echoes the logo's FUEL
  lettering in headlines and drink names; body copy and controls use the system font at 17 px.
  `branding.md › Best practices`: "use a custom font for headlines and subheadings while using
  system fonts for body copy and captions."
- **Glass only on the floating navigation bar,** with an opaque fallback for Reduce Transparency
  and Increase Contrast. `liquid-glass.md › Where the material belongs`.
- **The logo appears once.** The navigation and footer use a small text wordmark. `branding.md ›
  Best practices`: "Resist the temptation to display your logo throughout your app or game."
- **Familiar controls.** The drink filter is a segmented control built from a native radio group,
  so it works with the keyboard, screen readers, and no script. Every target is at least 44 by
  44 px (`accessibility.md › Mobility`), and buttons have a press state (`buttons.md › Best
  practices`).
- **Labels say what happens.** "See the Lineup", "Book Us", "Send Request", in title case for
  buttons and sentence case for headings. Form errors sit next to the field and say how to fix
  it. `writing.md › Best practices`.
- **Layout follows available width.** Drinks show as a menu-board list on phones and a five-wide
  cooler shelf on wide screens, with the same content at every size. `layout.md › Size classes`.
- **Motion is minimal.** Only the segmented control's thumb slides, and Reduce Motion turns it off.
  `motion.md › Best practices`: "Add motion purposefully."
