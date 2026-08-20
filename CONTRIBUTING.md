# Contributing

Thanks for helping improve Scroll Video Scrubber. The project is intentionally small and framework-agnostic; changes should preserve that portability and keep the browser API straightforward.

## Local setup

You need Node.js 20 or newer and npm.

```sh
git clone https://github.com/arvindang/scroll-video-scrubber.git
cd scroll-video-scrubber
npm install
```

Start the documentation demo with:

```sh
npm run dev
```

Vite will print the local URL. The demo source lives in `docs/` and imports the library directly from `src/`.

## Making a change

- Keep the core library free of framework dependencies.
- Treat exports from `src/index.ts` as the public API and document user-visible changes.
- Add or update a focused test in `tests/` for behavior changes.
- Update the demo when a feature is best explained interactively.
- Avoid committing generated `dist/` or `site-dist/` output.

Run the full validation suite before opening a pull request:

```sh
npm run check
npm run build
```

The individual commands are also available:

```sh
npm run lint
npm run typecheck
npm test
npm run build:lib
npm run build:site
```

## Pull requests

Keep pull requests focused and explain the user-facing motivation, the implementation choice, and how you verified it. Include a short screen recording or screenshots when changing the scroll behavior or documentation demo.

CI runs linting, type checks, tests, and both production builds. Merges to `main` also deploy the demo to GitHub Pages.
