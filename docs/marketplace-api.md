# Marketplace API

## Database and Storage

`User.id` stores the UUID from Supabase Auth. The API verifies each bearer token with Supabase and upserts a local `User` row before handling marketplace requests. Prisma foreign keys then relate listings to that local user row; the request body never chooses the seller ID.

The `20261002143000_create_listing_images_bucket` migration creates the public `listing-images` bucket, limits files to 10 MB and supported image types, and restricts authenticated uploads/deletes to each user's UUID folder. Run `npm run db:migrate:deploy` to provision it in Supabase.

Public reads are enabled so listing image URLs work on the marketplace. The upload policy is:

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

## Live Campus Auctions

Apply the new `20260930170000_add_auctions` and `20260930180000_public_auction_accountability` migrations after the existing initial schema migration, then regenerate the Prisma client. Each listing can have at most one auction room. The listing's `Post.price` initializes `currentHighestBid` as the minimum; every submitted bid must be strictly greater. Auction creation accepts an ISO date-time no more than 30 days in the future. A seller cannot bid on their own listing.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `POST` | `/api/listings/:listingId/auction` | Seller creates a room with `{ "endsAt": "..." }`. |
| `GET` | `/api/auctions/:auctionRoomId` | Fetch current room/listing/participants and the latest 50 bids. |
| `POST` | `/api/auctions/:auctionRoomId/bids` | Submit `{ "amount": 25.5 }`; amount must exceed both the current high bid and listing price. |
| `POST` | `/api/auctions/:auctionRoomId/close` | Seller may end early; any authenticated caller may finalize an expired room. A qualifying winner moves the room to `PENDING_APPROVAL`; rooms without a bid meeting reserve close without approval. |
| `POST` | `/api/auctions/:roomId/verdict` | Seller sends `{ "decision": "ACCEPT" }` or `{ "decision": "REJECT" }` after the room enters `PENDING_APPROVAL`. Accepting marks the room/listing `SOLD`, increments `completedAuctions`, and adds 5 trust points. Rejecting marks the room `REJECTED`, locks the listing as `RESERVED`, increments `backedOutAuctions`, and subtracts 20 trust points. Scores are bounded from 0 to 100. |
| `GET` | `/api/auctions?limit=20&cursor=<roomId>` | Cursor-paginated active public rooms (1–50 per page), ordered by soonest expiration. The response includes `nextCursor`, or `null` when the feed is exhausted. |

Bid placement locks the auction row with `SELECT ... FOR UPDATE` inside a database transaction. This serializes competing bids, validates each bid against the latest committed amount and end time, records the bid, updates the winner/high bid, and extends the clock atomically. A valid bid in the final 10 seconds adds 30 seconds to the current end time. The same row lock makes closing, verdicts, and bidding mutually ordered. A server-side worker checks every five seconds for expired rooms; it moves rooms with a winning bid meeting reserve to `PENDING_APPROVAL` and closes rooms with no qualifying bid. The close route can also trigger finalization on demand.

Public room creation accepts `{ "endsAt": "...", "isPublic": true, "reservePrice": 30 }`. `isPublic` defaults to `true` for this API but can be set to `false`; the Prisma default is `false` for direct database writes. A reserve, when provided, must be at least the listing's starting price. Rejected posts use the existing `RESERVED` status as the temporary lock and require an explicit seller/admin relisting action; the system does not automatically reactivate a rejected listing.

### Live Bid and Timer Updates

Add both tables to the Supabase Realtime publication and allow authenticated campus users to read room and bid rows. All writes stay behind the authenticated Express API:

```sql
alter publication supabase_realtime add table public."AuctionRoom";
alter publication supabase_realtime add table public."Bid";

grant select on public."AuctionRoom", public."Bid" to authenticated;
alter table public."AuctionRoom" enable row level security;
alter table public."Bid" enable row level security;

create policy "Authenticated users can read auction rooms"
on public."AuctionRoom" for select to authenticated using (true);

create policy "Authenticated users can read auction bids"
on public."Bid" for select to authenticated using (true);
```

