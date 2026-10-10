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

Set the variables from `.env.example`. Use the Supabase pooler URL for `DATABASE_URL` at runtime and the direct database URL for `DIRECT_URL` migrations. Then run `npm run prisma:generate` and `npm run db:migrate`; migrations provision the listing categories, and the categories endpoint also ensures they exist. Run `npm run db:seed` only when you also want the demo users and listings.

## Account and Profile

The signed-in account menu provides profile editing, campus and budget preferences, email/password security settings, sign-out, and permanent account deletion. Profile names are updated in Supabase Auth metadata; preferences are stored on the local `User` record. Email changes follow Supabase's email-confirmation flow. Account deletion requires the account email as confirmation, removes owned listing photos from Supabase Storage, deletes linked marketplace data and order history, then deletes the Supabase Auth user and sessions. Payment processors may retain transaction records under their own legal and retention requirements.

The backend must have `SUPABASE_SERVICE_ROLE_KEY` configured as a server-only secret for account deletion. Never place this key in the frontend or expose it to clients. The account endpoints require the signed-in user's bearer token:

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/account` | Return the signed-in user's profile and shopping preferences. |
| `PATCH` | `/api/account` | Update `{ "preferredDormOrCampus": "...", "budgetPreference": 250 }`; budget may be `null`. |
| `DELETE` | `/api/account` | Permanently remove linked marketplace records after `{ "confirmation": "account@email" }` matches the authenticated user's email. |

## Seller Payout Reconciliation Dry Run

Run the backend's local, read-only report before manually reviewing missed seller payouts:

```sh
npm run payouts:reconcile:dry-run > seller-payout-reconciliation.csv
npm run payouts:reconcile:dry-run -- --since=2026-01-01 > seller-payout-reconciliation.csv
```

The report groups paid-in-app order lines by order and seller, uses the stored line prices and seller fees to calculate the same net USD cents used by checkout, and shows only the bank name and last four digits. It never initiates a Paystack transfer. New checkout payouts include their recorded Paystack status and reference; successful means Paystack reported transfer success, not independent confirmation from the receiving bank. Legacy orders without a ledger remain `NOT_TRACKED` and must be checked in Paystack.

Apply pending schema migrations with `npm run db:migrate:deploy` when deploying the backend. Configure Paystack to send `transfer.success`, `transfer.failed`, and `transfer.reversed` webhooks to `/api/paystack/webhook`. The wallet response includes a separate seller earnings summary and recent paid-order payouts; it does not add seller proceeds to the buyer wallet deposit balance. Sellers can cash out each paid product line from Wallet or Seller Studio after marking it pickup-ready or shipped; the action requires a verified payout account and passkey verification. Checkout no longer automatically transfers seller funds. Sellers receive in-app notifications when a payout is blocked, succeeds, fails, is reversed, or needs review; they can open the notification to reach Seller Studio and refresh the status. New payouts are recorded before the transfer call and use a stable Paystack reference. Ambiguous transfer outcomes are marked for manual reconciliation rather than automatically retried, to avoid duplicate payments. Older orders without per-item payout records are not eligible for the button; reconcile them against Paystack first to avoid double payment. Keep the generated CSV private because it contains seller/order and Paystack recipient identifiers.

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

## Scout AI Assistance

Scout keeps its deterministic, on-device guidance for bidding, checkout, support, and marketplace actions. For general questions it can optionally call the backend `POST /api/scout/chat` endpoint, which forwards bounded recent chat and a curated public marketplace snapshot to a private Ollama instance. The model returns text only: navigation, bids, purchases, and other consequential actions remain controlled by the app. If Ollama is offline or times out, Scout falls back to its local response. The endpoint is rate-limited and does not require authentication; do not include passwords, payment information, or other sensitive data in Scout messages.

The default model is `qwen2.5:0.5b` (Ollama's approximately 397 MB model artifact, below the 500 MB requirement). Install Ollama on the backend host, then pull the model and configure the backend:

```sh
ollama pull qwen2.5:0.5b
```

Set `OLLAMA_BASE_URL` to the Ollama API base URL (default `http://127.0.0.1:11434`) and optionally set `SCOUT_MODEL` in the backend environment. Keep Ollama private; expose only the marketplace API to clients. The backend starts and serves all other routes normally if Ollama is not installed or running.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `POST` | `/api/scout/chat` | Accepts up to 8 recent `{ role, content }` messages and a bounded public auction/listing context; returns `{ reply, model }`. Responds with `503` when the configured model is unavailable and `429` when the per-IP request limit is exceeded. |

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

Run the additive migrations `20260930190000_add_shopping_cart_orders`, `20261003130000_add_order_fulfillment_tracking`, and `20261003150000_add_auction_cart_holds`, then regenerate Prisma before enabling these routes. `GET /api/store` returns in-stock, fixed-price listings that are not attached to an auction. Bidding automatically adds a locked auction hold to the bidder's cart. Outbid holds stay locked for rebidding and are removed when the auction resolves without that bidder; a hold unlocks only after the seller accepts the buyer's winning bid. Auction winners pay the accepted final bid through Paystack checkout. `POST /api/listings` accepts optional `quantityAvailable` (integer 1–1000), defaulting to one.

