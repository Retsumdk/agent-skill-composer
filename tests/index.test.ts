import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import {
  WorkflowValidator,
  SkillRegistry,
  StatePersister,
  ExecutionEngine,
  type WorkflowDefinition,
  type SkillDefinition,
} from "../src/index";

function makeSkill(
  name: string,
  fn: (input: any, ctx: any) => Promise<any>
): SkillDefinition<any, any> {
  return {
    name,
    description: `${name} test skill`,
    inputSchema: z.object({ value: z.number().optional(), text: z.string().optional() }),
    outputSchema: z.object({ doubled: z.number().optional(), upper: z.string().optional() }),
    execute: fn,
  };
}

describe("WorkflowValidator", () => {
  const wf: WorkflowDefinition = {
    name: "w",
    steps: [
      { id: "a", skillName: "s", inputMapping: {} },
      { id: "b", skillName: "s", inputMapping: { value: { fromStep: "a", path: "doubled" } } },
    ],
  };

  test("accepts a valid acyclic workflow", () => {
    expect(() => WorkflowValidator.validate(wf)).not.toThrow();
  });

  test("rejects duplicate step IDs", () => {
    const dup: WorkflowDefinition = {
      name: "d",
      steps: [
        { id: "a", skillName: "s", inputMapping: {} },
        { id: "a", skillName: "s", inputMapping: {} },
      ],
    };
    expect(() => WorkflowValidator.validate(dup)).toThrow(/Duplicate step IDs/);
  });

  test("rejects circular dependencies", () => {
    const cyc: WorkflowDefinition = {
      name: "c",
      steps: [
        { id: "a", skillName: "s", inputMapping: { value: { fromStep: "b", path: "doubled" } } },
        { id: "b", skillName: "s", inputMapping: { value: { fromStep: "a", path: "doubled" } } },
      ],
    };
    expect(() => WorkflowValidator.validate(cyc)).toThrow(/Circular dependency/);
  });
});

describe("SkillRegistry", () => {
  test("registers, lists, and throws on unknown skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("adder", async (i) => ({ doubled: (i.value ?? 0) * 2 })));
    expect(reg.listSkills()).toEqual([{ name: "adder", description: "adder test skill" }]);
    expect(reg.getSkill("adder").name).toBe("adder");
    expect(() => reg.getSkill("nope")).toThrow(/Skill not found: nope/);
  });
});

describe("StatePersister", () => {
  test("save/load roundtrip isolates by workflow id", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-composer-"));
    try {
      const p = new StatePersister(join(dir, "state.json"));
      p.saveState("wf1", { status: "completed", stepResults: { a: 1 } });
      p.saveState("wf2", { status: "in-progress" });
      expect(p.loadState("wf1")!.status).toBe("completed");
      expect(p.loadState("wf2")!.status).toBe("in-progress");
      expect(p.loadState("missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ExecutionEngine", () => {
  test("runs a two-step workflow and merges outputs into context variables", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("double", async (i) => ({ doubled: (i.value ?? 0) * 2 })));
    reg.register(
      makeSkill("shout", async (i) => ({ upper: String(i.text ?? "").toUpperCase() }))
    );
    const engine = new ExecutionEngine(reg);
    const logs: string[] = [];
    const wf: WorkflowDefinition = {
      name: "pipeline",
      steps: [
        { id: "double-it", skillName: "double", inputMapping: { value: 21 } },
        { id: "shout-it", skillName: "shout", inputMapping: { text: "hi" } },
      ],
    };
    const results = await engine.executeWorkflow(wf, {}, );
    void logs;
    expect(results["double-it"].doubled).toBe(42);
    expect(results["shout-it"].upper).toBe("HI");
  });

  test("skips a step whose condition is not met", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("double", async (i) => ({ doubled: (i.value ?? 0) * 2 })));
    const engine = new ExecutionEngine(reg);
    const wf: WorkflowDefinition = {
      name: "cond",
      steps: [
        {
          id: "gated",
          skillName: "double",
          inputMapping: { value: 3 },
          condition: { variable: "flag", operator: "equals", value: "go" },
        },
      ],
    };
    const results = await engine.executeWorkflow(wf, { flag: "stop" });
    expect(results["gated"]).toBeUndefined();
  });

  test("input mapping resolves $variables and fromStep paths", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("double", async (i) => ({ doubled: (i.value ?? 0) * 2 })));
    const engine = new ExecutionEngine(reg);
    const wf: WorkflowDefinition = {
      name: "chain",
      steps: [
        { id: "s1", skillName: "double", inputMapping: { value: 5 } },
        { id: "s2", skillName: "double", inputMapping: { value: { fromStep: "s1", path: "doubled" } } },
        { id: "s3", skillName: "double", inputMapping: { value: "$seed" } },
      ],
    };
    const results = await engine.executeWorkflow(wf, { seed: 10 });
    expect(results["s2"].doubled).toBe(20);
    expect(results["s3"].doubled).toBe(20);
  });
});
