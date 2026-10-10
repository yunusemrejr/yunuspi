---
name: wasm
description: "WebAssembly across browsers, Rust (wasm-bindgen), C/C++ (Emscripten), Python (Pyodide), runtime ABIs and animation pipelines: feature floors, COOP/COEP threads, builds, interop, failures."
---

# WebAssembly

Pick the toolchain and feature floor first. Verify versions on caniuse.com/wasm and the pinned SDK.

## Browser support and dispatch
- Baseline Wasm works on all evergreen browsers. SIMD, threads, EH, GC, memory64 and tail calls are tiered: detect each with `WebAssembly.validate` on a tiny probe module, never UA sniffing.
- Ship tiers: pure-JS reference (also the legacy fallback; IE and legacy Edge have no Wasm), wasm baseline, wasm+SIMD, optional threads.
- Threads need `crossOriginIsolated === true`: COOP `same-origin` and COEP `require-corp` (or `credentialless`) on every response. One non-CORP CDN asset silently disables threads. Test with headers on; dev servers often omit them.
- Serve `.wasm` as `application/wasm`; version JS glue and wasm together (mismatch = `Linking failed`).
- Safari compiles after full download and kills background tabs above about 1 GB. Release-gate on real Safari; WebKit headless is not Safari.

## Rust
- Browser target `wasm32-unknown-unknown` with wasm-bindgen; `wasm32-wasi` is for standalone hosts.
- A panic aborts the module: return `Result<T, JsError>` for expected failures, never `unwrap()` in browser code.
- `Vec<u8>` returns copy. Hot paths pass typed-array views; owned buffers get one freeing side and an explicit free function.
- Release: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `opt-level = "s"` or `"z"`, `strip = true`. Audit with `wasm-objdump`; avoid serde-json and regex stacks in browser builds.
- Test in browsers: `wasm-pack test --headless --chrome`; node misses DOM glue.

## C and C++ (Emscripten)
- Build with `em++`, record `emcc --version`, export only what the JS wrapper calls (`--no-entry` for libraries).
- A pointer is a heap byte offset. Reacquire `HEAP*` views after any call that may allocate or grow; views die on growth, free or vector reallocation.
- One owner and one matching free per allocation; `_malloc` can return 0. Check `count <= capacity`, multiplication overflow and `bytes <= heapBytes - ptr`.
- C++ exceptions: `-fexceptions` (JS) or `-fwasm-exceptions`, at compile and link. Longjmp is not the exception mechanism.
- `-msimd128` for SIMD; no blind `-mavx2`/`-march=native`. Pthreads need `-pthread` at compile and link.

## Python (Pyodide)
- CPython on wasm: pure Python runs about 3-10x slower than native; NumPy's C code runs near native. No threads; parallelism means one interpreter per worker.
- `indexURL` must be absolute and version-pinned (relative breaks off the site root, the most common bug). Pin micropip packages; lazy-load heavy ones (scikit-learn is 100+ MB).
- `destroy()` every PyProxy and `.toJs()` result in `finally`; leaked proxies are the top memory bug.
- Move bulk data via the virtual FS (`writeFile`/`readFile`), not `toJs()`.
- Long code runs in a worker with a cancel path (`setInterrupt` cannot stop C code). User code gets a typed facade, never `js`, `fetch` or `eval`.

## Runtime and ABI
- Record host version, features, imports and security boundary first. Imports grant abilities: restrict FS and network; bound memory and execution (fuel, epoch, wall time) as the runtime supports.
- Check `ptr <= size` and `len <= size - ptr` without overflow. JS strings are not UTF-8 bytes; test malformed UTF-8, empty buffers, oversized lengths.
- Batch host calls. Zero-copy can retain allocations or race; a small copy can win end to end.
- Atomics synchronize memory, not host objects. A core module is not a component.

## Animation and simulation pipelines
- Use Wasm for measured compute or reused native code, not for scene animation alone; keep the scalar result as reference.
- Small versioned C ABI: create, destroy, submit commands, fixed-step advance, snapshot. Document units and handedness; no C++ objects or exceptions cross it.
- Entity IDs are slot plus generation so stale handles fail; reject non-integer IDs before truncating.
- Fixed step `h`; accumulate frame time; interpolate with `alpha = accumulator/h`; cap steps and state whether backlog is dropped.
- Snapshot handoff: producer claims FREE, writes, publishes READY; consumer claims READY, reads, releases FREE. A two-slot swap without acknowledgement lets the producer lap a consumer.
- Transfer an `OffscreenCanvas` once, before any context is taken; decide the fallback first.
- Verify scalar vs Wasm on identical command sequences within a stated tolerance; include stale handles, zero entities, heap growth. NaN is failure, not a clamp.
