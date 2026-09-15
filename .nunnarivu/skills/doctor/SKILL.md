---
name: doctor
description: Check whether this session or machine is ready for nunnarivu factory. Use when setting up the kit or a cloud environment, or when an autonomous run fails to start.
disable-model-invocation: true
---

Run `nunnarivu doctor`.

For every `[fail]` or `[warn]` line, tell the user in plain language what is missing and the exact fix. If everything passes, say the session or machine is ready.
