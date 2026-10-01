import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Shirt, ExternalLink } from "lucide-react";
import type { PickView, Session, Crew } from "@shared/schema";
import { Page, Swatches } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";
import { assetUrl } from "@/lib/queryClient";
import { formatDate } from "@/lib/color";

type ClosetPick = PickView & { session: Session; crew: Crew };

export default function Closet() {
  const q = useQuery<ClosetPick[]>({ queryKey: ["/api/closet"] });
  const pieces = q.data?.reduce((n, p) => n + p.items.length, 0) ?? 0;

  return (
    <Page title="Closet" subtitle={q.data ? `${q.data.length} looks · ${pieces} pieces spotted` : undefined}>
      {q.isLoading && <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />)}</div>}
      {q.data && q.data.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <Shirt className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />
          <p className="font-semibold">Nothing worn yet</p>
          <p className="text-sm text-muted-foreground">Every pick you post lands here so you remember what you wore, and where.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {q.data?.map((p) => (
          <Link key={p.id} href={`/sessions/${p.sessionId}`} className="overflow-hidden rounded-2xl border border-card-border bg-card hover-elevate" data-testid={`card-closet-${p.id}`}>
            <img src={assetUrl(p.photoPath)} alt="" className="aspect-[3/4] w-full object-cover" loading="lazy" />
            <div className="px-2.5 py-2">
              <p className="truncate text-sm font-semibold">{p.session.title}</p>
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground">{p.crew.name} · {formatDate(p.session.date)}</p>
                <Swatches colors={p.palette} size="sm" />
              </div>
            </div>
          </Link>
        ))}
      </div>
      {q.data && (
        <aside className="mt-6 rounded-2xl border border-card-border bg-card px-4 py-3" data-testid="card-closet-featured">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Crew favorite this week</p>
          <a
            href="https://sovrn.co/v4b8fpj"
            target="_blank"
            rel="noopener sponsored"
            className="mt-1 flex items-center justify-between gap-3 text-sm font-semibold text-primary"
            data-testid="link-featured-lululemon"
          >
            <span>Lululemon Align High-Rise Pant 25"</span>
            <ExternalLink className="h-4 w-4 shrink-0" />
          </a>
          <p className="mt-1 text-[11px] text-muted-foreground">Affiliate link. MMV may earn a commission at no extra cost to you.</p>
        </aside>
      )}
    </Page>
  );
}
