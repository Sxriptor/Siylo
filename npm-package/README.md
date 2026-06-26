# Siylo NPM Package

This folder is the dedicated boundary for the publishable `siylo` npm package.

Target flow:

```bash
npm install -g siylo
siylo
```

From the package itself during development:

```bash
npm install
npm start
```

Intended contents:

- package-specific `package.json`
- CLI bootstrap files
- bundled radio web build output
- npm publish and packaging scripts
- release-only assets that should not live in the main app root

Current status:

- the package manifest lives in `package.json`
- the package bin entrypoint lives in `bin/siylo.js`
- the local runtime lives in `src/cli` and `src/main`
- the bundled radio assets live in `out` and `public`
- `node bin/siylo.js start` boots from inside this folder without reaching back into the repo root
