import { redirect } from "next/navigation";

// A raiz e resolvida no middleware; este redirect cobre o fallback direto.
export default function RootPage() {
  redirect("/dashboard");
}
