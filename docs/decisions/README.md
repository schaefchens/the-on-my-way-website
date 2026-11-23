# Design notes and owner decisions

These are the working documents behind wave 5 (approval-only followers) and the traveler app.
Until 2026-11-23 they lived only in the git-ignored `.cache/`; they were moved here unchanged so
they survive a fresh checkout.
- **Authoritative:** `owner-decisions.md` in each folder. Where a document contradicts it, the
  decisions file wins.
- **Specs and research notes** are historical records, written by agents, reviewed and revised.
- **Left out on purpose:** the live host probe results. They contain absolute server paths; their
  conclusions are in [docs/HOSTING.md §11.4](../HOSTING.md).

## access-and-safety/ (wave 5)
| File | What |
|---|---|
| [owner-decisions.md](access-and-safety/owner-decisions.md) | D1–D12, the answers Q0–Q9, the wave split, additions (password change) |
| [spec-wave5.md](access-and-safety/spec-wave5.md) | The buildable spec, revision 2: API-only gate, store, cookies, data rights, work packages |
| [spec-wave5-review.md](access-and-safety/spec-wave5-review.md) | The skeptical review of the spec |
| [proposal.md](access-and-safety/proposal.md), [critique.md](access-and-safety/critique.md) | The earlier design proposal (gate on the site host) and its critique; partly superseded by Q0 b |
| [threats.md](access-and-safety/threats.md), [access.md](access-and-safety/access.md), [contact.md](access-and-safety/contact.md) | Research: threat model and prior art; access-control options; contact form, abuse protection, GDPR |

## traveler-app/
| File | What |
|---|---|
| [owner-decisions.md](traveler-app/owner-decisions.md) | A1–A5, Q1–Q11 (WhatsApp-compatible model, uploads, archive-only, …) |
| [app-plan.md](traveler-app/app-plan.md) | The phase plan, revision 2: scope, architecture, stack, milestones |
| [app-critique.md](traveler-app/app-critique.md) | The critique of the plan |
| [styling.md](traveler-app/styling.md), [stack.md](traveler-app/stack.md), [flow.md](traveler-app/flow.md), [ux.md](traveler-app/ux.md) | Research: WhatsApp status features and the data model; React Native stack; data flow; UX, motion and haptics |

Later decisions made directly in conversation (e.g. the package name `de.schaefchens.apps.onmyway`,
`WA_MODE=off`, the live backend started by hand, publishing app moments) are recorded in the
commit messages and in [docs/OPERATIONS.md](../OPERATIONS.md).
