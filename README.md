# LadybugDB WASM Shell

A browser/WebAssembly-based shell for [LadybugDB](https://github.com/ladybugdb/ladybugdb), an embedded graph database that runs entirely in the browser.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000/ in your browser.

## Development

The `dev` command automatically copies the multithreaded WASM modules from `@ladybugdb/wasm-core` before starting the Vite dev server. The shell mounts OPFS via WasmFS and stores the database at `/opfs/ladybug-shell`.

## Building

```bash
pnpm build
```

This builds both the WASM modules and the production bundle, then writes
precompressed `.gz` and `.br` versions of text/WASM assets in `dist/`.

The web server or CDN must serve those files with `Content-Encoding: gzip` or
`Content-Encoding: br` for browsers to use them. GitHub Pages does not expose
custom response-header configuration from this repository; use a CDN or static
host that supports precompressed assets if you need to control compression
explicitly.
