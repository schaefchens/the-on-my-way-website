# Protecting the traveler: threat model, prior art, levers

Design note for wave 5 (contact button + traveler protection). Written 2026-11-20 from a read-only
review of the repo (README.md, docs/PLAN.md, packages/contracts, backend/src/generator,
frontend/site) and web research. No live host was contacted. Sources are listed at the end with
IDs like [PS6]. Where a source page blocked automated fetching, the claim comes from search-result
excerpts and is marked "(excerpt)".

---

## 0. Summary

1. **The site changes what WhatsApp status was.** A status is shown for 24 h, only to her contacts,
   respects "My contacts except…" and shows her who viewed it. The site makes the same content
   **permanent, open to anyone with the link, anonymous to view and machine-readable** (JSON with
   exact timestamps). Someone she excluded on WhatsApp, such as an ex, can read the same statuses on
   the site, live, and she never sees that he looked.
2. **Today the site is close to a live location feed.** Publishing is `instant` by default. There is
   a "Now in <place> · 12 min ago" chip. Every entry carries an exact timestamp, and day files can
   carry full-precision coordinates. The photos themselves show hostels, streets and views.
   `manifest.json` can be polled at any rate. A motivated person learns her city, often her venue,
   within minutes.
3. **Most stalkers know their victim** (US figures: 40 % current or former partner, 42 %
   acquaintance [SA9]). So "only people with the link" is weak protection: the person to fear can
   usually get the link from a mutual friend. Design the defaults so that **"he got in" is still
   survivable.** That means freshness and precision levers (delay, "post after you leave", no live
   chip). Access control is the first line of defense, not the only one.
4. **Harm needs fresh and precise data together.** Country-level news from today is low risk.
   A hostel photo from three weeks ago is low risk. The same hostel photo while she is still
   staying there is the dangerous case. A fixed 12 h delay does not cover a 3-night hostel stay.
   "Publish after she has moved on" does.
5. **Removing metadata is not enough.** EXIF/GPS is already stripped
   (`backend/src/pipeline/image.ts`, `video.ts`). People still geolocate photos from what they show,
   such as reflections in eyes [C1], and AI tools do it in seconds without metadata [C2]. A portrait
   plus a first name feeds face search engines [C3].
6. **Prior art converges on one pattern:**
   - followers by **approval, not auto-accept**;
   - **per-item/per-trip audiences** with a "close friends" tier;
   - **live location off by default**, or shared only 1:1 and time-limited;
   - **silent removal** of followers;
   - a **one-tap emergency reset**.

   The September 2026 Polarsteps/Follow the Money incident is the warning [PS6]:
   - Accounts set to auto-accept and "secret links" let a journalist read followers-only trips at
     scale.
   - Polarsteps expired all secret links, reset everyone to approval-required, and added "hide
     start / end / current location".
7. **Safety organisations and experienced solo travelers say the same thing:** don't share your
   exact location or accommodation; post after you leave [SA1][SA5][SA6]. German police add: post
   holiday photos only after you are home, because posts tell burglars the home is empty [SA7].
8. **Recommended default ("Friends & family"):**
   - invite-only site with personal links and approval-based "request access";
   - silent per-follower revocation;
   - a 24 h delay plus "place names only after she has moved on";
   - no "here now" chip, no coordinates, no planned return date;
   - first name only, no public portrait;
   - a contact form inside the site (messages attributed to the invite), plus a "request access"
     form outside;
   - a panic button that works even when the home backend is offline;
   - a per-follower access log.

   Details in §8. Several cheap fixes (P0) need almost no code and should land before real travel
   content goes live.

---

## 1. Roles and assumptions

| Role | Who | Notes |
|---|---|---|
| Traveler | The young woman whose WhatsApp statuses are archived | The data subject. Her safety is the goal. |
| Owner / operator | Runs the backend and admin PWA ("the owner") | May or may not be the traveler. If not, see §4.6. |
| Followers | Friends and family she wants to share with | Must stay happy: one tap to open, no passwords to remember. |
| Attackers | §4 | Five profiles from the brief, plus one sub-case and an insider note. |

The current design promise is that the site works on **any static host**. Real access control
needs something that runs on each request (Apache rules, PHP) or client-side encryption. §7 marks
which levers keep or break that promise.

---

## 2. What the site gives away today (exposure inventory)

Found in the repo as of 2026-11-20 (uncommitted working tree included).

