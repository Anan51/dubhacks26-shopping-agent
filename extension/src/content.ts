import css from "./overlay.css?inline";

import { boot } from "./content-boot.js";

boot({
  document,
  location,
  view: window,
  runtime: () => chrome.runtime,
  css,
});
