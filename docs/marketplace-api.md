# Marketplace API

## Database and Storage

`User.id` stores the UUID from Supabase Auth. The API verifies each bearer token with Supabase and upserts a local `User` row before handling marketplace requests. Prisma foreign keys then relate listings to that local user row; the request body never chooses the seller ID.

Create a public Supabase Storage bucket named `listing-images`. Restrict uploads to each authenticated user's UUID folder with a Storage policy such as:

```sql
create policy "Users upload listing images to their own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'listing-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
```

Set the variables from `.env.example`. Use the Supabase pooler URL for `DATABASE_URL` at runtime and the direct database URL for `DIRECT_URL` migrations. Then run `npm run prisma:generate`, `npm run db:migrate`, and `npm run db:seed`.

## Vite/React Listing Creation

Configure the frontend Supabase client with the project URL and publishable/anon key. Start Google OAuth with:

```ts
await supabase.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo: `${window.location.origin}/auth/callback` },
});
```

Upload image bytes directly to Storage; send only the resulting public URL and listing fields to Express. Send the Supabase access token as a bearer token, not a trusted `userId` field; the API verifies the token, derives the seller UUID, and checks that each URL belongs to the configured bucket and that user's folder.

```ts
const { data: { session } } = await supabase.auth.getSession();
if (!session) throw new Error("Sign in before creating a listing.");

const file = selectedFile;
const extension = file.name.split(".").pop() ?? "jpg";
const path = `${session.user.id}/${crypto.randomUUID()}.${extension}`;
const { data: upload, error: uploadError } = await supabase.storage
  .from("listing-images")
  .upload(path, file, { contentType: file.type, upsert: false });
if (uploadError) throw uploadError;

const { data: { publicUrl } } = supabase.storage
  .from("listing-images")
  .getPublicUrl(upload.path);

const response = await fetch(`${import.meta.env.VITE_API_URL}/api/listings`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
  },
  body: JSON.stringify({
    title,
    description,
    categoryId,
    price,
    originalPrice,
    locationCampus,
    imageUrls: [publicUrl],
  }),
});
if (!response.ok) throw new Error((await response.json()).error ?? "Listing creation failed.");
const { listing } = await response.json();
```

To start the backend locally, copy `.env.example` to `.env`, fill in the Supabase values, and run `npm run dev`.

## Buyer-Seller Conversations

Run `npm run prisma:generate` and `npm run db:migrate` to create the schema. This repository had no earlier migrations, so its initial migration creates the existing marketplace tables as well as chat tables. If those tables already exist in your database, back up the database and baseline/adopt the migration history rather than applying the initial migration unchanged. All chat API routes require the same Supabase bearer token as the marketplace routes; the API derives the participant from the verified token and never trusts a user ID in the request body.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/conversations` | List the signed-in user's conversations, newest activity first, including the latest message, listing preview, buyer, and seller. |
| `POST` | `/api/listings/:listingId/conversation` | Start or return the existing thread between the signed-in buyer and the listing's seller. New threads can only be started for active listings. |
| `GET` | `/api/conversations/:conversationId/messages` | Return the full message history in chronological order. Only conversation participants may read it. |
| `POST` | `/api/conversations/:conversationId/messages` | Send `{ "content": "..." }`; only participants may send messages. Content is trimmed and limited to 4,000 characters. |

The optional `Conversation.listingId` permits non-listing conversations. The composite unique constraint prevents duplicate listing conversations for the same buyer and seller. PostgreSQL permits multiple `NULL` values in a unique constraint, so this does not prevent multiple listing-less conversations.

### Supabase Realtime

Enable Realtime for the Prisma-created `"Message"` table (the Prisma model names are also the PostgreSQL table names in this schema). Run the following once in the Supabase SQL Editor; it grants authenticated clients read access only to messages and conversation rows where they are a participant:

```sql
alter publication supabase_realtime add table public."Message";

grant select on public."Message", public."Conversation" to authenticated;
alter table public."Message" enable row level security;
alter table public."Conversation" enable row level security;

create policy "Participants can read conversations"
on public."Conversation" for select to authenticated
using (auth.uid() = "buyerId" or auth.uid() = "sellerId");

create policy "Participants can read conversation messages"
on public."Message" for select to authenticated
using (
  exists (
    select 1 from public."Conversation" c
    where c.id = "Message"."conversationId"
      and (c."buyerId" = auth.uid() or c."sellerId" = auth.uid())
  )
);
```

Subscribe to inserts filtered by the active conversation, and remove the channel when the component unmounts or the conversation changes:

```tsx
import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
};

function useLiveMessages(
  supabase: SupabaseClient,
  conversationId: string,
  initialMessages: ChatMessage[],
) {
  const [messages, setMessages] = useState(initialMessages);

  useEffect(() => {
    setMessages(initialMessages);
  }, [conversationId, initialMessages]);

  useEffect(() => {
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "Message",
          filter: `conversationId=eq.${conversationId}`,
        },
        (payload) => {
          const message = payload.new as ChatMessage;
          setMessages((current) =>
            current.some((item) => item.id === message.id) ? current : [...current, message],
          );
        },
      )
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Message Realtime subscription failed.", error);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);

  return messages;
}
```

Pass the signed-in user's Supabase client and the history returned by the messages endpoint. Realtime row events contain message columns, not the related sender profile, so use `senderId` for immediate display or fetch the sender profile separately. Keep sending messages through Express so its participant checks remain authoritative; do not expose a service-role key in the frontend.