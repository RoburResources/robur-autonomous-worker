import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye, Play, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  in_progress: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  completed: "bg-green-500/10 text-green-600 border-green-500/20",
  failed: "bg-red-500/10 text-red-600 border-red-500/20",
  cancelled: "bg-gray-500/10 text-gray-600 border-gray-500/20",
  awaiting_approval: "bg-orange-500/10 text-orange-600 border-orange-500/20",
};

function LinkedResult({ value }: { value: string }) {
  const parts = value.split(/(https?:\/\/[^\s]+)/g);
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-6">
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={`${part}-${index}`}
            href={part.replace(/[.,;:]+$/, "")}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {part}
          </a>
        ) : (
          part
        )
      )}
    </div>
  );
}

export default function TaskQueue() {
  const [filter, setFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [newTask, setNewTask] = useState({
    description: "",
    priorityScore: 80,
  });
  const { data: tasks, isLoading, refetch } = trpc.tasks.list.useQuery({ limit: 100 });
  const createTask = trpc.tasks.create.useMutation();
  const runTask = trpc.tasks.run.useMutation();

  const filteredTasks = tasks?.filter(t => filter === "all" || t.status === filter) || [];
  const selectedTask = tasks?.find(task => task.id === selectedTaskId) || null;

  const handleCreate = async () => {
    const description = newTask.description.trim();
    if (description.length < 10) {
      toast.error("Describe the research task in at least 10 characters");
      return;
    }
    try {
      const created = await createTask.mutateAsync({
        description,
        actionType: "web_research",
        priorityScore: newTask.priorityScore,
      });
      setNewTask({ description: "", priorityScore: 80 });
      setShowAdd(false);
      setSelectedTaskId(created.taskId);
      await refetch();
      toast.success(`Task #${created.taskId} queued`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Task could not be queued");
    }
  };

  const handleRun = async (taskId: number) => {
    try {
      const result = await runTask.mutateAsync({ id: taskId });
      await refetch();
      if (result.executed && result.succeeded) {
        toast.success(`Task #${taskId} completed and verified`);
      } else {
        toast.error(result.error || `Task #${taskId} did not complete`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Task could not run");
    }
  };

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            aria-label="Refresh task queue"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Dialog open={showAdd} onOpenChange={setShowAdd}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                Add research task
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add research task</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium" htmlFor="task-description">
                    What should the worker research?
                  </label>
                  <Textarea
                    id="task-description"
                    value={newTask.description}
                    onChange={event =>
                      setNewTask(current => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    placeholder="Find official WA sources that answer..."
                    rows={6}
                    className="mt-1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Results must include at least two linked sources and pass independent verification.
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="task-priority">
                    Priority (1-100)
                  </label>
                  <Input
                    id="task-priority"
                    type="number"
                    min={1}
                    max={100}
                    value={newTask.priorityScore}
                    onChange={event =>
                      setNewTask(current => ({
                        ...current,
                        priorityScore: Math.min(
                          100,
                          Math.max(1, Number(event.target.value) || 80)
                        ),
                      }))
                    }
                    className="mt-1"
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={handleCreate}
                  disabled={createTask.isPending}
                >
                  {createTask.isPending ? "Queuing..." : "Queue task"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">Score</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[120px]">Action</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[100px]">Value</TableHead>
                <TableHead className="w-[140px]">Created</TableHead>
                <TableHead className="w-[90px]">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={selectedTaskId !== null}
        onOpenChange={open => {
          if (!open) setSelectedTaskId(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selectedTask ? `Task #${selectedTask.id}` : "Task details"}
            </DialogTitle>
          </DialogHeader>
          {selectedTask ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={statusColors[selectedTask.status] || ""}>
                  {selectedTask.status.replace("_", " ")}
                </Badge>
                <Badge variant="secondary">{selectedTask.actionType || "unknown"}</Badge>
                <Badge variant="outline">Priority {selectedTask.priorityScore}</Badge>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Request
                </p>
                <p className="mt-1 text-sm leading-6">{selectedTask.description}</p>
              </div>
              {selectedTask.resultSummary ? (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Verified result
                  </p>
                  <div className="mt-2 rounded-md border bg-muted/30 p-4">
                    <LinkedResult value={selectedTask.resultSummary} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No result has been recorded yet.
                </p>
              )}
              {selectedTask.status === "pending" ? (
                <Button
                  onClick={() => handleRun(selectedTask.id)}
                  disabled={runTask.isPending}
                >
                  <Play className="h-4 w-4 mr-1" />
                  {runTask.isPending ? "Running safely..." : "Run now"}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Refreshing task details...</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
