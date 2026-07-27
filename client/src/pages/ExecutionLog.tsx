import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const outcomeColors: Record<string, string> = {
  success: "bg-green-500/10 text-green-600 border-green-500/20",
  failure: "bg-red-500/10 text-red-600 border-red-500/20",
  partial: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  pending: "bg-blue-500/10 text-blue-600 border-blue-500/20",
};

export default function ExecutionLog() {
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");
  const { data: executions, isLoading } = trpc.executions.list.useQuery({ limit: 200 });

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  const allExecs = executions || [];
  const successCount = allExecs.filter(e => e.outcome === "success").length;
  const failureCount = allExecs.filter(e => e.outcome === "failure").length;
  const pendingCount = allExecs.filter(e => e.outcome === "pending").length;

  const filtered = outcomeFilter === "all"
    ? allExecs
    : allExecs.filter(e => e.outcome === outcomeFilter);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Full audit trail of every action taken by the autonomous system.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-green-500/20 bg-green-500/5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground">Successful</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-2xl font-bold text-green-600">{successCount}</p>
          </CardContent>
        </Card>
        <Card className="border-red-500/20 bg-red-500/5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground">Failed</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-2xl font-bold text-red-600">{failureCount}</p>
          </CardContent>
        </Card>
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground">Pending / Gated</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-2xl font-bold text-blue-600">{pendingCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter:</span>
        <Select value={outcomeFilter} onValueChange={setOutcomeFilter}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ({allExecs.length})</SelectItem>
            <SelectItem value="success">Success ({successCount})</SelectItem>
            <SelectItem value="failure">Failure ({failureCount})</SelectItem>
            <SelectItem value="pending">Pending ({pendingCount})</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">ID</TableHead>
                <TableHead className="w-[140px]">Action Type</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="w-[100px]">Outcome</TableHead>
                <TableHead className="w-[80px]">Tokens</TableHead>
                <TableHead className="w-[80px]">Duration</TableHead>
                <TableHead className="w-[140px]">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No executions logged yet
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(exec => (
                  <TableRow key={exec.id}>
                    <TableCell className="font-mono text-xs">{exec.id}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">{exec.actionType}</Badge>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm truncate max-w-sm">
                        {exec.errorMessage || (typeof exec.details === "object" ? JSON.stringify(exec.details).substring(0, 100) : String(exec.details || "—"))}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${outcomeColors[exec.outcome] || ""}`}>
                        {exec.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {exec.tokensCost || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {exec.durationMs ? `${(exec.durationMs / 1000).toFixed(1)}s` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(exec.createdAt).toLocaleString("en-AU", {
                        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
                      })}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
