<p align="center">
  <img src="./public/icon.svg" width="180" alt="Loom logo">
</p>

<h1 align="center">Loom</h1>

<p align="center">
  A browser-based WebGPU node compositor.<br>
  <a href="https://laubsauger.github.io/loom/">Open Loom</a>
</p>

<a href="./docs/loom-editor.png">
  <img src="./docs/loom-editor.png" alt="The Loom editor showing a node graph, WGSL shader, inspector, and live output">
</a>

<sub>Click the screenshot for the full-size view.</sub>

## Run

Requires Node.js 22+, pnpm 9.15.4, and a WebGPU browser.

```bash
pnpm install
pnpm dev
```

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Deploy

Deployment is manual. Once the changes are on `main`:

```bash
pnpm deploy
```

[Spec](./SPEC.md) · [Examples](./examples/README.md)
