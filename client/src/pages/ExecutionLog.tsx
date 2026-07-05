import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

const outcomeColors: Record<string, string> = {
  success: "bg-green-500/10 text-green-600 border-green-500/20",
  failure: "bg-red-500/10 text-red-600 border-red-500/20",
  partial: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  pending: "bg-blue-500/10 text-blue-600 border-blue-500/20",
};

export default function ExecutionLog() {
  const { data: executions, isLoading } = trpc.executions.list.useQuery({ limit: 100 });

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Full audit trail of every action taken by the autonomous system.
      </p>

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
              {!executions || executions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No executions logged yet
                  </TableCell>
                </TableRow>
              ) : (
                executions.map(exec => (
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
