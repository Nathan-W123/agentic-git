/**
 * Colour arithmetic for the accent a workspace picks.
 *
 * Anybody can choose any accent, including one that leaves white text
 * unreadable on it, so ink is computed against the ground rather than
 * configured beside it: `readableOn` is what stops a pale accent shipping
 * white-on-white to whoever chose it.
 */

export function channels(hex) {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

export function mix(hex, towards, amount) {
  const from = channels(hex);
  const to = channels(towards);
  const parts = from.map((value, index) =>
    Math.round(value + (to[index] - value) * amount),
  );
  return `#${parts.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function withAlpha(hex, alpha) {
  const [red, green, blue] = channels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** WCAG relative luminance, which is what a contrast ratio is built from. */
export function luminance(hex) {
  const [red, green, blue] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(hex, against) {
  const [lighter, darker] = [luminance(hex), luminance(against)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The accent, darkened only as far as it has to be to be read on `ground`.
 *
 * Stepped rather than solved for: the relationship between a mix amount and
 * the resulting ratio is not one anybody should be inverting in a theme
 * function, and fifty steps of 2% is both exact enough and over in a fraction
 * of a millisecond. Stopping at the first step that clears the target is what
 * keeps the hue: darkening further buys contrast nobody needed and spends the
 * colour somebody chose to get it.
 *
 * An accent already dark enough comes back untouched, which is the common case
 * for anybody who picked a deep colour.
 */
export function readableOn(accent, ground, target) {
  for (let step = 0; step <= 40; step += 1) {
    const candidate = mix(accent, "#000000", step / 50);
    if (contrastRatio(candidate, ground) >= target) {
      return candidate;
    }
  }
  return mix(accent, "#000000", 0.8);
}

/**
 * The readable ink for text sitting on a filled accent.
 *
 * Not a search, because there are only two answers worth having: near-white
 * and near-black are the two colours a filled bubble can carry without
 * inventing a third tone the palette does not have. Whichever stands further
 * off the accent wins, which lands white on a deep blue and black on the
 * yellows and limes the wheel also allows — the case a hardcoded `#fff` got
 * wrong every time.
 */
export function accentInk(accent) {
  return contrastRatio("#ffffff", accent) >= contrastRatio("#141312", accent)
    ? "#ffffff"
    : "#141312";
}

/* ------------------------------------------------------------- router ---- */
