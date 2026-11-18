"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, Loader2Icon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Client-side or server-side filterable combobox.
 *
 * Client-side filtering (default): `items` is the value collection and a
 * render-prop child of `ComboboxList` lets Base UI render only matches. Object
 * values display their `label` in the input, and `itemToStringValue` produces
 * the value submitted with the form.
 *
 * ```tsx
 * const items = [{ value: "react", label: "React" }];
 * <Combobox items={items} name="framework" itemToStringValue={(item) => item.value}>
 *   <ComboboxInput placeholder="Search frameworks" />
 *   <ComboboxContent>
 *     <ComboboxEmpty>No matches</ComboboxEmpty>
 *     <ComboboxList>
 *       {(item) => (
 *         <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>
 *       )}
 *     </ComboboxList>
 *   </ComboboxContent>
 * </Combobox>
 * ```
 *
 * Server-side search: pass `filter={null}` so Base UI never filters, control the
 * query with `inputValue`/`onInputValueChange`, and render the already-filtered
 * array. Fetching and debouncing belong to the consumer (a `filter={null}` root
 * never filters on its own):
 *
 * ```tsx
 * <Combobox
 *   items={results}
 *   filter={null}
 *   inputValue={query}
 *   onInputValueChange={(value) => setQuery(value)}
 *   value={selected}
 *   onValueChange={setSelected}
 *   itemToStringValue={(item) => item.value}
 * >
 *   <ComboboxInput placeholder="Search by SKU" />
 *   <ComboboxContent>
 *     <ComboboxEmpty>No matches</ComboboxEmpty>
 *     <ComboboxList>
 *       {results.map((item) => (
 *         <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>
 *       ))}
 *     </ComboboxList>
 *     <ComboboxLoadMore loading={isFetchingNextPage} onClick={fetchNextPage}>
 *       Load more
 *     </ComboboxLoadMore>
 *   </ComboboxContent>
 * </Combobox>
 * ```
 *
 * The root `name` renders a hidden input carrying the selected value, so the
 * combobox participates in native form submission (`FormData`).
 */
function Combobox<Value = string, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  return <ComboboxPrimitive.Root {...props} />;
}

function ComboboxInput({
  className,
  showClear = false,
  triggerLabel = "Show options",
  clearLabel = "Clear",
  ...props
}: ComboboxPrimitive.Input.Props & {
  showClear?: boolean;
  triggerLabel?: string;
  clearLabel?: string;
}) {
  return (
    <div
      data-slot="combobox-input-group"
      className="relative flex w-full min-w-0 items-center"
    >
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pl-2.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          showClear ? "pr-16" : "pr-8",
          className,
        )}
        {...props}
      />
      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
        {showClear ? (
          <ComboboxPrimitive.Clear
            data-slot="combobox-clear"
            aria-label={clearLabel}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:pointer-events-none data-disabled:opacity-50"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </ComboboxPrimitive.Clear>
        ) : null}
        <ComboboxPrimitive.Trigger
          data-slot="combobox-trigger"
          aria-label={triggerLabel}
          className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronDownIcon className="size-4 shrink-0" aria-hidden="true" />
        </ComboboxPrimitive.Trigger>
      </div>
    </div>
  );
}

function ComboboxContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative z-50 max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  value,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      // Exposes the option value to tests and Playwright; object values pass
      // their own `data-value` through `props`.
      data-value={typeof value === "string" ? value : undefined}
      value={value}
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        data-slot="combobox-item-indicator"
        className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center"
      >
        <ComboboxPrimitive.ItemIndicator>
          <CheckIcon className="size-4" aria-hidden="true" />
        </ComboboxPrimitive.ItemIndicator>
      </span>
      {children}
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "px-2 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  );
}

function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxSeparator({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn(
        "pointer-events-none -mx-1 my-1 h-px bg-border data-[orientation=vertical]:mx-1 data-[orientation=vertical]:my-0 data-[orientation=vertical]:h-auto data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxStatus({
  className,
  ...props
}: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      data-slot="combobox-status"
      className={cn(
        "px-2 py-1 text-xs text-muted-foreground empty:hidden",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Footer button for paginated/server-side combobox results. It is a plain
 * `button`, so `Tab`/`Shift+Tab` reach it and it does not dismiss the popup.
 */
function ComboboxLoadMore({
  className,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  loading?: boolean;
}) {
  return (
    <button
      data-slot="combobox-load-more"
      data-loading={loading ? "" : undefined}
      {...props}
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "mt-1 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {loading ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxLoadMore,
  ComboboxSeparator,
  ComboboxStatus,
};
