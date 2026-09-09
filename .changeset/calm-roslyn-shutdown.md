---
"@narumitw/pi-lsp": patch
---

Omit the `params` member from parameterless LSP shutdown requests so strict servers such as Roslyn exit cleanly instead of aborting during PI session cleanup.
