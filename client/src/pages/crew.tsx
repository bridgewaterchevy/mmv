import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, Users, Share2 } from "lucide-react";
import type { CrewView, Session, SessionView } from "@shared/schema";
import { Page, Avatar } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { copyText, shareInvite } from "@/lib/invite";
import { useToast } from "@/hooks/use-toast";
import { todayIso } from "@/lib/color";
import { cn } from "@/lib/utils";
import { SessionBody, SessionSkeleton } from "@/pages/session";

type CrewDetail = CrewView & { sessions: (Session & { pickCount: number })[] };

export default function CrewPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const crew = useQuery<CrewDetail>({ queryKey: ["/api/crews", id] });
  const [date, setDate] = useState(todayIso());
  const [showMembers, setShowMembers] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const day = useQuery<SessionView>({ queryKey: ["/api/crews", id, "day", date], refetchInterval: 15_000, enabled: !!crew.data });

  const [sharing, setSharing] = useState(false);

  /** Native share sheet (title + text + deep link) or clipboard fallback. */
  async function invite() {
    if (!crew.data || sharing) return;
    setSharing(true);
    try {
      const outcome = await shareInvite(crew.data.name, crew.data.inviteCode);
      if (outcome === "copied") toast({ title: "Invite copied", description: "Paste it into your group chat. The link opens straight to your crew." });
      else if (outcome === "failed") toast({ title: `Invite code: ${crew.data.inviteCode}`, description: "Couldn't copy automatically — read it out or type it for them." });
    } finally {
      setSharing(false);
    }
  }

  /** Tap-to-copy just the short code. */
  async function copyCode() {
    if (!crew.data) return;
    const ok = await copyText(crew.data.inviteCode);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast({ title: `Code ${crew.data.inviteCode} copied` });
    } else {
      toast({ title: `Invite code: ${crew.data.inviteCode}` });
    }
  }

  if (crew.isLoading) {
    return (
      <Page title=" " back="/">
        <Skeleton className="mb-3 h-12 rounded-2xl" />
        <SessionSkeleton />
      </Page>
    );
  }
  if (!crew.data) return <Page title="Crew not found" back="/"><p className="text-sm text-muted-foreground">You may not be a member of this crew.</p></Page>;

  const c = crew.data;
  const days = [-1, 0, 1, 2, 3, 4, 5].map((o) => todayIso(o));
  const picksByDate = new Map(c.sessions.map((s) => [s.date, s.pickCount]));

  return (
    <Page
      title={c.name}
      subtitle={`${c.activity} · ${c.members.length} ${c.members.length === 1 ? "member" : "members"}`}
      back="/"
      action={
        <button onClick={() => setShowMembers((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold hover-elevate" data-testid="button-toggle-members">
          <Users className="h-3.5 w-3.5" /> Crew
        </button>
      }
    >
      <Button onClick={invite} disabled={sharing} className="mb-4 w-full" size="lg" data-testid="button-invite">
        <Share2 className="h-4 w-4" /> {sharing ? "Opening share…" : "Invite friends"}
      </Button>

      {showMembers && (
        <section className="mb-4 rounded-2xl border border-card-border bg-card p-4 fade-up">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Members</span>
            <button onClick={copyCode} className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-mono text-xs font-semibold tracking-widest hover-elevate" data-testid="button-copy-invite">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {c.inviteCode}
            </button>
          </div>
          <div className="flex flex-wrap gap-3">
            {c.members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-sm" data-testid={`text-member-${m.id}`}>
                <Avatar user={m} size="sm" /> <span>{m.name}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Tap the code to copy it, or use Invite friends to send a link that opens straight to this crew.</p>
        </section>
      )}

      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar">
        {days.map((d) => {
          const active = d === date;
          const n = picksByDate.get(d) ?? (d === date ? day.data?.picks.length : undefined);
          return (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={cn(
                "flex min-w-[64px] shrink-0 flex-col items-center rounded-2xl border px-3 py-2 leading-tight",
                active ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-card text-foreground hover-elevate",
                d < todayIso() && !active && "opacity-60",
              )}
              data-testid={`button-day-${d}`}
            >
              <span className={cn("text-[10px] font-semibold uppercase", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{dayLabel(d)}</span>
              <span className="text-base font-bold">{Number(d.split("-")[2])}</span>
              <span className={cn("mt-0.5 h-1.5 w-1.5 rounded-full", n ? (active ? "bg-primary-foreground" : "bg-primary") : "bg-transparent")} />
            </button>
          );
        })}
      </div>

      {day.isLoading || !day.data ? <SessionSkeleton /> : <SessionBody key={day.data.id} session={day.data} queryKey={["/api/crews", id, "day", date]} />}
    </Page>
  );
}

function dayLabel(iso: string) {
  const today = todayIso();
  if (iso === today) return "Today";
  if (iso === todayIso(1)) return "Tmrw";
  if (iso === todayIso(-1)) return "Yday";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}
