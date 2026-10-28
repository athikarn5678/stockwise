"use client";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { completeFirstOrganizationOnboarding } from "@/api-client";

import { useLanguage } from "@/providers/language-provider";
import { authErrorMessage } from "./auth-form-support";

interface OnboardingFields {
  branchAddress: string;
  branchName: string;
  branchPhone: string;
  displayName: string;
  organizationName: string;
  phone: string;
}

const initialFields: OnboardingFields = {
  branchAddress: "",
  branchName: "",
  branchPhone: "",
  displayName: "",
  organizationName: "",
  phone: "",
};

function requiredFieldsArePresent(fields: OnboardingFields): boolean {
  return [fields.displayName, fields.organizationName, fields.branchName].every(
    (value) => value.trim() !== "",
  );
}

export function OnboardingForm() {
  const { t } = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState(initialFields);
  const [error, setError] = useState<unknown>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(field: keyof OnboardingFields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    if (!requiredFieldsArePresent(fields)) {
      setError("required");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await completeFirstOrganizationOnboarding(fields);
      queryClient.removeQueries({ queryKey: ["access-context"] });
      router.replace("/app");
    } catch (requestError: unknown) {
      setError(requestError);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <TextField
        autoComplete="name"
        disabled={isSubmitting}
        id="onboarding-display-name"
        label={t("onboardingDisplayName")}
        maxLength={200}
        onChange={(value) => updateField("displayName", value)}
        required
        value={fields.displayName}
      />
      <TextField
        autoComplete="tel"
        disabled={isSubmitting}
        id="onboarding-profile-phone"
        label={t("onboardingProfilePhone")}
        maxLength={32}
        onChange={(value) => updateField("phone", value)}
        value={fields.phone}
      />
      <TextField
        autoComplete="organization"
        disabled={isSubmitting}
        id="onboarding-organization-name"
        label={t("onboardingOrgName")}
        maxLength={200}
        onChange={(value) => updateField("organizationName", value)}
        required
        value={fields.organizationName}
      />
      <TextField
        autoComplete="organization"
        disabled={isSubmitting}
        id="onboarding-branch-name"
        label={t("onboardingBranchName")}
        maxLength={200}
        onChange={(value) => updateField("branchName", value)}
        required
        value={fields.branchName}
      />
      <TextField
        autoComplete="tel"
        disabled={isSubmitting}
        id="onboarding-branch-phone"
        label={t("onboardingBranchPhone")}
        maxLength={32}
        onChange={(value) => updateField("branchPhone", value)}
        value={fields.branchPhone}
      />
      <div>
        <Label className="form-field" htmlFor="onboarding-address">
          {t("onboardingBranchAddress")}
        </Label>
        <Textarea
          className="mt-1"
          disabled={isSubmitting}
          id="onboarding-address"
          maxLength={500}
          name="branchAddress"
          onChange={(event) => updateField("branchAddress", event.target.value)}
          value={fields.branchAddress}
        />
      </div>
      {error === null ? null : (
        <p
          aria-live="assertive"
          className="text-sm text-destructive form-message"
          role="alert"
        >
          {error === "required"
            ? t("onboardingRequired")
            : authErrorMessage(error, t, {
                already_has_organization_access: "onboardingHasAccess",
                already_onboarded: "onboardingDone",
              })}
        </p>
      )}
      <Button className="w-full" disabled={isSubmitting} type="submit">
        {isSubmitting ? t("onboardingCreating") : t("onboardingCreate")}
      </Button>
    </form>
  );
}

function TextField({
  autoComplete,
  disabled,
  id,
  label,
  maxLength,
  onChange,
  required = false,
  value,
}: {
  autoComplete: string;
  disabled: boolean;
  id: string;
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  required?: boolean;
  value: string;
}) {
  return (
    <div>
      <Label className="form-field" htmlFor={id}>
        {label}
      </Label>
      <Input
        autoComplete={autoComplete}
        className="mt-1"
        disabled={disabled}
        id={id}
        maxLength={maxLength}
        name={id.replace("onboarding-", "")}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        type="text"
        value={value}
      />
    </div>
  );
}
