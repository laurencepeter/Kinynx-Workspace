// Kinynx brand geometry — the single source of truth for every logo and icon.
// Edit here, then run `npm run build` in brand/ to regenerate all outputs.

export const COLORS = {
  violet: '#6D5EFC', // primary tile
  violetLight: '#A99FFF', // glyph on dark (iOS dark icon)
  mint: '#34D399', // collaborator arm
  ink: '#0E0F13',
  paper: '#F6F5FF',
  text: '#E7E9F0',
  white: '#FFFFFF',
};

// The mark lives on a 64-unit grid. Three round-capped strokes, 10u wide:
// stem, upper arm, and the collaborator (lower) arm meeting at the 32,32 joint.
export const GRID = 64;
export const TILE_RADIUS = 15;
export const STROKE = 10;
export const GLYPH = {
  stem: [[22, 20], [22, 44]],
  arm: [[32, 32], [45, 19]],
  collab: [[32, 32], [45, 45]],
};

/** SVG/VectorDrawable path data for one glyph stroke, optionally offset. */
export const lineD = ([[x1, y1], [x2, y2]], off = 0, sep = ' ') =>
  `M${x1 + off}${sep}${y1 + off}L${x2 + off}${sep}${y2 + off}`;

// "kinynx" outlined from Space Grotesk Bold (SIL Open Font License 1.1),
// tracking -45/1000 em. Font units, baseline at y=0, y grows downward.
export const WORDMARK = {
  upm: 1000,
  bounds: [70, -714, 3019, 200],
  d: 'M70 0V-700H196V-313H214L378 -496H542L313 -256L550 0H388L214 -197H196V0ZM589 0V-496H715V0ZM652 -554Q618 -554 594.5 -576Q571 -598 571 -634Q571 -670 594.5 -692Q618 -714 652 -714Q687 -714 710 -692Q733 -670 733 -634Q733 -598 710 -576Q687 -554 652 -554ZM810 0V-496H934V-431H952Q964 -457 997 -480.5Q1030 -504 1097 -504Q1155 -504 1198.5 -477.5Q1242 -451 1266 -404.5Q1290 -358 1290 -296V0H1164V-286Q1164 -342 1136.5 -370Q1109 -398 1058 -398Q1000 -398 968 -359.5Q936 -321 936 -252V0ZM1435 200V90H1705Q1733 90 1733 60V-65H1715Q1707 -48 1690 -31Q1673 -14 1644 -3Q1615 8 1570 8Q1512 8 1468.5 -18.5Q1425 -45 1401 -92Q1377 -139 1377 -200V-496H1503V-210Q1503 -154 1530.5 -126Q1558 -98 1609 -98Q1667 -98 1699 -136.5Q1731 -175 1731 -244V-496H1857V88Q1857 139 1827 169.5Q1797 200 1747 200ZM1952 0V-496H2076V-431H2094Q2106 -457 2139 -480.5Q2172 -504 2239 -504Q2297 -504 2340.5 -477.5Q2384 -451 2408 -404.5Q2432 -358 2432 -296V0H2306V-286Q2306 -342 2278.5 -370Q2251 -398 2200 -398Q2142 -398 2110 -359.5Q2078 -321 2078 -252V0ZM2479 0 2659 -250 2481 -496H2627L2740 -331H2758L2871 -496H3017L2839 -250L3019 0H2871L2758 -167H2740L2627 0Z',
};
