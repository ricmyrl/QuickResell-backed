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
    seller: {
      displayName: options.sellerName ?? "Seller",
      sellerVerification: {
        payoutStatus: options.payoutStatus ?? "VERIFIED",
        bankName: "Example Bank",
        bankAccountLast4: "1234",
        paystackRecipientCode: options.recipientCode === undefined ? "RCP_123" : options.recipientCode,
      },
    },
    order: {
      id: options.orderId ?? "order-1",
      paymentReference: "PAY_123",
      status: options.orderStatus ?? "COMPLETED",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      sellerPayouts: options.transferStatus ? [{
        sellerId: "seller-1",
        status: options.transferStatus,
        transferReference: options.transferReference ?? null,
      }] : [],
    },
  };
}

test("groups an order's items per seller and calculates the same net amount as checkout", () => {
  const [row] = buildSellerPayoutReconciliationRows([
    makeItem(),
    makeItem({ id: "item-2", quantity: 1, unitPriceCents: 500, sellerFeeCents: 0 }),
  ]);

  assert.equal(row?.itemCount, 2);
  assert.equal(row?.quantity, 3);
  assert.equal(row?.grossUsdCents, 3_500);
  assert.equal(row?.sellerFeeUsdCents, 200);
  assert.equal(row?.netPayoutUsdCents, 3_300);
  assert.equal(row?.transferStatus, "NOT_TRACKED");
  assert.equal(row?.transferReference, "");
  assert.equal(row?.action, "RECONCILE_WITH_PAYSTACK_BEFORE_TRANSFER");
});

test("reports persisted Paystack transfer status and reference", () => {
  const [row] = buildSellerPayoutReconciliationRows([
    makeItem({ transferStatus: "SUCCESS", transferReference: "QRSP_reference" }),
  ]);

  assert.equal(row?.transferStatus, "SUCCESS");
  assert.equal(row?.transferReference, "QRSP_reference");
  assert.equal(row?.action, "PAYSTACK_TRANSFER_SUCCESS");
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
