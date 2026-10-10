---
name: wasm
description: "WebAssembly across browsers, Rust (wasm-bindgen), C/C++ (Emscripten), Python (Pyodide), runtime ABIs and animation pipelines: feature floors, COOP/COEP threads, builds, interop, failures."
---

# WebAssembly

Verify versions on caniuse.com/wasm and the pinned SDK before choosing a floor.

## Browser support and dispatch
- Baseline Wasm works on all evergreen browsers. SIMD, threads, EH, GC, memory64 and tail calls are tiered: detect each with `WebAssembly.validate` on a tiny probe module, never UA sniffing.
- Ship tiers: pure-JS reference (also the legacy fallback; IE and legacy Edge lack Wasm), wasm baseline, wasm+SIMD, optional threads.
- Threads (Firefox 111+, Safari 15.4+) need `crossOriginIsolated === true`: COOP `same-origin` and COEP `require-corp` (or `credentialless`) on every response. One non-CORP CDN asset silently disables threads. Test with headers on; dev servers omit them.
- Serve `.wasm` as `application/wasm`; version JS glue and wasm together (mismatch = `Linking failed`).
- Safari historically compiles after full download; iOS kills backgrounded tabs above ~1 GB of wasm+heap. Release-gate on real Safari, not WebKit headless.

## Rust
- Browser target `wasm32-unknown-unknown` with wasm-bindgen; `wasm32-wasi` is for standalone hosts.
- A panic aborts the module: return `Result<T, JsError>` for expected failures, never `unwrap()` in browser code.
- `Vec<u8>` returns copy; hot paths pass typed-array views; owned buffers need one freeing side.
- Release: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `opt-level = "s"` or `"z"`, `strip = true`. Avoid serde-json and regex stacks in browser builds.
- Test in browsers: `wasm-pack test --headless --chrome`; node misses DOM glue.

## C and C++ (Emscripten)
- Build with `em++`, record `emcc --version`, export only what the JS wrapper calls (`--no-entry` for libraries).
- A pointer is a heap byte offset. Reacquire `HEAP*` views after any call that may allocate or grow; views die on growth, free or vector reallocation.
- One owner and one matching free per allocation; `_malloc` can return 0. Check `count <= capacity`, multiplication overflow and `bytes <= heapBytes - ptr`.
- C++ exceptions: `-fexceptions` (JS) or `-fwasm-exceptions`, at compile and link. Longjmp is not the exception mechanism.
- `-msimd128` for SIMD; no blind `-mavx2`/`-march=native`. Pthreads need `-pthread` at compile and link.

## Python (Pyodide)
- Pure Python runs ~3-10x slower than native CPython; NumPy's C code is near native. No threads: parallelism means one interpreter per worker.
- `indexURL` must be absolute and version-pinned (relative breaks off the site root, the most common bug). Pin micropip packages; lazy-load heavy ones.
- `destroy()` every PyProxy and `.toJs()` result in `finally`; leaked proxies are the top memory bug.
- Move bulk data via the virtual FS (`writeFile`/`readFile`), not `toJs()`; the FS is in-memory and resets each load.
- Run long code in a worker with a cancel path (`setInterrupt` cannot stop C code). User code gets a typed facade, never `js`, `fetch` or `eval`.

## Runtime and ABI
- Record host version, features, imports and security boundary first. Imports grant abilities: restrict FS and network; bound memory and execution (fuel, epoch, wall time).
- Check `ptr <= size` and `len <= size - ptr` without overflow. JS strings are not UTF-8 bytes; test malformed UTF-8, empty buffers, oversized lengths.
- Batch host calls; zero-copy can retain allocations or race, so measure a small copy too.
- Atomics sync memory, not host objects; a core module is not a component.

## Animation and simulation pipelines
- Use Wasm for measured compute or reused native code, not scene animation alone; keep the scalar reference.
- Small versioned C ABI (create, destroy, commands, fixed-step advance, snapshot); document units and handedness; no C++ objects or exceptions cross it.
- Entity IDs are slot plus generation so stale handles fail; reject non-integer IDs before truncating.
- Fixed step `h`; accumulate frame time; interpolate with `alpha = accumulator/h`; cap steps and state whether backlog is dropped.
- Snapshot handoff: producer claims FREE, writes, publishes READY; consumer claims READY, reads, releases FREE. A two-slot swap without acks lets the producer lap a consumer.
- Verify scalar vs Wasm on identical command sequences within a stated tolerance (stale handles, zero entities, heap growth); NaN is failure, not a clamp.
