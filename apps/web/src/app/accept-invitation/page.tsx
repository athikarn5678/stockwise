import { AuthCardLocalized } from "@/components/auth/auth-card-localized";
import { InvitationAcceptanceForm } from "@/components/auth/invitation-acceptance-form";

export default function AcceptInvitationPage() {
  return (
    <AuthCardLocalized
      descriptionKey="invitationPageDescription"
      titleKey="invitationPageTitle"
    >
      <InvitationAcceptanceForm />
    </AuthCardLocalized>
  );
}
