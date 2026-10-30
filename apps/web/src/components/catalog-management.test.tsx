// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAccessContext } from "@/branch-api-client";
import {
  CatalogApiError,
  createCategory,
  createProduct,
  listCategories,
  listProducts,
  setProductLifecycle,
  updateProduct,
} from "@/catalog-api-client";

import { CatalogManagement } from "./catalog-management";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "30000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "40000000-0000-4000-8000-000000000001";
let role: "OWNER" | "CASHIER" | "INVENTORY_STAFF" = "OWNER";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams({
      branchId: BRANCH_ID,
      organizationId: ORGANIZATION_ID,
    }),
}));

vi.mock("@/branch-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/branch-api-client")>();
  return { ...original, fetchAccessContext: vi.fn() };
});

vi.mock("@/catalog-api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/catalog-api-client")>();
  return {
    ...original,
    createCategory: vi.fn(),
    createProduct: vi.fn(),
    listCategories: vi.fn(),
    listProducts: vi.fn(),
    setCategoryLifecycle: vi.fn(),
    setProductLifecycle: vi.fn(),
    updateCategory: vi.fn(),
    updateProduct: vi.fn(),
  };
});

const category = {
  createdAt: "2026-08-26T12:00:00.000Z",
  description: "Hot drinks",
  id: CATEGORY_ID,
  name: "Drinks",
  organizationId: ORGANIZATION_ID,
  status: "ACTIVE" as const,
  updatedAt: "2026-08-26T12:00:00.000Z",
};
const product = {
  barcode: "885000000001",
  basePrice: "12.3400",
  categoryId: CATEGORY_ID,
  createdAt: "2026-08-26T12:00:00.000Z",
  description: "Green tea",
  id: PRODUCT_ID,
  name: "Tea",
  organizationId: ORGANIZATION_ID,
  sku: "TEA-01",
  status: "ACTIVE" as const,
  unit: "EA" as const,
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function renderCatalog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CatalogManagement />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  vi.mocked(fetchAccessContext).mockImplementation(async () => ({
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [{ code: "MAIN", id: BRANCH_ID, name: "Main" }],
        id: ORGANIZATION_ID,
        name: "Store",
        role,
      },
    ],
    user: {
      displayName: "User",
      email: "user@example.com",
      id: "50000000-0000-4000-8000-000000000001",
    },
  }));
  vi.mocked(listCategories).mockImplementation(async (_context, options) => ({
    data: { categories: options?.limit === 100 ? [category] : [category] },
    meta: { nextCursor: null },
  }));
  vi.mocked(listProducts).mockResolvedValue({
    data: { products: [product] },
    meta: { nextCursor: null },
  });
  vi.mocked(createCategory).mockResolvedValue(category);
  vi.mocked(createProduct).mockResolvedValue(product);
  vi.mocked(updateProduct).mockResolvedValue(product);
  vi.mocked(setProductLifecycle).mockResolvedValue({
    ...product,
    status: "INACTIVE",
  });
});

