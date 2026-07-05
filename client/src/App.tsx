import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import TaskQueue from "./pages/TaskQueue";
import ExecutionLog from "./pages/ExecutionLog";
import Goals from "./pages/Goals";
import Opportunities from "./pages/Opportunities";
import SystemConfig from "./pages/SystemConfig";
import DashboardLayout from "./components/DashboardLayout";

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/tasks"} component={TaskQueue} />
        <Route path={"/executions"} component={ExecutionLog} />
        <Route path={"/goals"} component={Goals} />
        <Route path={"/opportunities"} component={Opportunities} />
        <Route path={"/config"} component={SystemConfig} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
