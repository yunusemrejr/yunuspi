> YunusPi-maintained API reference, derived from Pi 0.85.1 (MIT). Historical source and example links are pinned references, not release or installation authority. Install and update only through the [YunusPi source workflow](../../../docs/INSTALL.md).

# Develop YunusPi Core

Work in the YunusPi repository. Core implementation lives in `core/*/src`; edit these maintained files directly.

```sh
npm ci --ignore-scripts
npm run build:core
npm test
```

The source build validates JavaScript and JSON, produces package `dist` trees, and records the source digest. Follow [AGENTS.md](../../../AGENTS.md), [core ownership](../../../docs/CORE-OWNERSHIP.md), and the [manual porting process](../../../UPSTREAM-PORTING.md). No upstream package installation or patch-after-install step is part of the build.
