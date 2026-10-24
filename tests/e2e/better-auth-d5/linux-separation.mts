import { createHash } from "node:crypto";

export interface LinuxSeparationEvidence {
  version: 1;
  separateHostId: string;
  administrativeBoundary: "INDEPENDENTLY_ADMINISTERED";
  producerIdentity: string;
  protectedHostPrincipals: string[];
  producerCapabilities: string[];
  producerMayAccessRootOrSudo: false;
  producerMayManageShell: false;
  producerMayAccessDockerOrSocket: false;
  windowsProducerCanManageHost: false;
  producerMayUseWslIdentity: false;
  producerCanManageHypervisor: false;
  producerCanReadPolicy: false;
  producerCanReadOrWriteSnapshots: false;
  producerHasWritableAlias: false;
  transferOnly: true;
  aclEvidenceSha256: string;
}

/** Deployment pin deliberately absent until owner approval and producer-identity ACL evidence exist. */
export const INDEPENDENT_LINUX_SEPARATION_PIN: string | null = null;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateLinuxSeparationEvidence(
  evidence: LinuxSeparationEvidence,
  expectedSha256: string,
  expectedHostId: string,
  expectedProducerIdentity: string,
): void {
  const fields = [
    "aclEvidenceSha256",
    "administrativeBoundary",
    "producerCanManageHypervisor",
    "producerCanReadOrWriteSnapshots",
    "producerCanReadPolicy",
    "producerCapabilities",
    "producerMayAccessDockerOrSocket",
    "producerMayAccessRootOrSudo",
    "producerMayManageShell",
    "producerHasWritableAlias",
    "producerIdentity",
    "producerMayUseWslIdentity",
    "protectedHostPrincipals",
    "separateHostId",
    "transferOnly",
    "version",
    "windowsProducerCanManageHost",
  ].sort();
  if (
    !evidence ||
    Object.keys(evidence).sort().join("\0") !== fields.join("\0") ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    hash(evidence) !== expectedSha256 ||
    evidence.version !== 1 ||
    evidence.separateHostId !== expectedHostId ||
    typeof evidence.separateHostId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(evidence.separateHostId) ||
    evidence.administrativeBoundary !== "INDEPENDENTLY_ADMINISTERED" ||
    evidence.producerIdentity !== expectedProducerIdentity ||
    !evidence.producerIdentity ||
    !Array.isArray(evidence.protectedHostPrincipals) ||
    evidence.protectedHostPrincipals.length === 0 ||
    evidence.protectedHostPrincipals.includes(evidence.producerIdentity) ||
    !Array.isArray(evidence.producerCapabilities) ||
    evidence.producerCapabilities.length !== 0 ||
    evidence.windowsProducerCanManageHost !== false ||
    evidence.producerMayUseWslIdentity !== false ||
    evidence.producerMayAccessRootOrSudo !== false ||
    evidence.producerMayManageShell !== false ||
    evidence.producerMayAccessDockerOrSocket !== false ||
    evidence.producerCanManageHypervisor !== false ||
    evidence.producerCanReadPolicy !== false ||
    evidence.producerCanReadOrWriteSnapshots !== false ||
    evidence.producerHasWritableAlias !== false ||
    evidence.transferOnly !== true ||
    !/^[a-f0-9]{64}$/.test(evidence.aclEvidenceSha256)
  )
    throw new Error("LINUX_SEPARATION_EVIDENCE_REJECTED");
}

/** Real intake cannot be opened until the independently deployed pin is supplied by trusted deployment. */
export function requireDeployedLinuxSeparation(
  evidence: LinuxSeparationEvidence | null,
  expectedHostId: string,
  expectedProducerIdentity: string,
): void {
  if (!evidence) throw new Error("SEPARATE_HOST_APPROVAL_MISSING");
  if (!INDEPENDENT_LINUX_SEPARATION_PIN)
    throw new Error("SEPARATE_HOST_APPROVAL_NOT_INDEPENDENTLY_PINNED");
  validateLinuxSeparationEvidence(
    evidence,
    INDEPENDENT_LINUX_SEPARATION_PIN,
    expectedHostId,
    expectedProducerIdentity,
  );
}
