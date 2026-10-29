import type { IdentityEmailMessage } from "./email-provider.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// Verification emails are black and white; invitation and reset keep the brand accent.
const COLOR_THEME = {
  accent: "#0f766e",
  accentText: "#ffffff",
  page: "#f1f5f9",
  body: "#334155",
  heading: "#0f172a",
  border: "#cbd5e1",
  codeBackground: "#f1f5f9",
  codeBorder: "#cbd5e1",
  footerRule: "#e2e8f0",
  footerText: "#475569",
} as const;
const MONOCHROME_THEME = {
  accent: "#000000",
  accentText: "#ffffff",
  page: "#ffffff",
  body: "#262626",
  heading: "#000000",
  border: "#d4d4d4",
  codeBackground: "#f5f5f5",
  codeBorder: "#d4d4d4",
  footerRule: "#e5e5e5",
  footerText: "#525252",
} as const;

export function renderIdentityEmail(message: IdentityEmailMessage): {
  html: string;
  text: string;
} {
  const verification = message.kind === "verification";
  const invitation = message.kind === "invitation";
  const theme = verification ? MONOCHROME_THEME : COLOR_THEME;
  const heading = verification
    ? "Verify your email"
    : invitation
      ? "You're invited to StockWise"
      : "Reset your password";
  const explanation = verification
    ? "Confirm your email address to continue setting up your StockWise account."
    : invitation
      ? "You've been invited to join an organization on StockWise. Sign in with this invited email address, or create and verify an account with it, then accept your invitation."
      : "We received a request to reset the password for your StockWise account.";
  const action = verification
    ? "Verify Email"
    : invitation
      ? "Accept Invitation"
      : "Reset Password";
  const expiry = verification
    ? "The code and link expire in 10 minutes. Only the latest requested code and link are valid."
    : invitation
      ? "This invitation is valid for seven days from issuance, unless revoked or replaced. If it has expired, ask your organization administrator for a new invitation."
      : "This password reset link expires in 30 minutes and can be used only once. If it has expired, request a new password reset.";
  const guidance = invitation
    ? "If you weren't expecting this invitation, you can ignore this email."
    : verification
      ? "Do not share this code or link. If you did not request this email, ignore it."
      : "Do not share this link. If you did not request a password reset, ignore this email. Your password will remain unchanged.";
  const proof = verification
    ? "You may be asked to confirm your current password to finish verification. Verifying your email does not sign you in."
    : "";
  const codeText = verification
    ? `Or enter this verification code in StockWise: ${message.code}`
    : "";
  const text = [
    "StockWise",
    heading,
    explanation,
    `${action}: ${message.url}`,
    codeText,
    expiry,
    proof,
    guidance,
  ]
    .filter(Boolean)
    .join("\n\n");
  const codeHtml = verification
    ? `<p style="margin:24px 0 8px;">Or enter this verification code in StockWise:</p>
      <p style="margin:0 0 24px;padding:16px;background-color:${theme.codeBackground};border:1px solid ${theme.codeBorder};border-radius:8px;text-align:center;font-family:Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:4px;color:${theme.heading};">${escapeHtml(message.code)}</p>`
    : "";

  // Only the server-generated action URL is linked; no remote assets or tracking.
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(heading)} | StockWise</title></head>
<body style="margin:0;padding:0;background-color:${theme.page};color:${theme.body};font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:collapse;background-color:#ffffff;border:1px solid ${theme.border};">
<tr><td style="padding:24px 24px 16px;border-top:4px solid ${theme.accent};color:${theme.accent};font-size:22px;font-weight:700;">StockWise</td></tr>
<tr><td style="padding:0 24px 24px;">
<h1 style="margin:0 0 16px;color:${theme.heading};font-size:26px;line-height:1.3;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;">${escapeHtml(explanation)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td bgcolor="${theme.accent}" style="border-radius:6px;text-align:center;mso-padding-alt:12px 24px;">
<a href="${escapeHtml(message.url)}" style="display:inline-block;padding:12px 24px;border:1px solid ${theme.accent};border-radius:6px;background-color:${theme.accent};color:${theme.accentText};font-size:16px;font-weight:700;line-height:1.5;text-align:center;text-decoration:none;">${action}</a>
</td></tr></table>
${codeHtml}
<p style="margin:24px 0 16px;">${escapeHtml(expiry)}</p>
${proof ? `<p style="margin:0 0 16px;">${escapeHtml(proof)}</p>` : ""}
<p style="margin:0;">${escapeHtml(guidance)}</p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${theme.footerRule};color:${theme.footerText};font-size:14px;">StockWise &mdash; Retail, connected.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
  return { html, text };
}
