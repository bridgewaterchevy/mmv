import { useEffect, useState } from "react";
import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Logo } from "@/components/shell";
import { ReportProblemHost } from "@/components/report-problem";
import { getPendingInvite, inviteCodeFromPath, setPendingInvite } from "@/lib/invite";
import NotFound from "@/pages/not-found";
import Welcome from "@/pages/welcome";
import Home from "@/pages/home";
import CrewPage from "@/pages/crew";
import SessionPage from "@/pages/session";
import Closet from "@/pages/closet";
import JoinPage, { InviteGate } from "@/pages/join";
import DiscoverPage from "@/pages/discover";
import PostPage from "@/pages/post";
import ProfilePage from "@/pages/profile";
import { SignInPromptHost } from "@/components/sign-in-prompt";
import { isPublicPath } from "@/lib/discover";

/** Routes that render with or without a token: the Discover feed, a post permalink, a profile. */
function PublicRoutes() {
  return (
    <Switch>
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/discover/:vibe" component={DiscoverPage} />
      <Route path="/p/:id" component={PostPage} />
      <Route path="/u/:handle" component={ProfilePage} />
    </Switch>
  );
}

/**
 * Logged-out visitor: #/join/:code → stash the code, then show Welcome with the invite banner;
 * #/discover, #/p/:id, #/u/:handle render as-is (public); anything else → Welcome.
 */
function SignedOut() {
  const [loc, navigate] = useLocation();
  const code = inviteCodeFromPath(loc);
  useEffect(() => {
    if (!code) return;
    setPendingInvite(code);
    navigate("/", { replace: true });
  }, [code, navigate]);
  if (isPublicPath(loc)) return <PublicRoutes />;
  return <Welcome />;
}

function SignedIn() {
  const [pending, setPending] = useState<string | null>(() => getPendingInvite());
  if (pending) return <InviteGate code={pending} onDone={() => setPending(null)} />;
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/join/:code" component={JoinPage} />
      <Route path="/crews/:id" component={CrewPage} />
      <Route path="/sessions/:id" component={SessionPage} />
      <Route path="/closet" component={Closet} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/discover/:vibe" component={DiscoverPage} />
      <Route path="/p/:id" component={PostPage} />
      <Route path="/u/:handle" component={ProfilePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppRouter() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Logo className="animate-pulse" />
      </div>
    );
  }
  if (!user) return <SignedOut />;
  return <SignedIn />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
            <ReportProblemHost />
            <SignInPromptHost />
          </Router>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
