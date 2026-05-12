// Worker-only shim for `nodemailer`. SMTP needs raw TCP (`node:net`/`node:tls`),
// which Cloudflare Workers don't provide — the SMTP email adapter is never
// selected on Workers (see `buildContext::selectEmailAdapter`), so this stub
// only exists to satisfy the bundler's static import resolution. Calling it
// throws with a hint to use an HTTP email provider instead.
const unavailable = (): never => {
  throw new Error(
    "nodemailer / SMTP is not available on Cloudflare Workers — use an HTTP email provider (resend, sendgrid, mailgun, ses).",
  );
};

export function createTransport(): never {
  return unavailable();
}

export default { createTransport };
