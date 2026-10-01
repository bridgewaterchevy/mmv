import { useEffect, useState } from "react";
import { Lightbulb, LifeBuoy, Share, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar } from "@/components/shell";
import { isStandalone, SHOP_FOR_OPTIONS, type ShopFor } from "@/lib/invite";
import { openReportProblem, openSuggestion } from "@/components/report-problem";

/**
 * Segmented control for the "shop for" preference. Tapping the selected segment again clears it
 * (so the signup form can stay optional).
 */
export function ShopForControl({
  value,
  onChange,
  size = "md",
  allowClear = true,
  className,
  idPrefix = "shopfor",
}: {
  value: ShopFor | null;
  onChange: (v: ShopFor | null) => void;
  size?: "sm" | "md";
  allowClear?: boolean;
  className?: string;
  idPrefix?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Shop for"
      className={cn("flex rounded-full bg-muted p-1 font-medium", size === "sm" ? "text-xs" : "text-sm", className)}
      data-testid={`${idPrefix}-group`}
    >
      {SHOP_FOR_OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(active && allowClear ? null : o.value)}
            className={cn(
              "flex-1 rounded-full transition",
              size === "sm" ? "py-1" : "py-1.5",
              active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
            )}
            data-testid={`button-${idPrefix}-${o.value}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One-tap account menu for the Crews header: avatar → popover with the shop-for preference. */
export function AccountMenu() {
  const { user, setShopFor } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  if (!user) return null;

  async function change(v: ShopFor | null) {
    const ok = await setShopFor(v);
    if (!ok) toast({ title: "Couldn't save that yet", description: "We'll keep showing everything for now.", variant: "destructive" });
    else if (v) toast({ title: `Shopping ${SHOP_FOR_OPTIONS.find((o) => o.value === v)?.label.toLowerCase()} picks` });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative rounded-full ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Account settings"
          data-testid="button-account"
        >
          <Avatar user={user} />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-background bg-secondary text-foreground">
            <SlidersHorizontal className="h-2.5 w-2.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-2xl p-4" data-testid="popover-account">
        <div className="mb-3 flex items-center gap-3">
          <Avatar user={user} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">@{user.handle}</p>
          </div>
        </div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Shop for</p>
        <ShopForControl value={user.shopFor ?? null} onChange={change} size="sm" idPrefix="account-shopfor" />
        <p className="mt-2 text-xs text-muted-foreground">Controls which shop links we show under your crew's picks.</p>
        <div className="-mx-4 mt-3 border-t border-border/70 px-2 pt-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openReportProblem();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm font-medium hover-elevate"
            data-testid="button-report-problem"
          >
            <LifeBuoy className="h-4 w-4 text-primary" aria-hidden />
            Report a problem
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSuggestion();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm font-medium hover-elevate"
            data-testid="button-suggest-idea"
          >
            <Lightbulb className="h-4 w-4 text-primary" aria-hidden />
            Suggest an idea
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Add to Home Screen" nudge. Hidden once the app is running standalone. */
export function InstallHint({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(!isStandalone());
  }, []);
  if (!show) return null;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-2xl border border-dashed border-border bg-card/60 text-xs text-muted-foreground",
        compact ? "px-3 py-2" : "p-3",
        className,
      )}
      data-testid="text-install-hint"
    >
      <Share className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <p>
        <span className="font-semibold text-foreground">Install on iPhone:</span> Safari → Share → Add to Home Screen. Opens full-screen, no browser bar.
      </p>
    </div>
  );
}
