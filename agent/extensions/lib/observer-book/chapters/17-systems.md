---
id: systems
part: engineering
title: Systems programming
summary: C, C++, Rust and WebAssembly: undefined behavior, ownership and lifetimes, memory layout, FFI and WASM boundaries, build flags, sanitizers and portability.
terms: c cpp c++ rust wasm webassembly emscripten memory pointer pointers undefined behavior ub segfault buffer overflow ownership lifetime borrow unsafe ffi abi linker compile compiler clang gcc cmake cargo sanitizer valgrind simd embedded
files: .c .h .cc .cpp .hpp .rs .wasm .wat cmakelists.txt makefile cargo.toml
tools: syntax_check sandbox_run
skills: c-systems-engineering c-cpp-multiplatform cpp-performance-engineering rust-systems-engineering wasm-c-cpp wasm-rust wasm-runtime-engineering memory-resource-ownership
---

# Systems programming

In systems languages the compiler trusts you, and the hardware does exactly what the code says—including what you did not mean. Correctness depends on invariants about memory and lifetimes that the language may not check.

## Undefined behavior is not "whatever the hardware does" {#undefined-behavior}
<!-- terms: undefined behavior ub overflow null dereference uninitialized strict aliasing optimizer sanitizer -->

**Principle.** Treat undefined behavior as a license for the optimizer to do anything; eliminate it with sanitizers and defensive idioms rather than reasoning about what "probably" happens.

**Why.** Signed overflow, out-of-bounds access, use-after-free, data races, uninitialized reads and strict-aliasing violations let compilers delete checks, reorder code and produce behavior that changes with optimization level. Code "working" in debug builds proves nothing. AddressSanitizer, UndefinedBehaviorSanitizer and ThreadSanitizer in tests, plus warnings as errors, find most of these mechanically.

**Signals.** Pointer arithmetic, manual buffers, casts between unrelated types; behavior differing between -O0 and -O2; crashes that move when printf is added.

**Ask.** Have these paths run under sanitizers, and is any behavior relying on something the standard leaves undefined?

**Traps.** Silencing warnings instead of fixing them; assuming Rust unsafe blocks are checked.

## Every resource has one owner and a lifetime {#ownership}
<!-- terms: ownership lifetime raii borrow free malloc delete leak double free dangling unique_ptr shared_ptr -->

**Principle.** Make ownership explicit—RAII, smart pointers, Rust ownership—so every allocation, file and lock is released exactly once.

**Why.** Manual resource management fails on error paths: early returns skip frees, exceptions skip closes, shared pointers create cycles. RAII ties release to scope; unique ownership makes transfer explicit; borrowing rules prevent dangling references. When raw pointers are unavoidable, document who owns them and for how long.

**Signals.** malloc or new without a matching owner; raw pointers stored in long-lived structures; error paths returning before cleanup.

**Ask.** Who owns this resource, and is it released on every path, including errors?

**Traps.** shared_ptr everywhere to avoid thinking about ownership; reference cycles.

## FFI and WASM boundaries are contracts {#ffi-wasm}
<!-- terms: ffi abi wasm webassembly memory linear boundary export import pointer string encoding endianness -->

**Principle.** Specify at every language boundary who allocates and frees, how strings and arrays are encoded, and what happens on error.

**Why.** Boundaries between languages lose type information: a pointer is just a number, a string's encoding and length are conventions, and panics or exceptions crossing the boundary are undefined. WASM adds linear memory that can grow (invalidating views), fixed scratch buffers and no shared allocator with the host. Explicit ownership rules, length-prefixed buffers and error codes instead of exceptions make boundaries safe.

**Signals.** Strings passed without length or encoding; memory views held across calls that may grow memory; exceptions thrown across FFI.

**Ask.** For each value crossing this boundary, who allocates it, who frees it, and how is it encoded?

**Traps.** Assuming host and guest share endianness or pointer width.

## Builds should be reproducible and strict {#builds}
<!-- terms: build flags compiler warnings werror reproducible toolchain version cmake make cargo lockfile deterministic -->

**Principle.** Pin toolchains, enable strict warnings, and make build outputs reproducible so a binary can be traced to exact source and flags.

**Why.** Different compiler versions and flags produce different behavior, especially around UB and floating point. Reproducible builds let you verify artifacts, bisect regressions and trust provenance. Strict warnings catch real bugs cheaply. Recording flags and hashes (as provenance manifests do) makes checked-in binaries auditable.

**Signals.** Binaries checked in without source or flags; builds depending on whatever compiler is installed; warnings ignored in CI.

**Ask.** Could someone rebuild this exact artifact from source, and would warnings catch regressions?

**Traps.** Strictness settings that differ between local builds and CI.

## Know your memory layout and the cost of access {#layout}
<!-- terms: cache line locality struct layout padding alignment simd vectorize array of structs contiguous -->

**Principle.** Data layout drives performance: contiguous arrays, cache-friendly access patterns and compact structures often beat clever algorithms.

**Why.** A cache miss costs hundreds of cycles; pointer-chasing structures (linked lists, trees of small nodes) miss constantly, while contiguous arrays stream through caches and enable SIMD. Struct padding wastes memory and bandwidth; false sharing makes threads contend on unrelated variables in one cache line. These effects often dominate asymptotic differences for realistic sizes.

**Signals.** Linked structures in hot loops; large structs iterated for one field; threads writing adjacent variables.

**Ask.** Does the hot loop walk memory contiguously, and is it touching data it does not need?

**Traps.** Layout micro-tuning without measurement; sacrificing clarity in code that is not hot.

## Portability is decided by what you assume {#portability}
<!-- terms: portable portability platform linux windows macos arm x86 endianness path separator size_t long int -->

**Principle.** List the platform assumptions—integer sizes, endianness, path formats, system calls, CPU features—and either check them or abstract them.

**Why.** Code written on one platform silently encodes its assumptions: long is 64-bit (not on Windows), paths use slashes, fork exists, AVX2 is present, the filesystem is case-sensitive. Each assumption breaks on some target. Fixed-width types, feature detection with fallbacks and CI on each supported platform make portability real rather than hoped.

**Signals.** Native code targeting several platforms but tested on one; hardcoded path separators; CPU intrinsics without detection.

**Ask.** Which platform assumptions does this code make, and where are they checked?

**Traps.** Claiming support for platforms never built or tested.
