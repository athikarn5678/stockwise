"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { BranchApiError, fetchAccessContext } from "@/branch-api-client";
import { accountDraftAuthority } from "@/providers/account-draft";
import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import { LogoutButton } from "@/components/auth/logout-button";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  Home,
  Package,
  Receipt,
  ShoppingCart,
  Store,
  Users,
  Truck,
  UserRound,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/brand-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { PreferenceControls } from "@/components/preference-controls";
import { useLanguage } from "@/providers/language-provider";
import { isGuestRoute, routeAccessPolicy } from "@/route-access-policy";
import type { VerificationLinkWindow } from "@/verification-link-entry";
import type { CredentialLinkWindow } from "@/credential-link-entry";
import {
  acquireInvitationFlowLock,
  clearInvitationContinuationForFlow,
  isInvitationRecoveryRequired,
  loadInvitationContinuation,
} from "@/invitation-continuation";
import {
  InvitationContinuationApiError,
  resumeInvitationContinuation,
} from "@/invitation-continuation-api-client";
import { useSessionLifecycle } from "@/providers/session-lifecycle-provider";
import { discardPrivateSession } from "@/session-lifecycle";
import type {
  AccessContext,
  AccessibleOrganization,
} from "@/branch-api-client";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const lifecycle = useSessionLifecycle();
  const { t } = useLanguage();
  const policy = routeAccessPolicy(pathname);
  const previousPathname = useRef(pathname);
  useEffect(() => {
    const previous = previousPathname.current;
    previousPathname.current = pathname;
    // Discard an unclaimed credential as soon as the user leaves its owning
    // route, including navigation directly to the other credential route.
    // First mount and StrictMode effect replays are not abandonment.
    if (
      previous !== pathname &&
      (previous === "/reset-password" || previous === "/accept-invitation")
    ) {
      (window as CredentialLinkWindow).__stockwiseTakeCredentialLink?.();
    }
  }, [pathname]);
  if (policy === "public-marketing") {
    return <MarketingShell key={pathname}>{children}</MarketingShell>;
  }
  if (lifecycle.suspended)
    return (
      <main>
        <p aria-live="polite">{t("loadingAccess")}</p>
      </main>
    );
  if (
    lifecycle.unauthorized &&
    (policy === "protected-application" ||
      policy === "onboarding" ||
      policy === "invitation")
  )
    return (
      <main className="p-6">
        <p role="alert">{t("sessionExpired")}</p>
        <Link href="/login" replace>
          {t("signIn")}
        </Link>
      </main>
    );
  // Recheck a guest entry even when Back/Forward restores a cached 401.
  return (
    <WorkspaceShell
      key={`${lifecycle.generation}:${isGuestRoute(policy) ? pathname : "workspace"}`}
    >
      {children}
    </WorkspaceShell>
  );
}

function WorkspaceShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const lifecycle = useSessionLifecycle();
  const guestRoute = isGuestRoute(routeAccessPolicy(pathname));
  // A real mailbox-link visit is not an ordinary guest auth page.
  // The one-use handoff is installed by the pre-hydration bootstrap and
  // remains associated with this mounted route even after the form claims it.
  const mailboxLinkVisit = useRef(false);
  if (
    pathname === "/verify-email" &&
    typeof window !== "undefined" &&
    typeof (window as VerificationLinkWindow)
      .__stockwiseTakeVerificationLink === "function"
  ) {
    mailboxLinkVisit.current = true;
  }
  const contextQuery = useQuery({
    // Guest probes survive the initial StrictMode observer replay; session
    // generation cancellation still aborts on real logout/actor changes.
    queryFn: guestRoute
      ? () => fetchAccessContext()
      : ({ signal }) => fetchAccessContext({ signal }),
    queryKey: ["access-context"],
    retry: false,
    // Recheck cached guest errors on revisits. StrictMode's initial observer
    // replay remains single-request because guest queries do not consume its
    // abort signal; the session-generation abort signal still applies.
    refetchOnMount: guestRoute ? "always" : true,
  });
  const receivedContext =
    contextQuery.isError || (contextQuery.isFetching && !contextQuery.data)
      ? undefined
      : contextQuery.data;
  const actorChanged =
    receivedContext !== undefined &&
    lifecycle.authenticatedActorId !== null &&
    lifecycle.authenticatedActorId !== receivedContext.user.id;
  // Never render a newly detected actor against the previous actor's queries.
  // Reconcile before paint regardless of which access-context observer refetched.
  const context = actorChanged ? undefined : receivedContext;
  useLayoutEffect(() => {
    if (receivedContext)
      lifecycle.reconcileAuthenticatedActor(receivedContext.user.id);
  }, [receivedContext, lifecycle.reconcileAuthenticatedActor]);
  useEffect(() => {
    if (contextQuery.isError) lifecycle.reconcileAccountDraft(null);
    else if (contextQuery.isSuccess && !contextQuery.isFetching)
      lifecycle.reconcileAccountDraft(contextQuery.data);
  }, [
    contextQuery.isError,
    contextQuery.isSuccess,
    contextQuery.isFetching,
    contextQuery.data,
    lifecycle.reconcileAccountDraft,
  ]);
  const resolved = context
    ? resolveApplicationContext(
        context,
        searchParams.get("organizationId"),
        searchParams.get("branchId"),
      )
    : null;
  const organization = resolved?.organization;
  const branch = resolved?.branch;
  const homeUrl = organization
    ? applicationContextUrl(organization.id, branch?.id ?? null)
    : "/app";
  const activeInvitationFlow =
    loadInvitationContinuation().status === "ready" ||
    isInvitationRecoveryRequired();
  const invitationAuthRoute =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/verify-email";
  const openingWorkspace =
    context !== undefined &&
    guestRoute &&
    !mailboxLinkVisit.current &&
    !(activeInvitationFlow && invitationAuthRoute);
  const checkingSession = contextQuery.isPending || contextQuery.isFetching;
  const signedOut =
    contextQuery.error instanceof BranchApiError &&
    contextQuery.error.kind === "authentication_required";
  const previouslyAnonymous = useRef(false);
  if (guestRoute && signedOut && !checkingSession)
    previouslyAnonymous.current = true;
  // Once the backend established anonymous access for this mounted guest
  // route, keep its unsent draft mounted during later focus revalidation.
  const preserveGuestDraft =
    guestRoute && previouslyAnonymous.current && !openingWorkspace;
  const protectedRoute =
    routeAccessPolicy(pathname) === "protected-application" ||
    routeAccessPolicy(pathname) === "onboarding";
  useEffect(() => {
    if (signedOut && protectedRoute && !checkingSession) {
      discardPrivateSession(queryClient);
      router.replace("/login");
    }
  }, [signedOut, protectedRoute, checkingSession, queryClient, router]);

  useEffect(() => {
    // A reload may land after login installed its cookie but before the SPA
    // redirect. Only a protected resume can recognize that completed sign-in.
    if (
      pathname !== "/login" ||
      context === undefined ||
      checkingSession ||
      lifecycle.unauthorized
    )
      return;
    const selected = loadInvitationContinuation();
    if (selected.status !== "ready") return;
    const flowId = selected.continuation.flowId;
    let current = true;
    const stillSelected = () => {
      const saved = loadInvitationContinuation();
      return (
        current &&
        saved.status === "ready" &&
        saved.continuation.flowId === flowId
      );
    };
    void (async () => {
      const held = await acquireInvitationFlowLock(flowId);
      if (!stillSelected()) return;
      if (!held) {
        clearInvitationContinuationForFlow(flowId);
        router.replace("/accept-invitation");
        return;
      }
      try {
        await resumeInvitationContinuation(flowId);
        if (stillSelected()) router.replace("/accept-invitation");
      } catch (cause) {
        if (
          stillSelected() &&
          cause instanceof InvitationContinuationApiError &&
          cause.kind !== "unavailable"
        ) {
          clearInvitationContinuationForFlow(flowId);
          router.replace("/accept-invitation");
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [checkingSession, context, lifecycle.unauthorized, pathname, router]);

  useEffect(() => {
    // A resource 401 is only a revocation hint. An explicit, fresh and
    // successful access-context check on guest entry can confirm authority
    // is still valid; otherwise the protected recovery screen would loop.
    if (
      guestRoute &&
      lifecycle.unauthorized &&
      contextQuery.isSuccess &&
      contextQuery.isFetchedAfterMount &&
      !contextQuery.isFetching
    ) {
      lifecycle.acknowledgeFreshAuthenticatedContext();
    }
  }, [
    guestRoute,
    lifecycle.unauthorized,
    lifecycle.acknowledgeFreshAuthenticatedContext,
    contextQuery.isSuccess,
    contextQuery.isFetchedAfterMount,
    contextQuery.isFetching,
  ]);

  useEffect(() => {
    if (openingWorkspace && !checkingSession && !lifecycle.unauthorized) {
      // The pre-hydration boundary already scrubbed the URL. The form never
      // mounts here, so explicitly discard its one-use credential handoff.
      if (pathname === "/verify-email")
        (window as VerificationLinkWindow).__stockwiseTakeVerificationLink?.();
      if (pathname === "/reset-password")
        (window as CredentialLinkWindow).__stockwiseTakeCredentialLink?.();
      router.replace(homeUrl);
    }
  }, [
    checkingSession,
    homeUrl,
    openingWorkspace,
    pathname,
    router,
    lifecycle.unauthorized,
  ]);

  const canManage =
    organization?.role === "OWNER" || organization?.role === "ADMIN";
  const destinations = [
    { label: t("home"), path: "/app", visible: true },
    { label: t("profileTitle"), path: "/app/profile", visible: true },
  ];
  if (organization) {
    destinations.push(
      { label: t("catalog"), path: "/app/catalog", visible: true },
      { label: t("inventory"), path: "/app/inventory", visible: !!branch },
      {
        label: t("pos"),
        path: "/app/pos",
        visible: !!branch && organization.role !== "INVENTORY_STAFF",
      },
      {
        label: t("analytics"),
        path: "/app/analytics",
        visible: organization.role !== "CASHIER" && (canManage || !!branch),
      },
      {
        label: t("sales"),
        path: "/app/sales",
        visible: !!branch && organization.role !== "INVENTORY_STAFF",
      },
      {
        label: t("suppliers"),
        path: "/app/suppliers",
        visible: organization.role !== "CASHIER",
      },
      {
        label: t("purchaseOrders"),
        path: "/app/purchase-orders",
        visible: !!branch && organization.role !== "CASHIER",
      },
      { label: t("branches"), path: "/app/branches", visible: canManage },
      { label: t("members"), path: "/app/members", visible: canManage },
      {
        label: t("organizationSettingsTitle"),
        path: "/app/organization-settings",
        visible: canManage,
      },
    );
  }

  const content = (
    <div
      className="mx-auto flex w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6"
      id="main-content"
    >
      {actorChanged ||
      (checkingSession && !contextQuery.data && !preserveGuestDraft) ? (
        <p aria-live="polite">{t("loadingAccess")}</p>
      ) : openingWorkspace ? (
        <p aria-live="polite">{t("openingWorkspace")}</p>
      ) : signedOut && protectedRoute ? (
        <p role="alert">{t("sessionExpired")}</p>
      ) : !signedOut && !context && !preserveGuestDraft ? (
        <div className="space-y-4">
          <p role="alert">
            {t(
              contextQuery.error instanceof BranchApiError &&
                contextQuery.error.kind === "forbidden"
                ? "accessDenied"
                : "accessError",
            )}
          </p>
          <Button type="button" onClick={() => void contextQuery.refetch()}>
            {t("accessRetry")}
          </Button>
        </div>
      ) : (
        <Fragment
          key={
            context &&
            (pathname === "/app/profile" ||
              pathname === "/app/organization-settings")
              ? accountDraftAuthority(context)
              : "content"
          }
        >
          {children}
        </Fragment>
      )}
    </div>
  );
  const skip = (
    <a
      className="fixed left-4 top-2 z-[100] -translate-y-24 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:translate-y-0"
      href="#main-content"
    >
      {t("skip")}
    </a>
  );
  if (!context || mailboxLinkVisit.current)
    return (
      <div className="flex min-h-screen flex-col">
        {skip}
        <header className="border-b">
          <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
            <Link
              className="flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              href="/"
            >
              <BrandLogo priority className="h-7" />
            </Link>
            <nav
              aria-label={t("primaryNavigation")}
              className="flex items-center gap-1"
            >
              <PreferenceControls />
              {signedOut && (
                <Button
                  variant="ghost"
                  nativeButton={false}
                  role="link"
                  render={<Link href="/login" replace={guestRoute} />}
                >
                  {t("signIn")}
                </Button>
              )}
            </nav>
          </div>
        </header>
        <main className="flex min-w-0 flex-1">{content}</main>
      </div>
    );
  return (
    <SidebarProvider>
      {skip}
      <WorkspaceNavigation
        context={context}
        organization={organization}
        branch={branch}
        homeUrl={homeUrl}
        destinations={destinations.filter(({ visible }) => visible)}
        pathname={pathname}
      />
      <SidebarInset className="min-w-0">
        <WorkspaceHeader
          title={
            destinations.find((d) => d.path === pathname)?.label ??
            t("workspace")
          }
        />
        {content}
      </SidebarInset>
    </SidebarProvider>
  );
}

const destinationIcons: Record<string, LucideIcon> = {
  "/app": Home,
  "/app/catalog": Package,
  "/app/inventory": Boxes,
  "/app/pos": ShoppingCart,
  "/app/analytics": BarChart3,
  "/app/sales": Receipt,
  "/app/suppliers": Truck,
  "/app/purchase-orders": ClipboardList,
  "/app/branches": Store,
  "/app/members": Users,
  "/app/profile": UserRound,
  "/app/organization-settings": Settings,
};

function WorkspaceHeader({ title }: { title: string }) {
  const { t } = useLanguage();
  const { open, openMobile, isMobile } = useSidebar();
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <SidebarTrigger
        aria-label={t("menu")}
        aria-expanded={isMobile ? openMobile : open}
      />
      <Separator orientation="vertical" className="h-4" />
      <span className="text-sm font-medium">{title}</span>
    </header>
  );
}

function WorkspaceNavigation({
  context,
  organization,
  branch,
  homeUrl,
  destinations,
  pathname,
}: {
  context: AccessContext;
  organization: AccessibleOrganization | null | undefined;
  branch: { code: string; name: string } | null | undefined;
  homeUrl: string;
  destinations: { label: string; path: string; visible: boolean }[];
  pathname: string;
}) {
  const { t } = useLanguage();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="offcanvas" closeLabel={t("closeMenu")}>
      <aside aria-label={t("sidebar")} className="flex h-full min-h-0 flex-col">
        <SidebarHeader>
          <Link
            className="flex h-9 items-center rounded-md px-2 focus-visible:outline-2 focus-visible:outline-ring"
            href={homeUrl}
            onClick={() => setOpenMobile(false)}
          >
            <BrandLogo className="h-6" />
          </Link>
          {organization && (
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{t("workspace")}</p>
              <p
                className="mt-1 truncate text-sm font-medium"
                title={organization.name}
              >
                {organization.name}
              </p>
              {branch && (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {branch.code} · {branch.name}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {t(organization.role)}
              </p>
            </div>
          )}
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t("operations")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <nav
                aria-label={t("primaryNavigation")}
                id="application-navigation"
              >
                <SidebarMenu>
                  {destinations.map(({ label, path }) => {
                    const Icon = destinationIcons[path] ?? Home;
                    return (
                      <SidebarMenuItem key={path}>
                        <SidebarMenuButton
                          isActive={pathname === path}
                          render={
                            <Link
                              href={
                                path === "/app"
                                  ? homeUrl
                                  : path + homeUrl.slice(4)
                              }
                              aria-current={
                                pathname === path ? "page" : undefined
                              }
                              onClick={() => setOpenMobile(false)}
                            />
                          }
                        >
                          <Icon aria-hidden="true" />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <Separator />
          <PreferenceControls />
          <p className="break-words px-2 text-xs text-muted-foreground">
            {context.user.displayName ?? context.user.email}
          </p>
          <LogoutButton />
        </SidebarFooter>
      </aside>
    </Sidebar>
  );
}
