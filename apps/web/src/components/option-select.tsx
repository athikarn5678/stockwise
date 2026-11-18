"use client";

import type { ComponentProps } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type OptionSelectOption = {
  value: string;
  label: string;
  disabled?: boolean | undefined;
};

type OptionSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<OptionSelectOption>;
  id?: string | undefined;
  name?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  size?: "sm" | "default" | undefined;
  className?: string | undefined;
  placeholder?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: ComponentProps<"button">["aria-invalid"];
};

/**
 * Controlled select for the common "one flat list of options" case.
 *
 * The empty string is a normal option value, so an "All"/"None" entry keeps
 * working exactly like it did with a native `<select>`: it is selectable, the
 * trigger shows its label, and `onValueChange("")` / the hidden `name` input
 * both report `""` to the caller and to form submission.
 *
 * The trigger is a `button`, so it is reachable with `getByLabelText` through
 * both `<Label htmlFor={id}>` and a wrapping `<Label>`.
 */
export function OptionSelect({
  value,
  onValueChange,
  options,
  id,
  name,
  required,
  disabled,
  size,
  className,
  placeholder,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: OptionSelectProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <Select
      disabled={disabled}
      id={id}
      items={options}
      name={name}
      onValueChange={(next) => onValueChange(next ?? "")}
      required={required}
      value={value}
    >
      <SelectTrigger
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={className}
        size={size ?? "default"}
      >
        {/* An unmatched value renders blank, like a native select. */}
        <SelectValue>{selected?.label ?? placeholder ?? ""}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
