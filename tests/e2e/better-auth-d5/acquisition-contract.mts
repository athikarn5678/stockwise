export type AcquisitionResource = Readonly<{
  kind: "container" | "volume";
  name: string;
  token: string;
  state: "INTENT" | "UNCERTAIN" | "CONFIRMED" | "REMOVED" | "RETAINED";
  identity: string | null;
  candidateIdentities?: readonly string[];
}>;

export type AcquisitionObservation = Readonly<{
  identity: string;
  labels: Readonly<Record<string, string>>;
  /** Backend creation identity, required for volumes and checked by validateIdentity. */
  creationIdentity: string | null;
}>;

export type Inspection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; observation: AcquisitionObservation }>;

export type AcquisitionAdapter = Readonly<{
  /** Return the immutable creation ID when the backend provides it. */
  create(resource: AcquisitionResource): Promise<void | string>;
  inspectByName(resource: AcquisitionResource): Promise<Inspection>;
  inspectByIdentity(
    resource: AcquisitionResource,
    identity: string,
  ): Promise<Inspection>;
  validateIdentity(
    resource: AcquisitionResource,
    observation: AcquisitionObservation,
  ): boolean;
  /** Independently enforced exclusive management capability; omitted or false denies destructive cleanup. */
  hasExclusiveManagement?(resource: AcquisitionResource): Promise<boolean>;
  removeByIdentity(
    resource: AcquisitionResource,
    identity: string,
  ): Promise<void>;
}>;

export class AcquisitionCreateFailure extends Error {
  readonly identity: string | null;

  constructor(message: string, identity: string | null = null) {
    super(message);
    this.name = "AcquisitionCreateFailure";
    this.identity = identity;
  }
}

export type AcquisitionReason =
  | "CREATE_FAILED"
  | "INSPECTION_FAILED"
  | "FOREIGN_RESOURCE"
  | "IDENTITY_MISMATCH"
  | "REMOVE_FAILED"
  | "UNKNOWN_ID_ABSENCE"
  | "CREATE_NOT_OBSERVED"
  | "EXCLUSIVE_AUTHORITY_MISSING"
  | "PERSISTENCE_FAILED";

export type AcquisitionFailure = Readonly<{
  name: string;
  reason: "CREATE_FAILED";
  identity: string | null;
}>;
export type AcquisitionCleanupResult = Readonly<{
  status: "COMPLETE" | "INCOMPLETE";
  entries: readonly AcquisitionResource[];
  reasons: readonly Readonly<{ name: string; reason: AcquisitionReason }>[];
}>;

export type AcquisitionLedgerOptions = Readonly<{
  owner: string;
  source: string;
  persist(
    entries: readonly AcquisitionResource[],
    failures: readonly AcquisitionFailure[],
  ): Promise<void>;
}>;

const MAX_RECONCILE_ATTEMPTS = 2;

/** Tracks create intent before creation, records immutable identity, and requires verified identity plus exclusive authority for cleanup. */
export class AcquisitionLedger {
  private readonly entries = new Map<string, AcquisitionResource>();
  private readonly attempted = new Set<string>();
  private readonly reasons = new Map<string, AcquisitionReason>();
  private readonly createFailures = new Map<string, AcquisitionFailure>();
  private persistenceFailed = false;
  private readonly options: AcquisitionLedgerOptions;
  private readonly adapter: AcquisitionAdapter;

  constructor(options: AcquisitionLedgerOptions, adapter: AcquisitionAdapter) {
    this.options = options;
    this.adapter = adapter;
  }

  /** Rehydrate a previously persisted journal after interruption. */
  restore(
    entries: readonly AcquisitionResource[],
    failures: readonly AcquisitionFailure[] = [],
  ): void {
    for (const entry of entries) {
      if (this.entries.has(entry.name))
        throw new Error("Duplicate acquisition journal entry.");
      const restored: AcquisitionResource = {
        ...entry,
        ...(entry.candidateIdentities
          ? { candidateIdentities: [...entry.candidateIdentities] }
          : {}),
        state: entry.state === "REMOVED" ? "UNCERTAIN" : entry.state,
      };
      this.entries.set(entry.name, restored);
      if (restored.state !== "INTENT") this.attempted.add(restored.name);
    }
    for (const failure of failures)
      this.createFailures.set(failure.name, { ...failure });
  }

