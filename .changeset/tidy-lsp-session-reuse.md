---
"@narumitw/pi-lsp": patch
---

Reuse language servers across diagnostics and fixes within each Pi session and workspace by default. Refresh requested documents on every call, serialize shared-client work, and discard failed or cancelled clients so later calls can retry. Drain idle and active servers during shutdown, reload, and session replacement, with bounded shutdown and process-termination grace periods.
