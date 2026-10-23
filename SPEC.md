## Problem Statement

Organizing a Secret Santa gift exchange is cumbersome: organizers need to collect participant names, enforce "who can't give to whom" rules (e.g., siblings, partners, roommates), randomly assign gifters to receivers while respecting constraints, and securely share each person's assignment without revealing the full list. Existing tools either require email-based sign-up, don't support custom exclusion groups, or lack a simple way to distribute assignments via messaging apps like WhatsApp.

## Solution

A self-hosted Secret Santa web application where an organizer (authenticated via a shared admin password) can:

1. **Create events** with name, date, budget, and optional banner image (uploaded to Cloudinary)
2. **Add participants** with optional email reference and assign them to **event-scoped tags** (households/groups) — participants sharing any tag cannot give to each other
3. **Generate valid assignments** using a constrained derangement algorithm that respects all tag exclusions; if impossible, the system identifies the specific conflicting groups
4. **Distribute assignments** via magic links (short NanoID URLs like `/g/abc123xy`) — the organizer downloads a JSON/CSV export with all participant names, magic links, and assignments, then shares links manually via WhatsApp
5. **Participant view** — each magic link opens a public page showing only that person's assignment ("You're buying for **Name**"), the event budget, date, and banner image

No email infrastructure required. No real-time notifications. Runs locally via systemd + Cloudflare Tunnel.

## User Stories

