# IBM Plex Sans

`IBMPlexSans-Variable.ttf` is the normal variable font from Google Fonts:
https://github.com/google/fonts/tree/main/ofl/ibmplexsans

It covers weights 100–700, including the UI's 650 weight. Its width axis stays
at the normal default. The SIL Open Font License and copyright notices are in
`public/licenses/IBMPlexSans-OFL.txt`, which Vite copies into production builds.

Vite bundles the font through its relative URL in `src/App.css`. The face
uses no `local()` source, so it does not depend on a system font installation
or a CDN. The root family is inherited by the app's text and form controls.

To replace the UI font, update the bundled file, `@font-face` declaration,
root `font-family`, license, and rendering checks in `e2e/fonts.spec.ts`.
