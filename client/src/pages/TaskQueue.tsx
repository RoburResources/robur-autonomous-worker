import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  in_progress: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  completed: "bg-green-500/10 text-green-600 border-green-500/20",
  failed: "bg-red-500/10 text-red-600 border-red-500/20",
  cancelled: "bg-gray-500/10 text-gray-600 border-gray-500/20",
  awaiting_approval: "bg-orange-500/10 text-orange-600 border-orange-500/20",
};

export default function TaskQueue() {
  const [filter, setFilter] = useState<string>("all");
  const { data: tasks, isLoading } = trpc.tasks.list.useQuery({ limit: 100 });

  const filteredTasks = tasks?.filter(t => filter === "all" || t.status === filter) || [];

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tasks</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="awaiting_approval">Awaiting Approval</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{filteredTasks.length} tasks</span>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">Score</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[120px]">Action</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[100px]">Value</TableHead>
                <TableHead className="w-[140px]">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No tasks found
                  </TableCell>
                </TableRow>
              ) : (
                filteredTasks.map(task => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">{task.priorityScore}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-md">
                        <p className="text-sm truncate">{task.description}</p>
                        {task.resultSummary && (
                          <p className="text-xs text-muted-foreground truncate mt-1">{task.resultSummary}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">{task.actionType || "—"}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${statusColors[task.status] || ""}`}>
                        {task.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {task.estimatedValue && parseFloat(task.estimatedValue) > 0
                        ? `$${parseFloat(task.estimatedValue).toLocaleString()}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(task.createdAt).toLocaleDateString("en-AU", {
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
