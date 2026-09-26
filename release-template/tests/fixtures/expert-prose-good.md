# Migration guide: config v2

Version 2 renames `timeout_ms` to `timeoutMs` and requires `retries` to be an
integer between 0 and 5. The loader rejects unknown keys instead of ignoring
them, so a config that worked under v1 can fail fast under v2 with a message
naming the key.

Before:

```json
{ "timeout_ms": 5000 }
```

After:

```json
{ "timeoutMs": 5000, "retries": 2 }
```

Verify with `app --check-config ./app.json`, then run the suite. Roll back by
restoring the v1 file; v1 and v2 files are not interchangeable.
