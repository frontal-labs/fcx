import { describe, expect, it } from "vitest";
import { levenshtein, nearestNames } from "../src/levenshtein.js";

describe("levenshtein", () => {
  it("is zero for equal strings", () => {
    expect(levenshtein("helper", "helper")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("counts an empty side as the length of the other", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abcd", "")).toBe(4);
  });

  it("matches known textbook distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("intention", "execution")).toBe(5);
  });

  it("counts one insertion, deletion or substitution as one edit", () => {
    expect(levenshtein("helpr", "helper")).toBe(1);
    expect(levenshtein("helper", "helpr")).toBe(1);
    expect(levenshtein("helper", "helpe*")).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshtein("retries", "retires")).toBe(levenshtein("retires", "retries"));
  });

  it("is case-sensitive", () => {
    expect(levenshtein("Name", "name")).toBe(1);
  });
});

describe("nearestNames", () => {
  it("returns the closest names first, at most three", () => {
    const names = ["helper", "helpers", "helped", "helix", "run", "total"];
    // helper is 1 edit away; helix and helped are 2 away (ties alphabetical); helpers is 3 away and cut by the limit.
    expect(nearestNames("helpr", names)).toEqual(["helper", "helix", "helped"]);
  });

  it("never suggests the target itself", () => {
    expect(nearestNames("helper", ["helper", "helpe"])).toEqual(["helpe"]);
  });

  it("drops names too far away to be a plausible typo", () => {
    expect(nearestNames("helpr", ["totally", "unrelated"])).toEqual([]);
  });

  it("breaks ties alphabetically", () => {
    expect(nearestNames("ab", ["ac", "aa", "ad"])).toEqual(["aa", "ac", "ad"]);
  });
});
