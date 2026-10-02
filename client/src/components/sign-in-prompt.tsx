// "Sign in to do that" prompt for logged-out visitors on the public Discover surfaces.
// Mounted once (SignInPromptHost in App); any button calls requireSignIn(reason) or uses useGate().
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { LogIn, Heart, UserPlus, Flag, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { setReturnTo } from "@/lib/discover";

export type SignInReason = "like" | "follow" | "report" | "share" | "generic";

const OPEN_EVENT = "mmv:sign-in";

export function requireSignIn(reason: SignInReason = "generic"): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<{ reason: SignInReason }>(OPEN_EVENT, { detail: { reason } }));
}

/** Returns a wrapper that runs `fn` when signed in, otherwise opens the sign-in prompt. */
export function useGate() {
  const { user } = useAuth();
  return function gate<A extends unknown[]>(reason: SignInReason, fn: (...args: A) => void) {
    return (...args: A) => {
      if (user) fn(...args);
      else requireSignIn(reason);
    };
  };
}

const COPY: Record<SignInReason, { title: string; body: string; icon: ReactNode }> = {
  like: { title: "Sign in to like fits", body: "Likes bump a look up the Top feed. It takes a first name, a handle and a 4-digit PIN.", icon: <Heart className="h-5 w-5" /> },
  follow: { title: "Sign in to follow", body: "Follow people whose fits you want to keep seeing. It takes a first name, a handle and a 4-digit PIN.", icon: <UserPlus className="h-5 w-5" /> },
  report: { title: "Sign in to report", body: "So we can follow up if we need to. It takes a first name, a handle and a 4-digit PIN.", icon: <Flag className="h-5 w-5" /> },
  share: { title: "Sign in to share your fit", body: "Post a pick to Discover from any of your crews. It takes a first name, a handle and a 4-digit PIN.", icon: <Sparkles className="h-5 w-5" /> },
  generic: { title: "Sign in to continue", body: "It takes a first name, a handle and a 4-digit PIN.", icon: <LogIn className="h-5 w-5" /> },
};

export function SignInPromptHost() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<SignInReason>("generic");
  const [loc, navigate] = useLocation();
  const { user } = useAuth();
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<{ reason?: SignInReason }>).detail?.reason;
      setReason(r && r in COPY ? r : "generic");
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  // Signed in while the prompt is up (another tab, etc.) → nothing left to ask.
  useEffect(() => { if (user) setOpen(false); }, [user]);
  const c = COPY[reason];

  function go() {
    setReturnTo(loc);
    setOpen(false);
    navigate("/");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm rounded-2xl" data-testid="dialog-sign-in">
        <DialogHeader className="text-left">
          <div className="mb-1 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">{c.icon}</span>
            <DialogTitle className="font-display text-xl leading-tight">{c.title}</DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">{c.body}</DialogDescription>
        </DialogHeader>
        <Button size="lg" className="w-full" onClick={go} data-testid="button-sign-in-go">
          <LogIn className="h-4 w-4" /> Sign in or join MMV
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => setOpen(false)} data-testid="button-sign-in-later">Keep browsing</Button>
      </DialogContent>
    </Dialog>
  );
}
