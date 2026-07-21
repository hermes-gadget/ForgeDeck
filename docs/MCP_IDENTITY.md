# MCP identity and threat model

ForgeDeck treats an MCP actor as a stable local principal and its bearer token as a replaceable credential. The actor ID owns sessions and appears in session audit records; token rotation, dashboard restart, stdio restart, expiry, or inactivity do not change that ID.

## Lifecycle

- The installation bootstrap secret is stored in `.data/mcp-token`. `POST /api/mcp/actors` binds a validated `clientId` to an actor, or recovers that actor and rotates its token.
- The stdio MCP server keys its credential filename from the canonical ForgeDeck URL and `FORGEDECK_MCP_CLIENT_ID`. It stores the URL, client ID, actor ID, token, and issue/expiry times in `.data/mcp-actors/`.
- Normal startup reuses that credential. Near expiry, the current bearer token proves possession to the rotation endpoint. A `401`, expired token, inactive token, or lost credential file falls back to the installation bootstrap secret and the same client ID; the server returns the same actor ID.
- Rotation installs a new token atomically and accepts the preceding token for a short overlap so in-flight local requests do not fail. The server stores only token hashes. A client-side write failure is recoverable through the bootstrap flow.
- A target actor can mint a short-lived, one-time handoff token. The current owner presents it with an explicit session list; ForgeDeck validates every ownership record and transfers the whole list atomically.
- Revocation requires an explicit disposition. `release` preserves sessions but removes MCP ownership, making them view-only to a later actor. `archive` first requests archival for every owned session and does not revoke if any request fails. Revocation invalidates current and overlapping credentials and creates a fresh actor if the same client ID is used later.

## Threat model

Permissions and local theft: ForgeDeck forces the data directory and `.data/mcp-actors/` to mode `0700`, and the bootstrap, actor credential, and server access-state files to `0600`. The client credential is still an unencrypted bearer secret: another process running as the same OS user, a privileged process, or a compromised backup can use it until rotation or revocation. Use distinct client IDs for independent MCP clients and do not copy credential files between installations.

Proof of possession: bootstrap recovery requires the installation secret; ordinary rotation and API mutations require a valid current or briefly overlapping actor bearer token. A handoff requires both the source actor's credential and the one-time token minted by the target. ForgeDeck never accepts an actor ID alone as authorization.

Rotation and replay: absolute and inactivity limits bound a token's normal lifetime. Rotation narrows the old token to a short grace period, but requests captured during that overlap can still be replayed; this design assumes a trusted local loopback transport and does not replace TLS for remote exposure.

Audit attribution: session creation, MCP policy/interrupt/queue/archive actions, ownership release, and handoff use `mcp:<stable-actor-id>` attribution. Tokens and handoff secrets are excluded from audit details and logs. Actor IDs are identifiers, not secrets.

Recovery and reconciliation: dashboard restarts reload actor and owner records from the permission-restricted access file. Stdio restarts reload the scoped client credential. Expiry and inactivity disable a credential without deleting the actor or ownership. Inventory reconciliation releases records for backend threads that no longer exist, preventing phantom ownership from accumulating. If both the client credential and bootstrap secret are lost, ForgeDeck deliberately does not let a new actor claim the old sessions by ID; an operator can retain them as local sessions or restore the protected data directory from backup.
