import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, ChevronRight, Ticket } from "lucide-react";
import type { CrewView } from "@shared/schema";
import { ACTIVITY_GROUPS, ACTIVITY_ICON, type Activity } from "@shared/schema";
import { Page, Avatar, Logo } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiJson, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/color";
import { AccountMenu, InstallHint } from "@/components/preferences";


export default function Home() {
  const { user } = useAuth();
  const crews = useQuery<CrewView[]>({ queryKey: ["/api/crews"] });

  return (
    <Page
      title={<Logo />}
      action={
        <div className="flex items-center gap-2">
          <AccountMenu />
          <NewCrewButton />
        </div>
      }
    >
      <p className="mb-4 text-sm text-muted-foreground" data-testid="text-greeting">
        Hey {user?.name}. {crews.data?.length ? "Here's who's wearing what." : "Start a crew or join one with a code."}
      </p>

      {crews.isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      )}

      {crews.data && crews.data.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-2xl">👯‍♀️</div>
          <p className="font-semibold">No crews yet</p>
          <p className="mb-4 text-sm text-muted-foreground">A crew is the group you get dressed for: your 6am class, run club, Saturday doubles.</p>
          <NewCrewButton primary />
          <InstallHint className="mt-5 text-left" />
        </div>
      )}

      <div className="space-y-3">
        {crews.data?.map((c) => (
          <Link key={c.id} href={`/crews/${c.id}`} className="block rounded-2xl border border-card-border bg-card p-4 hover-elevate" data-testid={`card-crew-${c.id}`}>
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-xl">{ACTIVITY_ICON[c.activity as Activity] ?? "✨"}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="truncate text-base font-bold">{c.name}</h2>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">{c.activity} · {c.members.length} {c.members.length === 1 ? "member" : "members"}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="flex -space-x-2">
                    {c.members.slice(0, 5).map((m) => <Avatar key={m.id} user={m} size="sm" />)}
                  </span>
                  {c.nextSession ? (
                    <span className="rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground" data-testid={`text-next-${c.id}`}>
                      {formatDate(c.nextSession.date)} · {c.nextSession.pickCount}/{c.members.length} picked
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">No picks yet · tap to post today's</span>
                  )}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </Page>
  );
}

function NewCrewButton({ primary = false }: { primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [activity, setActivity] = useState<string>("Date night");
  const [code, setCode] = useState("");
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () => apiJson<CrewView>("POST", "/api/crews", { name, activity }),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["/api/crews"] });
      setOpen(false);
      setName("");
      toast({ title: `${c.name} is ready`, description: `Invite code ${c.inviteCode}. Share it with your crew.` });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  const join = useMutation({
    mutationFn: () => apiJson<CrewView>("POST", "/api/crews/join", { inviteCode: code }),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["/api/crews"] });
      setOpen(false);
      setCode("");
      toast({ title: `You're in ${c.name}` });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {primary ? (
          <Button data-testid="button-new-crew"><Plus className="h-4 w-4" /> New crew</Button>
        ) : (
          <Button size="icon" variant="default" className="rounded-full" aria-label="New crew" data-testid="button-new-crew"><Plus className="h-5 w-5" /></Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader><DialogTitle className="font-display text-xl">{tab === "create" ? "Start a crew" : "Join a crew"}</DialogTitle></DialogHeader>
        <div className="flex rounded-full bg-muted p-1 text-sm font-medium">
          {(["create", "join"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`flex-1 rounded-full py-1.5 ${tab === t ? "bg-card shadow-sm" : "text-muted-foreground"}`} data-testid={`button-crewtab-${t}`}>
              {t === "create" ? "Create" : "I have a code"}
            </button>
          ))}
        </div>
        {tab === "create" ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="crew-name">Crew name</Label>
              <Input id="crew-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Saturday date night" required data-testid="input-crew-name" />
            </div>
            <div className="space-y-1.5">
              <Label>Activity</Label>
              <Select value={activity} onValueChange={setActivity}>
                <SelectTrigger data-testid="select-activity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIVITY_GROUPS.map((g) => (
                    <SelectGroup key={g.label}>
                      <SelectLabel>{g.label}</SelectLabel>
                      {g.items.map((a) => <SelectItem key={a} value={a}>{ACTIVITY_ICON[a]} {a}</SelectItem>)}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full" disabled={create.isPending} data-testid="button-create-crew">{create.isPending ? "Creating…" : "Create crew"}</Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); join.mutate(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="code">Invite code</Label>
              <div className="flex items-center gap-2">
                <Ticket className="h-5 w-5 text-muted-foreground" />
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" className="font-mono uppercase tracking-widest" required data-testid="input-invite-code" />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={join.isPending} data-testid="button-join-crew">{join.isPending ? "Joining…" : "Join"}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
