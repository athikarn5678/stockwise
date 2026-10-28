"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { th } from "react-day-picker/locale";
import "react-day-picker/style.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useLanguage } from "@/providers/language-provider";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a calendar date without any timezone conversion (no off-by-one). */
export function parseIsoDate(value: string): Date | undefined {
  const match = ISO_DATE.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : undefined;
}

export function formatIsoDate(date: Date): string {
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * Drop-in replacement for `<input type="date">`: a labelled text field holding
 * an ISO `YYYY-MM-DD` value (so the surrounding form logic is unchanged) plus
 * an accessible calendar popover. Typing and keyboard selection both work.
 */
export function DateInput({
  className,
  disabled,
  onChange,
  value,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const { language } = useLanguage();
  const input = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const text = typeof value === "string" ? value : "";
  const selected = parseIsoDate(text);
  const invalid = text !== "" && selected === undefined;

  function pick(date: Date | undefined) {
    if (date === undefined || input.current === null) return;
    // Use the native setter so React's onChange receives a real change event.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input.current, formatIsoDate(date));
    input.current.dispatchEvent(new Event("input", { bubbles: true }));
    setOpen(false);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Input
        {...props}
        aria-invalid={props["aria-invalid"] ?? (invalid ? true : undefined)}
        className={className}
        disabled={disabled}
        inputMode="numeric"
        maxLength={10}
        onChange={onChange}
        pattern="\d{4}-\d{2}-\d{2}"
        placeholder="YYYY-MM-DD"
        ref={input}
        type="text"
        value={text}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={language === "th" ? "เลือกวันที่" : "Choose date"}
              disabled={disabled}
              size="icon"
              type="button"
              variant="outline"
            />
          }
        >
          <CalendarIcon aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent>
          <DayPicker
            mode="single"
            onSelect={pick}
            {...(selected === undefined
              ? {}
              : { defaultMonth: selected, selected })}
            {...(language === "th" ? { locale: th } : {})}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}
