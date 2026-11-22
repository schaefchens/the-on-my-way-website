# Privacy: what is stored about followers, and where

Wave 5 (approval-only followers, owner decisions D6, D11, D12). This page describes what the
software stores. It is **not legal advice**; the texts followers read before they join are the
owner's privacy notice (*Einstellungen → Datenschutzhinweise* in the admin), which starts from a
template marked "Vorlage – keine Rechtsberatung" (`api/src/Domain/Access/privacy-template.json`).

## Who is who

- **Owner** (the traveler): the one admin login. Sees names, devices, consent records.
- **Follower**: a person the owner invited with a personal link. Has a random, never reused id
  (`fid`, 12 characters); the name the owner typed is resolved from it.
- **Device**: one browser of a follower (`did`). Each has a device key; the first device joins
  without approval, every further one waits for the owner (Q3 c).

## What is stored where

| Where | What | Kept until |
|---|---|---|
| **API database** (`api/var/app.sqlite`, PHP host) | follower: id, name, optional owner memo, state, invitation and revocation times, the sha256 of the current personal link; per device: label from the browser ("iPhone · Safari", never the raw user agent), state (waiting / active / removed / declined), first or approved, joined / decided / removed times, last opened (at most every 6 h), sha256 of the device key and of the current session; consent records (notice version, language, time, device; a waiting device's confirmation counts as the person's only once the owner approves that device); published privacy notice versions; the outbox of store operations (`store_ops`: paths with person and device ids, times) | until the follower or the owner deletes the person; ending access keeps the data (D8); applied store operations 7 days. Deletion also erases the person's store operations and leaves a **tombstone**: id, "deleted on <date>", by whom — no name, no invitation date |
| API database backups (`api/var/backups/`, nightly) | the same, as of that night | `BACKUP_KEEP` (14) days; downloaded copies: the owner deletes them after the same time (HOSTING §8) |
| API rate limiting (`rate_events`) | hashed buckets (`sha256(IP or key + a salt that changes daily)`), no plain IP | 48 h |
| API log files (`api/var/logs/`) | errors and events without names, link secrets, keys or session ids (tested: `LogPrivacyTest`) | 30 days |
| **Session-file store** (site host, outside the docroot) | empty files named `<fid>/<did>.<session id>` for active sessions, short-lived handoff markers, the lock file, tombstones `t/<fid>` (`revoked`/`deleted` + date) | sessions until revoked or replaced; tombstones stay (they keep a deleted id from returning after an API restore) |
| **Site host access logs** (Hetzner) | IP addresses and request lines of every visit (`/_/h/` and `/<secret>/…`, never a key or session id: the handoff carries no secret in the URL) | per the host's retention (ask Hetzner; mention it in the notice) |
| **Backend (the Mac)** | nothing about followers: it never receives names; the fallback writer handles store paths (ids only) | – |
| **Follower's browser** | cookies below; no other storage of personal data (the site registers no service worker) | see below |

Owner notices ("Eine Person hat ihre Daten gelöscht", "after a restore") and push or e-mail alerts
never contain names.

## Cookies (on the site host only; the API sets none, except in fallback mode `parent`)

| Cookie (https) | Content | Lifetime | Purpose |
|---|---|---|---|
| `__Host-omw` | `<fid>.<did>.<session id>` | 400 days, renewed on every page load | the gate's check against the store (HttpOnly) |
| `__Host-omw_k` | device key | 400 days, renewed | proves the device to the API (sent in the request body, never in a URL) |
| `__Host-omw_s` | the session value | 120 s, deleted at the handoff | carries the new session from the join page to Apache |
| `__Host-omw_h` | `1` | 10 min | "a handoff just happened" (the site then says hello to the API once) |
| `__Host-omw_r` | `1` | 5 min | limits automatic resume attempts on the neutral page |

All are strictly necessary for access (no analytics, no third parties). Over plain http on a
loopback development host they are called `omw`, `omw_k`, … without `Secure`.

## Rights (D12)

- **See and export:** *Deine Daten* on the site (`/_/me/`) shows everything stored about the
  person and exports it as JSON (`omw-follower-data/1`, including the confirmed notice texts).
  The owner can export the same from the admin.
- **Delete:** "Mich und alle meine Daten löschen" with a deliberate confirmation: revokes every
  device at once, erases everything that references the id, leaves the tombstone above and a
  nameless notice to the owner. The owner has the same action for requests by other channels.
- **Sign out one device:** *Auf diesem Gerät abmelden*.
- Only **active** devices (and devices that ended together with the person's access) may read,
  export or delete the person's data; a waiting or declined device sees only its own entry and
  can withdraw its request.
- **Changed notice:** a new version is shown again on the next visit and must be confirmed
  ("Weiter", never a pre-ticked box); every confirmation is recorded.

## For wave 6

Views, impressions, reactions, messages, e-mail addresses and the request-access form are **not**
collected in wave 5. Before any of them is stored, publish a new notice version that names them
(the template's `_comment` says so), so every follower confirms it first.
