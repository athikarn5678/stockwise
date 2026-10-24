import type { Metadata } from "next";
import { PricingContent } from "@/components/marketing/pricing-content";

export const metadata: Metadata = {
  title: "StockWise pricing | Pre-launch plan concepts",
  description:
    "Explore Starter, Growth, Business, and Enterprise plan concepts for SME retail operations. Prices and allowances are proposals only and are not enforced.",
};

export default function PricingPage() {
  return <PricingContent />;
}
