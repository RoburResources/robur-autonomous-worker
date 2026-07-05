import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { toast } from "sonner";
import { Save, Shield } from "lucide-react";

export default function SystemConfig() {
  const { data: configs, isLoading, refetch } = trpc.config.list.useQuery();
  const setConfig = trpc.config.set.useMutation();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const handleSave = async (key: string) => {
    await setConfig.mutateAsync({ key, value: editValue });
    toast.success(`Config "${key}" updated`);
    setEditingKey(null);
    refetch();
  };

  const startEdit = (key: string, currentValue: string) => {
    setEditingKey(key);
    setEditValue(currentValue);
  };

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  // Group configs by category
  const safetyConfigs = configs?.filter(c => 
    c.key.includes("max_") || c.key.includes("kill_switch") || c.key.includes("approval")
  ) || [];
  const systemConfigs = configs?.filter(c => 
    c.key.includes("system_") || c.key.includes("model") || c.key.includes("weight")
  ) || [];
  const integrationConfigs = configs?.filter(c => 
    c.key.includes("retell") || c.key.includes("user_phone")
  ) || [];

  return (
    <div className="space-y-6">
      {/* Safety Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-orange-500" />
            Safety Controls
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ConfigTable
            configs={safetyConfigs}
            editingKey={editingKey}
            editValue={editValue}
            setEditValue={setEditValue}
            startEdit={startEdit}
            handleSave={handleSave}
            isSaving={setConfig.isPending}
          />
        </CardContent>
      </Card>

      {/* System Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Settings</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ConfigTable
            configs={systemConfigs}
            editingKey={editingKey}
            editValue={editValue}
            setEditValue={setEditValue}
            startEdit={startEdit}
            handleSave={handleSave}
            isSaving={setConfig.isPending}
          />
        </CardContent>
      </Card>

      {/* Integration Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Integration Settings</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ConfigTable
            configs={integrationConfigs}
            editingKey={editingKey}
            editValue={editValue}
            setEditValue={setEditValue}
            startEdit={startEdit}
            handleSave={handleSave}
            isSaving={setConfig.isPending}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigTable({
  configs,
  editingKey,
  editValue,
  setEditValue,
  startEdit,
  handleSave,
  isSaving,
}: {
  configs: Array<{ id: number; key: string; value: string; description: string | null; updatedAt: Date }>;
  editingKey: string | null;
  editValue: string;
  setEditValue: (v: string) => void;
  startEdit: (key: string, value: string) => void;
  handleSave: (key: string) => void;
  isSaving: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[200px]">Key</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="w-[250px]">Description</TableHead>
          <TableHead className="w-[80px]">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {configs.map(config => (
          <TableRow key={config.id}>
            <TableCell className="font-mono text-xs">{config.key}</TableCell>
            <TableCell>
              {editingKey === config.key ? (
                <Input
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  className="h-8"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") handleSave(config.key); }}
                />
              ) : (
                <span className="text-sm">{config.value}</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{config.description || "—"}</TableCell>
            <TableCell>
              {editingKey === config.key ? (
                <Button size="sm" variant="ghost" onClick={() => handleSave(config.key)} disabled={isSaving}>
                  <Save className="h-3 w-3" />
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => startEdit(config.key, config.value)}>
                  Edit
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
