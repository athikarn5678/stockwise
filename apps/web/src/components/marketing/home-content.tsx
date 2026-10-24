"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  ClipboardList,
  Package,
  Receipt,
  ShoppingCart,
  Store,
  Truck,
} from "lucide-react";
import { useLanguage } from "@/providers/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const features = [
  [Package, "marketingFeatureCatalog", "marketingFeatureCatalogCopy"],
  [Boxes, "marketingFeatureInventory", "marketingFeatureInventoryCopy"],
  [Truck, "marketingFeatureSuppliers", "marketingFeatureSuppliersCopy"],
  [
    ClipboardList,
    "marketingFeaturePurchasing",
    "marketingFeaturePurchasingCopy",
  ],
  [ShoppingCart, "marketingFeaturePos", "marketingFeaturePosCopy"],
  [Receipt, "marketingFeatureHistory", "marketingFeatureHistoryCopy"],
  [BarChart3, "marketingFeatureAnalytics", "marketingFeatureAnalyticsCopy"],
  [Store, "marketingFeatureAccess", "marketingFeatureAccessCopy"],
] as const;
const nav = [
  "marketingOverview",
  "marketingCatalog",
  "marketingInventory",
  "marketingPurchasing",
  "marketingSales",
  "marketingAnalytics",
] as const;
const metrics = [
  ["marketingNetSales", "marketingNetSalesValue"],
  ["marketingCompletedSales", "marketingCompletedSalesValue"],
  ["marketingProductsReview", "marketingProductsReviewValue"],
] as const;
const rows = [
  ["marketingProductTea", "TEA-01", "24", "marketingStable"],
  ["marketingProductCoffee", "COF-02", "6", "marketingReorderReview"],
  ["marketingProductCups", "CUP-03", "120", "marketingStable"],
] as const;
const workflow = [
  ["marketingPurchase", "marketingPurchaseCopy"],
  ["marketingReceive", "marketingReceiveCopy"],
  ["marketingStock", "marketingStockCopy"],
  ["marketingSell", "marketingSellCopy"],
  ["marketingReviewStep", "marketingReviewCopy"],
] as const;
const days = [
  "marketingMonday",
  "marketingTuesday",
  "marketingWednesday",
  "marketingThursday",
  "marketingFriday",
] as const;
const heights = [50, 75, 62, 100, 87];
export function HomeContent() {
  const { t } = useLanguage();
  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      <section
        aria-labelledby="hero-title"
        className="mx-auto max-w-3xl py-16 text-center sm:py-24"
      >
        <Badge variant="outline">{t("marketingHeroBadge")}</Badge>
        <h1
          id="hero-title"
          className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
        >
          {t("marketingHeroTitle")}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg">
          {t("marketingHeroCopy")}
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button
            size="lg"
            nativeButton={false}
            role="link"
            render={<Link href="/register" />}
          >
            {t("marketingGetStarted")}
            <ArrowRight />
          </Button>
          <Button
            size="lg"
            variant="outline"
            nativeButton={false}
            role="link"
            render={<Link href="#features" />}
          >
            {t("marketingViewFeatures")}
          </Button>
        </div>
      </section>
      <section aria-label={t("marketingPreviewLabel")} className="pb-16">
        <Card className="gap-0 overflow-hidden">
          <CardHeader className="flex-row items-center justify-between border-b pb-4">
            <div className="flex items-center gap-2 font-semibold">
              <Package className="size-4" />
              {t("marketingBrandBranch")}
            </div>
            <Badge variant="secondary">{t("marketingIllustrative")}</Badge>
          </CardHeader>
          <CardContent className="grid gap-6 pt-6 md:grid-cols-[160px_1fr]">
            <div className="hidden space-y-1 border-r pr-4 text-sm md:block">
              {nav.map((key, i) => (
                <p
                  key={key}
                  className={
                    i === 0
                      ? "rounded-md bg-muted px-3 py-2 font-medium"
                      : "px-3 py-2 text-muted-foreground"
                  }
                >
                  {t(key)}
                </p>
              ))}
            </div>
            <div className="min-w-0 space-y-6">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("marketingOperationsOverview")}
                </p>
                <h2 className="mt-1 text-xl font-semibold">
                  {t("marketingStorePicture")}
                </h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {metrics.map(([label, value]) => (
                  <Card size="sm" key={label}>
                    <CardContent>
                      <p className="text-xs text-muted-foreground">
                        {t(label)}
                      </p>
                      <p className="mt-2 text-xl font-semibold tabular-nums">
                        {label === "marketingNetSales"
                          ? `${t("marketingCurrency")} ${t(value)}`
                          : t(value)}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("marketingProduct")}</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">
                        {t("marketingAvailable")}
                      </TableHead>
                      <TableHead>{t("marketingReview")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(([name, sku, qty, status]) => (
                      <TableRow key={sku}>
                        <TableCell className="font-medium">{t(name)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {sku}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {qty}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{t(status)}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("marketingSampleNote")}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
      <section
        id="features"
        aria-labelledby="features-title"
        className="scroll-mt-6 border-t py-16"
      >
        <p className="text-sm text-muted-foreground">
          {t("marketingFeatureEyebrow")}
        </p>
        <h2
          id="features-title"
          className="mt-2 text-3xl font-semibold tracking-tight"
        >
          {t("marketingFeaturesTitle")}
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(([Icon, title, description]) => (
            <Card key={title}>
              <CardContent>
                <Icon className="mb-4 size-5" aria-hidden="true" />
                <h3 className="font-semibold">{t(title)}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t(description)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <section aria-labelledby="workflow-title" className="border-t py-16">
        <h2
          id="workflow-title"
          className="text-3xl font-semibold tracking-tight"
        >
          {t("marketingWorkflowTitle")}
        </h2>
        <ol className="mt-8 grid gap-6 sm:grid-cols-5">
          {workflow.map(([title, copy], i) => (
            <li key={title}>
              <p className="text-xs text-muted-foreground">0{i + 1}</p>
              <h3 className="mt-2 font-semibold">{t(title)}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t(copy)}
              </p>
            </li>
          ))}
        </ol>
      </section>
      <section
        aria-labelledby="analytics-title"
        className="grid items-center gap-8 border-t py-16 md:grid-cols-2"
      >
        <div>
          <p className="text-sm text-muted-foreground">
            {t("marketingAnalyticsEyebrow")}
          </p>
          <h2
            id="analytics-title"
            className="mt-2 text-3xl font-semibold tracking-tight"
          >
            {t("marketingAnalyticsTitle")}
          </h2>
          <p className="mt-4 leading-7 text-muted-foreground">
            {t("marketingAnalyticsCopy")}
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t("marketingAnalyticsNote")}
          </p>
        </div>
        <Card>
          <CardHeader>
            <h3 className="font-semibold">{t("marketingChartTitle")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("marketingChartCaption")}
            </p>
          </CardHeader>
          <CardContent>
            <div
              className="flex h-40 items-end gap-4 border-b"
              role="img"
              aria-label={t("marketingChartAria")}
            >
              {heights.map((height, i) => (
                <div key={i} className="flex h-full flex-1 items-end">
                  <div
                    className="w-full rounded-t-sm bg-foreground/80"
                    style={{ height: `${height}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-5 text-center text-xs text-muted-foreground">
              {days.map((day) => (
                <span key={day}>{t(day)}</span>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {t("marketingChartNote")}
            </p>
          </CardContent>
        </Card>
      </section>
      <section className="flex flex-col justify-between gap-5 border-t py-12 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold">
            {t("marketingPricingTitle")}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("marketingPricingNote")}
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          role="link"
          render={<Link href="/pricing" />}
        >
          {t("marketingExplorePricing")}
          <ArrowRight />
        </Button>
      </section>
      <section
        aria-labelledby="cta-title"
        className="mb-16 rounded-xl border bg-muted/40 p-8 text-center sm:p-12"
      >
        <h2 id="cta-title" className="text-3xl font-semibold tracking-tight">
          {t("marketingCtaTitle")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl leading-7 text-muted-foreground">
          {t("marketingCtaCopy")}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button
            nativeButton={false}
            role="link"
            render={<Link href="/register" />}
          >
            {t("marketingGetStarted")}
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={<Link href="/login" />}
          >
            {t("marketingSignIn")}
          </Button>
        </div>
      </section>
    </div>
  );
}