These broad read policies are suitable only if all auction room and bid data is intended to be visible to signed-in campus users. For more restrictive visibility, replace them with policies matching the product's campus membership model. Ensure the Supabase Realtime publication includes both tables.

## Backend Performance Notes

The marketplace feed builds one scorer per request, reusing the normalized buyer embedding and request timestamp instead of repeating setup for every candidate. Public auction feed results are cursor-paginated, with a maximum page size of 50 and a matching `(isPublic, status, endsAt)` index. The auction expiry worker finalizes up to 100 due rooms per batch using one `FOR UPDATE SKIP LOCKED` statement; overlapping local timer ticks are skipped, and the database lock lets multiple server instances share the work safely. Authenticated requests avoid writing the local user row unless Supabase profile fields changed.

Subscribe to bid inserts for price/bidder activity and room updates for extensions, closures, and the authoritative timer:

```ts
const channel = supabase
  .channel(`auction:${auctionRoomId}`)
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "Bid",
    filter: `auctionRoomId=eq.${auctionRoomId}`,
  }, ({ new: bid }) => {
    setBids((current) => current.some((item) => item.id === bid.id) ? current : [bid, ...current]);
  })
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "AuctionRoom",
    filter: `id=eq.${auctionRoomId}`,
  }, ({ new: room }) => {
    setCurrentHighestBid(room.currentHighestBid);
    setEndsAt(room.endsAt);
    setAuctionStatus(room.status);
  })
  .subscribe((status, error) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("Auction Realtime subscription failed.", error);
    }
  });

// On component cleanup:
void supabase.removeChannel(channel);
```

Load the initial state from `GET /api/auctions/:auctionRoomId`, then treat Realtime payloads as incremental updates. Render the countdown from the latest server-provided `endsAt`; a client timer is only a display and must never determine whether a bid is accepted. The API remains authoritative for bid validation and auction closure.

## Fixed-Price Shop and Cart

Run the additive migrations `20260930190000_add_shopping_cart_orders` and `20261003130000_add_order_fulfillment_tracking`, then regenerate Prisma before enabling these routes. `GET /api/store` returns in-stock, fixed-price listings that are not attached to an auction. Auction rooms remain in the live-auction feed and cannot be added to the buy-now cart. `POST /api/listings` accepts optional `quantityAvailable` (integer 1–1000), defaulting to one.

All cart endpoints require the signed-in user's Supabase bearer token. Cart rows are stored per user in PostgreSQL; client-submitted prices are never trusted.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/store` | List active fixed-price listings with available stock. |
| `GET` | `/api/cart` | Return this user's cart lines, current asking prices, stock availability, and listing previews. |
| `POST` | `/api/cart/items` | Send `{ "postId": "...", "quantity": 1 }` to add units. Re-adding increments the existing line. |
| `PATCH` | `/api/cart/items/:postId` | Set `{ "quantity": 2 }`, validated against current stock. |
| `DELETE` | `/api/cart/items/:postId` | Remove this listing from the signed-in user's cart. |
| `POST` | `/api/cart/checkout` | Verifies the Paystack reference and total, then atomically revalidates stock, snapshots prices, creates a paid order, decrements inventory, and clears the cart. |
| `GET` | `/api/orders/mine` | List the signed-in buyer's paid orders and each seller's fulfillment status. |
| `POST` | `/api/orders/items/:itemId/complete` | Buyer confirms receipt after an item is ready for pickup or shipped. |
| `GET` | `/api/seller/orders` | List paid line items for the signed-in seller. |
| `POST` | `/api/seller/orders/:itemId/fulfillment` | Seller sends `{ "method": "PICKUP" }` or `{ "method": "SHIPPING" }`; this sets the item to ready for pickup or shipped and notifies the buyer. |

Checkout is only completed after the backend verifies the Paystack payment. Sellers then choose pickup or shipping for each paid item; buyers can track those updates and confirm receipt. Pickup meetup arrangements are coordinated directly between buyer and seller. Shipping is tracked as a seller-reported shipped state; carrier tracking details are not collected. Cart writes and checkout lock the user row and listing rows to serialize concurrent changes and prevent overselling. Guest preview carts use browser local storage and do not create backend orders.