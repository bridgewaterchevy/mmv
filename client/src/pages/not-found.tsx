import { Link } from "wouter";
import { Page } from "@/components/shell";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <Page title="Hmm, nothing here">
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="font-semibold">That page doesn't exist</p>
        <p className="mb-4 text-sm text-muted-foreground">The link may be old, or the crew may have been removed.</p>
        <Button asChild><Link href="/">Back to my crews</Link></Button>
      </div>
    </Page>
  );
}
