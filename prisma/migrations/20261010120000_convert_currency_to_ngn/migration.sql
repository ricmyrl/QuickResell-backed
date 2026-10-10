-- Convert persisted USD values to NGN at the approved 2026-10-10 snapshot:
-- 1 USD = 1,331.267014 NGN. Integer currency values are stored in kobo.
-- Pending legacy wallet top-ups retain their USD value until verified so their
-- original Paystack metadata can still be validated safely.
DO $$
DECLARE
  conversion_rate NUMERIC := 1331.267014;
  target RECORD;
  overflow_count BIGINT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('AuctionRoom', 'platformFeeCents', NULL),
      ('PurchaseOrder', 'subtotalCents', NULL),
      ('PurchaseOrderItem', 'unitPriceCents', NULL),
      ('PurchaseOrderItem', 'sellerFeeCents', NULL),
      ('SellerPayout', 'amountUsdCents', NULL),
      ('Wallet', 'balanceCents', NULL),
      ('WalletTransaction', 'amountCents', 'TOP_UP')
    ) AS fields(table_name, column_name, pending_topup_type)
  LOOP
    IF target.table_name = 'WalletTransaction' THEN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE NOT ("status" = ''PENDING'' AND "type" = %L) AND (ROUND(%I::numeric * $1) > 2147483647 OR ROUND(%I::numeric * $1) < -2147483648)',
        target.table_name, target.pending_topup_type, target.column_name, target.column_name
      ) INTO overflow_count USING conversion_rate;
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE ROUND(%I::numeric * $1) > 2147483647 OR ROUND(%I::numeric * $1) < -2147483648',
        target.table_name, target.column_name, target.column_name
      ) INTO overflow_count USING conversion_rate;
    END IF;

    IF overflow_count > 0 THEN
      RAISE EXCEPTION 'NGN currency migration would overflow %.% for % row(s).',
        target.table_name, target.column_name, overflow_count;
    END IF;
  END LOOP;
END $$;

ALTER TABLE "Bid"
ALTER COLUMN "incrementAmountCents" TYPE DOUBLE PRECISION
USING "incrementAmountCents"::double precision;

UPDATE "User"
SET "budgetPreference" = ROUND(("budgetPreference"::numeric * 1331.267014), 2)::double precision
WHERE "budgetPreference" IS NOT NULL;

UPDATE "Post"
SET "price" = ROUND(("price"::numeric * 1331.267014), 2)::double precision,
    "originalPrice" = CASE
      WHEN "originalPrice" IS NULL THEN NULL
      ELSE ROUND(("originalPrice"::numeric * 1331.267014), 2)::double precision
    END;

UPDATE "AuctionRoom"
SET "currentHighestBid" = ROUND(("currentHighestBid"::numeric * 1331.267014), 2)::double precision,
    "reservePrice" = CASE
      WHEN "reservePrice" IS NULL THEN NULL
      ELSE ROUND(("reservePrice"::numeric * 1331.267014), 2)::double precision
    END,
    "platformFeeCents" = ROUND(("platformFeeCents"::numeric * 1331.267014))::integer,
    "curveAlphaParam" = CASE
      WHEN "curveAlphaParam" IS NULL THEN NULL
      ELSE "curveAlphaParam" * 1331.267014
    END,
    "curveGammaParam" = CASE
      WHEN "curveGammaParam" IS NULL THEN NULL
      ELSE "curveGammaParam" / 1331.267014
    END;

ALTER TABLE "AuctionRoom"
ALTER COLUMN "curveAlphaParam" SET DEFAULT 6656.33507,
ALTER COLUMN "curveGammaParam" SET DEFAULT 0.000001126807;

UPDATE "Bid"
SET "amount" = ROUND(("amount"::numeric * 1331.267014), 2)::double precision,
    "incrementAmountCents" = ROUND(("incrementAmountCents"::numeric * 1331.267014))::double precision;

UPDATE "AuctionWatchlistItem"
SET "maxBid" = ROUND(("maxBid"::numeric * 1331.267014), 2)::double precision,
    "bidStep" = ROUND(("bidStep"::numeric * 1331.267014), 2)::double precision;

ALTER TABLE "AuctionWatchlistItem"
ALTER COLUMN "bidStep" SET DEFAULT 1331.27;

UPDATE "PurchaseOrder"
SET "subtotalCents" = ROUND(("subtotalCents"::numeric * 1331.267014))::integer;

UPDATE "PurchaseOrderItem"
SET "unitPriceCents" = ROUND(("unitPriceCents"::numeric * 1331.267014))::integer,
    "sellerFeeCents" = ROUND(("sellerFeeCents"::numeric * 1331.267014))::integer;

ALTER TABLE "SellerPayout" RENAME COLUMN "amountUsdCents" TO "amountCents";
UPDATE "SellerPayout"
SET "amountCents" = ROUND(("amountCents"::numeric * 1331.267014))::integer;

UPDATE "Wallet"
SET "balanceCents" = ROUND(("balanceCents"::numeric * 1331.267014))::integer;

UPDATE "WalletTransaction"
SET "amountCents" = ROUND(("amountCents"::numeric * 1331.267014))::integer
WHERE NOT ("status" = 'PENDING' AND "type" = 'TOP_UP');
