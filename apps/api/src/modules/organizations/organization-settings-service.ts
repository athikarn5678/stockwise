import type {
  OrganizationSettingsOutcome,
  OrganizationSettingsRepository,
} from "./organization-settings-repository.ts";
import type { OrganizationNameUpdate } from "./organization-settings-schema.ts";

export interface OrganizationSettingsService {
  get(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationSettingsOutcome>;
  update(
    actorUserId: string,
    organizationId: string,
    input: OrganizationNameUpdate,
  ): Promise<OrganizationSettingsOutcome>;
}

export function createOrganizationSettingsService({
  repository,
}: {
  repository: OrganizationSettingsRepository;
}): OrganizationSettingsService {
  return {
    get: (actorUserId, organizationId) =>
      repository.get(actorUserId, organizationId),
    update: (actorUserId, organizationId, input) =>
      repository.update(actorUserId, organizationId, input),
  };
}
