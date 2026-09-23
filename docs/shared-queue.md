# AuraShare

AuraShare lets invited guests choose music without an application account.

The guest interface uses Aura's dark palette, green actions, artwork and search layout.
Its hamburger menu opens two views: Home, with approved song cards and proposals to vote
on, and Search and add, with live search and an action beside every song. Direct guests
see “הוסף”; guests who need approval see “בקש להוסיף”. Pending or approved songs show
their status and cannot be submitted again. Navigation preserves the current search.
Voting-only guests see Home without search or add controls. Permission changes update
the interface on the next state refresh, including while a search is in progress.
Open **Create > share** for a separate session, or use the AuraShare button inside Queue
to let guests add to your existing playback queue. Give the queue a name,
choose a lifetime of 1, 4, 8 or 24 hours, and create its QR. Guests scan it in their phone's
camera and enter a display name to request access. They wait until the host approves
them individually and chooses their permission. The host sees pending requests, names,
permissions, recent connection status, proposals and votes. Pending and rejected guests
cannot see proposals, search, suggest or vote. Reloading preserves the guest's decision
through the existing cookie. An approval grants access only to this AuraShare session.

## Guest permissions

The host selects a suggested permission for approvals, chooses it for each arrival,
and can change each admitted participant separately:

| Permission | Guest actions |
| --- | --- |
| Approval required | Search, suggest songs and vote. The host approves or declines each proposal. |
| Free additions | Search, add songs without individual approval and vote. |
| View and vote | See submitted songs and vote on proposals awaiting approval. |

There is no per-guest song count limit. Duplicate requests for the same accepted or pending
song are prevented. Changing the default changes the suggested approval permission; changing a participant's
permission applies to their future actions. Previously submitted proposals keep their
approval status. Votes sort the proposal list; the host still controls playback order.

Names are display names supplied by guests, not verified identities. A participant is
shown as connected when their guest page contacted the service within the last 30 seconds.
Closing the page or putting it in the background eventually changes that indicator.

## Playback and lifetime

Songs receive a monotonically increasing `queueOrder` when accepted, whether added
directly or approved by the host. Delivery and the guest's accepted-song list follow that
order. Votes rank pending proposals only. Retried approvals keep the original order.

Only the controlling host device receives additions. Creating AuraShare from **Queue**
keeps the current song, playback position, queue order, history and player settings.
Approved songs use the normal Add to queue action, including its duplicate prevention.
Shuffle, repeat and autoplay remain available and work normally. An explicit Pause stays
paused; additions to an empty or exhausted queue follow normal player behavior. The host
can still select a different playlist normally, and future guest additions go to that queue.
Closing or expiring the invitation leaves playback and all added songs in place. This queue
uses normal personal queue storage and reload behavior. Guests still see only submitted
songs, not the host's existing personal queue.

Creating AuraShare from **Create > share** pauses personal playback
and opens an empty session queue. Music begins with the first approved guest song or host
addition. Hosts can search and add directly in AuraShare, or select songs from the app.
Selecting one song adds only that song, without replacing other people's contributions.
Personal queue storage is kept separate; closing AuraShare restores it paused, and the
personal song resumes from where it was paused when the session began. The shared
playback queue is stored per tab, so reloading the same controlling tab retains its entries.

Accepted contributions play in queue order, ahead of any unplayed automatic suggestion.
When the queue runs out, Aura adds **one** related song based on this session's music.
It repeats this only when the queue runs out again, independently of the personal autoplay
setting. Shuffle and repeat are disabled for the session. A contribution arriving during
recommendation lookup takes priority. New songs restart an exhausted queue; an explicit
Pause remains paused. Recommendation and audio availability still depend on the providers.
The AuraShare panel shows current playback, upcoming songs and a Play button when paused
or a browser requires a playback gesture. Blocked songs remain blocked.

The creation mode belongs to the invitation. Reopening it from Queue or Create, or reloading
the app, does not switch modes. Opening **Create > share** while an invitation made from
Queue is active explains that playback was not paused and that the invitation must be
ended before a separate session can start. Before control of a separate session is moved
to another device, the panel warns that personal playback there pauses and an empty
shared queue opens. The host API accepts `mode: "existing-queue"` or
`mode: "standalone"` when creating a room; omission defaults to `standalone`, and unknown
values are rejected. The mode is returned only in host responses. Creating while a room
already exists returns that room with its original mode.

The host app polls every five seconds while a shared queue exists. Keep it open on the
device connected to the speaker to receive additions promptly. Browsers may suspend
background pages. Requests accepted while it is disconnected wait in the service.
The host can explicitly transfer control to another signed-in device on the same account.
For invitations created from Queue, future and waiting additions join the new device's
local queue. Its existing queue is preserved, and the previous device's queue is not copied
or stopped.
Acknowledged requests are not automatically added to that device again. An in-flight
transfer during a connection failure can require the host to check the two device queues.

