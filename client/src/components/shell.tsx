import { Link, useLocation } from "wouter";
import { Users, Shirt, ChevronLeft, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicUser } from "@shared/schema";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { openReportProblem, openSuggestion } from "@/components/report-problem";

export const APP_NAME = "MMV";
export const APP_TAGLINE = "Match My Vibe";

export function Logo({ className, withWord = true }: { className?: string; withWord?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg aria-label={APP_NAME} viewBox="0 0 32 32" className="h-7 w-7" fill="none">
        <rect width="32" height="32" rx="9" className="fill-primary" />
        <circle cx="12.5" cy="16" r="6" stroke="hsl(var(--primary-foreground))" strokeWidth="2.6" />
        <circle cx="19.5" cy="16" r="6" stroke="hsl(var(--primary-foreground))" strokeWidth="2.6" />
      </svg>
      {withWord && (
        <span className="flex flex-col leading-none">
          <span className="font-display text-xl font-bold tracking-tight">{APP_NAME}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{APP_TAGLINE}</span>
        </span>
      )}
    </span>
  );
}

export function Avatar({ user, size = "md", className }: { user: PublicUser; size?: "sm" | "md" | "lg"; className?: string }) {
  const s = size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-14 w-14 text-lg" : "h-9 w-9 text-sm";
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-background", s, className)}
      style={{ backgroundColor: user.color }}
      title={user.name}
      data-testid={`img-avatar-${user.id}`}
    >
      {user.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function Swatches({ colors, size = "md" }: { colors: string[]; size?: "sm" | "md" }) {
  if (!colors.length) return null;
  const s = size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5";
  return (
    <span className="inline-flex -space-x-1.5">
      {colors.slice(0, 4).map((c, i) => (
        <span key={i} className={cn("rounded-full ring-2 ring-card", s)} style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}

export function Page({
  title,
  back,
  action,
  children,
  subtitle,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  back?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] backdrop-blur">
        <div className="flex items-center gap-2">
          {back !== undefined ? (
            <Link href={back} className="-ml-2 rounded-full p-2 text-muted-foreground hover-elevate" data-testid="link-back" aria-label="Back">
              <ChevronLeft className="h-5 w-5" />
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">
            {typeof title === "string" ? (
              <h1 className="truncate font-display text-xl font-bold leading-tight">{title}</h1>
            ) : (
              title ?? <Logo />
            )}
            {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </div>
      </header>
      <main className="flex-1 px-4 pb-28 pt-4 fade-up">{children}</main>
      <TabBar />
    </div>
  );
}

function TabBar() {
  const [loc] = useLocation();
  const { logout } = useAuth();
  const tabs = [
    { href: "/", label: "Crews", icon: Users, active: loc === "/" || loc.startsWith("/crews") || loc.startsWith("/sessions") },
    { href: "/closet", label: "Closet", icon: Shirt, active: loc.startsWith("/closet") },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md border-t border-border/70 bg-background/90 backdrop-blur safe-bottom">
      <div className="flex items-stretch">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs font-medium",
              t.active ? "text-primary" : "text-muted-foreground",
            )}
            data-testid={`link-tab-${t.label.toLowerCase()}`}
          >
            <t.icon className="h-5 w-5" strokeWidth={t.active ? 2.4 : 1.8} />
            {t.label}
          </Link>
        ))}
        <button
          onClick={logout}
          className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs font-medium text-muted-foreground"
          data-testid="button-logout"
        >
          <LogOut className="h-5 w-5" strokeWidth={1.8} />
          Sign out
        </button>
      </div>
      <div className="-mt-1 flex items-center justify-center pb-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={openReportProblem}
          className="rounded-md px-2 py-0.5 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="link-report-problem"
        >
          Report a problem
        </button>
        <span aria-hidden className="select-none">·</span>
        <button
          type="button"
          onClick={openSuggestion}
          className="rounded-md px-2 py-0.5 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="link-suggest-idea"
        >
          Suggest an idea
        </button>
      </div>
    </nav>
  );
}
