import { createHash } from "node:crypto";
type TestEvent = {
  type: string;
  data: {
    file?: string;
    line?: number;
    column?: number;
    name?: string;
    skip?: boolean;
    todo?: boolean;
  };
};
type Result = { id: string; status: "PASS" | "FAIL" | "SKIP" | "NOT_RUN" };

// Discard stdout/stderr/diagnostics/errors: they may contain credential-bearing payloads.
export default async function* report(events: AsyncIterable<TestEvent>) {
  const discovered = new Set<string>();
  const results: Result[] = [];
  for await (const event of events) {
    if (
      event.type !== "test:enqueue" &&
      event.type !== "test:pass" &&
      event.type !== "test:fail"
    )
      continue;
    const data = event.data;
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          data.file ?? "",
          data.line ?? 0,
          data.column ?? 0,
          data.name,
        ]),
      )
      .digest("hex");
    if (event.type === "test:enqueue") discovered.add(id);
    else {
      results.push({
        id,
        status:
          data.skip || data.todo
            ? "SKIP"
            : event.type === "test:pass"
              ? "PASS"
              : "FAIL",
      });
    }
  }
  const settled = new Set(results.map((result) => result.id));
  for (const id of discovered)
    if (!settled.has(id)) results.push({ id, status: "NOT_RUN" });
  yield JSON.stringify({
    discoveredTestIds: [...discovered].sort(),
    results,
  }) + "\n";
}
