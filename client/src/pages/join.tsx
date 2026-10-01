import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import type { CrewView } from "@shared/schema";
import { Logo } from "@/components/shell";
import { apiJson, queryClient } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { clearPendingInvite, normalizeInviteCode } from "@/lib/invite";

/**
 * Join a crew by invite code. Resolves to the path to navigate to.
 * Any failure (bad/expired code, already a member, server down) toasts and sends the user home.
 */
export async function joinByInvite(code: string): Promise<string> {
  try {
    const crew = await apiJson<CrewView>("POST", "/api/crews/join", { inviteCode: code });
    queryClient.invalidateQueries({ queryKey: ["/api/crews"] });
    toast({ title: `You joined ${crew.name}`, description: "Post today's pick so your crew can see it." });
    return `/crews/${crew.id}`;
  } catch (err) {
    const message = (err as Error)?.message || "";
    toast({
      title: "That invite didn't work",
      description: /not found|invalid|expired|no crew/i.test(message)
        ? `No crew matches code ${code}. Ask for a fresh link.`
        : message || "Try the code from the + button on the Crews screen.",
      variant: "destructive",
    });
    return "/";
  }
}

function JoiningScreen({ code }: { code: string }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <Logo className="animate-pulse" />
      <p className="text-sm text-muted-foreground" data-testid="text-joining">
        Joining crew <span className="font-mono font-semibold tracking-widest text-foreground">{code}</span>…
      </p>
    </div>
  );
}

/** Signed-in route for #/join/:code — joins immediately. */
export default function JoinPage({ params }: { params: { code: string } }) {
  const [, navigate] = useLocation();
  const code = normalizeInviteCode(params.code);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    clearPendingInvite();
    if (!code) {
      toast({ title: "That invite link looks broken", description: "Ask your friend to share it again.", variant: "destructive" });
      navigate("/", { replace: true });
      return;
    }
    joinByInvite(code).then((to) => navigate(to, { replace: true }));
  }, [code, navigate]);

  return <JoiningScreen code={code ?? "…"} />;
}

/**
 * Mounted inside the signed-in tree. If a code was stashed while the visitor was logged out
 * (see App.tsx), consume it once the user exists: join, toast, and open the crew.
 */
export function InviteGate({ code, onDone }: { code: string; onDone: () => void }) {
  const [, navigate] = useLocation();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    clearPendingInvite();
    joinByInvite(code).then((to) => {
      navigate(to, { replace: true });
      onDone();
    });
  }, [code, navigate, onDone]);

  return <JoiningScreen code={code} />;
}
