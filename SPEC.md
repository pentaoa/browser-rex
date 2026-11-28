# Linux service contract

## Process and persistence

One foreground process owns the session Store, PTYs, private Unix listener and selected TCP listeners. `-mode web` enables browser TCP, `-mode rex` enables native TCP, and `-mode both` enables both. The private local Rex socket is always present. Each pane owns an isolated Ghostty VT module. Local panes and remote snapshot conversion share the pure-Go WASM compilation cache and read-only ABI metadata. Default addresses are loopback. All selected listeners must bind successfully; a startup error exits nonzero and releases already-opened listeners. A socket lifetime lock prevents concurrent service instances on the same socket. Regular files are never replaced as stale sockets.

SIGINT/SIGTERM closes HTTP servers, hijacked WebSockets and panes. Shells and layouts survive client disconnects. They do not survive service termination. Workspace files persist, and `-workspace` allows a stable location across service restarts. A fresh service starts one default shell.

## Sessions and streams

The Store owns session labels, ordered window tabs, nested binary horizontal/vertical splits, ratios and focus. Browser state handles presentation, selection and the last consumed stream byte offset. Each pane has a PTY, one live viewer and 512 KiB of retained output in lazily allocated 16 KiB pages. Live output and replay share immutable byte ranges. Panes that exit retain output until closed.

Browser attachment sends `stream` metadata, retained binary bytes, `ready`, and live bytes. A valid retained offset resumes without duplication; offsets outside retention reset the renderer. Slow viewers detach when the bounded output queue fills. Browser input is suppressed while replaying and discarded on disconnect. Output parsing is ordered and time-budgeted; consumed offsets advance only in parser completion callbacks. Input readiness and replacement transports wait behind parser barriers, so a disconnect during queued replay cannot claim bytes not yet consumed. Parser failure resets the renderer and resumes from a fresh retained replay. The bundled frontend retains the upstream webterm lifecycle and Ghostty renderer.

## Native Rex

Both the Unix socket and native TCP use `rex.control.v1` at `/api/control`, with API revision 12, and ticketed `rex.data.terminal.v1` at `/api/data`. New streams receive a blank Ghostty snapshot followed by retained bytes and live output. Tickets are single-use, expire after 60 seconds and require a live originating control connection. Native data-stream resume is unsupported; reopen with a fresh ticket.

Supported control methods:

- `server.version`, `server.status`, `server.whoami`, `hosts.list` (empty), `client.keymap`, `client.set_label` (no-op), `block_creator.list`.
- `session.list`, `session.attach`, `session.detach`, `session.attach_all`, `session.bootstrap`, `session.view`, `session.create`, `session.destroy`, `session.set_label`.
- `session.new_window`, `session.close_window`, `session.set_window_label`, `session.focus_window`, `session.focus_block`, `session.new_split`, `session.resize_pane`, `block.close`.
- `session.own_block`, `session.disown_block`, `data.connect`, `client.key`, `block.event`, `block.method` and creator-qualified terminal methods.
- `target.resolve` for sessions, windows and blocks, including exact IDs, labels, window positions, suffixes and ambiguity reporting.
- `session.describe_block`, `session.list_blocks` with terminal metadata for CLI input commands.

Terminal methods: write, resize, size, input_mode (Linux TCGETS), title (empty), pwd (initial workspace), process (initial shell metadata), program_status (empty), set_theme (no-op). Paste, focus events and basic key encoding are supported. These metadata methods do not inspect arbitrary foreground processes or reconstruct a terminal screen.

Creation accepts one initial shell tab; custom command layouts and initial input are rejected. Floating panes, Lua, target completion, full discovery/help, downloads and native file-transfer automation, native stream resume and multi-user login are outside this subset. Unknown methods fail explicitly. Revision 13 is not advertised.

## Security and verification

The optional `-hosts-file` enables an owner-managed browser host registry at
`GET/POST /api/hosts`. Save, remove and connection checks use the same authenticated,
same-origin boundary as workspace mutations. Registry files are private regular
JSON files, limited to 64 KiB and 32 hosts, updated by atomic rename. URLs are
HTTPS origins, except loopback HTTP forwards. The browser selects a stored host
ID with `host=`; arbitrary upstream URLs and native control methods are not exposed.

Selected remote hosts negotiate API revisions 9–12. Workspace HTTP operations share
one serialized native control connection per host; each terminal viewer owns a control
and ticketed data connection. Interleaved control events are consumed while
awaiting matching RPC responses. Native snapshots are decoded with the bundled
Ghostty WASM and formatted into a browser VT replay, followed by live output.
Nonce-authenticated Rex APC messages are removed from the byte stream; lookalikes
from programs remain terminal data. Fresh attachments reset browser offsets.
Input/mutations are never retried. Disconnect closes both upstream connections
and leaves remote sessions alive. At most 32 remote pane streams are admitted.
Floating layouts, pre-existing snapshot graphics and non-ground parser
continuations are unsupported. Native `hosts.list` still describes only the local
service's discovery subset. Native layout events invalidate an opaque generation;
`GET /api/updates?host=ID&since=GENERATION` waits at most ten seconds. Long polls do
not hold the RPC gate, queue events or send keepalive RPCs. There are at most 32
waiters per host. Reconnecting replaces the generation and forces a fresh view;
only a subsequent independent request reconnects after failure. Removing a host,
changing its endpoint or shutting down the manager cancels its connections.

