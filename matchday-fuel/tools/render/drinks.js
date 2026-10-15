// Drink table for the render pipeline. Mirrors the "Drinks" table in SPEC.md, which is the
// single source of truth: if a name, flavor, color or caffeine value changes there, change it
// here and run `npm run render`.
//
// Plain ES module with no imports, so both the browser page and the Node driver can load it.

export const LINES = {
  coldbrew: { label: 'COLD BREW COFFEE' },
  lotus: { label: 'LOTUS ENERGY DRINK' },
};

export const VOLUME_TEXT = '16.9 FL OZ (500 mL)';

// liquid: how the drink is shaded inside the bottle.
//   'milky'  opaque, creamy cold brew with milk
//   'black'  black coffee: transmissive with strong absorption (near black, amber at thin edges)
//   'clear'  clear, saturated, sparkling energy drink
export const DRINKS = [
  { key: 'stoppage-time', name: 'Stoppage Time', line: 'coldbrew', sport: 'soccer',
    flavor: 'Classic Black', color: '#241208', caffeine: 300, liquid: 'black' },
  { key: 'power-play', name: 'Power Play', line: 'coldbrew', sport: 'hockey',
    flavor: 'Maple Oat Milk', color: '#A97B55', caffeine: 200, liquid: 'milky' },
  { key: 'seventh-inning-stretch', name: 'Seventh-Inning Stretch', line: 'coldbrew', sport: 'baseball',
    flavor: 'Vanilla Sweet Cream', color: '#C29A72', caffeine: 180, liquid: 'milky' },
  { key: 'hail-mary', name: 'Hail Mary', line: 'coldbrew', sport: 'football',
    flavor: 'Salted Caramel', color: '#9B6438', caffeine: 190, liquid: 'milky' },
  { key: 'full-court-press', name: 'Full Court Press', line: 'coldbrew', sport: 'basketball',
    flavor: 'Sea Salt Mocha', color: '#5A3220', caffeine: 200, liquid: 'milky' },
  { key: 'golden-boot', name: 'Golden Boot', line: 'lotus', sport: 'soccer',
    flavor: 'Mango Passionfruit', color: '#F2A81D', caffeine: 160, liquid: 'clear' },
  { key: 'grand-slam', name: 'Grand Slam', line: 'lotus', sport: 'baseball',
    flavor: 'Blue Raspberry Lemonade', color: '#2F74D0', caffeine: 160, liquid: 'clear' },
  { key: 'red-zone', name: 'Red Zone', line: 'lotus', sport: 'football',
    flavor: 'Strawberry Watermelon', color: '#E0384B', caffeine: 160, liquid: 'clear' },
  { key: 'buzzer-beater', name: 'Buzzer Beater', line: 'lotus', sport: 'basketball',
    flavor: 'Peach Orange', color: '#F27A2E', caffeine: 120, liquid: 'clear' },
  { key: 'hat-trick', name: 'Hat Trick', line: 'lotus', sport: 'hockey',
    flavor: 'Triple Berry', color: '#7B3FA6', caffeine: 160, liquid: 'clear' },
];

export function drinkByKey(key) {
  const drink = DRINKS.find((d) => d.key === key);
  if (!drink) throw new Error(`Unknown drink key "${key}". Known: ${DRINKS.map((d) => d.key).join(', ')}`);
  return drink;
}

// Output contract (SPEC.md "Asset contract"). Sizes are final pixel sizes; the page renders at
// SUPERSAMPLE times this and encode.py downsamples.
export const OUTPUTS = {
  still: { width: 1200, height: 1500, small: { width: 600, height: 750 } },
  lineup: { width: 2400, height: 1000, small: { width: 1200, height: 500 } },
  sequence: { key: 'golden-boot', width: 1000, height: 1250, stepDegrees: 5 },
};