| # | Exposure | Where | Why it matters |
|---|---|---|---|
| E1 | **Instant publishing is the default** (`publish.mode: 'instant'`; `delayed` is an option with `delay_minutes: 720`, i.e. 12 h) | `packages/contracts/src/api.ts:339-341` | A status appears on the site about a minute after she posts it (PLAN phase 1 goal). |
| E2 | **"Here now" / "Now in <place> · <relative time>" chip** on the newest day while its last moment is < 48 h old | `frontend/site/src/components/decor.tsx:66-70`, `site-header.tsx:289` | States her current city and how many minutes ago. It falls back to the day title if no place is set. With a delay it would wrongly say "Now". |
| E3 | **Exact timestamps per entry** (`at`, ISO UTC with ms, plus `tz`); `firstAt`/`lastAt` per day | `packages/contracts/src/site.ts:169, 248-249` | Shows her daily rhythm (when she wakes, when she's back at the hostel) and which zone she is in. |
| E4 | **Full-precision day coordinates** (`lat`/`lng`) in `data/days/<date>.json` when the owner sets them, although the site UI never shows them | `site.ts:291-292`, `backend/src/generator/model.ts:419-420`, admin `screens/days.tsx` | If the owner pins the hostel, its exact point is published in the JSON. |
| E5 | **Place and country per day** in `timeline.json`, in the pre-rendered home HTML, and in day pages | `site.ts` DaySummary, `backend/src/generator/pages.ts:603` | Shown for the newest day too; readable without JS. |
| E6 | **Media content** (photos, videos with sound, voice statuses, captions verbatim, text statuses) | pipeline + `site.ts` entries | Hostel signs, room numbers, key cards, boarding passes, street signs, views, station announcements, her voice. EXIF/GPS is stripped (`pipeline/image.ts:5`, `video.ts:66`), but the content isn't. |
| E7 | **Profile**: display name, greeting, portrait up to 640 px (wave in progress) | `site.ts` SiteProfile; settings `site.author/intro/avatar` | Lets people recognise her in person, and feeds face search to find her other accounts [C3]. |
| E8 | **Trip date ranges as configured** (planned end date) once a trip has its first public day | `model.ts:473-474, 488-489` | Shows her planned return date: her home stays empty until then, and someone could wait for her on arrival. |
| E9 | **Everything is plain JSON at predictable paths**: `timeline.json` lists every day; `manifest.json` is fetched `no-store` and can be polled at any rate; the site itself polls every 5 min | `site.ts` paths, `frontend/site/src/config.ts:13` | Scraping and "alert me when she posts" take a few lines of code. Static hosting has no rate limit. |
| E10 | **Link previews**: the home `og:image` is the newest day's cover | `pages.ts:608-619` | Pasting the link into a group chat shows her latest photo to everyone in the chat, and preview services cache it. |
| E11 | **Discovery**: `noindex` and no sitemap by default (good), but the hostname is descriptive and appears in Certificate Transparency logs [C5]; the Internet Archive does not honour robots.txt [C4] | `docs/HOSTING.md`, `pages.ts` | `noindex` only keeps polite search engines away. |
| E12 | **No quick way to take recent days back.** Switching publish mode never unpublishes ("a settings change never turns a public capture back to pending") | `packages/contracts/src/policy.ts:25` | In an emergency the owner has to hide items one by one. |
| E13 | **Owner notes and stories skip the delay** ("Posts carry their own visibility") | `policy.ts:33`, `model.ts:360` | A note like "Just checked into the cutest hostel in Hội An!" goes out at once even in delayed mode. |
| E14 | **Originals with GPS stay in the home archive** | `backend/src/pipeline/files.ts:15-22` | Correct and needed, but it is the richest data set. See §4.6. |
| E15 | **No record of who looks** | n/a | WhatsApp shows her who viewed a status; the site does not. |

The PLAN already names the risk ("Live location exposed by instant publishing → delayed mode is one
setting away; `noindex` by default", `docs/PLAN.md:466`). This document argues that both
mitigations are weaker than they look: E2–E5 and E13 leak even in delayed mode, and `noindex`
does nothing against someone who has the link.

---

## 3. When does harm happen? Freshness × precision

How dangerous a disclosure is depends on two things together: how fresh it is and how precise it is.

| Freshness ↓ / precision → | Country | Region / city | Venue (hostel, café, beach bar) or exact point |
|---|---|---|---|
| **Live (≤ 1 h)** | low | medium; **high in small towns** | **critical**: someone can show up now |
| **While she is still there** (hours to days) | low | medium | **high**: someone can fly in within 24 h |
| **After she has left** | very low | low | low (except places she returns to) |
| **Weeks later** | none | none | low; only patterns remain |

Some disclosures don't depend on freshness at all and need their own levers:

- **Identity:** name, face, voice.
- **Home is empty** and **return date**.
- **Recurring patterns:** the same café every morning, posting at sunset, and the trip direction,
  which hints at the next stop.

Takeaways:
- Delay attacks the rows and coarsening attacks the columns. You need both, because photos keep
  venue-level precision whatever the metadata says.
- The delay has to be longer than her stay at a venue, not a fixed number of hours. Backpackers
  often stay 2–4 nights, so a 12 h delay mostly lands in the "still there" row.

---

## 4. Attackers

Ratings: **L**ikelihood (for a young woman sharing with friends and family) and **I**mpact.

### 4.1 A stranger who found the link

- **How they get it:**
  - a follower posted it publicly (Instagram story, Facebook);
  - a group chat;
  - Certificate Transparency logs list the hostname [C5];
  - an archived copy [C4].
  - **Sub-case, and the most realistic one: someone she met on the road.** She gave the link to a
    guy from the hostel or tour. He is already in the same region.
- **What they learn today:**
  - first name, face (portrait) and voice;
  - "Now in <city> · 12 min ago" (E2);
  - venue from photos (E6), sometimes exact coordinates (E4);
  - her daily rhythm (E3), who she travels with, and whether she is alone;
  - her planned return date (E8).
- **Harm:**
  - an unwanted approach or showing up (the sub-case can do this the same day);
  - creepy contact-form messages (§4.5);
  - misuse of her photos (fake profiles, sexualised edits).
- **L/I:** low/medium for a truly random stranger (the site is `noindex`); **medium/high for the
  person she met on the road.**
- **Levers that work:** access control with approval, which stops the random stranger. Against
  the person she met on the road it fails if she invited him herself, so you also need
  departure-gated places, no live chip and revocation.

### 4.2 An obsessive acquaintance or ex-partner

- **Knows already:**
  - full name, face, home address, friends and family, habits;
  - perhaps keys to her flat, perhaps her passwords or her phone;
  - perhaps still in her WhatsApp contacts.
- **How they get in:**
  - a mutual friend forwards the link or shows the site;
  - her WhatsApp status, if she didn't exclude him;
  - knowing the owner's domain;
  - a fake "request access" ("Hi, I'm Anna from her climbing club").
- **What they learn today:** everything in 4.1, plus context only he can decode:
  - who she is with;
  - her mood (voice and text statuses);
  - which "new friend" appears in photos;
  - that her flat is empty until the return date (E8).

  He can read all of this without her knowing (E15).
- **Harm:**
  - flying in and showing up (most destinations are reachable within 24 h);
  - waiting at the airport or her door on the return date;
  - entering her flat while she's away;
  - intimidation ("Nice rooftop. Say hi to Tom.");
  - contacting people in her photos;
  - escalation of an existing stalking situation.
- **L/I:** this is the statistically most likely stalker profile [SA9]. **Impact: high to severe.**
- **Levers that work:**
  - Delay and departure gating, because they still work after he gets in.
  - No return date and no live chip.
  - Approval with out-of-band verification of unknown requesters.
  - Revocation with an access log, so a leak is noticed and shut.
  - A panic button.
  - Her own WhatsApp status audience (§8.5).
  - Access control alone is weak here.

### 4.3 Someone a legitimate follower forwards the link to

- **How:**
  - Grandma forwards a day link to her choir group;
  - an uncle posts it on Facebook;
  - a friend puts a lovely day on her Instagram story.

  The link preview shows the newest photo (E10).
- **What they learn:** everything (same as 4.1). Intent is usually harmless, but every forward
  widens the audience, and one shared link cannot be taken back without cutting off everyone.
- **Harm:** mostly indirect. The audience grows until it contains 4.1/4.2 people, and she loses
  control over who watches.
- **L/I:** **high/medium**. This is the most likely leak path for any family site.
- **Levers that work:**
  - personal links (each leak can be traced back);
  - device limits per invite;
  - "Shared personally with <name>" shown on the page (social deterrent);
  - no link previews on private pages;
  - approval for newcomers.

### 4.4 A determined person who scrapes everything

- **How:**
  1. Poll `data/manifest.json` every minute (E9).
  2. When the version changes, fetch `timeline.json`, the new day JSON and all media.
  3. Keep a permanent copy, including items the owner later hides. Hiding deletes the media from the
     host, not from the scraper's disk.
  4. Analyse the copy:
     - posting-time histograms (pattern of life);
     - AI or crowd photo geolocation [C2];
     - face search on the portrait and on photos [C3] to find her other accounts, surname, employer
       and home town.

  Online communities do this for each other on request [C3].
- **What they learn:** everything, permanently, as soon as it goes public, with alerts.
- **Harm:** mostly enables 4.2. It may be the ex himself, or a doxxing group. It also makes "hide"
  and "panic" useless for anything already published.
- **L/I:** low/high. It takes intent, but very little skill.
- **Levers that work:**
  - Delay. The scraper only gets what is public, so data is old when it arrives.
  - Coarse place and time for recent days.
  - Access control, so scraping needs a token. Then rate limits and logs per token make it visible,
    and revocation stops it.
  - Nothing helps after the fact.

### 4.5 A harasser using the contact form

Any of the above, using the new form.

- **Abuse patterns:**
  - insults, sexual messages, threats;
  - "I know where you are" intimidation;
  - **pretexting to get her location** ("I'm from the hostel, you left your passport, where are
    you now?", "I'm her cousin, I want to surprise her");
  - phishing links or malware;
  - flooding;
  - probing for reactions (does she read it, when does she answer, does content change right
    after);
  - pressuring an owner who is a parent to reveal things.
- **Harm:** fear and distress while abroad, leaks through replies, and wasted time. On the plus
  side, the form can also be a source of **evidence** (German criminal code § 238, stalking [L2]).
- **L/I:** medium/medium. Any public contact channel gets some abuse. It is targeted if 4.2 uses
  it.
- **Levers that work:**
  - only invited followers see the form, so every message is tied to an invite;
  - the public only sees "request access";
  - no auto-reply, no read receipts;
  - silent block (the sender still sees "sent");
  - a word-filter folder (like Instagram's Hidden Words [IG3]);
  - rate limits;
  - evidence export;
  - a firm rule: **never confirm her whereabouts in a reply.**

### 4.6 Note: the operator and the archive (insider)

The backend archive holds originals with GPS (E14). The admin sees pending and hidden items. The
observer number sees every status live. If the operator is not the traveler, she must keep control
herself:
- her own admin login and panic button;
- the knowledge that removing the observer number from her WhatsApp status audience stops capture
  at once;
- a say in who is invited.

Relationships change, and this has to be safe even then. The admin PWA is already hardened
(`docs/HOSTING.md` §9); a stolen owner phone with a live session is the main residual risk.

---

## 5. Prior art: how comparable products protect users

### 5.1 Polarsteps (travel tracker, about 23 M users)

- **Two levels of control:**
  - Account: "Who can follow me" defaults to **"Only people I accept"** for new accounts.
  - Trip: **Everyone / Followers / Only me**. New trips default to Followers.

  Public trips are visible even on private accounts [PS1][PS2] (excerpt).
- **No per-follower trip selection.** An accepted follower sees every non-"Only me" trip. Polarsteps
  suggests sending specific people a trip's secret link instead [PS5] (excerpt).
- **Secret links** open followers-only trips to anyone who has them. **The only way to cut off
  people who already have the link is to set the trip to "Only me"** [PS5] (excerpt). This is the
  weakness of shared capability links.
- **Live location:**
  - By default followers see "the little pulsing dot" (the same idea as our "here now" chip).
  - A "Live location" toggle hides it. Followers then see only published steps, and the route since
    the last step stays hidden.
  - "Travel Buddies" always see it.
  - There is also a **"hide start location"** option: a randomly placed circle around the start
    [PS3][PS4] (excerpt).
- **Removing followers:** in the app, via "Remove as follower" [PS5] (excerpt).
- **2026 incident** (Polarsteps' own statement of 4 Sep 2026 [PS6]; we did not read the Follow the
  Money article itself):
  - Through the public API, the journalists collected profile data at scale.
  - By following accounts that **auto-accepted followers**, they saw followers-only trips.
  - Polarsteps admitted weak API rate limiting and a weak secret-link feature.
  - It **expired all secret links (20 Aug 2026)** and **reset every profile to require follow
    approval**.
  - It removed home-town and photo metadata from its API and added options to **hide start, end and
    current locations**.

  Lesson: auto-accept, long-lived shared links and unthrottled machine-readable data are exactly the
  weak spots. Our site currently has the third, and would have the first two with a naive "secret
  URL".

### 5.2 FindPenguins (travel tracker)

- **Privacy per trip:** **Public / Followers / Close friends / Private.** Followers-only needs a
  login to check follower status. "Close friends" is a hand-picked list. **Single footprints or
  photos can be made private.** Protected trips can be shared via a private link. Planned footprints
  stay private [FP1][FP2] (excerpt).
- A third-party comparison says FindPenguins has a **configurable delay** before followers see the
  newest route points [FP3]. I could not confirm this in FindPenguins' own docs; treat it as
  unverified.

### 5.3 Instagram

- **Private account:** only approved followers see posts; others send a follow request [IG5]. A
  follower can be removed **without being told** (first tested in 2018) [IG6].
- **Close Friends:** stories go to a hand-picked list. **Adding or removing someone sends no
  notification** [IG1]. "Hide story from" excludes specific people, also silently [IG2].
- **Against unwanted contact:**
  - message requests from non-followers go to a separate folder;
  - **Hidden Words** filters offensive words and phrases, plus your own list, into a hidden folder
    without notifications. Meta says the filtering runs on the device [IG3][IG4].
  - Restrict and Block exist for accounts you are already connected to [IG3].
- **Instagram Map (Aug 2025):** a live-location-to-friends feature. Even though it was opt-in, it
  drew a strong backlash, especially from women worried about stalking. People were unsure whether
  they were sharing without meaning to [IG7]. Lesson: **live location must be obviously off,
  obviously opt-in, and limited to named people.**

### 5.4 Strava

- **Map visibility (formerly privacy zones):**
  - hide the start and end of activities by radius, around a saved address or anywhere;
  - or hide the whole map;
  - or set an activity to "Only you".

  For accounts older than 7 days, the **first and last 200 m are hidden by default**.
  Hidden parts show grey to the owner, so she can check them [ST1][ST2].
- **Research shows that fuzzing endpoints fails against repeated observations:**
  - USENIX Security 2018: 95.1 % of moderately active users who used privacy zones were at risk [ST4].
  - ACM CCS 2022: on 1.4 M Strava activities, the hidden location was found for **up to 85 %** of
    privacy zones, using distance metadata and street grids [ST3].
  - The Polar app exposed soldiers' homes through aggregated "private" data (Bellingcat 2018) [ST6].

  Lesson: **coarsening by blurring coordinates is weak. Leave data out entirely, or snap it to a
  coarse unit such as a city or region.**
- **Delayed upload:** I found no built-in "publish later" in Strava. The common practice is
  uploading manually later. Strava's live sharing, **Beacon**, goes **only to up to three safety
  contacts** by text link and **stops when the activity ends** [ST5] (excerpt).

### 5.5 Find My / Google Maps: live sharing done right

- **Apple Find My:**
  - you share with **specific people**, for an hour, until the end of the day, or indefinitely [AP2]
    (excerpt);
  - you can stop for one person or for everyone;
  - "Hide" pauses sharing until the next day;
  - Apple warns that **people may notice you stopped** [AP1].
  - **Safety Check → Emergency Reset** stops all sharing with all people and apps at once. Apple
    notes it **cannot** reach social media sharing [AP3] (excerpt).
- **Google Maps:** sharing goes to named accounts, for a chosen duration or "until you turn this
  off" [GM1] (excerpt).
- Lesson: **live location is a 1:1, named-person, time-limited, revocable feature.** It never
  belongs on a page with an open audience. The family's need to know "is she OK right now" is better
  served this way than by the site.

### 5.6 WhatsApp status (what the site replaces)

- **Audience options:** "My contacts", "My contacts except…", "Only share with…". Changing it
  doesn't affect statuses already posted [WA1] (excerpt).
- Statuses vanish after 24 h, and she sees who viewed them (unless the viewer turned off read
  receipts).

The site currently **removes all three protections**: the audience list, the 24 h limit and the
view list.

### 5.7 Lessons for On My Way

| Prior-art pattern | Seen in | Apply here |
|---|---|---|
| Followers by approval, never auto-accept | Polarsteps default, after the incident [PS6]; Instagram private [IG5] | "Request access" goes to the owner, who approves. No auto-approval. |
| Live location off by default; only for named people | Polarsteps toggle [PS3], Strava Beacon [ST5], Find My [AP1], Instagram Map backlash [IG7] | Remove the public "here now" chip. Live goes 1:1 outside the site. |
| Tier for a close circle | Instagram Close Friends [IG1], FindPenguins close friends [FP1], Polarsteps Travel Buddies [PS4] | Optional "close circle" tier later (§8.2). |
| Per-item hiding | FindPenguins private footprints [FP1], Instagram hide story [IG2] | Already exists (visibility override). Keep it one swipe away. |
| Silent removal | Instagram [IG1][IG6] | A revoked invite sees the same neutral page as a stranger. |
| Shared secret links are hard to revoke | Polarsteps [PS5][PS6] | Prefer personal links. If a shared link is used, rotate it. |
| Rate limits on machine-readable data | Polarsteps admitted gap [PS6] | Gate data files per token; throttle and log. |
| Blurring coordinates fails | Strava research [ST3][ST4] | Don't publish `lat`/`lng`. Snap places to city/region/country. |
| One-tap emergency reset | Apple Safety Check [AP3] | Panic button (§7, L9). |
| Filtered message folder | Instagram Hidden Words [IG3] | Filter contact-form messages into a folder, never delete them (evidence). |

---

## 6. What safety organisations and travel writers advise

- **Government of Canada, advice for women travellers [SA1]:**
  - "Choose carefully what you post online, and avoid sharing your exact location on social media."
  - "Keep information about your accommodations private."
  - Share your plans with family or friends privately.
- **US State Department, women travelers [SA3]** (excerpt): "Don't tell strangers where you are
  staying."
- **Australia, Smartraveller [SA2]** (excerpt): social media posts can reveal your location;
  consider changing how you post and raising privacy settings while travelling.
- **eSafety Commissioner (Australia) [SA4]** (excerpt): almost any platform that lets you share
  content can reveal your location, and features like check-ins build a timeline "that may be used
  to monitor and track you".
- **Solo Female Travelers (community of women travelers) [SA5]:**
  - "Post content online after you have left a place so nobody can show up looking for you."
  - The authors share everything about **2–3 days after leaving**.
  - Posting while away can also signal that your home is empty.
- **Explore.com [SA6]** (excerpt): wait until you've moved on before sharing a location online, even
  without geotags.
- **German and Austrian police, via press [SA7]** (excerpt):
  - post holiday photos only once you are home;
  - offenders use social networks to find empty homes and absence periods;
  - Vienna police say burglars name social media as their source in interrogations.
- **NNEDV Safety Net, guidance for app developers [SA8]** (excerpt):
  - settings should **default to privacy** so users don't have to dig for protection;
  - design must consider survivors who need to keep an abuser from finding their location;
  - telling survivors to log off doesn't stop abuse; make the tools safe to use instead.
- **SPARC (Stalking Prevention, Awareness, and Resource Center) [SA9]:** most victims know their
  stalker (40 % intimate partner, 42 % acquaintance; US data).
- **Krebs on Security [SA10]:** never post boarding passes. The barcode contains the booking
  reference, which together with the surname opens the booking. The same caution applies to hotel
  key cards and booking screens.
- **Cases that show what photos reveal:**
  - In 2019 a man found a Japanese idol's station from a reflection in her eyes in a selfie, waited
    for her and assaulted her [C1].
  - In January 2025, 404 Media reported members of the public asking the AI tool GeoSpy to help find
    specific women from photos without metadata. Public access was closed after the report [C2].

The consensus fits our levers:
- post after you leave;
- never name the accommodation;
- default to private;
- share live location only with trusted people, 1:1.

---

## 7. Mitigation levers, rated

**Protection** columns rate each lever against the attackers in §4:
- A1 stranger (including someone she met on the road);
- A2 ex or acquaintance;
- A3 forward recipient;
- A4 scraper;
- A5 contact-form harasser.

Scale: **H** high, **M** medium, **L** low, **–** none.

**Cost** is friction for legitimate followers. **Build** is effort on this stack:
- "none" = a setting;
- "S" = days;
- "M" = a feature;
- "L" = architectural.

### 7.1 Overview

| # | Lever | A1 | A2 | A3 | A4 | A5 | Cost to followers | Build | Keeps "any static host"? |
|---|---|---|---|---|---|---|---|---|---|
| L1a | Fixed delay 12 h (exists) | M | L | M | L | – | low | none | yes |
| L1b | Fixed delay ≥ 48–72 h | H | M | H | M | – | medium (feels less "live") | none | yes |
| L2 | **Departure-gated release** ("post after you leave") | H | M–H | H | M–H | – | low–medium | M | yes |
| L3a | Remove public "here now" / "Now in · N min ago" chip | M | L | M | L | – | low | S | yes |
| L3b | Recent days country/region-only until she has left | M | M | M | M | – | low | M | yes |
| L3c | Never publish `lat`/`lng` | L | L | L | M | – | none (UI doesn't use them) | S | yes |
| L3d | Coarse times for recent days (part of day, not 14:37:12) | L | M | L | M | – | low | M | yes |
| L4 | Identity and detail hygiene (first name only, no public portrait, no return date, owner review checklist, no boarding passes/key cards, no address in a legal notice) | M | L–M | M | M | – | low (owner effort) | S | yes |
| L5a | Unguessable URL ("secret link") | M | L | L | L | L | none | S | yes |
| L5b | One shared password | H | L–M | M | M | M | low–medium | M | depends (see 7.2) |
| L5c | **Personal invite links** (token per person/household) | H | M | M | M | H | low (one tap) | M–L | no (needs Apache/PHP) or encryption |
| L5d | **Approval-based "request access"** | H | M | H | M | M | medium (wait for approval) | M | needs API (exists) |
| L6 | **Per-follower silent revocation** | M | M | M | M | M | none | S on top of L5c | as L5c |
| L7a | Device limit per invite (e.g. 3), more on request | – | M | M–H | L | – | medium (family iPads) | M | as L5c |
| L7b | "Shared personally with <name>" label | – | L | M | – | – | none | S | as L5c |
| L7c | No link previews (`og:*`) on private pages | L | – | M | – | – | low (plain link in chats) | S | yes |
| L7d | Per-follower watermarks in media | – | L | M | L | – | none | L (breaks content addressing) | no |
| L8 | **Access log for the owner** (per invite: last seen, devices, anomalies) | L | M | M | M | M | none (privacy notice) | M | as L5c |
| L9a | **Panic: "hide the last 14 days"** | H* | H* | H* | L | – | high while active | M | partly |
| L9b | **Panic: "go private now"** | H* | H* | H* | L | M | high while active | M | partly |
| L10 | **Contact-form hardening** (followers-only, filters, silent block, evidence, no auto-reply) | – | – | – | – | H | low | M | needs API (exists) |
| L11 | Close-circle tier (fresh for a few, delayed for the rest) | (enabler) | | | | | low | L | as L5c |
| L12 | Discovery hygiene (`noindex`, no sitemap, robots, `noarchive`, neutral hostname) | L | – | – | – | – | none | done / S | yes |

\* For future exposure only. Nothing recalls what was already seen, screenshotted, scraped,
previewed or archived.

### 7.2 Notes per lever: what it does, how it fits, what it does NOT do

**L1 Time delay (exists: `publish.mode = delayed`).**
- Does: removes the "live" row of §3 for captures.
- Does NOT:
  - help while she stays longer than the delay (12 h vs a 3-night stay);
  - hide patterns, identity, return date or recurring places;
  - stop people in her WhatsApp status audience, who see everything live anyway.
- Gaps on this stack:
  - Owner posts skip it (E13). Fix: posts follow the same delay unless the owner explicitly taps
    "publish now".
  - With a delay, the "here now" chip would call 24-hour-old content "Now in…" (E2). Rename it or
    remove it.
- Cost: family loses the "she's fine right now" feeling. That need is better met by 1:1 sharing
  (§5.5).

**L2 Departure-gated release ("post after you leave").**
- Does:
  - A day's media and place become public only once she has **moved on**: a later day with a
    different place is public, or the owner taps "she has left <place>". A cap such as 7 days stops
    a long stay from holding everything back forever.
  - The newest published place is then by design **not** her current place.
  - It adapts: short stays mean short delays.
  - It is exactly the advice from [SA1][SA5][SA6].
- Does NOT:
  - hide the trip direction, so the next stop can sometimes be guessed;
  - hide a long silence ("nothing new for 5 days, she's still somewhere new");
  - hide recurring places.
- Build:
  - a new rule in `policy.ts` and the PHP mirror, with shared vectors;
  - it depends on the owner setting places per day (manual today), or on a "moved on" tap.
  - A simpler variant: fixed delay **plus** L3b for the newest place.

**L3 Location coarsening.**
- **L3a** removes the explicit "she is here now" signal. Cheap, and important for casual viewers.
  Against A2/A4 it is weak, because the photos still show the place.
- **L3b** shows recent days as country (or region) until the departure gate passes; the city or
  place name appears afterwards. Useful mainly against readers of text and metadata. Photos still
  leak venue-level detail (cases [C1][C2]), so L3b without L1/L2 is weak.
- **L3c** stops publishing `lat`/`lng`. Today they sit in day JSON and no UI uses them. Do not fuzz
  them as Strava and Polarsteps do; repeated observations defeat fuzzing [ST3][ST4].
- **L3d:**
  - For days inside the gate, publish only the order of moments and a part of the day ("morning",
    "evening"), not the exact `at`. Also round `firstAt`/`lastAt`.
  - This makes pattern-of-life analysis harder.
  - It is a contract change: `at` is `IsoUtc` today, so `contractVersion` must be bumped.
  - The `tz` of entries also reveals the region (e.g. `Asia/Ho_Chi_Minh`). That is acceptable at
    country level.
- Does NOT: hide anything in the picture, the sound or the caption.

**L4 Identity and detail hygiene.**
- EXIF/GPS stripping already exists.
- Add:
  1. **First name or nickname only**, never a surname; check the site title and OG tags as well.
  2. **Portrait only behind access control**, small and optional. An illustration or a photo without
     a clear frontal face reduces face-search matches [C3].
  3. **Hide a trip's planned end date until it has passed** (E8). Show the range as "since 3 Nov"
     while the trip is running.
  4. An **owner review checklist** in the inbox: hostel or hotel names, room numbers, key cards,
     boarding passes and booking screens [SA10], street signs, house numbers, reflections, other
     people's faces, background audio (station announcements). Review mode exists; in delayed mode
     the owner has the delay window to hide.
  5. **No legal-notice (Impressum) page with a home address.** A strictly private, family-purpose
     site is exempt under § 18 (1) of the German Interstate Media Treaty (MStV). A public site with
     a contact form is a grey area, and the exemption is read narrowly [L1]. This is not legal
     advice, but it is one more reason to keep the site private.
  6. Ask companions before publishing their faces, both for their safety and because of GDPR.
- Does NOT: protect against A2 on identity, since he already knows her. It reduces what A1, A3 and
  A4 can link to the rest of her life.
- Cost: owner time. Followers see nothing missing.

**L5 Access control.**
- **L5a, secret URL** (e.g. the site under `/j/<random>/`):
  - Cheap and keeps static hosting.
  - Stops discovery via the hostname (CT logs [C5]) and random visitors.
  - Does nothing once the link is forwarded.
  - Revoking it means rotating the link for everyone. That is the Polarsteps lesson [PS5][PS6].
- **L5b, one shared password.** Three ways to build it:
  1. *HTTP Basic auth* via `.htaccess` (Apache only). Ugly browser prompt on phones.
  2. *Client-side encryption* in the style of StatiCrypt [C6]. Works on any host, but brute force
     can run offline against the downloaded file, and encrypting media means decrypting into blob
     URLs, which loses `<picture>`, native lazy loading and video streaming.
  3. *A cookie gate* (see L5c).

  People forward the password with the link. Revoking it means changing it for everyone.
- **L5c, personal invite links:**
  - Each person or household gets a link with a token. Opening it sets a long-lived cookie.
  - Every request for HTML, `data/*` and `media/*` checks the cookie.
  - The link is one tap from WhatsApp and needs no password.
  - Implementation on the current host:
    - Apache 2.4 can check a cookie against a generated allow-list with `Require expr` in
      `.htaccess` [C7], **or** a small PHP gate can do it on the same Hetzner account.
    - Either way the backend generates the list and revocation is a redeploy.
    - The `.htaccess` route must be verified on the live Apache before relying on it.
  - **This ends "any static host"** unless client-side encryption is used with a content key
    wrapped per invite. That is heavy for media.
  - Media names are content hashes and can't be guessed, so the JSON is the main gate. But a
    revoked person keeps any media URLs already fetched until those files are deleted.
- **L5d, approval-based requests:**
  - A public "Request access" form (name, how do you know her, message) goes to the admin inbox.
    The owner approves, and the requester gets a personal link.
  - This is what Polarsteps went back to after the incident [PS6].
  - Does NOT stop A2 posing as someone else. Rule: **unknown names get verified through a known
    channel** (ask her, call the aunt).
- **Overall:** access control mainly stops A1 and A3. Against A2 it only works together with
  approval, revocation and the log.

**L6 Per-follower revocation.**
- Do it silently: a revoked invite sees the same neutral "this journey is private" page as a
  stranger. Prior art: Instagram removal and Close Friends [IG1][IG6].
- Like Apple's warning [AP1], expect that people notice. Choose wording that doesn't escalate.
- Does NOT:
  - undo what was seen or saved;
  - stop a new request under another name (L5d and L8 help there);
  - help without per-person tokens.

**L7 Forwarding resistance.**
- **L7a, device limit per invite:**
  - Up to N devices (e.g. 3). One more device gives "ask <owner> to add this device", one tap in the
    admin.
  - Stops casual forwarding. A tech-savvy follower can still copy a cookie.
  - Cost: families with an iPad, a laptop and a phone (hence N = 3).
- **L7b, label "Shared personally with Uncle Tom"** in the footer:
  - A soft, free deterrent. Most people won't forward something visibly addressed to them.
- **L7c, no `og:image`/description on private pages:**
  - A pasted link no longer shows her newest photo in group chats (E10).
  - Cost: plainer chat previews.
- **L7d, per-follower watermarks:**
  - Every invite would need its own media variants, which breaks content addressing, caching and the
    disk budget.
  - **Not recommended.**
- **Honest limit:** nothing stops screenshots, screen recording, or a follower simply telling
  someone "she's in Hanoi".

**L8 Access log for the owner.**
- Per invite: first and last seen, number of devices, rough country (derived without storing full
  IPs), request rate.
- Flags:
  - a new device beyond the limit;
  - the manifest polled every minute;
  - three countries in a day;
  - an invite unused for months suddenly active.
- Purely **detection**, but it restores what WhatsApp's viewer list gave her (E15).
- Without per-person tokens, a log of anonymous IPs is close to useless (VPNs) and still personal
  data.
- GDPR: legitimate interest (security), a short privacy note, ~30 days retention, truncated IPs.
  The log itself is sensitive (it shows who follows her), so keep it in the API's `var/`.
- Does NOT: identify a person using someone else's valid link. It shows them as that follower.

**L9 Panic button.**
- Two actions:
  1. **"Hide the last 14 days"**: an embargo window. Days from today−14 on are not public, and the
     newest place is removed. Undo is explicit.
  2. **"Go private now"**: every page and data file answers with the neutral landing page, and all
     invites are suspended until the owner resumes.
- Requirements:
  - **It must work while the home backend is down** (Mac asleep, Docker stopped). The normal path is
    admin → API → change feed → backend → SFTP, and that path needs the Mac to be up.
  - Options for a direct switch on the site host, to be verified:
    - a pre-installed `.htaccess` rule that answers 403 or the landing page when a flag file exists;
    - flipping that flag directly from the API, if both subdomains share one Hetzner account and
      filesystem (not verified);
    - otherwise a tiny PHP endpoint on the site host.
  - The backend later removes the data properly.
  - **Both the owner and the traveler** must be able to trigger it. That means her own login, or a
    deliberately simple trigger.
  - Needs a new policy rule. Today mode switches never unpublish (E12).
- Does NOT:
  - recall scraped copies, browser caches, link-preview caches or Internet Archive captures [C4];
  - stop her WhatsApp contacts.

  A post-panic checklist in the admin should cover: review invites and the log, request removal from
  archives, and tell the close circle through a private channel.

**L10 Contact-form hardening** (the form itself is designed elsewhere in this wave; these are the
threat-driven requirements):
1. **Placement:** the "Write to <first name>" button is shown to invited followers inside the site,
   and messages carry the invite ID. The public landing page only offers "Request access" with a
   message field.
2. **Delivery:** messages go to the admin inbox. Notifications (ntfy/e-mail) say only "new message",
   so a lock screen doesn't show threats. They never go to her personal number or address, and there
   is **no auto-reply**, no read receipt, no "she has seen it".
3. **Silent block** per invite or per sender fingerprint: the sender still sees "sent".
4. **Filter folder:** messages matching a word list (built-in plus the owner's own) land in a hidden
   folder, never deleted. This mirrors Instagram Hidden Words [IG3][IG4].
5. **Rate limits** per invite and IP, a honeypot field, a length cap, no attachments, links shown
   as plain text.
6. **Evidence export** (timestamped, including headers) for police. In Germany: § 238 StGB
   Nachstellung [L2], help line "Gewalt gegen Frauen" 116 016 [L2].
7. **Reply policy:** reply from a neutral address, if at all, and **never confirm where she is or
   when she'll be somewhere**. This counters pretexting.

- Does NOT: stop harassment through her other channels (Instagram, WhatsApp).

**L11 Close-circle tier.**
- A handful of named people (parents, a sibling, a best friend) get fresh, place-named content.
  Everyone else gets the delayed, coarse version.
- Prior art: Instagram Close Friends, FindPenguins close friends, Polarsteps Travel Buddies.
- Build: two data builds or per-tier gating. It is the most expensive lever here.
- Worth it only if the family really misses near-live updates. 1:1 live sharing (§5.5) is the
  simpler answer.

**L12 Discovery hygiene.**
- Keep `noindex` and no sitemap. Add `X-Robots-Tag: noindex, noarchive` on Apache.
- Use a neutral hostname or path when moving to production. The current one is in CT logs [C5].
- Does NOT stop anyone who has the link. The Internet Archive does not honour robots.txt [C4].

---

## 8. Recommendation: privacy-minded, friends-and-family-friendly default

### 8.1 The default profile ("Friends & family")

| Area | Default | Why |
|---|---|---|
| Who can see | **Invite-only.** The public URL shows a soft, neutral landing page: site title, "This journey is shared with friends and family", and a **Request access** button. No name, portrait, places, photos or OG image for the public. | Stops A1 and A3. Prior art: Polarsteps after 2026 [PS6], Instagram private [IG5], NNEDV privacy-by-default [SA8]. |
| How followers get in | **Personal invite links** created in the admin PWA and shared via the phone's share sheet (WhatsApp). One tap, no password. Cookie lasts 12 months. **Up to 3 devices** per invite, more by one-tap approval. Footer: "Shared personally with <label>". | Friendly for family; forwarding becomes traceable and discouraged (L5c, L7a, L7b). |
| Strangers who want in | **Request access → owner approves.** Never auto-approve. Unknown names are checked with the traveler or through a known channel. | L5d; the Polarsteps auto-accept lesson. |
| Removing someone | **Silent revocation.** They see the same landing page as a stranger. | L6. |
| Freshness | **`delayed`, 24 h**, replacing `instant` as the default. **Notes and stories follow the same delay** unless "publish now" is tapped, with a warning. Later (L2): release a day only once she has moved on (cap 7 days). | "Post after you leave" [SA1][SA5][SA6]; E1, E13. |
| Place precision | The newest day(s) show **country only** ("Latest from 🇻🇳 Vietnam · yesterday") until a later day with another place is public. The city appears afterwards. **No "here now" chip** on the public or invite tier. | §3; E2, E5; Polarsteps live-location toggle [PS3]. |
| Never published | `lat`/`lng`; a planned trip end date before it has passed; surname; exact `at` for days inside the gate (part of day instead, phase P3). | E3, E4, E8; Strava research [ST3]. |
| Identity | First name only. The portrait appears only inside the invite tier, small. Avoid a clear frontal face, or use an illustration. | E7; face search [C3]. |
| Contact | Inside: an obvious **"Write to <first name>"** button for invited followers. Outside: only "Request access" with a message. Admin inbox, filter folder, silent block, rate limits, no auto-reply, evidence export, "never confirm her whereabouts". | Meets the owner's wish for an obvious contact button without opening a public harassment channel (L10). |
| Emergency | **Two panic buttons**, "Hide the last 14 days" and "Go private now", for **both owner and traveler**. They work while the home backend is offline (flag on the site host). Undo is explicit. | L9; Apple Safety Check [AP3]. |
| Awareness | **Access log per invite** (last seen, devices, anomaly flags), 30 days, truncated IPs, privacy note. | L8; restores the WhatsApp viewer list (E15). |
| Discovery | Keep `noindex`; add `noarchive`; no OG on private pages; neutral production hostname or path. | L7c, L12. |

What followers experience:
- They tap a link once in WhatsApp and land in the same lovely timeline.
- What they see is about a day behind, and the newest stop shows as a country.
- They can write to her with one tap.
- Nothing to remember, no passwords.

### 8.2 Presets for the admin settings screen

| Preset | Audience | Freshness | Place precision | Use when |
|---|---|---|---|---|
| **Friends & family** (recommended default) | invite + approval | 24 h delay; later "after she left" | country while there, city after | normal travel |
| **Close circle live** (optional tier, phase P3) | a few named people | instant | city | parents want near-live updates and the traveler agrees |
| **Open travel blog** | anyone with the URL (`noindex`) | ≥ 7 days or after the trip | city | trips that are over; never for the current trip |

If the owner keeps `instant` for the main audience, the **minimum** is:
- invite-only;
- no here-now chip;
- country-only for the newest place;
- no coordinates and no return date;
- notes follow the same rules;
- the owner reviews photos for venue names.

Even then, an invited bad actor gets her city live. The admin should say so plainly next to the
setting.

### 8.3 Phased rollout (cheapest protection first)

| Phase | Contents | Needs |
|---|---|---|
| **P0, before real travel content goes live** | Default to `delayed` 24 h. Notes and stories follow the delay. Remove the here-now and "Now in" chips (or reword them to "Latest from <country>"). Stop publishing `lat`/`lng`. Hide the trip end date until it has passed. First name only. No public portrait. No Impressum with an address. | Small generator, contract and site changes. Owner settings. |
| **P1** | Invite links, request access with approval, silent revocation, neutral landing page, no OG on private pages, contact form inside the site (attributed) and request form outside. | Gate on the site host (Apache rules or a PHP gate). API endpoints for invites and requests. Admin screens. |
| **P2** | Panic buttons (backend-independent), access log with anomaly flags, device limit. | Flag mechanism on the site host. API log. |
| **P3** | Departure-gated release, coarse times for recent days, optional close-circle tier. | Policy rule plus PHP mirror and vectors. `contractVersion` bump. Second data build for the tier. |

### 8.4 What this combination still does NOT protect against (residual risk)

- **An invited person who is or becomes the threat**, until the owner notices and revokes. They see
  everything up to yesterday (or up to her last stop, with P3).
- **Screenshots, screen recordings and retelling** by any follower.
- **Her WhatsApp status audience.** Anyone who sees her statuses on WhatsApp sees them live. The
  site cannot fix this (§8.5).
- **Photo content when she stays longer than the delay**, until the departure gate (P3) exists. Only
  owner review helps meanwhile.
- **A predictable route** (the next stop on a classic backpacker loop).
- **Anything already copied** before a hide or a panic (scrapers, caches, link previews, archives).
- **Harassment on her other channels** (Instagram, e-mail, phone).
- **The operator and the home archive** (originals with GPS) if they are compromised or the
  relationship changes (§4.6).

### 8.5 Outside the site: a short checklist for the traveler

1. **WhatsApp → Settings → Privacy → Status:** use "My contacts except…" or "Only share with…" to
   exclude anyone she wouldn't want watching [WA1]. The **observer number must stay included**,
   otherwise capture stops. That is also her instant off-switch for capture.
2. **Real-time "I'm OK":** share live location 1:1 with one or two trusted people (Find My, Google
   Maps, WhatsApp live location) for a limited time [AP1][GM1]. Don't use the site for this.
3. **Before leaving:** run iPhone **Safety Check** or the Google equivalent. Old partners often still
   have location sharing or shared albums from the relationship [AP3].
4. **Never photograph:** boarding passes, key cards, booking confirmations, room numbers [SA10].
5. **If someone frightening shows up online:** don't engage, keep evidence (the admin export), and
   get help. In Germany: police (§ 238 StGB), Hilfetelefon 116 016 [L2].

---

## 9. Open questions for the owner

1. **Is the owner the traveler?** If not, does she get her own admin login and panic button, and
   does she approve invites?
2. **Is any public part wanted at all** (strangers reading along), or is it only for friends and
   family? This decides whether the public landing page shows anything beyond "request access".
3. **Who really needs near-live updates?** Would 1:1 location sharing to parents cover it, so the
   site can stay delayed for everyone?
4. **Host lock-in:** is relying on Apache/PHP at Hetzner for access control acceptable? The
   alternative is keeping "any static host" via client-side encryption, which is much heavier for
   media.
5. **How long does she usually stay in one place?** This calibrates the delay and the cap for the
   departure gate.
6. **Who reads contact messages:** the owner, the traveler, or both? Who answers, and from which
   address?

---

## 10. Sources

Retrieved 2026-11-20. "(excerpt)" = the page blocked automated fetching (HTTP 403 or timeout), so
the claim is based on search-result excerpts of that page.

**Prior art**
- [PS1] Polarsteps Help: Who can see my Polarsteps account and trips: https://support.polarsteps.com/hc/articles/24267891448850-Who-can-see-my-Polarsteps-account-and-trips (excerpt)
- [PS2] Polarsteps Help: What is a follower and can anyone become my follower: https://support.polarsteps.com/hc/en-us/articles/24268053797010-What-is-a-follower-and-can-anyone-become-my-follower (excerpt)
- [PS3] Polarsteps Help: Hide your live location on Polarsteps: https://support.polarsteps.com/hc/articles/34424572094482-Hide-your-live-location-on-Polarsteps (excerpt)
- [PS4] Polarsteps Help: Who can see my location on Polarsteps: https://support.polarsteps.com/hc/en-us/articles/38644843536018-Who-can-see-my-location-on-Polarsteps (excerpt)
- [PS5] Polarsteps Help: How can I remove a follower: https://support.polarsteps.com/article/91-how-to-i-delete-a-follower ; How do I share my trip: https://support.polarsteps.com/article/95-how-do-i-share-my-trip-with-others (excerpt)
- [PS6] Polarsteps: Statement on Follow the Money (4 Sep 2026): https://www.polarsteps.com/comment-follow-the-money (fetched)
- [FP1] FindPenguins Help: Privacy of trips and footprints: https://support.findpenguins.com/hc/en-us/articles/360013804914-Privacy-of-trips-and-footprints (excerpt)
- [FP2] FindPenguins Help: My followers cannot see my trip or posts: https://support.findpenguins.com/hc/en-us/articles/360022456174-My-followers-cannot-see-my-trip-or-posts (excerpt)
- [FP3] travelhighlights.io: FindPenguins vs Polarsteps (third party; the delay claim is unverified): https://travelhighlights.io/travel-apps/findpenguins-vs-polarsteps/ (fetched)
- [IG1] Instagram Help: Create a Close Friends list: https://help.instagram.com/android-app/476003390920140
- [IG2] Instagram Help: Hide your story from people: https://help.instagram.com/iphone-app/1177797265575168
- [IG3] Instagram Help: Hidden message requests / hide offensive message requests: https://help.instagram.com/iphone-app/194599462478093 ; https://help.instagram.com/iphone-app/700284123459336
- [IG4] Instagram: Introducing new tools to protect our community from abuse (2021): https://about.instagram.com/blog/announcements/introducing-new-tools-to-protect-our-community-from-abuse
- [IG5] Childnet: Privacy settings on Instagram, FAQs: https://www.childnet.com/blog/privacy-setting-on-instagram-answering-some-faqs
- [IG6] The Next Web (2018): Instagram lets you remove followers without them knowing: https://thenextweb.com/news/instagram-feature-remove-followers
- [IG7] NBC News (Aug 2025): Instagram's Map feature raises privacy concerns: https://www.nbcnews.com/tech/tech-news/instagram-maps-feature-raises-privacy-concerns-some-users-rcna223706 ; Engadget: https://www.engadget.com/social-media/adam-mosseri-says-people-are-confused-about-how-the-instagram-map-works-184736070.html
- [ST1] Kaspersky: How to set up security and privacy in Strava: https://www.kaspersky.com/blog/running-apps-privacy-settings-part2-strava/52409
- [ST2] DC Rainmaker (Aug 2021): Strava privacy features: https://dcrainmaker.com/2021/08/privacy-features-options.html
- [ST3] Dhondt, Le Pochat, Voulimeneas, Joosen: "A Run a Day Won't Keep the Hacker Away: Inference Attacks on Endpoint Privacy Zones in Fitness Tracking Social Networks", ACM CCS 2022: https://lepoch.at/files/epz-inference-attacks-ccs22.pdf
- [ST4] Hassan, Hussain, Bates: "Analysis of Privacy Protections in Fitness Tracking Social Networks", USENIX Security 2018: https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-hassan_0.pdf
- [ST5] TechRadar: Strava Beacon now free for everyone: https://www.techradar.com/news/one-of-stravas-most-important-tools-is-now-free-for-everyone (excerpt)
- [ST6] Bellingcat (2018): After Strava, Polar is revealing the homes of soldiers and spies: https://www.bellingcat.com/resources/2018/07/08/strava-polar-revealing-homes-soldiers-spies/
- [AP1] Apple Personal Safety Guide: manage location sharing in Find My: https://support.apple.com/guide/personal-safety/ips05ede4573/web (fetched)
- [AP2] Apple Support: Share your location with iPhone: https://support.apple.com/en-by/105104 (excerpt)
- [AP3] Apple Personal Safety Guide: How Safety Check works: https://support.apple.com/guide/personal-safety/how-safety-check-works-ips2aad835e1/web (excerpt)
- [GM1] Google Maps Help: Share your real-time location: https://support.google.com/maps/answer/7326816?hl=en (excerpt)
- [WA1] WhatsApp Help: How to change your privacy settings: https://whatsapp.com/faq/en/android/23225461 ; Consumer Reports: How to use WhatsApp privacy settings: https://www.consumerreports.org/privacy/how-to-use-whatsapp-privacy-settings-a5254545737/ (excerpt)

**Safety advice**
- [SA1] Government of Canada: Advice for women travellers: https://travel.gc.ca/travelling/health-safety/women-travellers (fetched; quotes verbatim)
- [SA2] Smartraveller (Australia): https://smartraveller.gov.au/node/90 (excerpt)
- [SA3] U.S. Department of State: Women travelers: https://travel.state.gov/content/travel/en/international-travel/before-you-go/travelers-with-special-considerations/women-travelers.html (excerpt)
- [SA4] eSafety Commissioner: Location sharing: https://www.esafety.gov.au/key-topics/online-tools-and-features/location-sharing (excerpt)
- [SA5] Solo Female Travelers Club: Solo female travel tips: https://www.solofemaletravelers.club/solo-female-travel-tips (fetched; quotes verbatim)
- [SA6] Explore.com: Safety tips for women traveling alone: https://www.explore.com/travel/safety-tips-women-traveling-alone/ (excerpt)
- [SA7] PC-Welt: Polizei rät: So schützen Sie Ihr Zuhause während des Urlaubs: https://www.pcwelt.de/article/3176457/polizei-raet-so-schuetzen-sie-ihr-zuhause-wahrend-des-urlaubs.html ; ORF Wien: Facebook: Einbrecher lesen mit: https://wien.orf.at/v2/news/stories/2596528/ (excerpt)
- [SA8] NNEDV Safety Net: Considerations for app developers: https://www.techsafety.org/considerations-app-developers ; For technologists: https://www.techsafety.org/for-technologists (excerpt)
- [SA9] SPARC stalking fact sheets (40 % intimate partner, 42 % acquaintance): https://www.umt.edu/police/information-resources/stalking/sparc-futures-workplace-stalking-fact-sheet.pdf ; https://www.stalkingawareness.org/fact-sheets-and-infographics/ (excerpt)
- [SA10] Krebs on Security: What's in a boarding pass barcode? A lot (2015): https://krebsonsecurity.com/2015/10/whats-in-a-boarding-pass-barcode-a-lot/ ; Why it's still a bad idea to post or trash your airline boarding pass (2017): https://krebsonsecurity.com/2017/08/why-its-still-a-bad-idea-to-post-or-trash-your-airline-boarding-pass/

**Cases, capabilities, technology**
- [C1] The Register (Oct 2019): stalker used reflections in a pop idol's eyes: https://www.theregister.com/2019/10/10/stalker_japan_eyes ; NBC News: https://www.nbcnews.com/news/world/stalking-suspect-allegedly-studied-pop-idol-s-pupil-images-online-n1064916
- [C2] 404 Media (Jan 2025): The powerful AI tool that cops (or stalkers) can use to geolocate photos in seconds: https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/ ; Malwarebytes: https://www.malwarebytes.com/blog/news/2025/01/ai-tool-geospy-analyzes-images-and-identifies-locations-in-seconds
- [C3] Malwarebytes (Nov 2022): PimEyes accused of "surveillance and stalking on a scale previously unimaginable": https://www.malwarebytes.com/blog/news/2022/11/face-search-engine-pimeyes-accused-of-surveillance-and-stalking-on-a-scale-previously-unimaginable ; The Intercept (Jul 2022): https://theintercept.com/2022/07/16/facial-recognition-search-children-photos-privacy-pimeyes/
- [C4] Internet Archive blog (Apr 2017): Robots.txt meant for search engines don't work well for web archives: https://blog.archive.org/2017/04/17/robots-txt-meant-for-search-engines-dont-work-well-for-web-archives/
- [C5] Certificate Transparency info leaks: https://latedeployment.github.io/posts/certificate-transparency-info-leaks ; search tool: https://crt.sh/
- [C6] StatiCrypt: https://github.com/robinmoisson/staticrypt
- [C7] Apache HTTP Server 2.4: Expressions (`Require expr`, `%{HTTP_COOKIE}`): https://httpd.apache.org/docs/expr.html

**Legal (Germany; orientation only, not legal advice)**
- [L1] NLM Leitfaden Impressumspflicht 2024: https://www.nlm.de/fileadmin/dateien/pdf/leitfaden_impressumspflicht_2024.pdf ; e-recht24: Impressum für die private Homepage: https://www.e-recht24.de/impressum/13095-impressum-fuer-die-private-homepage.html (excerpt)
- [L2] § 238 StGB Nachstellung: https://www.gesetze-im-internet.de/stgb/__238.html ; Hilfetelefon Gewalt gegen Frauen (116 016): https://www.hilfetelefon.de/ (well-known references, not fetched in this session)
