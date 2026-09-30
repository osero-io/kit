---
'@osero/client': major
---

Replace legacy bridge-status requests and responses with normalized Transfer Status. Status requests
now keep the source transaction hash and complete quote Status Context together, known Enso and LI.FI
Provider Details are typed, and unknown providers remain inspectable. Polling continues for pending
and unknown states and returns completed or failed Transfer Status observations without discarding
provider diagnostics.
