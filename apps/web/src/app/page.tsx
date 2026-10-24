import type { Metadata } from "next";
import { HomeContent } from "@/components/marketing/home-content";

export const metadata: Metadata = {
  title: "StockWise | Inventory and sales, in one workspace",
  description:
    "Catalog, branch inventory, purchasing, receiving, POS, sales history and analytics for SME retail operations.",
};
export default function HomePage() {
  return <HomeContent />;
}
