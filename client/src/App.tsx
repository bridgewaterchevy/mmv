import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Logo } from "@/components/shell";
import NotFound from "@/pages/not-found";
import Welcome from "@/pages/welcome";
import Home from "@/pages/home";
import CrewPage from "@/pages/crew";
import SessionPage from "@/pages/session";
import Closet from "@/pages/closet";

function AppRouter() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Logo className="animate-pulse" />
      </div>
    );
  }
  if (!user) return <Welcome />;
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/crews/:id" component={CrewPage} />
      <Route path="/sessions/:id" component={SessionPage} />
      <Route path="/closet" component={Closet} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
