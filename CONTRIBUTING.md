# Contributing to Sentinel Override (Firefox)

## Development

```bash
npm install
npm test        # node:test — manifest/file references, syntax, pure helpers
npm run lint    # web-ext lint
npm start       # web-ext run --source-dir .
```

## Tests

- Run the full suite with `npm test`.
- Lint with `npm run lint` (0 errors expected; warnings are reported, not fatal).
- CI runs the same two commands on Ubuntu 24.04 with Node 22.

## Pull requests

- Keep changes small and focused.
- Update the README and CHANGELOG where behaviour changes.
- Do not include secrets or real credentials in tests or examples.
- Run `npm test` and `npm run lint` before opening a PR.
