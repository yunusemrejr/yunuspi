---
id: embedded
part: engineering
title: Embedded systems and hardware
summary: Software that touches the physical world: exact target identity, timing and interrupts, memory limits, power, safe flashing and I/O, protocols, and verifying on real hardware.
terms: embedded firmware microcontroller mcu esp32 arduino stm32 raspberry pi gpio i2c spi uart serial interrupt rtos freertos flash bootloader sensor actuator pwm adc power low power watchdog iot device hardware platformio
files: .ino .c .h platformio.ini sdkconfig .dts
tools: sys_probe sandbox_run
skills: embedded-device-engineering industrial-automation-control industrial-device-protocols c-systems-engineering
---

# Embedded systems and hardware

Embedded software controls physical things with limited memory, strict timing and no easy undo. A bug may brick a device, damage hardware or hurt someone. The discipline is to know the exact target, respect its limits, and verify on real hardware before claiming anything works.

## Know the exact target {#target}
<!-- terms: board target chip variant pinout voltage toolchain sdk version datasheet -->

**Principle.** Identify the exact board, chip variant, pin mapping, voltage levels and toolchain before writing I/O code.

**Why.** Boards with similar names differ in pinouts, flash sizes, peripherals and voltage (3.3 V versus 5 V). Writing to the wrong pin can short outputs; mismatched voltage can destroy components. The datasheet and the board's schematic are the source of truth, not tutorials for similar hardware. Compiling for the exact target catches many mismatches early.

**Signals.** Pin numbers copied from tutorials for other boards; unknown voltage levels; generic board targets in build configuration.

**Ask.** Which exact board and chip is this for, and do the pin assignments match its datasheet?

**Traps.** Assuming Arduino pin numbers equal chip GPIO numbers.

## Timing, interrupts and concurrency {#timing}
<!-- terms: interrupt isr timing real time latency deadline volatile race critical section rtos task priority -->

**Principle.** Keep interrupt handlers short, share data with them safely (volatile, atomic access, critical sections), and budget timing for deadlines.

**Why.** Long interrupt handlers delay other interrupts and break timing guarantees; shared variables without protection produce rare corruption. RTOS task priorities can cause priority inversion. Blocking delays in main loops make devices unresponsive. Measuring timing with an oscilloscope or logic analyzer beats assumptions.

**Signals.** Heavy work or printing inside interrupts; shared variables without volatile or locking; delay-based timing.

**Ask.** What runs in interrupt context here, and how is shared data protected?

**Traps.** Disabling interrupts for long stretches.

## Memory and power are hard limits {#resources}
<!-- terms: memory ram flash heap stack overflow fragmentation dynamic allocation power sleep low power battery current -->

**Principle.** Budget RAM, flash and power explicitly; avoid dynamic allocation in long-running firmware and use sleep modes deliberately.

**Why.** Microcontrollers have kilobytes of RAM; heap fragmentation eventually crashes long-running devices; stack overflows corrupt memory silently. Battery-powered devices live or die by sleep current. Static allocation, bounded buffers and measured power profiles make behavior predictable.

**Signals.** malloc in loops; large stack buffers; no power measurements for battery devices.

**Ask.** What are the RAM, flash and power budgets, and how close is this design to them?

**Traps.** Measuring power only in active mode.

## Flash and test safely {#flashing}
<!-- terms: flash flashing bootloader brick recovery ota update rollback watchdog serial reset -->

**Principle.** Keep a recovery path before flashing—a working bootloader, known-good image, OTA rollback—and enable a watchdog to recover from hangs.

**Why.** A bad firmware image or interrupted update can brick a device, especially remotely. Dual-bank OTA with verification and rollback, watchdog timers and physical recovery procedures turn failures into restarts instead of truck rolls. Opening a serial connection can reset some boards, which matters when testing.

**Signals.** OTA updates without verification or rollback; no watchdog; flashing without a known-good backup.

**Ask.** If this firmware hangs or the update fails halfway, how does the device recover?

**Traps.** Watchdogs fed from timers that keep running while the main logic is stuck.

## Protocols have timing and electrical rules {#protocols}
<!-- terms: i2c spi uart can modbus pull-up baud rate clock address bus protocol checksum -->

**Principle.** Follow each bus protocol's electrical and timing requirements—pull-ups, clock speeds, addressing, termination—and validate messages with checksums.

**Why.** I2C needs pull-up resistors and unique addresses; UART needs matching baud rates and voltage levels; industrial protocols need termination and error handling. Many "software bugs" in hardware communication are wiring, speed or electrical issues. Checksums and timeouts catch corrupted or lost messages.

**Signals.** Communication failures debugged only in code; no timeouts on bus reads; missing checksums on noisy links.

**Ask.** Are the electrical and timing requirements of this bus met, and are messages validated?

**Traps.** Increasing bus speed beyond what wiring supports.

## Compilation is not verification {#verify-hardware}
<!-- terms: verify hardware test bench real device measure oscilloscope multimeter compile works -->

**Principle.** A successful build proves only that the code compiles; claim behavior only after testing on real hardware, and say so when hardware is unavailable.

**Why.** Embedded behavior depends on electrical reality, timing and peripherals that simulators approximate at best. Firmware that compiles cleanly can still drive the wrong pin, miss timing or fail under noise. When no hardware is available, the honest report states what was verified (compilation, unit tests of logic) and what remains untested.

**Signals.** Claims that firmware works based on compilation; no hardware test plan.

**Ask.** What has actually been verified on the target hardware, and what has only been compiled?

**Traps.** Testing on a development board and assuming the production board behaves the same.
