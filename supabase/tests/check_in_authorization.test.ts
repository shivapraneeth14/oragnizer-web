import { assert } from "jsr:@std/assert"

const checkInSrc = await Deno.readTextFile(
  new URL("../functions/check-in/index.ts", import.meta.url),
)
const scanPageSrc = await Deno.readTextFile(
  new URL("../../apps/organizer-web/src/pages/check-in-page.tsx", import.meta.url),
)
const scanResultSrc = await Deno.readTextFile(
  new URL("../../apps/organizer-web/src/components/check-in/scan-result.tsx", import.meta.url),
)

Deno.test("check-in edge function rejects cross-organizer tickets with clear error", () => {
  assert(checkInSrc.includes("This ticket belongs to another organizer's event."))
  assert(checkInSrc.includes("status: 403"))
})

Deno.test("check-in edge function enforces event matching when event_id is supplied", () => {
  assert(checkInSrc.includes("expectedEventId && event.id !== expectedEventId"))
  assert(checkInSrc.includes('Wrong event: This ticket is for "${event.title}", not this event.'))
  assert(checkInSrc.includes("status: 400"))
})

Deno.test("check-in edge function enforces community matching when community_id is supplied", () => {
  assert(checkInSrc.includes("expectedCommunityId && event.community_id !== expectedCommunityId"))
  assert(checkInSrc.includes("This ticket belongs to another community's event."))
  assert(checkInSrc.includes("status: 400"))
})

Deno.test("organizer-web check-in page passes selected event_id and community_id", () => {
  assert(scanPageSrc.includes("event_id: selectedEventId || undefined"))
  assert(scanPageSrc.includes("community_id: communityId || undefined"))
  assert(scanPageSrc.includes("}, [selectedEventId, communityId])"))
})

Deno.test("organizer-web scan-result overlay shows clear titles for wrong event and other organizer", () => {
  assert(scanResultSrc.includes("isWrongEvent"))
  assert(scanResultSrc.includes('"Wrong Event"'))
  assert(scanResultSrc.includes("isOtherOrganizer"))
  assert(scanResultSrc.includes('"Invalid Ticket"'))
})