  snapshot(): readonly AcquisitionResource[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      ...(entry.candidateIdentities
        ? { candidateIdentities: [...entry.candidateIdentities] }
        : {}),
    }));
  }

  failures(): readonly AcquisitionFailure[] {
    return [...this.createFailures.values()].map((failure) => ({ ...failure }));
  }

  hasAcquisitionFailure(): boolean {
    return this.createFailures.size > 0;
  }

  private async save(): Promise<boolean> {
    try {
      await this.options.persist(this.snapshot(), this.failures());
      return true;
    } catch {
      this.persistenceFailed = true;
      return false;
    }
  }

  private setReason(
    resource: AcquisitionResource,
    reason: AcquisitionReason,
  ): void {
    this.reasons.set(resource.name, reason);
  }

  private async transition(resource: AcquisitionResource): Promise<boolean> {
    this.entries.set(resource.name, resource);
    return this.save();
  }

  private hasExactLabels(
    resource: AcquisitionResource,
    observation: AcquisitionObservation,
  ): boolean {
    return (
      observation.labels["stockwise.d5.owner"] === this.options.owner &&
      observation.labels["stockwise.d5.source"] === this.options.source &&
      observation.labels["stockwise.d5.acquisition-token"] === resource.token
    );
  }

  private async inspect(
    resource: AcquisitionResource,
    byIdentity = false,
  ): Promise<Inspection | null> {
    try {
      if (!byIdentity || resource.identity === null)
        return await this.adapter.inspectByName(resource);
      const byId = await this.adapter.inspectByIdentity(
        resource,
        resource.identity,
      );
      const byName = await this.adapter.inspectByName(resource);
      if (byId.kind === "absent") return byName;
      if (
        byName.kind === "found" &&
        byName.observation.identity !== resource.identity
      )
        return byName;
      return byId;
    } catch (error) {
      this.setReason(
        resource,
        error instanceof Error &&
          error.message === "RESOURCE_UNKNOWN_ID_ABSENCE"
          ? "UNKNOWN_ID_ABSENCE"
          : "INSPECTION_FAILED",
      );
      return null;
    }
  }

  private async hasRemovalAuthority(
    resource: AcquisitionResource,
  ): Promise<boolean> {
    try {
      return (await this.adapter.hasExclusiveManagement?.(resource)) === true;
    } catch {
      return false;
    }
  }

  private async reconcile(
    resource: AcquisitionResource,
    observation: AcquisitionObservation,
  ): Promise<boolean> {
    if (!this.hasExactLabels(resource, observation)) {
      this.setReason(resource, "FOREIGN_RESOURCE");
      return false;
    }
    if (resource.state === "CONFIRMED" && resource.identity === null) {
      this.setReason(resource, "IDENTITY_MISMATCH");
      return false;
    }
    // A token/name observation is only a candidate. Container identity must come from create stdout.
    if (resource.kind === "container" && resource.identity === null) {
      let candidateValid: boolean;
      try {
        candidateValid =
          /^[a-f0-9]{64}$/i.test(observation.identity) &&
          this.adapter.validateIdentity(resource, observation);
      } catch {
        candidateValid = false;
      }
      if (candidateValid) {
        const candidates = new Set(
          this.entries.get(resource.name)?.candidateIdentities ??
            resource.candidateIdentities ??
            [],
        );
        candidates.add(observation.identity);
        const hint = { ...resource, candidateIdentities: [...candidates] };
        if (!(await this.transition(hint)))
          this.setReason(hint, "PERSISTENCE_FAILED");
        else this.setReason(hint, "UNKNOWN_ID_ABSENCE");
      } else {
        this.setReason(resource, "IDENTITY_MISMATCH");
      }
      return false;
    }
    let valid: boolean;
    try {
      valid =
        this.adapter.validateIdentity(resource, observation) &&
        (resource.kind !== "volume" || observation.creationIdentity !== null);
    } catch {
      valid = false;
    }
    if (
      !valid ||
      (resource.identity !== null && observation.identity !== resource.identity)
    ) {
      this.setReason(resource, "IDENTITY_MISMATCH");
      return false;
    }
    if (
      resource.state === "CONFIRMED" &&
      resource.identity !== observation.identity
    ) {
      this.setReason(resource, "IDENTITY_MISMATCH");
      return false;
    }
    const confirmed: AcquisitionResource = {
      ...resource,
      state: "CONFIRMED",
      identity: observation.identity,
    };
    const failure = this.createFailures.get(resource.name);
    if (failure && failure.identity !== observation.identity) {
      this.createFailures.set(resource.name, {
        ...failure,
        identity: observation.identity,
      });
    }
    if (!(await this.transition(confirmed))) {
      this.setReason(confirmed, "PERSISTENCE_FAILED");
      return false;
    }
    this.reasons.delete(resource.name);
    return true;
  }

  async acquire(
    kind: AcquisitionResource["kind"],
    name: string,
    token: string,
  ): Promise<AcquisitionResource> {
    if (!name || !token || this.entries.has(name))
      throw new Error("Invalid or duplicate acquisition intent.");
    const intent: AcquisitionResource = {
      kind,
      name,
      token,
      state: "INTENT",
      identity: null,
    };
    this.entries.set(name, intent);
    if (!(await this.save())) {
      this.setReason(intent, "PERSISTENCE_FAILED");
      return intent;
    }
    const uncertain: AcquisitionResource = { ...intent, state: "UNCERTAIN" };
    if (!(await this.transition(uncertain))) {
      this.setReason(uncertain, "PERSISTENCE_FAILED");
      return uncertain;
    }
    this.attempted.add(name);

    let responseIdentity: string | undefined;
    try {
      const response = await this.adapter.create(uncertain);
      if (typeof response === "string") {
        const trimmed = response.trim();
        if (kind === "container" && !/^[a-f0-9]{64}$/i.test(trimmed)) {
          this.setReason(uncertain, "IDENTITY_MISMATCH");
          return uncertain;
        } else if (trimmed) {
          responseIdentity = trimmed;
          const recorded: AcquisitionResource = {
            ...uncertain,
            identity: trimmed,
          };
          if (!(await this.transition(recorded))) {
            this.setReason(recorded, "PERSISTENCE_FAILED");
            return recorded;
          }
          this.reasons.delete(name);
        }
      }
    } catch (error) {
      const failedIdentity =
        error instanceof AcquisitionCreateFailure
          ? error.identity?.trim()
          : null;
      const validFailedIdentity =
        kind === "container" &&
        failedIdentity &&
        /^[a-f0-9]{64}$/i.test(failedIdentity)
          ? failedIdentity
          : null;
      this.createFailures.set(name, {
        name,
        reason: "CREATE_FAILED",
        identity: validFailedIdentity,
      });
      this.setReason(uncertain, "CREATE_FAILED");
      if (validFailedIdentity) {
        responseIdentity = validFailedIdentity;
        const recorded: AcquisitionResource = {
          ...uncertain,
          identity: validFailedIdentity,
        };
        if (!(await this.transition(recorded))) {
          this.setReason(recorded, "PERSISTENCE_FAILED");
          return recorded;
        }
      } else if (!(await this.save())) {
        this.setReason(uncertain, "PERSISTENCE_FAILED");
        return uncertain;
      }
    }

    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      const current = this.entries.get(name) ?? uncertain;
      const found = await this.inspect(current, current.identity !== null);
      if (found === null) continue;
      const latest = this.entries.get(name) ?? current;
      if (found.kind === "absent") {
        this.setReason(
          latest,
          kind === "container" && responseIdentity === undefined
            ? "UNKNOWN_ID_ABSENCE"
            : "CREATE_NOT_OBSERVED",
        );
        return latest;
      }
      await this.reconcile(latest, found.observation);
      return this.entries.get(name) ?? latest;
    }
    return this.entries.get(name) ?? uncertain;
  }

  async cleanup(): Promise<AcquisitionCleanupResult> {
    const reverseOrder = [...this.entries.values()].reverse();
    for (const initial of reverseOrder) {
      let current = this.entries.get(initial.name) ?? initial;
      if (current.state === "REMOVED" || current.state === "RETAINED") continue;
      if (current.state === "INTENT" && !this.attempted.has(current.name))
        continue;

      let completed = false;
      for (
        let attempt = 0;
        attempt < MAX_RECONCILE_ATTEMPTS && !completed;
        attempt++
      ) {
        const inspected = await this.inspect(
          current,
          current.identity !== null,
        );
        if (inspected === null) continue;
        if (inspected.kind === "absent") {
          if (current.kind === "container" && current.identity === null) {
            this.setReason(current, "UNKNOWN_ID_ABSENCE");
            continue;
          }
          if (!(await this.hasRemovalAuthority(current))) {
            this.setReason(current, "EXCLUSIVE_AUTHORITY_MISSING");
            continue;
          }
          const removed: AcquisitionResource = { ...current, state: "REMOVED" };
          if (await this.transition(removed)) {
            this.reasons.delete(current.name);
            completed = true;
          } else this.setReason(removed, "PERSISTENCE_FAILED");
          continue;
        }
        if (!(await this.reconcile(current, inspected.observation))) {
          if (this.reasons.get(current.name) === "FOREIGN_RESOURCE") {
            const retained: AcquisitionResource = {
              ...current,
              state: "RETAINED",
            };
            if (!(await this.transition(retained)))
              this.setReason(retained, "PERSISTENCE_FAILED");
            else this.setReason(retained, "FOREIGN_RESOURCE");
          }
          continue;
        }
        current = this.entries.get(current.name) ?? current;
        if (current.identity === null) continue;
        if (!(await this.hasRemovalAuthority(current))) {
          this.setReason(current, "EXCLUSIVE_AUTHORITY_MISSING");
          continue;
        }
        try {
          await this.adapter.removeByIdentity(current, current.identity);
        } catch {
          this.setReason(current, "REMOVE_FAILED");
          continue;
        }
        const after = await this.inspect(current, true);
        if (after === null) continue;
        if (after.kind === "absent") {
          if (!(await this.hasRemovalAuthority(current))) {
            this.setReason(current, "EXCLUSIVE_AUTHORITY_MISSING");
            continue;
          }
          const removed: AcquisitionResource = { ...current, state: "REMOVED" };
          if (await this.transition(removed)) {
            this.reasons.delete(current.name);
            completed = true;
          } else this.setReason(removed, "PERSISTENCE_FAILED");
        } else if (!this.hasExactLabels(current, after.observation)) {
          const retained: AcquisitionResource = {
            ...current,
            state: "RETAINED",
          };
          if (!(await this.transition(retained)))
            this.setReason(retained, "PERSISTENCE_FAILED");
          else this.setReason(retained, "FOREIGN_RESOURCE");
        } else {
          let identityValid: boolean;
          try {
            identityValid = this.adapter.validateIdentity(
              current,
              after.observation,
            );
          } catch {
            identityValid = false;
          }
          if (
            after.observation.identity !== current.identity ||
            !identityValid
          ) {
            this.setReason(current, "IDENTITY_MISMATCH");
          } else {
            this.setReason(current, "REMOVE_FAILED");
          }
        }
      }
    }
    const entries = this.snapshot();
    const unresolved = entries.some(
      (entry) =>
        entry.state !== "REMOVED" &&
        !(entry.state === "INTENT" && !this.attempted.has(entry.name)),
    );
    const reasons = [...this.reasons].map(([name, reason]) => ({
      name,
      reason,
    }));
    if (
      this.persistenceFailed &&
      !reasons.some((reason) => reason.reason === "PERSISTENCE_FAILED")
    ) {
      reasons.push({ name: "*", reason: "PERSISTENCE_FAILED" });
    }
    return {
      status: unresolved || this.persistenceFailed ? "INCOMPLETE" : "COMPLETE",
      entries,
      reasons,
    };
  }
}
