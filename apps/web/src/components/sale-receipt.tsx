import { formatThb } from "@/money-display";
import { useLanguage } from "@/providers/language-provider";
import type { CompletedSale, SalesHistoryDetail } from "@/sales-api-client";

export function SaleReceipt({
  sale,
}: {
  sale: CompletedSale | SalesHistoryDetail;
}) {
  const { t } = useLanguage();
  // Both API projections contain frozen Sale facts; adapt names, never economics.
  const receipt =
    "occurredAt" in sale
      ? {
          actorDisplayName: sale.actorDisplayNameSnapshot,
          branchCode: sale.branchCodeSnapshot,
          branchName: sale.branchNameSnapshot,
          timestamp: sale.occurredAt,
          organizationName: sale.organizationNameSnapshot,
          items: sale.items.map((item) => ({
            ...item,
            productName: item.nameSnapshot,
            productSku: item.skuSnapshot,
            unit: item.unitSnapshot,
          })),
        }
      : { ...sale, timestamp: sale.createdAt };

  return (
    <>
      <p className="text-sm text-muted-foreground">{t("receiptPreview")}</p>
      <article aria-label={t("receiptAria")} className="sales-receipt">
        <header className="sales-receipt-header">
          <h2>{receipt.organizationName}</h2>
          <p>
            {receipt.branchCode} — {receipt.branchName}
          </p>
          <p>{t("receiptKind")}</p>
        </header>
        <div className="sales-receipt-identity">
          <p>{t("receiptSale").replace("{reference}", sale.reference)}</p>
          <p>
            {receipt.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}
          </p>
          <p>
            {t("receiptCashier").replace("{name}", receipt.actorDisplayName)}
          </p>
        </div>
        <ul className="sales-receipt-items">
          {receipt.items.map((item) => (
            <li key={item.id}>
              <p className="sales-receipt-item-name">{item.productName}</p>
              <div className="sales-receipt-row">
                <span>
                  {item.quantity} {item.unit} × {formatThb(item.unitPrice)}
                </span>
                <strong>{formatThb(item.lineNet)}</strong>
              </div>
              <p className="sales-receipt-sku">{item.productSku}</p>
            </li>
          ))}
        </ul>
        <div className="sales-receipt-summary">
          <dl>
            <ReceiptAmount
              label={t("receiptSubtotal")}
              value={sale.subtotalAmount}
            />
            {sale.discountAmount !== "0.00" ? (
              <ReceiptAmount
                label={t("receiptDiscount")}
                value={sale.discountAmount}
              />
            ) : null}
            {sale.taxableAmount !== null ? (
              <ReceiptAmount
                label={t("receiptTaxable")}
                value={sale.taxableAmount}
              />
            ) : null}
            <ReceiptAmount
              label={t("receiptVat")}
              value={sale.outputVatAmount}
            />
            <ReceiptAmount
              label={t("receiptTotal")}
              value={sale.totalAmount}
              emphasis
            />
          </dl>
          <footer>
            <p>
              {t("receiptPayment")
                .replace(
                  "{method}",
                  sale.payment.method === "CASH"
                    ? t("paymentCash")
                    : t("paymentTransfer"),
                )
                .replace("{amount}", formatThb(sale.payment.amount))}
            </p>
            {sale.payment.method === "CASH" ? (
              <p>
                {t("receiptTendered")
                  .replace("{tendered}", formatThb(sale.payment.amountTendered))
                  .replace("{change}", formatThb(sale.payment.changeAmount))}
              </p>
            ) : null}
            {sale.payment.method === "TRANSFER" &&
            sale.payment.reference !== null ? (
              <p>
                {t("receiptTransferRef").replace(
                  "{reference}",
                  sale.payment.reference,
                )}
              </p>
            ) : null}
            <p className="sales-receipt-thanks">{t("receiptThanks")}</p>
          </footer>
        </div>
      </article>
    </>
  );
}

function ReceiptAmount({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`sales-receipt-row${emphasis ? " sales-receipt-total" : ""}`}
    >
      <dt>{label}</dt>
      <dd>{formatThb(value)}</dd>
    </div>
  );
}
