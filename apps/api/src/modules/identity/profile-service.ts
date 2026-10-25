import type {
  SelfProfile,
  SelfProfileRepository,
  UpdateProfileOutcome,
} from "./profile-repository.ts";
import type { UpdateProfileInput } from "./profile-schema.ts";

export interface SelfProfileService {
  get(actorUserId: string): Promise<SelfProfile | null>;
  update(
    actorUserId: string,
    input: UpdateProfileInput,
  ): Promise<UpdateProfileOutcome>;
}

export function createSelfProfileService({
  repository,
}: {
  repository: SelfProfileRepository;
}): SelfProfileService {
  return {
    get: (actorUserId) => repository.get(actorUserId),
    update: (actorUserId, input) => repository.update(actorUserId, input),
  };
}
