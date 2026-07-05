import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Target } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-600 border-green-500/20",
  paused: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  completed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  archived: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

function SubGoalsList({ subGoals }: { subGoals: unknown }) {
  let items: string[] = [];
  try {
    if (Array.isArray(subGoals)) items = subGoals as string[];
    else if (typeof subGoals === "string") items = JSON.parse(subGoals);
  } catch { items = []; }
  if (items.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {items.map((sg, i) => (
        <p key={i} className="text-xs text-muted-foreground">• {sg}</p>
      ))}
    </div>
  );
}

export default function Goals() {
  const { data: goals, isLoading, refetch } = trpc.goals.list.useQuery();
  const createGoal = trpc.goals.create.useMutation();
  const updateGoal = trpc.goals.update.useMutation();
  const [showAdd, setShowAdd] = useState(false);
  const [newGoal, setNewGoal] = useState({ goalText: "", priority: 5, subGoals: "" });
  const [editingGoal, setEditingGoal] = useState<{ id: number; goalText: string; priority: number; subGoals: string } | null>(null);

  const handleCreate = async () => {
    if (!newGoal.goalText.trim()) return;
    await createGoal.mutateAsync({
      goalText: newGoal.goalText,
      priority: newGoal.priority,
      subGoals: newGoal.subGoals ? newGoal.subGoals.split("\n").filter(Boolean) : undefined,
    });
    toast.success("Goal created");
    setNewGoal({ goalText: "", priority: 5, subGoals: "" });
    setShowAdd(false);
    refetch();
  };

  const handleEdit = async () => {
    if (!editingGoal || !editingGoal.goalText.trim()) return;
    await updateGoal.mutateAsync({
      id: editingGoal.id,
      goalText: editingGoal.goalText,
      priority: editingGoal.priority,
      subGoals: editingGoal.subGoals ? editingGoal.subGoals.split("\n").filter(Boolean) : undefined,
    });
    toast.success("Goal updated");
    setEditingGoal(null);
    refetch();
  };

  const startEdit = (goal: any) => {
    let sgs = "";
    try {
      const arr = Array.isArray(goal.subGoals) ? goal.subGoals : JSON.parse(String(goal.subGoals || "[]"));
      sgs = arr.join("\n");
    } catch {}
    setEditingGoal({ id: goal.id, goalText: goal.goalText, priority: goal.priority, subGoals: sgs });
  };

  const handleStatusChange = async (id: number, status: "active" | "paused" | "completed" | "archived") => {
    await updateGoal.mutateAsync({ id, status });
    toast.success("Goal updated");
    refetch();
  };

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          High-level business objectives that drive autonomous task generation.
        </p>
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Goal</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Goal</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Goal Description</label>
                <Textarea
                  value={newGoal.goalText}
                  onChange={e => setNewGoal(prev => ({ ...prev, goalText: e.target.value }))}
                  placeholder="e.g., Acquire 50 tonnes of scrap metal per month..."
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Priority (1-10)</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={newGoal.priority}
                  onChange={e => setNewGoal(prev => ({ ...prev, priority: parseInt(e.target.value) || 5 }))}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Sub-goals (one per line)</label>
                <Textarea
                  value={newGoal.subGoals}
                  onChange={e => setNewGoal(prev => ({ ...prev, subGoals: e.target.value }))}
                  placeholder="Identify auto shops&#10;Contact demolition companies&#10;..."
                  className="mt-1"
                  rows={4}
                />
              </div>
              <Button onClick={handleCreate} disabled={createGoal.isPending} className="w-full">
                Create Goal
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {goals?.map(goal => (
          <Card key={goal.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <Target className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium">{goal.goalText}</p>
                    {goal.subGoals ? (
                      <SubGoalsList subGoals={goal.subGoals} />
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="font-mono">P{goal.priority}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(goal)}>Edit</Button>
                  <Select
                    value={goal.status}
                    onValueChange={(v) => handleStatusChange(goal.id, v as any)}
                  >
                    <SelectTrigger className="w-[120px] h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Edit Goal Dialog */}
      <Dialog open={!!editingGoal} onOpenChange={(open) => { if (!open) setEditingGoal(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Goal</DialogTitle>
          </DialogHeader>
          {editingGoal && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Goal Description</label>
                <Textarea
                  value={editingGoal.goalText}
                  onChange={e => setEditingGoal(prev => prev ? { ...prev, goalText: e.target.value } : null)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Priority (1-10)</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={editingGoal.priority}
                  onChange={e => setEditingGoal(prev => prev ? { ...prev, priority: parseInt(e.target.value) || 5 } : null)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Sub-goals (one per line)</label>
                <Textarea
                  value={editingGoal.subGoals}
                  onChange={e => setEditingGoal(prev => prev ? { ...prev, subGoals: e.target.value } : null)}
                  className="mt-1"
                  rows={4}
                />
              </div>
              <Button onClick={handleEdit} disabled={updateGoal.isPending} className="w-full">
                Save Changes
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
