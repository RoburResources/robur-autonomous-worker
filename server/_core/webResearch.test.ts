import { describe, expect, it, vi } from "vitest";
import {
  extractGroundedSources,
  formatGroundedResearchSummary,
  runGroundedWebResearch,
  type WebResearchClient,
} from "./webResearch";
import { validateTaskOutput } from "../autonomous/schemaValidator";

function groundedResponse() {
  return {
    id: "resp_test",
    model: "gpt-5.6-luna",
    output_text: "Two source-backed findings with inline citations.",
    output: [
      {
        type: "web_search_call" as const,
        status: "completed",
        action: {
          type: "search" as const,
          sources: [
            { type: "url" as const, url: "https://www.wa.gov.au/topic/planning" },
            {
              type: "url" as const,
              url: "https://www.planning.wa.gov.au/development-assessment-panels",
            },
          ],
        },
      },
      {
        type: "message" as const,
        content: [
          {
            type: "output_text" as const,
            text: "Two source-backed findings with inline citations.",
            annotations: [
              {
                type: "url_citation" as const,
                title: "Planning",
                url: "https://www.wa.gov.au/topic/planning#overview",
                start_index: 0,
                end_index: 10,
              },
              {
                type: "url_citation" as const,
                title: "Development Assessment Panels",
                url: "https://www.planning.wa.gov.au/development-assessment-panels",
                start_index: 11,
                end_index: 25,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("grounded web research", () => {
  it("requires a completed web search and retains distinct cited sources", async () => {
    const create = vi.fn().mockResolvedValue(groundedResponse());
    const client = { responses: { create } } as WebResearchClient;

    const result = await runGroundedWebResearch(
      "Research Western Australian planning approvals for a hardstand.",
      { client }
    );

    expect(result.webSearchCallCount).toBe(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.url).not.toContain("#");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        store: false,
        input:
          "Research task: Research Western Australian planning approvals for a hardstand.",
        include: ["web_search_call.action.sources"],
        tools: [
          expect.objectContaining({
            type: "web_search",
            search_context_size: "medium",
          }),
        ],
      })
    );
  });

  it("fails closed when the response has fewer than two citations", async () => {
    const response = groundedResponse();
    const message = response.output[1];
    if (message.type === "message") {
      message.content[0]!.annotations = message.content[0]!.annotations.slice(0, 1);
    }
    const client = {
      responses: { create: vi.fn().mockResolvedValue(response) },
    } as WebResearchClient;

    await expect(
      runGroundedWebResearch(
        "Research Western Australian planning approvals for a hardstand.",
        { client }
      )
    ).rejects.toThrow("at least 2 are required");
  });

  it("does not count aliases of one document as two sources", async () => {
    const response = groundedResponse();
    const message = response.output[1];
    if (message.type === "message") {
      message.content[0]!.annotations = [
        {
          type: "url_citation" as const,
          title: "Planning alias one",
          url: "http://www.wa.gov.au:80/topic/planning/?utm_source=one",
          start_index: 0,
          end_index: 10,
        },
        {
          type: "url_citation" as const,
          title: "Planning alias two",
          url: "https://www.wa.gov.au/topic/planning?utm_source=two",
          start_index: 11,
          end_index: 25,
        },
      ];
    }
    const client = {
      responses: { create: vi.fn().mockResolvedValue(response) },
    } as WebResearchClient;

    await expect(
      runGroundedWebResearch(
        "Research Western Australian planning approvals for a hardstand.",
        { client }
      )
    ).rejects.toThrow("at least 2 are required");
  });

  it("rejects citations that are not linked to output text spans", async () => {
    const response = groundedResponse();
    const message = response.output[1];
    if (message.type === "message") {
      message.content[0]!.annotations = message.content[0]!.annotations.map(
        annotation => ({
          ...annotation,
          end_index: 9_999,
        })
      );
    }
    const client = {
      responses: { create: vi.fn().mockResolvedValue(response) },
    } as WebResearchClient;

    await expect(
      runGroundedWebResearch(
        "Research Western Australian planning approvals for a hardstand.",
        { client }
      )
    ).rejects.toThrow("at least 2 are required");
  });

  it("fails closed when no web search tool call completed", async () => {
    const response = groundedResponse();
    response.output = response.output.filter(
      item => item.type !== "web_search_call"
    );
    const client = {
      responses: { create: vi.fn().mockResolvedValue(response) },
    } as WebResearchClient;

    await expect(
      runGroundedWebResearch(
        "Research Western Australian planning approvals for a hardstand.",
        { client }
      )
    ).rejects.toThrow("without using web search");
  });

  it("formats retained evidence as a visible source list", () => {
    const response = groundedResponse();
    const sources = extractGroundedSources(response);
    const summary = formatGroundedResearchSummary({
      text: response.output_text,
      sources,
      model: response.model,
      responseId: response.id,
      webSearchCallCount: 1,
    });

    expect(summary).toContain("findings:");
    expect(summary).toContain("Sources:");
    expect(summary).toContain("https://www.wa.gov.au/topic/planning");
    expect(summary).toContain(
      "https://www.planning.wa.gov.au/development-assessment-panels"
    );
    expect(validateTaskOutput("web_research", summary)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("prevents uncited prose from being recorded as successful web research", () => {
    const validation = validateTaskOutput(
      "web_research",
      "findings: This is long enough to look plausible but contains no retained source evidence."
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Web research output is missing a visible Sources section"
    );
  });
});
