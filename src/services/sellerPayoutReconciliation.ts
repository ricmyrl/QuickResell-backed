export type PayoutOrderItem = {
  id: string;
  orderId: string;
  sellerId: string;
  quantity: number;
  unitPriceCents: number;
  sellerFeeCents: number;
  fulfillmentStatus: string;
  seller: {
    displayName: string | null;
    sellerVerification: {
      payoutStatus: string;
      bankName: string | null;
      bankAccountLast4: string | null;
      paystackRecipientCode: string | null;
    } | null;
  };
  sellerPayout: {
    status: string;
    transferReference: string | null;
    amountKobo: number | null;
  } | null;
  order: {
    id: string;
    paymentReference: string | null;
    status: string;
    createdAt: Date;
  };
};

export type SellerPayoutReconciliationRow = {
  orderId: string;
  orderCreatedAt: string;
  orderStatus: string;
  paymentReference: string;
  sellerId: string;
  sellerName: string;
  quantity: number;
  fulfillmentStatus: string;
  grossUsdCents: number;
  sellerFeeUsdCents: number;
  netPayoutUsdCents: number;
  payoutStatus: string;
  bankName: string;
  bankAccountLast4: string;
  paystackRecipientCode: string;
  transferStatus: string;
  transferReference: string;
  action: string;
};

export function buildSellerPayoutReconciliationRows(
  items: PayoutOrderItem[],
): SellerPayoutReconciliationRow[] {
  return items.map((item) => {
    const grossCents = item.quantity * item.unitPriceCents;
    const validAmounts = Number.isSafeInteger(item.quantity)
      && item.quantity > 0
      && Number.isSafeInteger(item.unitPriceCents)
      && item.unitPriceCents >= 0
      && Number.isSafeInteger(item.sellerFeeCents)
      && item.sellerFeeCents >= 0
      && Number.isSafeInteger(grossCents)
      && item.sellerFeeCents <= grossCents;
    const safeGrossCents = validAmounts ? grossCents : 0;
    const safeFeeCents = validAmounts ? item.sellerFeeCents : 0;
    const verification = item.seller.sellerVerification;
    const row: SellerPayoutReconciliationRow = {
      orderId: item.order.id,
      orderCreatedAt: item.order.createdAt.toISOString(),
      orderStatus: item.order.status,
      paymentReference: item.order.paymentReference ?? "",
      sellerId: item.sellerId,
      sellerName: item.seller.displayName ?? "",
      quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0,
      fulfillmentStatus: item.fulfillmentStatus,
      grossUsdCents: safeGrossCents,
      sellerFeeUsdCents: safeFeeCents,
      netPayoutUsdCents: safeGrossCents - safeFeeCents,
      payoutStatus: verification?.payoutStatus ?? "NOT_STARTED",
      bankName: verification?.bankName ?? "",
      bankAccountLast4: verification?.bankAccountLast4 ?? "",
      paystackRecipientCode: verification?.paystackRecipientCode ?? "",
      transferStatus: item.sellerPayout?.status ?? "NOT_TRACKED",
      transferReference: item.sellerPayout?.transferReference ?? "",
      action: "",
    };
    row.action = row.orderStatus === "CANCELLED"
      ? "BLOCKED_CANCELLED_ORDER"
      : !validAmounts
        ? "BLOCKED_INVALID_AMOUNT"
        : row.transferStatus === "SUCCESS"
          ? "PAYSTACK_TRANSFER_SUCCESS"
          : row.transferStatus === "PROCESSING"
            ? "WAIT_FOR_PAYSTACK_TRANSFER"
            : row.transferStatus === "FAILED" || row.transferStatus === "REVERSED" || row.transferStatus === "REVIEW_REQUIRED"
              ? "RECONCILE_WITH_PAYSTACK"
              : row.transferStatus === "BLOCKED"
                ? "PAYOUT_BLOCKED"
        : row.netPayoutUsdCents <= 0
          ? "BLOCKED_NON_POSITIVE_PAYOUT"
          : row.payoutStatus !== "VERIFIED"
            ? "BLOCKED_PAYOUT_NOT_VERIFIED"
            : !row.paystackRecipientCode
              ? "BLOCKED_NO_PAYSTACK_RECIPIENT"
              : row.transferStatus === "PENDING"
              ? ["READY_FOR_PICKUP", "SHIPPED", "COMPLETED"].includes(row.fulfillmentStatus)
                ? "AVAILABLE_TO_CASH_OUT"
                : "WAIT_FOR_FULFILLMENT"
              : "RECONCILE_WITH_PAYSTACK_BEFORE_TRANSFER";
    return row;
  }).sort((left, right) =>
    left.orderCreatedAt.localeCompare(right.orderCreatedAt)
    || left.orderId.localeCompare(right.orderId)
    || left.sellerId.localeCompare(right.sellerId));
}

const columns: Array<keyof SellerPayoutReconciliationRow> = [
  "orderId",
  "orderCreatedAt",
  "orderStatus",
  "paymentReference",
  "sellerId",
  "sellerName",
  "quantity",
  "fulfillmentStatus",
  "grossUsdCents",
  "sellerFeeUsdCents",
  "netPayoutUsdCents",
  "payoutStatus",
  "bankName",
  "bankAccountLast4",
  "paystackRecipientCode",
  "transferStatus",
  "transferReference",
  "action",
];

function csvCell(value: string | number): string {
  const text = String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function sellerPayoutReconciliationCsv(rows: SellerPayoutReconciliationRow[]): string {
  const header = columns.map((column) => csvCell(column)).join(",");
  const lines = rows.map((row) => columns.map((column) => csvCell(row[column])).join(","));
  return [header, ...lines].join("\r\n");
}