afterEach(() => {
  cleanup();
  role = "OWNER";
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("catalog management UI", () => {
  it.each([
    ["4.0000", "4.00"],
    ["4.1230", "4.123"],
    ["4.1234", "4.1234"],
  ])(
    "formats price %s while preserving the edit value",
    async (basePrice, display) => {
      vi.mocked(listProducts).mockResolvedValue({
        data: { products: [{ ...product, basePrice }] },
        meta: { nextCursor: null },
      });
      renderCatalog();
      expect(await screen.findByText(`TEA-01 · ${display} · EA`)).toBeTruthy();
      const editor = screen.getByRole("form", { name: "Edit product Tea" });
      expect(within(editor).getByLabelText("Base price")).toHaveProperty(
        "value",
        basePrice,
      );
    },
  );

  it("presents the default product view with exact decimal and immutable unit information", async () => {
    renderCatalog();

    expect(
      await screen.findByRole("heading", { name: "Catalog" }),
    ).toBeTruthy();
    expect(await screen.findByText("Tea")).toBeTruthy();
    expect(screen.getByText(/TEA-01.*12\.34.*EA/)).toBeTruthy();
    expect(screen.getByText("Unit: EA (immutable)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create product" })).toBeTruthy();
  });

  it("sends selected filters and search to the API-driven product query", async () => {
    renderCatalog();
    await screen.findByText("Tea");

    fireEvent.change(screen.getByLabelText("Category filter"), {
      target: { value: "uncategorized" },
    });
    fireEvent.change(screen.getByLabelText("Search catalog"), {
      target: { value: "tea" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Search" }).closest("form")!,
    );

    await waitFor(() =>
      expect(listProducts).toHaveBeenLastCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({ categoryId: "uncategorized", q: "tea" }),
      ),
    );
  });

  it("creates a product without numeric price conversion and uses the selected active category", async () => {
    renderCatalog();
    await screen.findAllByRole("option", { name: "Drinks" });
    const createForm = screen
      .getByRole("heading", { name: "Create product" })
      .closest("form")!;

    fireEvent.change(within(createForm).getByLabelText("Product name"), {
      target: { value: "Coffee" },
    });
    fireEvent.change(within(createForm).getByLabelText("SKU"), {
      target: { value: "COFFEE-01" },
    });
    fireEvent.change(within(createForm).getByLabelText("Base price"), {
      target: { value: "10.2500" },
    });
    fireEvent.change(within(createForm).getByLabelText("Barcode (optional)"), {
      target: { value: "0012345678905" },
    });
    fireEvent.change(within(createForm).getByLabelText("Category (optional)"), {
      target: { value: CATEGORY_ID },
    });
    fireEvent.submit(createForm);

    await waitFor(() =>
      expect(createProduct).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({
          basePrice: "10.2500",
          barcode: "0012345678905",
          categoryId: CATEGORY_ID,
          unit: "EA",
        }),
      ),
    );
  });

  it("shows safe stale feedback and does not fabricate a new version", async () => {
    vi.mocked(updateProduct).mockRejectedValue(
      new CatalogApiError("product_stale"),
    );
    renderCatalog();
    await screen.findByText("Tea");

    fireEvent.submit(
      screen.getByRole("button", { name: "Save changes" }).closest("form")!,
    );

    expect(
      await screen.findAllByText(/changed since you opened it/i),
    ).not.toHaveLength(0);
    expect(updateProduct).toHaveBeenCalledWith(
      expect.anything(),
      PRODUCT_ID,
      expect.objectContaining({ expectedUpdatedAt: product.updatedAt }),
    );
  });

  it.each(["00001234", ""])(
    "updates/removes barcode %s while preserving SKU and version",
    async (barcode) => {
      renderCatalog();
      const editor = await screen.findByRole("form", {
        name: "Edit product Tea",
      });
      fireEvent.change(within(editor).getByLabelText("Barcode (optional)"), {
        target: { value: barcode },
      });
      fireEvent.submit(editor);
      await waitFor(() =>
        expect(updateProduct).toHaveBeenCalledWith(
          expect.anything(),
          PRODUCT_ID,
          expect.objectContaining({
            barcode,
            sku: product.sku,
            expectedUpdatedAt: product.updatedAt,
          }),
        ),
      );
    },
  );

  it("shows a clear tenant barcode conflict returned by the API", async () => {
    vi.mocked(updateProduct).mockRejectedValue(
      new CatalogApiError("barcode_conflict"),
    );
    renderCatalog();
    const editor = await screen.findByRole("form", {
      name: "Edit product Tea",
    });
    fireEvent.submit(editor);
    expect(
      await screen.findAllByText(
        "That barcode already exists in this organization.",
      ),
    ).not.toHaveLength(0);
  });

  it("opens labels from saved product details without submitting unsaved edits", async () => {
    renderCatalog();
    const editor = await screen.findByRole("form", {
      name: "Edit product Tea",
    });
    fireEvent.change(within(editor).getByLabelText("Barcode (optional)"), {
      target: { value: "UNSAVED" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview barcode labels" }),
    );
    expect(
      screen.getByRole("img", { name: `Code 128 barcode ${product.barcode}` }),
    ).toBeTruthy();
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it("denies inventory staff direct Catalog access without fetching products", async () => {
    role = "INVENTORY_STAFF";
    renderCatalog();

    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(listProducts).not.toHaveBeenCalled();
  });

  it("presents a view-only catalog to a cashier without issuing management controls", async () => {
    role = "CASHIER";
    renderCatalog();

    await screen.findByText("Tea");
    expect(screen.queryByRole("button", { name: "Create product" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /include inactive/i }),
    ).toBeNull();
  });

  it("switches to category management and creates a category", async () => {
    renderCatalog();
    await screen.findByRole("tab", { name: "Categories" });
    fireEvent.click(screen.getByRole("tab", { name: "Categories" }));

    expect(
      await screen.findByRole("heading", { name: "Create category" }),
    ).toBeTruthy();
    const createForm = screen
      .getByRole("heading", { name: "Create category" })
      .closest("form")!;
    fireEvent.change(within(createForm).getByLabelText("Category name"), {
      target: { value: "Pantry" },
    });
    fireEvent.submit(createForm);

    await waitFor(() =>
      expect(createCategory).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({ name: "Pantry" }),
      ),
    );
  });
});
