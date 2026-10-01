import { useState } from "react";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo, APP_NAME } from "@/components/shell";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getPendingInvite, type ShopFor } from "@/lib/invite";
import { InstallHint, ShopForControl } from "@/components/preferences";

export default function Welcome() {
  const { signup, login } = useAuth();
  const { toast, dismiss } = useToast();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [shopFor, setShopFor] = useState<ShopFor | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingInvite = getPendingInvite();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    dismiss();
    try {
      if (mode === "signup") await signup({ name, handle, pin, ...(shopFor ? { shopFor } : {}) });
      else await login({ handle, pin });
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-background px-6 pb-10 pt-[calc(env(safe-area-inset-top,0px)+2.5rem)]">
      <Logo className="mb-10" />
      {pendingInvite && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-3.5 fade-up" role="status" data-testid="banner-invite">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Ticket className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">You're invited to a crew — sign up to join</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Code <span className="font-mono font-semibold tracking-widest text-foreground">{pendingInvite}</span> is saved. Already have an account? Sign in instead.
            </p>
          </div>
        </div>
      )}
      <div className="mb-8 fade-up">
        <p className="mb-2 text-sm font-medium uppercase tracking-wider text-primary">Date night · girls' night · game day · gym</p>
        <h1 className="font-display text-xl font-bold leading-snug">
          Stop texting outfit pics back and forth. See what everyone's wearing, lock in the look, and find every piece for less.
        </h1>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-2 text-center text-xs text-muted-foreground">
        {[
          ["1", "Make a crew", "Invite by code"],
          ["2", "Post your pick", "Photo of the fit"],
          ["3", "Match & lock", "Shop it cheaper"],
        ].map(([n, t, d]) => (
          <div key={n} className="rounded-2xl border border-card-border bg-card p-3">
            <div className="mx-auto mb-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{n}</div>
            <div className="font-semibold text-foreground">{t}</div>
            <div>{d}</div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-card-border bg-card p-5">
        <div className="flex rounded-full bg-muted p-1 text-sm font-medium">
          {(["signup", "login"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-full py-1.5 transition ${mode === m ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              data-testid={`button-mode-${m}`}
            >
              {m === "signup" ? "New here" : "Sign in"}
            </button>
          ))}
        </div>
        {mode === "signup" && (
          <div className="space-y-1.5">
            <Label htmlFor="name">First name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jess" required autoComplete="given-name" data-testid="input-name" />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="handle">Handle</Label>
          <div className="flex items-center rounded-md border border-input bg-background pl-3 focus-within:ring-2 focus-within:ring-ring">
            <span className="text-muted-foreground">@</span>
            <Input
              id="handle"
              className="border-0 bg-transparent pl-1 focus-visible:ring-0"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="jess_lifts"
              required
              autoCapitalize="none"
              data-testid="input-handle"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pin">4-digit PIN</Label>
          <Input
            id="pin"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="••••"
            required
            type="password"
            data-testid="input-pin"
          />
          <p className="text-xs text-muted-foreground">Quick sign-in for the early test. Real accounts come later.</p>
        </div>
        {mode === "signup" && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label>Shop for</Label>
              <span className="text-xs text-muted-foreground">Optional</span>
            </div>
            <ShopForControl value={shopFor} onChange={setShopFor} idPrefix="signup-shopfor" />
          </div>
        )}
        <Button type="submit" className="w-full" size="lg" disabled={busy} data-testid="button-submit-auth">
          {busy ? "One sec…" : mode === "signup" ? (pendingInvite ? "Sign up & join crew" : `Join ${APP_NAME}`) : pendingInvite ? "Sign in & join crew" : "Sign in"}
        </Button>
      </form>
      <InstallHint className="mt-4" />
    </div>
  );
}