Close the shared queue to invalidate the QR immediately. Expiration also invalidates it,
including for guests who already joined. Sessions live only in this service's memory;
restarting or deploying the service closes all active shared queues. No guest profiles or
audio files are persisted. Requests are metadata only and never include the host's library,
listening history, AI keys or account email in guest responses.

## Floating host controls

While an invitation is active, a small circular AuraShare control appears outside the
full sharing panel. Drag it to any of the four edges; it snaps to the closest edge and
remembers that position on this browser. Arrow keys move the focused control to an edge.
Tap to expand or minimize it. The panel stays inside the app when the screen resizes.
Ending the invitation removes the control.

Its badge counts pending joins and song proposals. A new request previews one actionable
card with approval and rejection controls, including the permission choice for a new guest.
Only the controlling playback device can approve songs, as in the full panel. QR access
opens the existing invitation panel directly. Minimized requests stay available until
handled, and decisions made on another device disappear on refresh.

Informational previews last 6.5 seconds. The expanded panel keeps the latest 20 activity
updates, including song additions, admission, permission changes, votes, presence changes
and transfer of control. Repeated polls do not repeat the same event. Reloading restores
pending actions without replaying old activity. These are in-app updates while the host
app is open, using the existing five-second polling interval.

The active shell cache version is shown under **Settings > About**. It comes from the
service worker controlling the page, including offline, rather than the newest cache
that may be waiting to activate.

## Hosting and access

The feature requires the private self-hosted stack and its publicly reachable HTTPS
address. Configure your domain and an HTTPS reverse proxy as described in the
[installation guide](../README.md#self-hosting). Guests open invitations in their browser
without a VPN. After initial setup, update the checkout on that server and run:

```sh
sh selfhost/private-app/setup.sh
```

The updated automatic deploy script also rebuilds when files in the queue service change.
The application shows the feature after `/api/queue/` responds, with a retry entry on
installations where library sync is already available.

`aura-queue` exposes two **internal**, unpublished ports:

| Listener | Route | Access |
| --- | --- | --- |
| 8091 | `/api/queue/` | Authenticated account, only its own shared queue |
| 8092 | `/guest/api/` | QR invitation token and, after joining, an HTTP-only guest cookie |

The public listener contains no host endpoints and ignores forwarded account headers.
nginx strips identity and authorization headers on public guest API requests. The
authentication proxy exempts only the exact guest HTML, JS, CSS and guest API methods
listed in the compose configuration. All other application routes keep their existing
sign-in requirement. This uses the proxy's documented
[method-and-path authentication exceptions](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/).

The random invitation token is in the QR URL fragment, so it is not part of URL access
logs or referrers. The guest page sends it in a request header. The host's own requests
carry it in the request path, so the `/api/queue/` location has access logging off in
nginx and is excluded from oauth2-proxy's request log. Anyone holding the QR or
its link can request access while it remains open. Only the authenticated host can admit
each guest and grant one of the existing permissions.
The QR image is generated inside the private service; no third-party QR service receives
the invitation. Guest pages have a restrictive content security policy and bypass the
private application's service worker cache.
Cover images load only from `https://i.ytimg.com`, using validated video IDs and no
referrer. The guest CSP allows this image host; private application assets remain
behind authentication. Missing artwork falls back to a music icon.

Search is a bounded request to the configured Invidious search endpoint. A guest can
submit only IDs returned by a recent search, with metadata validated by the server.
Request sizes, request rates, active sessions and participant counts have service-level
limits to protect a publicly reachable endpoint. These are separate from song count;
there is no three-song or other per-participant submission allowance.

## Verification

Install the service's QR dependency before running its tests:

```sh
npm ci --prefix selfhost/private-app/queue
node --test tests/shared-queue-*.test.js tests/service-worker-integrity.test.js
```

With Playwright, pngjs and jsqr available via `NODE_PATH`, and Chromium installed:

```sh
node tests/shared-queue-ui.cjs
```

The browser test decodes the rendered QR, joins from independent guest contexts, checks
named presence, admission approval, song approvals, free additions, votes, permission changes, private-route
denials, mobile layout and closure. Its music search is a fixture; real playback uses the
existing player and deployment's Invidious instance.

With Podman and the deployment's authentication gateway image available,
`node tests/shared-queue-gateway.cjs` checks the real gateway's route exceptions against
a local fixture, including forged identity headers and attempts to reach private APIs.
