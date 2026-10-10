---
name: systems-languages
description: "Use when writing, reviewing or shipping C, C++, Rust, Go, Java, .NET, PHP, x86 assembly, Fortran or embedded firmware, or when handling compilers, model checking, concurrency, memory ownership, cross-platform builds, ABI, FFI and hardware access."
---

# Systems Languages
## C
- Document ownership, length, alignment, errors; check `n > SIZE_MAX / sizeof *p` before allocating; keep the old pointer when realloc fails.
- Signed overflow is UB; serialize with explicit width and endianness, never raw structs.
- `restrict` is a promise: check a scalar reference, then tails and unaligned buffers, before SIMD.
## C and C++ multiplatform
- Name the target matrix (OS, arch, compiler, standard); build through one entry point (CMake presets, toolchain files).
- Verify each target: warnings-as-errors build plus its tests. One Linux green build proves nothing about other targets.
- Put platform differences behind feature checks and small adapters, not `#ifdef` business logic.
## C++ performance
- Prefer owned values; `string_view`/`span` dangle when the owner dies or a vector reallocates.
- Keep a scalar fallback behind runtime dispatch; avoid `-march=native` in distributed binaries.
## Rust
- Never hold a sync lock across `.await`; `Arc` shares ownership, not mutation safety. Panics mean broken assumptions, not bad input.
- Each unsafe block documents pointer validity, aliasing and lifetime; run Miri or fuzzing where supported.
## Go
- `context.Context` goes first; a timeout stops waiting but does not undo a remote mutation. One owner closes each channel.
- Verify cgo and certificate/timezone assets before claiming a static binary; SSRF-check user-supplied URLs.
- Bound queues and goroutines; never copy types holding mutexes.
## Java
- Pin JDK, build wrapper and module layout; use `Path`, explicit charsets and time zones.
- Ship per target (jar, jlink, jpackage); each form needs its own test on that OS. Linux success is not Windows or macOS evidence.
- `BigDecimal` from strings, not doubles. Container limits cover heap, metaspace and native memory, not just heap.
## .NET
- Pin SDK and runtime identifier; nullable annotations are not input validation. Pass cancellation through owned async work.
- Trimming and Native AOT break reflection-heavy code; test the published artifact on Linux. Path case and ICU matter.
## PHP
- Use prepared statements; allowlist SQL identifiers; escape HTML by context; never expose phpinfo or `.env`.
- Web SAPI and CLI can differ in php.ini and extensions; `php -S` is not production. A file rollback does not undo a migration.
## x86 assembly
- Confirm ISA, syntax and ABI first; System V and Win64 differ in argument and preserved registers.
- CPUID is not enough for SIMD: check OS state support; keep a scalar path; test tail, overlap and guard-page sizes.
## Fortran
- Pin standard, flags and `real64` kinds; use modules and explicit interfaces. Fast-math and OpenMP reductions change rounding.
- `do concurrent` asserts independence. Validate with manufactured solutions and an independent reference, not two builds of one bug.
## Embedded devices
- Identify exact board, chip, port and artifact; check pinout, voltage limits and boot straps before flash, erase or reset.
- Check build hooks first; they can upload or run commands. Compile first; keep compile, upload, monitor separate. Opening a serial port can toggle reset lines.
- Stop on unexpected reset or identity change; never auto-erase or disable the watchdog. Report compiled, flashed and ran separately.
## Compiler construction
- Keep source spans for diagnostics; specify precedence, scoping and evaluation order.
- Preserve effects and evaluation counts (`f() * 0` is not `0`); test against an independent interpreter.
## Formal model checking
- Model the smallest system that can violate a property with real consequences; seed a known defect to validate the model.
- Report bounds, tool version and completeness; without a checker run, call it an unverified sketch, not a proof.
## Concurrency and memory ownership
- Map each shared object to its synchronization owner; one atomic field does not make a compound update atomic.
- Write lock order; never hold locks across unknown callbacks. x86 success does not validate weaker memory models.
- Test cancellation and contention; deadlock-free is not lock-free or fair.
- Give each resource one release owner; check partial-init, error and cancel paths; make cleanup idempotent.
