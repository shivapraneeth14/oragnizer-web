import { assertEquals } from "jsr:@std/assert";

Deno.test("BUG-008: Realtime message payload contract and profile cache hydration", () => {
  // 1. Simulating Supabase Realtime postgres_changes INSERT payload
  // Supabase Realtime only delivers columns of the source table (event_messages),
  // NEVER joined foreign tables (e.g. profiles:user_id).
  const rawRealtimeInsert = {
    schema: "public",
    table: "event_messages",
    eventType: "INSERT",
    new: {
      id: "msg-realtime-101",
      event_id: "evt-uuid-1",
      user_id: "user-uuid-ada",
      content: "Can anyone tell me where to park?",
      created_at: "2026-11-01T12:00:00Z",
      updated_at: "2026-11-01T12:00:00Z",
    },
    old: null,
  };

  // Sender profile cache initially seeded from initial load / REST query
  const profileCache = new Map<string, { first_name?: string | null; last_name?: string | null; avatar_url?: string | null }>();
  profileCache.set("user-uuid-ada", {
    first_name: "Ada",
    last_name: "Lovelace",
    avatar_url: "https://res.cloudinary.com/cluvo/image/upload/v1/ada.jpg",
  });

  // Verify that raw realtime payload has no 'profiles' property
  const newRecord = rawRealtimeInsert.new as Record<string, unknown>;
  assertEquals(newRecord.profiles, undefined);

  // Hydrate using in-memory profile cache
  const cachedProfile = profileCache.get(newRecord.user_id as string) || null;
  const hydratedMessage = {
    ...newRecord,
    profiles: cachedProfile,
  };

  assertEquals(hydratedMessage.profiles?.first_name, "Ada");
  assertEquals(hydratedMessage.profiles?.last_name, "Lovelace");
  assertEquals(hydratedMessage.profiles?.avatar_url, "https://res.cloudinary.com/cluvo/image/upload/v1/ada.jpg");
});

Deno.test("BUG-008: Deduplication of messages in Realtime handler", () => {
  const existingMessages = [
    { id: "msg-1", user_id: "u1", content: "Existing message" },
  ];

  const incomingInsert = { id: "msg-1", user_id: "u1", content: "Existing message duplicate" };

  const isDuplicate = existingMessages.some((m) => m.id === incomingInsert.id);
  assertEquals(isDuplicate, true);

  const newInsert = { id: "msg-2", user_id: "u2", content: "Brand new message" };
  const isDuplicateNew = existingMessages.some((m) => m.id === newInsert.id);
  assertEquals(isDuplicateNew, false);
});

Deno.test("BUG-008: Realtime message update and delete reflection", () => {
  let messages = [
    { id: "msg-1", user_id: "u1", content: "Hello", updated_at: "2026-11-01T10:00:00Z" },
    { id: "msg-2", user_id: "u2", content: "World", updated_at: "2026-11-01T10:01:00Z" },
  ];

  // UPDATE
  const updatePayload = {
    new: { id: "msg-1", content: "Hello (edited)", updated_at: "2026-11-01T10:05:00Z" },
  };
  messages = messages.map((m) =>
    m.id === updatePayload.new.id
      ? { ...m, content: updatePayload.new.content, updated_at: updatePayload.new.updated_at }
      : m
  );
  assertEquals(messages[0].content, "Hello (edited)");
  assertEquals(messages[0].updated_at, "2026-11-01T10:05:00Z");

  // DELETE
  const deletePayload = { old: { id: "msg-2" } };
  messages = messages.filter((m) => m.id !== deletePayload.old.id);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].id, "msg-1");
});

