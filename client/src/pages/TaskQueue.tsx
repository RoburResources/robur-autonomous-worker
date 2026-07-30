import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Eye, Play, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { linkifyResult } from "@/lib/linkifyResult";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  in_progress: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  completed: "bg-green-500/10 text-green-600 border-green-500/20",
  failed: "bg-red-500/10 text-red-600 border-red-500/20",
  cancelled: "bg-gray-500/10 text-gray-600 border-gray-500/20",
  awaiting_approval: "bg-orange-500/10 text-orange-600 border-orange-500/20",
};

function LinkedResult({ value }: { value: string }) {
  const parts = linkifyResult(value);
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-6">
      {parts.map((part, index) =>
        part.href ? (
          <a
            key={`${part.href}-${index}`}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {part.text}
          </a>
        ) : (
          part.text
        )
      )}
    </div>
  );
}

type ApprovalArtifact = {
  actionType: "outbound_call" | "send_email" | "send_sms";
  target: string;
  content: string;
  subject?: string;
  targetName?: string;
  sourceFingerprint: string;
  approvalFingerprint: string;
  approvalRequestId: string;
  providerIdentity:
    | {
        provider: "retell";
        from: string;
        agentId: string;
        agentVersion: number;
        agentConfigSha256: string;
        scriptVariable: "approved_script";
      }
    | {
        provider: "sendgrid";
        from: string;
        fromName: string;
      }
    | {
        provider: "twilio";
        from: string;
      };
};

type OutcomeReconciliation = {
  requestedAt: string;
  reconciliationId: string;
  provider?: string;
  receiptId?: string;
};

const externalActionTypes = new Set([
  "outbound_call",
  "send_email",
  "send_sms",
]);

function approvalArtifactFromMetadata(metadata: unknown): ApprovalArtifact | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).external_approval_artifact;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifact = value as Record<string, unknown>;
  const approvalFingerprint = (metadata as Record<string, unknown>)
    .external_approval_fingerprint;
  const approvalRequestId = (metadata as Record<string, unknown>)
    .external_approval_request_id;
  const providerIdentity =
    artifact.providerIdentity &&
    typeof artifact.providerIdentity === "object" &&
    !Array.isArray(artifact.providerIdentity)
      ? (artifact.providerIdentity as Record<string, unknown>)
      : null;
  if (
    artifact.version !== 1 ||
    (artifact.actionType !== "outbound_call" &&
      artifact.actionType !== "send_email" &&
      artifact.actionType !== "send_sms") ||
    typeof artifact.target !== "string" ||
    typeof artifact.content !== "string" ||
    typeof artifact.sourceFingerprint !== "string" ||
    typeof approvalFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(approvalFingerprint) ||
    typeof approvalRequestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      approvalRequestId
    ) ||
    !providerIdentity ||
    (artifact.actionType === "outbound_call" &&
      (providerIdentity.provider !== "retell" ||
        typeof providerIdentity.from !== "string" ||
        typeof providerIdentity.agentId !== "string" ||
        !Number.isInteger(providerIdentity.agentVersion) ||
        typeof providerIdentity.agentConfigSha256 !== "string" ||
        providerIdentity.scriptVariable !== "approved_script")) ||
    (artifact.actionType === "send_email" &&
      (providerIdentity.provider !== "sendgrid" ||
        typeof providerIdentity.from !== "string" ||
        typeof providerIdentity.fromName !== "string")) ||
    (artifact.actionType === "send_sms" &&
      (providerIdentity.provider !== "twilio" ||
        typeof providerIdentity.from !== "string"))
  ) {
    return null;
  }
  return {
    ...(artifact as Omit<
      ApprovalArtifact,
      "approvalFingerprint" | "approvalRequestId"
    >),
    approvalFingerprint,
    approvalRequestId,
  };
}

function reconciliationFromMetadata(
  metadata: unknown
): OutcomeReconciliation | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = metadata as Record<string, unknown>;
  if (
    value.external_outcome_reconciliation_required !== true ||
    typeof value.external_outcome_reconciliation_at !== "string" ||
    typeof value.external_outcome_reconciliation_id !== "string"
  ) {
    return null;
  }
  const receipt =
    value.external_provider_receipt &&
    typeof value.external_provider_receipt === "object" &&
    !Array.isArray(value.external_provider_receipt)
      ? (value.external_provider_receipt as Record<string, unknown>)
      : null;
  return {
    requestedAt: value.external_outcome_reconciliation_at,
    reconciliationId: value.external_outcome_reconciliation_id,
    ...(typeof receipt?.provider === "string"
      ? { provider: receipt.provider }
      : typeof value.external_outcome_provider === "string"
        ? { provider: value.external_outcome_provider }
        : {}),
    ...(typeof receipt?.receiptId === "string"
      ? { receiptId: receipt.receiptId }
      : {}),
  };
}

function approvalRequestIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)
    .external_approval_request_id;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value
    : undefined;
}

export default function TaskQueue() {
  const [filter, setFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [newTask, setNewTask] = useState({
    description: "",
    priorityScore: 80,
  });
  const [reconciliationEvidence, setReconciliationEvidence] = useState("");
  const { data: tasks, isLoading, refetch } = trpc.tasks.list.useQuery({ limit: 100 });
  const createTask = trpc.tasks.create.useMutation();
  const runTask = trpc.tasks.run.useMutation();
  const updateTask = trpc.tasks.update.useMutation();
  const reconcileExternalOutcome =
    trpc.tasks.reconcileExternalOutcome.useMutation();

  const filteredTasks = tasks?.filter(t => filter === "all" || t.status === filter) || [];
  const selectedTask = tasks?.find(task => task.id === selectedTaskId) || null;
  const selectedApprovalArtifact = selectedTask
    ? approvalArtifactFromMetadata(selectedTask.metadata)
    : null;
  const selectedReconciliation = selectedTask
    ? reconciliationFromMetadata(selectedTask.metadata)
    : null;
  const selectedApprovalRequestId = selectedTask
    ? approvalRequestIdFromMetadata(selectedTask.metadata)
    : undefined;

  useEffect(() => {
    setReconciliationEvidence("");
  }, [selectedTaskId]);

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

  const handleApprovalDecision = async (
    taskId: number,
    decision: "approve" | "reject",
    approvalFingerprint?: string,
    approvalRequestId?: string
  ) => {
    try {
      await updateTask.mutateAsync({
        id: taskId,
        status: decision === "approve" ? "pending" : "cancelled",
        expectedStatus: "awaiting_approval",
        ...(decision === "approve" && approvalFingerprint
          ? { approvalFingerprint }
          : {}),
        ...(decision === "approve" && approvalRequestId
          ? { approvalRequestId }
          : {}),
      });
      await refetch();
      setSelectedTaskId(null);
      toast.success(
        decision === "approve"
          ? `Task #${taskId} approved`
          : `Task #${taskId} rejected`
      );
    } catch (error) {
      await refetch();
      toast.error(
        error instanceof Error
          ? error.message
          : `Task #${taskId} could not be ${decision}d`
      );
    }
  };

  const handleReconciliation = async (
    taskId: number,
    resolution:
      | "confirmed_completed"
      | "confirmed_not_performed"
      | "cancelled_unknown"
  ) => {
    if (!selectedReconciliation) return;
    const evidence = reconciliationEvidence.trim();
    if (evidence.length < 10) {
      toast.error("Record the provider lookup or other evidence first");
      return;
    }
    try {
      const result = await reconcileExternalOutcome.mutateAsync({
        id: taskId,
        resolution,
        evidence,
        expectedReconciliationId: selectedReconciliation.reconciliationId,
      });
      await refetch();
      setReconciliationEvidence("");
      if (result.freshApprovalRequired) {
        toast.success(
          `Task #${taskId} is safe to retry after one fresh exact approval`
        );
      } else {
        setSelectedTaskId(null);
        toast.success(`Task #${taskId} reconciliation recorded`);
      }
    } catch (error) {
      await refetch();
      toast.error(
        error instanceof Error
          ? error.message
          : "The provider outcome could not be reconciled"
      );
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
                <DialogDescription>
                  Queue an owner-authorised web research task for grounded,
                  independently verified execution.
                </DialogDescription>
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
            <DialogDescription>
              Review the request, execution status, verified result, and linked
              sources.
            </DialogDescription>
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
              {selectedTask.status === "awaiting_approval" ? (
                <div className="space-y-3 rounded-md border border-orange-500/30 bg-orange-500/5 p-4">
                  {selectedReconciliation ? (
                    <>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-orange-700">
                          Provider outcome must be reconciled
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Automatic retry is blocked. Check the provider using
                          the receipt below, record what you found, then choose
                          the matching outcome.
                        </p>
                      </div>
                      <div className="rounded-md border bg-background p-3 text-sm">
                        <p>
                          <span className="font-medium">Provider:</span>{" "}
                          {selectedReconciliation.provider || "unknown"}
                        </p>
                        <p className="break-all">
                          <span className="font-medium">Receipt:</span>{" "}
                          {selectedReconciliation.receiptId ||
                            "No provider receipt was returned"}
                        </p>
                      </div>
                      <Textarea
                        value={reconciliationEvidence}
                        onChange={event =>
                          setReconciliationEvidence(event.target.value)
                        }
                        placeholder="Provider lookup result, status, timestamp, or other evidence (required)"
                        rows={4}
                        maxLength={2_000}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() =>
                            handleReconciliation(
                              selectedTask.id,
                              "confirmed_completed"
                            )
                          }
                          disabled={reconcileExternalOutcome.isPending}
                        >
                          <Check className="mr-1 h-4 w-4" />
                          Confirm it happened
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() =>
                            handleReconciliation(
                              selectedTask.id,
                              "confirmed_not_performed"
                            )
                          }
                          disabled={reconcileExternalOutcome.isPending}
                        >
                          Confirm not sent
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() =>
                            handleReconciliation(
                              selectedTask.id,
                              "cancelled_unknown"
                            )
                          }
                          disabled={reconcileExternalOutcome.isPending}
                        >
                          <X className="mr-1 h-4 w-4" />
                          Cancel without retry
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-orange-700">
                      Owner decision required
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Review the complete request below. Approval is bound to
                      this exact task state; a changed task must be reviewed
                      again.
                    </p>
                  </div>
                  {selectedApprovalArtifact ? (
                    <div className="space-y-3 rounded-md border bg-background p-4">
                      <div className="grid gap-2 text-sm sm:grid-cols-2">
                        <p>
                          <span className="font-medium">Action:</span>{" "}
                          {selectedApprovalArtifact.actionType}
                        </p>
                        <p>
                          <span className="font-medium">Target:</span>{" "}
                          {selectedApprovalArtifact.target}
                        </p>
                        <p>
                          <span className="font-medium">Provider:</span>{" "}
                          {selectedApprovalArtifact.providerIdentity.provider}
                        </p>
                        <p>
                          <span className="font-medium">From:</span>{" "}
                          {selectedApprovalArtifact.providerIdentity.from}
                        </p>
                        {selectedApprovalArtifact.providerIdentity.provider ===
                        "retell" ? (
                          <>
                            <p>
                              <span className="font-medium">Agent:</span>{" "}
                              {selectedApprovalArtifact.providerIdentity.agentId} v
                              {
                                selectedApprovalArtifact.providerIdentity
                                  .agentVersion
                              }
                            </p>
                            <p className="break-all sm:col-span-2">
                              <span className="font-medium">
                                Agent configuration:
                              </span>{" "}
                              {
                                selectedApprovalArtifact.providerIdentity
                                  .agentConfigSha256
                              }
                            </p>
                          </>
                        ) : selectedApprovalArtifact.providerIdentity.provider ===
                          "sendgrid" ? (
                          <p>
                            <span className="font-medium">Sender name:</span>{" "}
                            {selectedApprovalArtifact.providerIdentity.fromName}
                          </p>
                        ) : null}
                        {selectedApprovalArtifact.subject ? (
                          <p className="sm:col-span-2">
                            <span className="font-medium">Subject:</span>{" "}
                            {selectedApprovalArtifact.subject}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Exact approved content
                        </p>
                        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
                          {selectedApprovalArtifact.content}
                        </pre>
                      </div>
                      <p className="break-all text-xs text-muted-foreground">
                        Approval fingerprint:{" "}
                        {selectedApprovalArtifact.approvalFingerprint}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">
                        Approval request:{" "}
                        {selectedApprovalArtifact.approvalRequestId}
                      </p>
                    </div>
                  ) : externalActionTypes.has(selectedTask.actionType || "") ? (
                    <p className="text-sm font-medium text-red-600">
                      Approval is disabled because the exact external artifact
                      is missing or invalid.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        handleApprovalDecision(
                          selectedTask.id,
                          "approve",
                          selectedApprovalArtifact?.approvalFingerprint,
                          selectedApprovalArtifact?.approvalRequestId ||
                            selectedApprovalRequestId
                        )
                      }
                      disabled={
                        updateTask.isPending ||
                        (externalActionTypes.has(
                          selectedTask.actionType || ""
                        ) &&
                          !selectedApprovalArtifact)
                      }
                    >
                      <Check className="mr-1 h-4 w-4" />
                      Approve exact task
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        handleApprovalDecision(selectedTask.id, "reject")
                      }
                      disabled={updateTask.isPending}
                    >
                      <X className="mr-1 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                    </>
                  )}
                </div>
              ) : null}
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
