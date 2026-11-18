import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Drives the Base UI backed select (`components/ui/select.tsx` and
 * `components/option-select.tsx`) and combobox (`components/ui/combobox.tsx`)
 * in end-to-end specs.
 *
 * `locator.selectOption()` only works for a native `<select>`; these components
 * render a `button` trigger plus a portalled `role="listbox"`, so the popup has
 * to be opened and an option clicked.
 *
 * Pass a label for the common `<Label>`/`htmlFor` case, or a locator when the
 * trigger needs a narrower query. `option` selects by visible text or by the
 * `data-value` attribute the option exposes.
 */
export async function selectOption(
  page: Page,
  labelOrLocator: string | Locator,
  option: { label: string } | { value: string },
): Promise<void> {
  const trigger = resolveTrigger(page, labelOrLocator);

  await trigger.click();

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();

  await optionLocator(listbox, option).click();
  await expect(listbox).toBeHidden();
}

/**
 * Chooses an option in the server-searched product combobox: the query is typed
 * into the combobox input, which is what drives the server request, and the
 * matching option is clicked once the filtered page arrives.
 */
export async function chooseComboboxOption(
  page: Page,
  labelOrLocator: string | Locator,
  query: string,
  option: { label: string } | { value: string },
): Promise<void> {
  const input = resolveTrigger(page, labelOrLocator);

  // Clicking opens the popup (`openOnInputClick`); filling alone would not,
  // because a programmatic fill has no input type to type into.
  await input.click();
  await input.fill(query);

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();

  await optionLocator(listbox, option).click();
  await expect(listbox).toBeHidden();
}

function resolveTrigger(page: Page, labelOrLocator: string | Locator): Locator {
  return typeof labelOrLocator === "string"
    ? page.getByLabel(labelOrLocator, { exact: true })
    : labelOrLocator;
}

function optionLocator(
  listbox: Locator,
  option: { label: string } | { value: string },
): Locator {
  return "value" in option
    ? listbox.locator(
        `[role="option"][data-value="${escapeAttribute(option.value)}"]`,
      )
    : listbox.getByRole("option", { name: option.label, exact: true });
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
