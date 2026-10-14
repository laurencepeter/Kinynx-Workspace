# Kinynx brand

Logo, app icons (iOS, Android, web) and motion tokens. Every asset is generated
from [`src/geometry.mjs`](src/geometry.mjs). Don't hand-edit the outputs.

Design canvas (spec, motion and navigation prototype):
https://claude.ai/artifact/PP8NfqHTV7erXLG1DCkuyE

## Regenerate

```bash
cd brand
npm install                      # Playwright (dev-only)
npx playwright install chromium  # first run only, if no Chromium is installed
npm run build
```

`brand/` is deliberately outside the pnpm workspace, so core installs and CI
never pull in a browser.

## The mark

A geometric K on a 64-unit grid: three 10u round-capped strokes (stem, arm,
collaborator arm) meeting at the 32,32 joint. The mint arm is the second
collaborator. The glyph stays inside a 44u safe circle, so it survives every
platform mask.

| Token  | Hex       | Use                          |
|--------|-----------|------------------------------|
| Violet | `#6D5EFC` | Tile, primary accent         |
| Mint   | `#34D399` | Collaborator arm             |
| Ink    | `#0E0F13` | Dark ground, text on light   |
| Paper  | `#F6F5FF` | Light ground                 |

Wordmark: "kinynx", Space Grotesk Bold (SIL OFL 1.1), tracking −45, outlined
to paths so it renders without the font. Minimum sizes: mark 16 px, lockup
80 px wide. Clear space: ½ mark height on all sides.

## Outputs

| Path | What |
|------|------|
| `logo/kinynx-mark.svg` | Mark on violet tile |
| `logo/kinynx-glyph.svg`, `kinynx-glyph-mono.svg` | Glyph only (colour / `currentColor`) |
| `logo/kinynx-wordmark.svg` | Wordmark (`currentColor`) |
| `logo/kinynx-lockup-on-{dark,light}.svg`, `kinynx-lockup-mono-{black,white}.svg` | Horizontal lockups |
| `ios/AppIcon.appiconset/` | 1024 default (opaque RGB), dark and tinted variants for iOS 18+ |
| `android/res/` | Adaptive icon (foreground, background, monochrome), legacy mipmaps mdpi to xxxhdpi |
| `android/play-store-512.png` | Google Play listing icon |
| `../apps/web/` | `icon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png` (180, opaque), `icon-192/512.png`, `icon-maskable-512.png`, `manifest.webmanifest` |
| `tokens/motion.{css,json}` | Durations, easings, splash timeline |

## Platform integration

**iOS.** Replace `Assets.xcassets/AppIcon.appiconset` in the Xcode project with
`ios/AppIcon.appiconset`. Xcode 14+ derives every device size from the
single 1024 image. The dark and tinted appearances need Xcode 16+.

**Android.** Copy `android/res/*` into `app/src/main/res/` and set
`android:icon="@mipmap/ic_launcher"` and
`android:roundIcon="@mipmap/ic_launcher_round"` in the manifest. The adaptive
icon is used on API 26+. The monochrome layer drives themed icons on
Android 13+. The PNG mipmaps cover older launchers.

**Web.** Already wired into `apps/web/*.html`. The icons are same-origin static
files, so they work under a strict CSP (`img-src 'self'`) with no data: URIs or
third-party CDNs.

## Motion

| Token | ms | Easing | Use |
|-------|----|--------|-----|
| fast | 120 | standard `(0.2, 0, 0, 1)` | press, hover |
| base | 240 | standard | tabs, toggles (fade-through) |
| enter | 300 | decelerate `(0.05, 0.7, 0.1, 1)` | push, sheet in |
| exit | 200 | accelerate `(0.3, 0, 0.8, 0.15)` | dismiss, back |
| spring | 420 | `(0.34, 1.56, 0.64, 1)` | logo, FAB |

- **Navigation.** Tab switches fade through (240 ms). Pushed screens slide in
  from the trailing edge (300 ms, decelerate) and pop back with a 30% parallax.
  On iOS, use the system navigation stack with
  `.spring(response: 0.35, dampingFraction: 0.85)`. On Android, support
  predictive back (14+).
- **Splash.** A 900 ms logo reveal (timeline in `tokens/motion.json`). Show it
  only on cold start and never gate it on the network. On Android, use the
  SplashScreen API.
- **Performance.** Animate transform and opacity only, so animations stay on the
  compositor at 60/120 Hz.
- **Reduced motion.** Always honour the OS setting: slides become 150 ms fades.
