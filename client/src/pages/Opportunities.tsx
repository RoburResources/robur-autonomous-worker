import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const priorityColors: Record<string, string> = {
  low: "bg-gray-500/10 text-gray-600 border-gray-500/20",
  medium: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  high: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  critical: "bg-red-500/10 text-red-600 border-red-500/20",
};

const statusColors: Record<string, string> = {
  new: "bg-green-500/10 text-green-600 border-green-500/20",
  investigating: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  actioned: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  dismissed: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

export default function Opportunities() {
  const { data: opportunities, isLoading, refetch } = trpc.opportunities.list.useQuery({ limit: 50 });
  const updateOpp = trpc.opportunities.update.useMutation();

  const handleStatusChange = async (id: number, status: "new" | "investigating" | "actioned" | "dismissed") => {
    await updateOpp.mutateAsync({ id, status });
    refetch();
  };

  if (isLoading) {
    return <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Market opportunities detected by the autonomous system through web research and data analysis.
      </p>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Source</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[100px]">Priority</TableHead>
                <TableHead className="w-[100px]">Value</TableHead>
                <TableHead className="w-[150px]">Status</TableHead>
                <TableHead className="w-[120px]">Detected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!opportunities || opportunities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No opportunities detected yet. The system will scan for opportunities during task generation.
                  </TableCell>
                </TableRow>
              ) : (
                opportunities.map(opp => (
                  <TableRow key={opp.id}>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">{opp.source}</Badge>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm max-w-md">{opp.description}</p>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${priorityColors[opp.priority] || ""}`}>
                        {opp.priority}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {opp.estimatedValue && parseFloat(opp.estimatedValue) > 0
                        ? `$${parseFloat(opp.estimatedValue).toLocaleString()}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={opp.status}
                        onValueChange={(v) => handleStatusChange(opp.id, v as any)}
                      >
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">New</SelectItem>
                          <SelectItem value="investigating">Investigating</SelectItem>
                          <SelectItem value="actioned">Actioned</SelectItem>
                          <SelectItem value="dismissed">Dismissed</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(opp.detectedAt).toLocaleDateString("en-AU", {
                        day: "2-digit", month: "short"
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
