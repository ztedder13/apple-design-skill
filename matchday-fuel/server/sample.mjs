// The ten drinks from SPEC.md, and the sample menu served until Square is connected.
// Sample prices and stock are for previews only; the page says so.

export const SAMPLE_PRICE_CENTS = Object.freeze({ "Cold brew": 600, "Lotus energy": 650 });

// Same order as the SPEC table: cold brews, then Lotus energy.
export const DRINKS = Object.freeze([
  { key: "stoppage-time", name: "Stoppage Time", line: "Cold brew" },
  { key: "power-play", name: "Power Play", line: "Cold brew" },
  { key: "seventh-inning-stretch", name: "Seventh-Inning Stretch", line: "Cold brew" },
  { key: "hail-mary", name: "Hail Mary", line: "Cold brew" },
  { key: "full-court-press", name: "Full Court Press", line: "Cold brew" },
  { key: "golden-boot", name: "Golden Boot", line: "Lotus energy" },
  { key: "grand-slam", name: "Grand Slam", line: "Lotus energy" },
  { key: "red-zone", name: "Red Zone", line: "Lotus energy" },
  { key: "buzzer-beater", name: "Buzzer Beater", line: "Lotus energy" },
  { key: "hat-trick", name: "Hat Trick", line: "Lotus energy" },
].map((drink) => Object.freeze(drink)));

// One drink sold out and one nearly gone, so the preview shows both states.
export const SAMPLE_STOCK = Object.freeze({ "hat-trick": 0, "red-zone": 3 });
const DEFAULT_SAMPLE_STOCK = 24;

/** The /api/menu body in sample mode. */
export function sampleMenu() {
  return {
    mode: "sample",
    currency: "USD",
    items: DRINKS.map(({ key, name, line }) => {
      const available = key in SAMPLE_STOCK ? SAMPLE_STOCK[key] : DEFAULT_SAMPLE_STOCK;
      return {
        key,
        name,
        variationId: `sample-${key}`,
        priceCents: SAMPLE_PRICE_CENTS[line],
        available,
        soldOut: available <= 0,
      };
    }),
  };
}
