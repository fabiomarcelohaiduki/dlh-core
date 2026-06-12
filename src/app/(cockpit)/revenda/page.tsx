import type { Metadata } from "next";
import { RevendaClient } from "./revenda-client";

export const metadata: Metadata = { title: "Revenda" };

export default function RevendaPage() {
  return <RevendaClient />;
}
