import { isConfigured } from "@/lib/backlex";
import { NotConfigured } from "../ui";
import { SignInForm } from "./form";

/**
 * Credentials the form opens pre-filled with — `null` unless BOTH are set.
 *
 * Read on the SERVER and handed down as a prop, which is the difference that
 * matters here: `NEXT_PUBLIC_*` would inline the value into the client bundle
 * for every build, set or not. This way an unset var means the prop is `null`
 * and nothing about the credential ever exists outside the developer's own
 * `.env`. (When it IS set, the value does reach the browser in the RSC payload
 * — it has to, the inputs are in the browser. That is the whole cost, and it is
 * the same cost the Vite examples pay.)
 */
const demo = () => {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  return email && password ? { email, password } : null;
};

export default function SignInPage() {
  if (!isConfigured()) return <NotConfigured />;
  return <SignInForm demo={demo()} />;
}
