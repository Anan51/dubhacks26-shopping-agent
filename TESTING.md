# Testing

`npm test` runs the unit and HTTP tests. It does not need Playwright's Chromium, and it does not write outside the repo.

`npm run test:zoom` installs Chromium (`playwright install chromium`) and checks that the card stays inside the viewport at browser zoom 67%, 80%, 100%, 125%, and 150% for widths 1280 and 800. Screenshots are written to `test-artifacts/zoom/`, which is gitignored.

Set `SIMMER_ZOOM_DIR` to choose another directory. For example:

```bash
SIMMER_ZOOM_DIR=/opt/cursor/artifacts/zoom npm run test:zoom
```
