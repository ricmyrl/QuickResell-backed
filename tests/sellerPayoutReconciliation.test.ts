import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSellerPayoutReconciliationRows,
  sellerPayoutReconciliationCsv,
  type PayoutOrderItem,
} from "../src/services/sellerPayoutReconciliation.js";

function makeItem(options: {
  id?: string;
  orderId?: string;
  quantity?: number;
  unitPriceCents?: number;
  sellerFeeCents?: number;
  fulfillmentStatus?: string;
  orderStatus?: string;
  payoutStatus?: string;
  recipientCode?: string | null;
  sellerName?: string;
  transferStatus?: string;
  transferReference?: string | null;
} = {}): PayoutOrderItem {
  return {
    id: options.id ?? "item-1",
    orderId: options.orderId ?? "order-1",
    sellerId: "seller-1",
    quantity: options.quantity ?? 2,
    unitPriceCents: options.unitPriceCents ?? 1_500,
    sellerFeeCents: options.sellerFeeCents ?? 200,
    fulfillmentStatus: options.fulfillmentStatus ?? "PENDING_HANDOFF",
    seller: {
      displayName: options.sellerName ?? "Seller",
      sellerVerification: {
        payoutStatus: options.payoutStatus ?? "VERIFIED",
        bankName: "Example Bank",
        bankAccountLast4: "1234",
        paystackRecipientCode: options.recipientCode === undefined ? "RCP_123" : options.recipientCode,
      },
    },
    sellerPayout: options.transferStatus ? {
      status: options.transferStatus,
      transferReference: options.transferReference ?? null,
      amountKobo: 270_000,
    } : null,
    order: {
      id: options.orderId ?? "order-1",
      paymentReference: "PAY_123",
      status: options.orderStatus ?? "COMPLETED",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

test("reports product-line net amounts separately for individual cashout", () => {
  const rows = buildSellerPayoutReconciliationRows([
    makeItem(),
    makeItem({ id: "item-2", quantity: 1, unitPriceCents: 500, sellerFeeCents: 0 }),
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.quantity, 2);
  assert.equal(rows[0]?.grossUsdCents, 3_000);
  assert.equal(rows[0]?.sellerFeeUsdCents, 200);
  assert.equal(rows[0]?.netPayoutUsdCents, 2_800);
  assert.equal(rows[0]?.transferStatus, "NOT_TRACKED");
  assert.equal(rows[0]?.transferReference, "");
  assert.equal(rows[0]?.action, "RECONCILE_WITH_PAYSTACK_BEFORE_TRANSFER");
  assert.equal(rows[1]?.netPayoutUsdCents, 500);
  assert.equal(rows[0]?.action, "RECONCILE_WITH_PAYSTACK_BEFORE_TRANSFER");
});

test("reports persisted Paystack transfer status and reference", () => {
  const [row] = buildSellerPayoutReconciliationRows([
    makeItem({ transferStatus: "SUCCESS", transferReference: "QRSP_reference", fulfillmentStatus: "SHIPPED" }),
  ]);

  assert.equal(row?.transferStatus, "SUCCESS");
  assert.equal(row?.transferReference, "QRSP_reference");
  assert.equal(row?.action, "PAYSTACK_TRANSFER_SUCCESS");
});

test("marks a paid, fulfilled product line available to cash out only after fulfillment", () => {
  const [ready] = buildSellerPayoutReconciliationRows([
    makeItem({ transferStatus: "PENDING", fulfillmentStatus: "READY_FOR_PICKUP" }),
  ]);
  const [notReady] = buildSellerPayoutReconciliationRows([
    makeItem({ transferStatus: "PENDING", fulfillmentStatus: "PENDING_HANDOFF" }),
  ]);

  assert.equal(ready?.action, "AVAILABLE_TO_CASH_OUT");
  assert.equal(notReady?.action, "WAIT_FOR_FULFILLMENT");
});

test("blocks cancelled orders, invalid amounts, and unverified or missing recipients", () => {
  const rows = buildSellerPayoutReconciliationRows([
    makeItem({ orderId: "order-1", orderStatus: "CANCELLED" }),
    makeItem({ orderId: "order-2", sellerFeeCents: 4_000 }),
    makeItem({ orderId: "order-3", payoutStatus: "PENDING" }),
    makeItem({ orderId: "order-4", recipientCode: null }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.action).sort(),
    [
      "BLOCKED_CANCELLED_ORDER",
      "BLOCKED_INVALID_AMOUNT",
      "BLOCKED_NO_PAYSTACK_RECIPIENT",
      "BLOCKED_PAYOUT_NOT_VERIFIED",
    ].sort(),
  );
});

test("CSV escapes fields and neutralizes formula-leading seller-controlled text", () => {
  const [row] = buildSellerPayoutReconciliationRows([
    makeItem({ sellerName: '=HYPERLINK("https://bad.example")' }),
  ]);
  const csv = sellerPayoutReconciliationCsv([row!]);

  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example""\)"/);
  assert.match(csv, /"NOT_TRACKED"/);
});
