import { describe, expect, it } from "vitest";

import { orderPendingTasksForExecution } from "./dagEngine";

describe("DAG task selection order", () => {
  it("orders by priority descending and newest id descending for stable ties", () => {
    const tasks = [
      { id: 62, priorityScore: 5 },
      { id: 73, priorityScore: 5 },
      { id: 25, priorityScore: 4 },
      { id: 72, priorityScore: 5 },
    ];

    expect(orderPendingTasksForExecution(tasks).map(task => task.id)).toEqual([
      73, 72, 62, 25,
    ]);
    expect(tasks.map(task => task.id)).toEqual([62, 73, 25, 72]);
  });
});