For auctions created after this policy takes effect, every second accepted bid creates a seller platform fee equal to that bid's actual increase over the preceding bid (the first increase is measured from the listing's starting price). Each accepted bid counts once, including automated jump bids. The winner pays the displayed winning bid; the accumulated fee is deducted from the seller's payout, not added to the buyer's checkout. The fee is shown to bidders before they bid, to sellers before they accept the winning bid, and is recorded on the order item. Existing auctions are not charged this fee.

All cart endpoints require the signed-in user's Supabase bearer token. Cart rows are stored per user in PostgreSQL; client-submitted prices are never trusted.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/store` | List active fixed-price listings with available stock. |
| `GET` | `/api/cart` | Return this user's cart lines, current asking prices, stock availability, and listing previews. |
| `POST` | `/api/cart/items` | Send `{ "postId": "...", "quantity": 1 }` to add units. Re-adding increments the existing line. |
| `PATCH` | `/api/cart/items/:postId` | Set `{ "quantity": 2 }`, validated against current stock. |
| `DELETE` | `/api/cart/items/:postId` | Remove this listing from the signed-in user's cart. |
| `POST` | `/api/cart/checkout` | Verifies the Paystack reference and payable subtotal, then atomically revalidates stock and accepted auction wins, creates a paid order, decrements fixed-price inventory, removes purchased cart entries, and records in-app notifications for the buyer and each seller. Locked auction holds are not charged or removed. |
| `GET` | `/api/orders/mine` | List the signed-in buyer's paid orders and each seller's fulfillment status. |
| `POST` | `/api/orders/items/:itemId/complete` | Buyer confirms receipt after an item is ready for pickup or shipped. |
| `GET` | `/api/seller/orders` | List paid line items for the signed-in seller. |
| `POST` | `/api/seller/orders/:itemId/fulfillment` | Seller sends `{ "method": "PICKUP" }` or `{ "method": "SHIPPING" }`; this sets the item to ready for pickup or shipped and notifies the buyer. |

Checkout is only completed after the backend verifies the Paystack payment. Payment initialization snapshots the exact payable cart-line IDs and subtotal so auction holds that unlock during an in-progress payment cannot be charged accidentally; a changed payable set is rejected for support follow-up. A single checkout supports up to 100 payable cart lines. The buyer and each seller receive a persisted `ORDER_UPDATE` notification as part of the same transaction that creates the order; notifications are delivered through the in-app Alerts feed. Sellers then choose pickup or shipping for each paid item; buyers can track those updates and confirm receipt. Pickup meetup arrangements are coordinated directly between buyer and seller. Shipping is tracked as a seller-reported shipped state; carrier tracking details are not collected. Cart writes and checkout lock the user row and listing rows to serialize concurrent changes and prevent overselling. Guest preview carts use browser local storage and do not create backend orders.

### Paystack production setup

Production checkout and wallet deposits use Paystack NGN transactions. Configure `PAYSTACK_SECRET_KEY` (`sk_live_...`) on the backend only. Checkout uses Paystack's hosted authorization URL, so the frontend does not need a Paystack public key. The backend refuses to start in production with a missing, test-mode, or placeholder secret key. Never commit the live secret key.

Seller verification defaults to Paystack's combined form for legal name, NIN or BVN, and payout bank account. The bank selector is limited to major Nigerian commercial banks and omits microfinance institutions and smaller financial institutions. Paystack validates the identity number together with the supplied account details. Set `SELLER_VERIFICATION_PROVIDER=smile` only to explicitly use the separate Smile ID identity flow.

Configure `SELLER_VERIFICATION_HASH_SECRET` on the backend with a stable, randomly generated secret of at least 32 characters. It is used to hash verified legal names before storing them and to compare them with payout account names. Generate one with `openssl rand -hex 32`, then add the output to the backend's environment variables. Do not use the example placeholder, commit the generated value, or rotate it without a migration plan: rotating it invalidates existing seller name hashes and sellers will need to verify again.

Register `https://YOUR_API_HOST/api/paystack/webhook` in the Paystack Dashboard and subscribe to `charge.success`. The endpoint validates Paystack's `x-paystack-signature` against the unmodified request body. It verifies the transaction with Paystack and idempotently finalizes cart orders or wallet deposits; browser callbacks use the same finalizers, so webhook/callback retries cannot duplicate orders or wallet credits. Keep the API publicly reachable over HTTPS and set `FRONTEND_URL` and frontend `VITE_API_URL` to their HTTPS production origins.

API errors return a safe message, stable error code, and request ID, for example `{ "error": "The database is temporarily unavailable. Please retry shortly.", "code": "DATABASE_UNAVAILABLE", "requestId": "..." }`. The matching request ID is included in server logs and in the `X-Request-Id` response header; share it with support when reporting a failure. Missing database tables or columns return `503 DATABASE_SCHEMA_UNAVAILABLE` rather than an opaque internal-server error.