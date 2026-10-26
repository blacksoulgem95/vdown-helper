---
id: VDH-003
title: Shared types and typed messaging
status: done
priority: P0
area: lib
depends_on: [VDH-001]
---

# VDH-003: Shared types and typed messaging

## Description

Define `MediaResource`, `HlsVariant`, `Downloadability`, `DownloadJob`, `JobStage`, `Settings` and a discriminated-union message protocol between popup/side panel/background/content/offscreen, with a typed `send()`/`onMessage()` wrapper and runtime payload validation.

## Acceptance criteria

- [x] No `any` in message plumbing
- [x] Unknown/invalid messages are rejected with a typed error
- [x] Unit tests for validation

## Notes

_None yet._
