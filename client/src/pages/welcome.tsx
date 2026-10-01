import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo, APP_NAME } from "@/components/shell";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

export default function Welcome() {
  const { signup, login } = useAuth();
  const { toast, dismiss } = useToast();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    dismiss();
    try {
      if (mode === "signup") await signup({ name, handle, pin });
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
        <Button type="submit" className="w-full" size="lg" disabled={busy} data-testid="button-submit-auth">
          {busy ? "One sec…" : mode === "signup" ? `Join ${APP_NAME}` : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
