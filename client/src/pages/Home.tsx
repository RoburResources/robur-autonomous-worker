import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, Phone, Mail, MessageSquare, CheckCircle2,
  XCircle, Clock, AlertTriangle, Power, PowerOff
} from "lucide-react";

export default function Home() {
  const { data: health, isLoading: healthLoading } = trpc.health.status.useQuery();
  const { data: todayMetrics } = trpc.metrics.today.useQuery();
  const { data: pendingTasks } = trpc.tasks.byStatus.useQuery({ status: "pending", limit: 5 });
  const { data: recentExecs } = trpc.executions.list.useQuery({ limit: 10 });
  const toggleKillSwitch = trpc.health.toggleKillSwitch.useMutation();
  const isRetired = health?.systemStatus === "retired";

  const handleToggleKillSwitch = async () => {
    if (!health) return;
    await toggleKillSwitch.mutateAsync({ active: !health.killSwitchActive });
    window.location.reload();
  };

  if (healthLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-20" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* System Status Banner */}
      <Card className={health?.killSwitchActive ? "border-destructive bg-destructive/5" : "border-green-500/50 bg-green-500/5"}>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {health?.killSwitchActive ? (
              <PowerOff className="h-5 w-5 text-destructive" />
            ) : (
              <Power className="h-5 w-5 text-green-500" />
            )}
            <div>
              <p className="font-semibold">
                System: {isRetired ? "RETIRED" : health?.killSwitchActive ? "PAUSED" : "ACTIVE"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isRetired
                  ? "This legacy worker is retired by deployment policy and cannot execute autonomous work."
                  : health?.killSwitchActive
                  ? "All autonomous operations are paused. Send START via SMS or click to resume."
                  : "Autonomous worker is running. Generating tasks, executing, and evaluating."}
              </p>
            </div>
          </div>
          <Button
            variant={health?.killSwitchActive ? "default" : "destructive"}
            size="sm"
            onClick={handleToggleKillSwitch}
            disabled={toggleKillSwitch.isPending || isRetired}
          >
            {isRetired ? "Retired" : health?.killSwitchActive ? "Resume Operations" : "Kill Switch"}
          </Button>
        </CardContent>
      </Card>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tasks Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{todayMetrics?.tasksCompleted ?? 0}</div>
            <p className="text-xs text-muted-foreground">today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Calls Made</CardTitle>
            <Phone className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{health?.callsToday ?? 0} / {health?.maxCalls ?? 20}</div>
            <p className="text-xs text-muted-foreground">daily limit</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emails Sent</CardTitle>
            <Mail className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{health?.emailsToday ?? 0} / {health?.maxEmails ?? 100}</div>
            <p className="text-xs text-muted-foreground">daily limit</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tasks Failed</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{todayMetrics?.tasksFailed ?? 0}</div>
            <p className="text-xs text-muted-foreground">today</p>
          </CardContent>
        </Card>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pending Tasks */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Next Up (Pending Tasks)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingTasks && pendingTasks.length > 0 ? (
              <div className="space-y-3">
                {pendingTasks.map(task => (
                  <div key={task.id} className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {task.priorityScore}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm truncate">{task.description}</p>
                      <p className="text-xs text-muted-foreground">{task.actionType}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No pending tasks. Generator will create new ones soon.</p>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentExecs && recentExecs.length > 0 ? (
              <div className="space-y-2">
                {recentExecs.slice(0, 8).map(exec => (
                  <div key={exec.id} className="flex items-center gap-3 text-sm">
                    <Badge
                      variant={exec.outcome === "success" ? "default" : exec.outcome === "failure" ? "destructive" : "secondary"}
                      className="text-xs shrink-0"
                    >
                      {exec.outcome}
                    </Badge>
                    <span className="truncate text-muted-foreground">{exec.actionType}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {new Date(exec.createdAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No activity yet. System will begin executing tasks shortly.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
