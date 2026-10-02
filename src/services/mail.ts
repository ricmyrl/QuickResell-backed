import formData from "form-data";
import Mailgun from "mailgun.js";

const mailgun = new Mailgun(formData);
let client: ReturnType<typeof mailgun.client> | null = null;

function getMailgunClient() {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN ?? process.env.SANDBOX_URL_DOMAIN;

  if (!apiKey || !domain) {
    console.warn("Mailgun is not configured; skipping transactional email delivery.");
    return null;
  }

  if (!client) {
    client = mailgun.client({
      username: "api",
      key: apiKey,
      url: "https://api.mailgun.net",
    });
  }

  return { client, domain };
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export async function sendAuctionWonEmail(
  recipientEmail: string,
  itemTitle: string,
  finalPrice: number,
): Promise<void> {
  const clientConfig = getMailgunClient();
  if (!clientConfig) return;

  const cleanTitle = itemTitle.trim().replace(/\s+/g, " ").slice(0, 120) || "your item";
  const amount = formatCurrency(finalPrice);
  const authorizedRecipient = process.env.AUTHORIZED_RECIPIENT?.trim();
  const targetRecipient = authorizedRecipient || recipientEmail;

  try {
    await clientConfig.client.messages.create(clientConfig.domain, {
      from: `Quick Resell <noreply@${clientConfig.domain}>`,
      to: [targetRecipient],
      subject: `You won: ${cleanTitle}`,
      text: `Congratulations! You won \"${cleanTitle}\" on Quick Resell for ${amount}. Please coordinate payment and pickup with the seller.`,
      html: `
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Auction win receipt</title>
          </head>
          <body style="margin:0; padding:0; background-color:#f4f6f4; font-family:Arial, Helvetica, sans-serif; color:#1d2a25;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f4; padding:32px 16px;">
              <tr>
                <td align="center">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#ffffff; border:1px solid #e8efe9; border-radius:18px; overflow:hidden;">
                    <tr>
                      <td style="padding:28px 28px 14px; background:#203c32; color:#ffffff; font-size:28px; line-height:1.2; font-weight:700;">
                        Quick Resell
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:28px;">
                        <p style="margin:0 0 12px; font-size:14px; letter-spacing:0.12em; text-transform:uppercase; color:#5a7265; font-weight:700;">
                          Auction won
                        </p>
                        <h1 style="margin:0 0 16px; font-size:32px; line-height:1.15; color:#1d2a25;">Congratulations!</h1>
                        <p style="margin:0 0 20px; font-size:16px; line-height:1.7; color:#475a52;">
                          You won <strong style="color:#1d2a25;">${cleanTitle}</strong> for <strong style="color:#1d2a25;">${amount}</strong>.
                        </p>
                        <p style="margin:0 0 24px; font-size:16px; line-height:1.7; color:#475a52;">
                          Please coordinate payment and pickup directly with the seller through the Quick Resell marketplace.
                        </p>
                        <table role="presentation" cellpadding="0" cellspacing="0" style="background:#f8faf8; border:1px solid #e5ece5; border-radius:12px; width:100%;">
                          <tr>
                            <td style="padding:18px 20px;">
                              <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:#71827a; font-weight:700;">Final price</div>
                              <div style="margin-top:8px; font-size:28px; font-weight:700; color:#203c32;">${amount}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:0 28px 28px; font-size:12px; line-height:1.7; color:#78877e;">
                        This receipt was generated automatically by Quick Resell.
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `,
    });
  } catch (error) {
    console.error("Failed to send auction won email.", {
      recipientEmail,
      itemTitle,
      finalPrice,
      error,
    });
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export async function sendScoutSupportEmail({
  requestId,
  customerEmail,
  category,
  message,
}: {
  requestId: string;
  customerEmail: string | null;
  category: string;
  message: string;
}): Promise<boolean> {
  const recipient = process.env.SCOUT_SUPPORT_EMAIL?.trim();
  if (!recipient) return false;

  const clientConfig = getMailgunClient();
  if (!clientConfig) return false;

  const safeMessage = message.trim().slice(0, 2000);
  try {
    await clientConfig.client.messages.create(clientConfig.domain, {
      from: `Quick Resell Support <support@${clientConfig.domain}>`,
      to: [recipient],
      subject: `Scout support request ${requestId}`,
      text: `Request: ${requestId}\nCategory: ${category}\nCustomer: ${customerEmail ?? "Unavailable"}\n\n${safeMessage}`,
      html: `<p><strong>Request:</strong> ${escapeHtml(requestId)}</p><p><strong>Category:</strong> ${escapeHtml(category)}</p><p><strong>Customer:</strong> ${escapeHtml(customerEmail ?? "Unavailable")}</p><pre style="white-space:pre-wrap;font:14px/1.5 sans-serif">${escapeHtml(safeMessage)}</pre>`,
    });
    return true;
  } catch (error) {
    console.error("Failed to notify the configured Scout support inbox.", {
      requestId,
      error,
    });
    return false;
  }
}

export async function sendScoutWatchlistEmail({
  recipientEmail,
  itemTitle,
  maxBid,
  bidStep,
  note,
}: {
  recipientEmail: string;
  itemTitle: string;
  maxBid: number;
  bidStep: number;
  note: string;
}): Promise<boolean> {
  const clientConfig = getMailgunClient();
  if (!clientConfig) return false;

  const cleanTitle = itemTitle.trim().replace(/\s+/g, " ").slice(0, 120) || "your watched item";
  const subject = `Scout watchlist update: ${cleanTitle}`;
  const text = `Scout has updated your watchlist for "${cleanTitle}". Max bid: ${formatCurrency(maxBid)}. Bid step: ${formatCurrency(bidStep)}. ${note}`;

  try {
    await clientConfig.client.messages.create(clientConfig.domain, {
      from: `Quick Resell Scout <scout@${clientConfig.domain}>`,
      to: [recipientEmail],
      subject,
      text,
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif; color:#1d2a25; line-height:1.6;">
          <h2 style="margin:0 0 12px; color:#203c32;">Scout watchlist update</h2>
          <p style="margin:0 0 12px;"><strong>Item:</strong> ${escapeHtml(cleanTitle)}</p>
          <p style="margin:0 0 12px;"><strong>Max bid:</strong> ${escapeHtml(formatCurrency(maxBid))}</p>
          <p style="margin:0 0 12px;"><strong>Bid step:</strong> ${escapeHtml(formatCurrency(bidStep))}</p>
          <p style="margin:0;">${escapeHtml(note)}</p>
        </div>
      `,
    });
    return true;
  } catch (error) {
    console.error("Failed to send Scout watchlist email.", {
      recipientEmail,
      itemTitle,
      maxBid,
      bidStep,
      note,
      error,
    });
    return false;
  }
}
