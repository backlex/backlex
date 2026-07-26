import { isConfigured } from "@/lib/backlex";
import { NotConfigured } from "../ui";
import { SignInForm } from "./form";

export default function SignInPage() {
  if (!isConfigured()) return <NotConfigured />;
  return <SignInForm />;
}
