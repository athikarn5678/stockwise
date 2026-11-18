import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

/**
 * Test helpers for the Base UI backed `Select` (`components/ui/select.tsx`) and
 * `OptionSelect` (`components/option-select.tsx`).
 *
 * A native `<select>` could be driven with `fireEvent.change` and read with
 * `toHaveValue`. These components render a `button` trigger plus a portalled
 * listbox, so tests open the popup and click an option instead. Everything here
 * uses `fireEvent` only, because `@testing-library/user-event` is not installed.
 */

function ensureScrollIntoView() {
  // jsdom implements no layout, so Base UI's scroll-into-view helper needs a stub.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn();
  }
}

function optionElements(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole("listbox")
      .querySelectorAll<HTMLElement>('[role="option"]'),
  );
}

function findOption(
  match: (element: HTMLElement) => boolean,
  description: string,
): HTMLElement {
  const option = optionElements().find(match);
  if (!option) {
    throw new Error(
      `No option ${description} in ${String(
        optionElements().map(
          (element) =>
            `${element.textContent ?? ""} (data-value=${element.getAttribute("data-value") ?? ""})`,
        ),
      )}`,
    );
  }
  return option;
}

function pickOption(option: HTMLElement): void {
  // Base UI arms pointer selection on pointerdown; a bare jsdom `click` is
  // treated as a stale mouse click and ignored.
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

async function settle(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
}

function openSelect(trigger: HTMLElement): void {
  ensureScrollIntoView();
  // Outside another `act` scope the popup is mounted by the time this returns.
  fireEvent.click(trigger);
}

/** Opens the popup and selects the option whose visible label matches. */
export async function chooseOption(
  trigger: HTMLElement,
  optionLabel: string | RegExp,
): Promise<void> {
  openSelect(trigger);
  pickOption(
    findOption(
      (element) =>
        optionLabel instanceof RegExp
          ? optionLabel.test(element.textContent ?? "")
          : (element.textContent ?? "").trim() === optionLabel,
      optionLabel instanceof RegExp
        ? `matching ${String(optionLabel)}`
        : `labelled ${optionLabel}`,
    ),
  );
  await settle();
}

/** Opens the popup and selects the option whose `data-value` matches. */
export async function chooseOptionByValue(
  trigger: HTMLElement,
  value: string,
): Promise<void> {
  openSelect(trigger);
  pickOption(
    findOption(
      (element) => element.getAttribute("data-value") === value,
      `with value ${JSON.stringify(value)}`,
    ),
  );
  await settle();
}

/** Reads every option value in the popup, then closes it again. */
export async function readSelectOptionValues(
  trigger: HTMLElement,
): Promise<string[]> {
  openSelect(trigger);
  const values = optionElements().map(
    (element) => element.getAttribute("data-value") ?? "",
  );
  fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
  await settle();
  return values;
}

/** Asserts the label the trigger shows for the current value. */
export function expectSelectValue(
  trigger: HTMLElement,
  label: string | RegExp,
): void {
  const text = (trigger.textContent ?? "").trim();
  if (label instanceof RegExp) {
    expect(text).toMatch(label);
    return;
  }
  expect(text).toBe(label);
}
