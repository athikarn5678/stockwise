"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OptionSelect } from "@/components/option-select";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/providers/language-provider";

/**
 * Shared page chrome for every /app page: one centered width and spacing, one
 * header, one tab style, one list toolbar and one Active/Inactive filter.
 */

/** The single centered content column of an application page. */
export function PageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("mx-auto w-full min-w-0 max-w-6xl space-y-6", className)}
      data-slot="page-container"
    >
      {children}
    </section>
  );
}

/** Title, optional description and optional actions (right aligned on wide screens). */
export function PageHeader({
  actions,
  children,
  description,
  title,
}: {
  actions?: ReactNode;
  /** Extra content above the title, for example a back link. */
  children?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <header
      className="flex flex-wrap items-start justify-between gap-3"
      data-slot="page-header"
    >
      <div className="min-w-0 space-y-1">
        {children}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export interface PageTab<Id extends string = string> {
  id: Id;
  label: ReactNode;
}

/**
 * Pill tabs (the Analytics style): a selected pill and outlined siblings, with no
 * underline and no border line beneath the row.
 */
export function PageTabs<Id extends string>({
  ariaLabel,
  className,
  onValueChange,
  tabs,
  value,
}: {
  ariaLabel?: string;
  className?: string;
  onValueChange: (id: Id) => void;
  tabs: ReadonlyArray<PageTab<Id>>;
  value: Id;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-2", className)}
      data-slot="page-tabs"
      role="group"
    >
      {tabs.map((tab) => (
        <Button
          aria-pressed={value === tab.id}
          key={tab.id}
          onClick={() => onValueChange(tab.id)}
          type="button"
          variant={value === tab.id ? "secondary" : "outline"}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  );
}

export type StatusFilterValue = "ACTIVE" | "INACTIVE" | "ALL";

/**
 * The Active/Inactive/All dropdown used wherever a list can be filtered by
 * lifecycle status. Pass `labels` to say "Active products" instead of "Active".
 */
export function StatusFilter({
  className,
  label,
  labels,
  onValueChange,
  value,
}: {
  className?: string;
  /** Visible field label; defaults to "Status". */
  label?: string;
  labels?: { active?: string; all?: string; inactive?: string };
  onValueChange: (value: StatusFilterValue) => void;
  value: StatusFilterValue;
}) {
  const { t } = useLanguage();
  return (
    <Label className={cn("form-field", className)} data-slot="status-filter">
      {label ?? t("commonStatus")}
      <OptionSelect
        className="w-full"
        onValueChange={(next) => onValueChange(next as StatusFilterValue)}
        options={[
          { label: labels?.active ?? t("commonActive"), value: "ACTIVE" },
          { label: labels?.inactive ?? t("commonInactive"), value: "INACTIVE" },
          { label: labels?.all ?? t("commonAll"), value: "ALL" },
        ]}
        value={value}
      />
    </Label>
  );
}

/**
 * Search, Status filter and Refresh in one row (the Suppliers toolbar). Pass a
 * `StatusFilter` as `status`; omit it for lists without a status.
 */
export function ListToolbar({
  onRefresh,
  refreshLabel,
  search,
  status,
}: {
  onRefresh?: () => void;
  refreshLabel?: string;
  search?: {
    defaultValue?: string;
    label: string;
    onChange: (value: string) => void;
    placeholder?: string;
    value?: string;
  };
  status?: ReactNode;
}) {
  const { t } = useLanguage();
  // Literal class names so Tailwind generates them.
  const layout =
    search && status && onRefresh
      ? "sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
      : search && status
        ? "sm:grid-cols-[minmax(0,1fr)_12rem]"
        : search && onRefresh
          ? "sm:grid-cols-[minmax(0,1fr)_auto]"
          : status && onRefresh
            ? "sm:grid-cols-[12rem_auto] sm:justify-start"
            : "";
  return (
    <div className={cn("grid gap-3", layout)} data-slot="list-toolbar">
      {search ? (
        <Label className="form-field">
          {search.label}
          <Input
            {...(search.value === undefined
              ? { defaultValue: search.defaultValue ?? "" }
              : { value: search.value })}
            onChange={(event) => search.onChange(event.target.value)}
            {...(search.placeholder === undefined
              ? {}
              : { placeholder: search.placeholder })}
          />
        </Label>
      ) : null}
      {status}
      {onRefresh ? (
        <Button
          className="self-end"
          onClick={onRefresh}
          type="button"
          variant="outline"
        >
          {refreshLabel ?? t("commonRefresh")}
        </Button>
      ) : null}
    </div>
  );
}