1. As an **organizer**, I want to create a Secret Santa event with a name, date, and budget, so that I have a container for participants and assignments.
2. As an **organizer**, I want to upload a banner image for the event, so that participants see a festive header on their assignment page.
3. As an **organizer**, I want to add participants with their names (and optional email for my reference), so that I can build the gift exchange roster.
4. As an **organizer**, I want to create tags (e.g., "Smith Family", "Roommates") and assign them to participants, so that members of the same household/group cannot draw each other.
5. As an **organizer**, I want to generate Secret Santa assignments that respect all tag exclusions, so that no one gives to someone in their own group.
6. As an **organizer**, I want to see a clear error with specific conflicting groups if no valid assignment exists, so that I can adjust tags or participants and retry.
7. As an **organizer**, I want to download a JSON or CSV file containing every participant's name, email (if provided), magic link URL, and assigned recipient, so that I can distribute links via WhatsApp or any channel.
8. As an **organizer**, I want to protect the admin dashboard with a single shared password (from an environment variable), so that only trusted people can manage events.
9. As a **participant**, I want to open a magic link and see only my assignment (who I'm buying for), the event budget, date, and banner, so that the surprise is preserved for everyone else.
10. As a **participant**, I want the magic link to be a short, easy-to-share URL, so that it works well in WhatsApp messages.
11. As an **organizer**, I want to edit or delete events, participants, and tags before generating assignments, so that I can correct mistakes.
12. As an **organizer**, I want to view a list of all events I've created, so that I can manage multiple Secret Santa exchanges.

## Implementation Decisions

### Architecture
- **Framework**: Next.js 14+ (App Router) with TypeScript
- **Database**: SQLite via Prisma ORM (file-based, zero-config, suitable for single-season use)
- **Authentication**: Admin-only, stateless password check against `ADMIN_PASSWORD` env var; cookie-based session for `/admin/*` routes
- **Image Storage**: Cloudinary (signed upload from server, `secure_url` stored in DB)
- **Magic Links**: NanoID (8 chars, URL-safe) generated at assignment time, stored in `Assignment` table
- **Deployment**: Local systemd service + Cloudflare Tunnel (`cloudflared`)

### Data Model (Prisma)

```prisma
model Event {
  id          String       @id @default(cuid())
  name        String
  date        DateTime
  budget      Int          // in cents
  bannerUrl   String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  participants Participant[]
  assignments Assignment[]
  tags        Tag[]
}

model Participant {
  id        String       @id @default(cuid())
  name      String
  email     String?
  eventId   String
  event     Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  tags      Tag[]        // many-to-many via join table
  assignment Assignment?  @relation("Giver")
  received  Assignment?   @relation("Receiver")
}

model Tag {
  id            String        @id @default(cuid())
  name          String
  eventId       String
  event         Event         @relation(fields: [eventId], references: [id], onDelete: Cascade)
  participants  Participant[]
  @@unique([eventId, name])   // event-scoped tag names
}

model Assignment {
  id           String       @id @default(cuid())
  eventId      String
  event        Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  giverId      String       @unique
  giver        Participant  @relation("Giver", fields: [giverId], references: [id])
  receiverId   String       @unique
  receiver     Participant  @relation("Receiver", fields: [receiverId], references: [id])
  magicLink    String       @unique @default(nanoid(8))
  createdAt    DateTime     @default(now())
}
```

### Assignment Algorithm
- **Input**: List of participants with their tags for a given event
- **Constraint**: Participant A cannot give to Participant B if they share ≥1 tag; no self-gifting
- **Approach**: Constrained derangement via backtracking with constraint propagation
- **Failure Mode**: If no valid permutation exists, compute minimal conflicting tag groups (e.g., "Group X has 4 members, only 3 outsiders available → impossible") and return structured error
- **Output**: One `Assignment` row per participant with `giverId`, `receiverId`, and generated `magicLink`

### API Contracts

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/events` | GET | List all events (admin) |
| `/api/admin/events` | POST | Create event with optional banner upload |
| `/api/admin/events/[id]` | GET | Event detail with participants, tags, assignments |
| `/api/admin/events/[id]` | PUT | Update event (name, date, budget, banner) |
| `/api/admin/events/[id]` | DELETE | Delete event and all related data |
| `/api/admin/events/[id]/participants` | POST | Add participant |
| `/api/admin/events/[id]/participants/[pid]` | PUT/DELETE | Update/remove participant |
| `/api/admin/events/[id]/tags` | POST | Create tag for event |
| `/api/admin/events/[id]/tags/[tid]` | DELETE | Delete tag |
| `/api/admin/events/[id]/assign` | POST | Generate assignments (returns success or conflict details) |
| `/api/admin/events/[id]/export` | GET | Download JSON/CSV of all participants + magic links + assignments |
| `/api/upload` | POST | Cloudinary signed upload endpoint (returns upload params) |
| `/g/[magicLink]` | GET | Public participant view page |

### Admin Auth
- Middleware on `/admin/*` checks for session cookie
- `/admin/login` POST validates password against `ADMIN_PASSWORD` env var, sets HttpOnly cookie
- No user accounts, no password reset, no OAuth

### Export Format
**JSON**:
```json
[
  { "name": "Alice", "email": "alice@example.com", "magicLink": "https://domain.com/g/abc123xy", "assignedTo": "Bob" }
]
```
**CSV columns**: `Name, Email, Magic Link, Assigned To`

### Participant View Page
Displays:
- "You're buying for **[Assigned Name]**"
- Event name, date, budget (formatted as currency)
- Banner image (if set)
- No navigation, no links to other participants

### Environment Variables
```
DATABASE_URL="file:./dev.db"
ADMIN_PASSWORD="24-char-shared-secret"
CLOUDINARY_CLOUD_NAME="xxx"
CLOUDINARY_API_KEY="xxx"
CLOUDINARY_API_SECRET="xxx"
NEXT_PUBLIC_BASE_URL="https://tunnel-url.trycloudflare.com"
```

## Testing Decisions

### What Makes a Good Test
- Test **external behavior** only: API responses, page renders, algorithm outputs
- No implementation detail tests (private functions, internal state)
- Use real SQLite DB (Prisma) in tests, not mocks — fast enough for this scale
- Test the assignment algorithm exhaustively: valid cases, edge cases (odd numbers, tight constraints), and conflict detection accuracy

### Modules to Test
1. **Assignment Algorithm** (`src/lib/assignment.ts`) — unit tests with varied participant/tag configurations
   - Valid derangement with no tags
   - Valid derangement with simple tag exclusions
   - Impossible case: tag group larger than outsider pool
   - Impossible case: all participants share a tag
   - Conflict reporting identifies correct groups
2. **Export Helpers** (`src/lib/export.ts`) — JSON/CSV format correctness
3. **API Routes** — integration tests via `next-test-api-route-handler` or similar
   - Event CRUD
   - Participant/Tag CRUD
   - Assignment generation (success + conflict)
   - Export download
4. **Admin Auth Middleware** — cookie validation, redirect on missing/invalid password
5. **Participant View Page** — renders correct assignment, budget, banner

### Prior Art
- No existing tests in repo (fresh project)
- Follow Next.js + Prisma testing patterns: `vitest` for unit, `playwright` for E2E if needed

## Out of Scope

- **Email delivery** — organizer manually shares magic links via WhatsApp/other channels
- **User accounts / OAuth** — single shared admin password only
- **Real-time updates / WebSockets** — static pages, no live assignment reveal
- **Participant avatars / wishlist images** — event banner only
- **Recurring events / templates** — each event created from scratch
- **Multi-language / i18n** — English only
- **Automated reminders / notifications** — none
- **Assignment editing after generation** — regenerate if changes needed
- **Public event discovery** — all events private to admin
- **Mobile app** — responsive web only

## Further Notes

- **Tag Scope Decision**: Tags are event-scoped (unique per event). A "Family" tag in Event A is separate from "Family" in Event B. This avoids cross-event leakage and simplifies mental model.
- **Conflict Detection**: The algorithm should return not just "impossible" but which tag groups conflict and why (e.g., group sizes vs. available outsiders). This is critical for usability.
- **Cloudinary Upload**: Use signed uploads from the server — the client gets upload parameters via `/api/upload`, uploads directly to Cloudinary, then the server receives the `secure_url` via webhook or callback and attaches it to the event. Simpler alternative: server-side upload via `cloudinary.uploader.upload()` in the event create/update API (acceptable for low volume).
- **Systemd Service**: Will be created as a separate file (`secret-santa.service`) for the user to install.
- **Database Migrations**: Prisma migrations checked into repo; `prisma migrate deploy` runs on startup.
- **Base URL**: `NEXT_PUBLIC_BASE_URL` used to construct absolute magic links in export. Must match the Cloudflare Tunnel URL.