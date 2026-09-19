> YunusPi-maintained API reference, derived from Pi 0.85.1 (MIT). Historical source and example links are pinned references, not release or installation authority. Install and update only through the [YunusPi source workflow](../../../docs/INSTALL.md).

# Install and run YunusPi

Follow the [source installation instructions](../../../docs/INSTALL.md). The installer builds the repository-owned core and exact workspace lockfile. Launch `yunuspi`; `pi` remains a compatibility alias in managed installations.

## Uninstall

Stop managed sessions, preserve any wanted private data, and remove the PATH entry and installation directory you selected. Unrelated upstream Pi installations are separate.

## Updates

Use `yunuspi update --source /path/to/reviewed/yunuspi` to apply reviewed YunusPi source. See [updates and recovery](../../../docs/CORE-UPDATES.md). Upstream Pi packages and release feeds are never used for core updates.
