---
id: VDH-004
title: Security utilities
status: todo
priority: P0
area: security
depends_on: [VDH-001]
---

# VDH-004: Security utilities

## Description

URL scheme allow-list (http/https/blob), URL normalisation, credential/token redaction for logs, filename sanitiser (reserved names, path separators, control chars, length), naming template renderer.

## Acceptance criteria

- [ ] Dangerous schemes (`javascript:`, `data:`, `file:`, `chrome:`) rejected
- [ ] Sanitiser covers Windows reserved names, trailing dots/spaces, unicode controls, 200-char cap
- [ ] Logger redacts userinfo and sensitive query params
- [ ] Unit tests

## Notes

_None yet._
