import type { Metadata } from "next";
import { BacktestClient } from "./backtest-client";

export const metadata: Metadata = { title: "Backtest" };

export default function BacktestPage() {
  return <BacktestClient />;
}
