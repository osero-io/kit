---
'@osero/client': patch
---

Call the hosted API fetch implementation as a plain function instead of as a method, so browsers
that enforce the fetch receiver no longer throw `TypeError: Illegal invocation`. This applies to
both the default global fetch and a caller-supplied `fetch` override.
