// The game's colour vocabulary. Every colour the player sees is named here, so
// retheming is a single-file edit and related elements stay in step.
//
// Names describe what the colour is for, not what it looks like: change
// PALETTE.rival.hull and every rival ship, its debris and its radar marker
// follow. Values are plain CSS colour strings, which both renderer backends
// accept.
//
// The renderers keep their own neutral defaults for the planet primitive, and
// backdrop hues are generated per sector in background.js; neither is part of
// this vocabulary.

// Blend two "#rrggbb" colours, `t` running 0 at `from` to 1 at `to`. For an
// element that crosses between two named colours rather than holding either.
export function mixColour(from, to, t) {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16)
  const blend = (at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t)
  return `rgb(${blend(1)},${blend(3)},${blend(5)})`
}

export const PALETTE = {
  // deep space, behind everything
  space: "#02040a",
  white: "#ffffff",

  // HUD and menu text, brightest to faintest
  text: {
    bright: "#eaf4ff",
    normal: "#bcd0ee",
    dim: "#9fc0ff",
    soft: "#8fb2dd",
    faint: "#7fa0c8",
    muted: "#5f79a6",
    disabled: "#5a6f92",
  },

  // panels, frames and empty slots
  ui: {
    edge: "#1c3050",
    slotEmpty: "#26436b",
    good: "#57e39a",
    goodBright: "#7ff0b8",
    warn: "#ff5b5b",
    accent: "#7fe0ff",
    accentAlt: "#ff7fdc",
    lost: "#ff8080",
  },

  // the player ship and its systems
  player: {
    hull: "#5fd7ff",
    lowEnergy: "#ff6b6b",
    exhaust: "#7fd8ff",
    exhaustFlame: "#aee6ff",
    beam: "#eaf4ff",
    charge: "#57e39a",
    overdrive: "#ff3b52", // beam and charge glow once the shot is guaranteed
    turret: "#9ff5c8",
  },

  // shields, shared by every host
  shield: {
    spark: "#9fe8ff",
    standard: "#9fe8ff",
    deflector: "#b8f0ff",
    bulwark: "#7fb4ff", // heavier and bluer, for the bubble that shrugs off shot
    flash: "#ffffff",
  },

  // rival ships
  rival: {
    hull: "#ff9a3c",
    frigateHull: "#ff8a3c",
    core: "#ffcf5c",
    hullSpark: "#ffcaa0",
    minerBeam: "#ffb060",
    cannonBeam: "#ff4d6d",
    seekerBeam: "#ff6ad5",
  },

  // asteroids. Plain rock is a size ramp between `sizeCool` and `sizeWarm`;
  // the others mark what a rock is carrying.
  rock: {
    gun: "#9fd8ff",
    shielded: "#ffd36a",
    gunShielded: "#c9a0ff",
    explosive: "#ff6b52",
    explosiveCore: "#ff5b3b",
    cut: "#dbeeff",
    impact: "#9fc0ff",
    sizeWarm: 40, // hue for the smallest rock
    sizeCool: 196, // hue for the largest
  },

  // ore chunks and the mining effects that make them
  ore: {
    body: "#ff8ae6",
    spark: "#ffbdee",
    shatterBeam: "#ff8af0",
    flash: "#ffffff",
  },

  // guns, projectiles and explosions
  weapon: {
    gun: "#ffb14b",
    bulletImpact: "#ff8a5a",
  },
  fx: {
    fire: "#ff7a4a",
    ember: "#ffd36a",
    flash: "#ffcf5c",
    dust: "#cfe0ff",
  },

  // specials, one per SPECIAL_TYPES entry
  special: {
    repel: "#ff6bd0",
    refuel: "#57e39a",
    booster: "#ffcf5c",
    multi: "#5fd7ff",
    magnet: "#b38bff",
    stealth: "#dfe9f5",
  },

  // the arena boundary and its out-of-bounds hatching
  arena: { boundary: "#ff3b52" },
}
