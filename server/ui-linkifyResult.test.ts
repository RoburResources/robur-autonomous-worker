import { describe, expect, it } from "vitest";
import { linkifyResult } from "../client/src/lib/linkifyResult";

describe("linkifyResult", () => {
  it("keeps canonical URLs clickable", () => {
    expect(linkifyResult("Source: https://wa.gov.au/planning")).toEqual([
      { text: "Source: " },
      {
        text: "https://wa.gov.au/planning",
        href: "https://wa.gov.au/planning",
      },
    ]);
  });

  it("removes Markdown closing punctuation from the link target", () => {
    expect(
      linkifyResult(
        "([WA Planning](https://wa.gov.au/planning?utm_source=openai))."
      )
    ).toEqual([
      { text: "([WA Planning](" },
      {
        text: "https://wa.gov.au/planning?utm_source=openai",
        href: "https://wa.gov.au/planning?utm_source=openai",
      },
      { text: "))." },
    ]);
  });

  it("removes bold and inline-code delimiters from the link target", () => {
    expect(
      linkifyResult(
        "**https://wa.gov.au/planning** and `https://wa.gov.au/building`"
      )
    ).toEqual([
      { text: "**" },
      {
        text: "https://wa.gov.au/planning",
        href: "https://wa.gov.au/planning",
      },
      { text: "** and `" },
      {
        text: "https://wa.gov.au/building",
        href: "https://wa.gov.au/building",
      },
      { text: "`" },
    ]);
  });

  it("preserves balanced parentheses that belong to the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    expect(linkifyResult(`${url}).`)).toEqual([
      { text: url, href: url },
      { text: ")." },
    ]);
  });

  it("preserves prose without URLs", () => {
    expect(linkifyResult("No source was supplied.")).toEqual([
      { text: "No source was supplied." },
    ]);
  });
});