Local `GET /api/updates` follows the same ten-second invalidation contract with up to 32 waiters. Mutations, terminal metadata changes, and child exit wake waiting clients. Ordinary terminal output travels on its own WebSocket.

The browser pauses update work when the document or embedded workspace is hidden.
Host switches preserve only per-page selection and renderer preferences, close
the previous pane transports and discard stale asynchronous responses. Native
layout state remains authoritative. Stable tab nodes and presentation comparisons
avoid DOM replacement for metadata-only revisions. Motion uses bounded opacity
and transform effects; dragging avoids geometry transitions and reduced-motion
preferences disable the effects.

Default shell isolation uses Linux namespaces and fails closed. Host isolation is a deliberate full-account option. Remote web requires password authentication and a fixed public origin. Remote native TCP requires anonymous-access opt-in. See [SECURITY.md](SECURITY.md) for precise boundaries.

Run `make check`, `make race`, `make smoke` and `make release`. Smoke tests cover execution from an empty directory, embedded assets/WASM, sandbox file/network/socket denial, capability drop, PTY resizing, reconnect offsets, nested splits, native wire streams, shared layouts, mode selection, web authentication and shutdown. Set `REX_REFERENCE_BIN` for optional official CLI tests over both native transports.

## Browser search and shared input

The focused-pane search uses the core's literal search over the active screen and loaded history, with ASCII case folding, a 1024-character query limit, result counts and a selected-match highlight. It owns a separate decoration layer and frees native handles when panes reset or close. Switching panes clears the former target's highlight. Search never supplies terminal input or searches other sessions. Optional case-sensitive, whole-word and regex modes use cooperatively built text/cell snapshots and RE2JS linear-time matching, with generation cancellation and explicit pending/error/truncated result fields. Limits are 500,000 cells/1 MiB text and 10,000 matches. Historical soft wraps and complete combining graphemes map back to terminal cells; unsupported syntax is rejected.

Mobile input remains a single shared textarea/keybar. Its anchor follows the focused pane's cursor and stays within the visible viewport. Native clipboard staging is user-initiated, uses the current selection, and clears staged text after Copy or subsequent input. No background clipboard reads are performed.

## Authoritative capture

The server embeds the same Ghostty WASM as the browser bundle and executes it through wazero, without CGO or an external runtime. Each pane has an independent module with a 64 MiB memory cap and bounded calls; output is fed before publication. Native `format`/`blob_read` and the browser capture endpoint read this state without requiring a viewer. Browser command-palette exports support text, HTML and VT. Captures cover the active screen and its retained history (2000 lines/16 MiB, page-granular pruning), with a 4 MiB export cap. Native chunks obey encoded JSON limits; at most 4 MiB of temporary blobs is retained per pane. HTML export is sanitised and supplied with an offline CSP.

The server is authoritative for terminal query replies. The embedded browser sets emitTerminalResponses=false so replay and live parser activity cannot generate duplicate replies. Capture does not imply service-restart session persistence or a stable native snapshot wire format.

## Program and prompt effects

The server records bounded OSC 7501 statuses and reported title/pwd using Ghostty callbacks. HTTP session views carry a separate terminal_metadata extension for browser badges and automatic tab titles, leaving native Rex session-view shapes unchanged. Native program_status/title/pwd read the same metadata. Native terminal title changes publish a `title_changed` block event. The remote gateway reads the focused terminal's title for each tab and uses those events to invalidate cached views. Explicit window labels take precedence in the tab strip. Records and prompt events are cleared on VT reset; process exit and VT failure are reflected in browser state.

Default supported shells receive OSC 133 PS1 hooks. Browser Previous/Next prompt navigation uses the client's core marks, temporarily reading core scroll positions and restoring the live viewport before updating external scroll state. No shell input is emitted.

## Web image/file uploads

`-uploads` plus password authentication enables one-file multipart POST uploads. The initiating session and pane must exist. A local upload returns the generated workspace name, detected MIME, size and path. Storage is rooted in a pinned directory descriptor, with no-follow/exclusive creation, complete-request validation and no-replace atomic commit. The browser pastes the quoted local path without Enter.

A remote upload requires a registered Rex host advertising the terminal's `upload_begin` method. The gateway stages the bounded request, gets a one-use ticket and sends the file over `rex.data.bytes.v1`. Rex stores it and pastes the path into the initiating pane. The gateway waits for Rex to confirm the transfer. Clipboard, drop and file-picker actions submit at most eight files sequentially. Limits are 16 MiB per file, four concurrent requests per upload backend and two minutes per request. Files are never served as web assets.

## Resolved image frames

Client image snapshots use the shared render state's resolved rectangles/layers/crops and native content generations. Owned pixel caching is bounded to 64 MiB; borrowed WASM views are not retained. Terminal-owned animation scheduling cancels on reset/disposal/suspension, respects DEC holds and uses bounded deadlines. Canvas clips image layers to repainted rows to avoid stale retransmission and alpha accumulation. Server VT image storage is bounded to 16 MiB with a host PNG decoder limited to 8 MiB input/4096 dimensions/4 million pixels, and remains the source of protocol acknowledgements.
