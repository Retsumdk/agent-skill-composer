#!/usr/bin/env bun
/**
 * agent-skill-composer - Dynamic tool chaining system for agents to build complex workflows from atomic skills
 * Built by Retsumdk
 */

import { Command } from "commander";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync, readFileSync, existsSync } from "fs";

// --- Types & Interfaces ---

export interface SkillDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  execute: (input: z.infer<I>, context: ExecutionContext) => Promise<z.infer<O>>;
}

export interface ExecutionContext {
  workflowId: string;
  variables: Record<string, any>;
  logger: (message: string) => void;
  metadata?: Record<string, any>;
}

export interface WorkflowStep {
  id: string;
  skillName: string;
  inputMapping: Record<string, any>;
  condition?: {
    variable: string;
    operator: "equals" | "contains" | "greaterThan" | "lessThan";
    value: any;
  };
  retryConfig?: {
    maxRetries: number;
    delayMs: number;
  };
  parallelWith?: string[]; // IDs of steps to run in parallel with this one
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

// --- Validation Utils ---

export class WorkflowValidator {
  static validate(workflow: WorkflowDefinition) {
    const stepIds = new Set(workflow.steps.map(s => s.id));
    if (stepIds.size !== workflow.steps.length) {
      throw new Error("Duplicate step IDs found in workflow.");
    }

    // Check for circular dependencies
    const adj = new Map<string, string[]>();
    for (const step of workflow.steps) {
      const deps: string[] = [];
      for (const mapping of Object.values(step.inputMapping)) {
        if (typeof mapping === "object" && mapping.fromStep) {
          deps.push(mapping.fromStep);
        }
      }
      adj.set(step.id, deps);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (v: string): boolean => {
      if (recStack.has(v)) return true;
      if (visited.has(v)) return false;

      visited.add(v);
      recStack.add(v);

      for (const neighbor of (adj.get(v) || [])) {
        if (hasCycle(neighbor)) return true;
      }

      recStack.delete(v);
      return false;
    };

    for (const step of workflow.steps) {
      if (hasCycle(step.id)) {
        throw new Error(`Circular dependency detected involving step: ${step.id}`);
      }
    }
  }
}

// --- Skill Registry ---

export class SkillRegistry {
  private skills: Map<string, SkillDefinition<any, any>> = new Map();

  register(skill: SkillDefinition<any, any>) {
    this.skills.set(skill.name, skill);
  }

  getSkill(name: string) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    return skill;
  }

  listSkills() {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description
    }));
  }
}

// --- Persistence Layer ---

export class StatePersister {
  private storagePath: string;

  constructor(storagePath: string = "workflows-state.json") {
    this.storagePath = storagePath;
  }

  saveState(workflowId: string, state: any) {
    let allStates: Record<string, any> = {};
    if (existsSync(this.storagePath)) {
      allStates = JSON.parse(readFileSync(this.storagePath, "utf-8"));
    }
    allStates[workflowId] = {
      ...state,
      updatedAt: new Date().toISOString()
    };
    writeFileSync(this.storagePath, JSON.stringify(allStates, null, 2));
  }

  loadState(workflowId: string) {
    if (existsSync(this.storagePath)) {
      const allStates = JSON.parse(readFileSync(this.storagePath, "utf-8"));
      return allStates[workflowId];
    }
    return null;
  }
}

// --- Execution Engine ---

export class ExecutionEngine {
  private persister: StatePersister;

  constructor(private registry: SkillRegistry) {
    this.persister = new StatePersister();
  }

  async executeWorkflow(workflow: WorkflowDefinition, initialVariables: Record<string, any> = {}) {
    WorkflowValidator.validate(workflow);
    
    const workflowId = uuidv4();
    const context: ExecutionContext = {
      workflowId,
      variables: { ...initialVariables },
      logger: (msg) => console.log(`[Workflow:${workflowId}] ${msg}`)
    };

    const stepResults: Record<string, any> = {};
    const executedSteps = new Set<string>();

    context.logger(`Starting workflow: ${workflow.name}`);

    for (const step of workflow.steps) {
      if (executedSteps.has(step.id)) continue;

      // Handle parallel execution
      if (step.parallelWith && step.parallelWith.length > 0) {
        const parallelSteps = [step, ...workflow.steps.filter(s => step.parallelWith!.includes(s.id))];
        context.logger(`Running ${parallelSteps.length} steps in parallel: ${parallelSteps.map(s => s.id).join(', ')}`);
        
        const promises = parallelSteps.map(s => this.executeStep(s, context, stepResults));
        const results = await Promise.all(promises);
        
        results.forEach((res, i) => {
          if (res) {
            stepResults[parallelSteps[i].id] = res;
            executedSteps.add(parallelSteps[i].id);
          }
        });
        continue;
      }

      const result = await this.executeStep(step, context, stepResults);
      if (result) {
        stepResults[step.id] = result;
        executedSteps.add(step.id);
      }
      
      this.persister.saveState(workflowId, { status: "in-progress", currentStep: step.id, stepResults });
    }

    context.logger(`Workflow ${workflow.name} completed.`);
    this.persister.saveState(workflowId, { status: "completed", stepResults });
    return stepResults;
  }

  private async executeStep(step: WorkflowStep, context: ExecutionContext, stepResults: Record<string, any>): Promise<any | null> {
    // Check condition if present
    if (step.condition) {
      const val = context.variables[step.condition.variable];
      let met = false;
      switch (step.condition.operator) {
        case "equals": met = val === step.condition.value; break;
        case "contains": met = String(val).includes(step.condition.value); break;
        case "greaterThan": met = val > step.condition.value; break;
        case "lessThan": met = val < step.condition.value; break;
      }
      if (!met) {
        context.logger(`Skipping step ${step.id} due to condition.`);
        return null;
      }
    }

    const skill = this.registry.getSkill(step.skillName);
    context.logger(`Executing step: ${step.id} (${step.skillName})`);

    const input = this.resolveInputs(step.inputMapping, context.variables, stepResults);
    const validatedInput = skill.inputSchema.parse(input);

    let lastError: any;
    let success = false;
    const retries = step.retryConfig?.maxRetries || 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) context.logger(`Retry attempt ${attempt} for step ${step.id}`);
        
        const result = await skill.execute(validatedInput, context);
        const validatedOutput = skill.outputSchema.parse(result);
        
        // Merge results into global variables for convenience
        Object.assign(context.variables, validatedOutput);
        
        return validatedOutput;
      } catch (error) {
        lastError = error;
        context.logger(`Error in step ${step.id}: ${error}`);
        if (attempt < retries && step.retryConfig?.delayMs) {
          await new Promise(r => setTimeout(r, step.retryConfig!.delayMs));
        }
      }
    }

    context.logger(`Step ${step.id} failed after ${retries} retries: ${lastError}`);
    throw lastError;
  }

  private resolveInputs(mapping: Record<string, any>, variables: Record<string, any>, stepResults: Record<string, any>): Record<string, any> {
    const input: Record<string, any> = {};
    for (const [key, val] of Object.entries(mapping)) {
      if (typeof val === "string" && val.startsWith("$")) {
        input[key] = variables[val.slice(1)];
      } else if (typeof val === "object" && val.fromStep) {
        const prevResult = stepResults[val.fromStep];
        input[key] = this.resolvePath(prevResult, val.path);
      } else {
        input[key] = val;
      }
    }
    return input;
  }

  private resolvePath(obj: any, path: string): any {
    if (!path) return obj;
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }
}

// --- Built-in Skills (Examples) ---

const registry = new SkillRegistry();

registry.register({
  name: "text-transformer",
  description: "Transforms text to uppercase or lowercase",
  inputSchema: z.object({
    text: z.string(),
    mode: z.enum(["uppercase", "lowercase"])
  }),
  outputSchema: z.object({
    result: z.string()
  }),
  execute: async (input) => {
    return {
      result: input.mode === "uppercase" ? input.text.toUpperCase() : input.text.toLowerCase()
    };
  }
});

registry.register({
  name: "sentiment-analyzer",
  description: "Analyzes sentiment of text (Mock)",
  inputSchema: z.object({
    text: z.string()
  }),
  outputSchema: z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    score: z.number()
  }),
  execute: async (input) => {
    // Mock logic
    const score = Math.random();
    return {
      sentiment: score > 0.6 ? "positive" : score < 0.4 ? "negative" : "neutral",
      score
    };
  }
});

registry.register({
  name: "email-formatter",
  description: "Formats a report email",
  inputSchema: z.object({
    subject: z.string(),
    content: z.string(),
    sentiment: z.string()
  }),
  outputSchema: z.object({
    emailBody: z.string()
  }),
  execute: async (input) => {
    return {
      emailBody: `Subject: ${input.subject}\n\nAnalysis: ${input.content}\nSentiment: ${input.sentiment}\n\nBest,\nAgent Skill Composer`
    };
  }
});

registry.register({
  name: "data-fetcher",
  description: "Fetches external data (Mock)",
  inputSchema: z.object({
    url: z.string().url()
  }),
  outputSchema: z.object({
    data: z.any(),
    status: z.number()
  }),
  execute: async (input) => {
    return {
      data: { id: 1, title: "Mock Data", content: "This is some mock content from " + input.url },
      status: 200
    };
  }
});

registry.register({
  name: "summarizer",
  description: "Summarizes long text (Mock)",
  inputSchema: z.object({
    text: z.string(),
    maxLength: z.number().default(100)
  }),
  outputSchema: z.object({
    summary: z.string()
  }),
  execute: async (input) => {
    return {
      summary: input.text.slice(0, input.maxLength) + "..."
    };
  }
});

registry.register({
  name: "validator",
  description: "Validates data against rules (Mock)",
  inputSchema: z.object({
    data: z.any(),
    rules: z.array(z.string())
  }),
  outputSchema: z.object({
    isValid: z.boolean(),
    errors: z.array(z.string())
  }),
  execute: async (input) => {
    return {
      isValid: true,
      errors: []
    };
  }
});

// --- CLI ---

const program = new Command();

program
  .name("agent-skill-composer")
  .description("Dynamic tool chaining system for AI agents")
  .version("1.0.0");

program
  .command("list")
  .description("List available skills")
  .action(() => {
    const skills = registry.listSkills();
    console.table(skills);
  });

program
  .command("run-example")
  .description("Run a sample workflow")
  .option("-t, --text <text>", "Text to process", "Hello World, this is a great day!")
  .action(async (options) => {
    const engine = new ExecutionEngine(registry);

    const workflow: WorkflowDefinition = {
      name: "Text Analysis Workflow",
      steps: [
        {
          id: "step1",
          skillName: "text-transformer",
          inputMapping: {
            text: options.text,
            mode: "uppercase"
          }
        },
        {
          id: "step2",
          skillName: "sentiment-analyzer",
          inputMapping: {
            text: { fromStep: "step1", path: "result" }
          }
        },
        {
          id: "step3",
          skillName: "email-formatter",
          inputMapping: {
            subject: "Daily Analysis",
            content: { fromStep: "step1", path: "result" },
            sentiment: { fromStep: "step2", path: "sentiment" }
          }
        }
      ]
    };

    try {
      const results = await engine.executeWorkflow(workflow);
      console.log("\n--- Final Results ---");
      console.log(JSON.stringify(results, null, 2));
    } catch (err) {
      console.error("Workflow execution failed:", err);
    }
  });

program
  .command("run-parallel")
  .description("Run a parallel workflow example")
  .action(async () => {
    const engine = new ExecutionEngine(registry);

    const workflow: WorkflowDefinition = {
      name: "Parallel Data Processing",
      steps: [
        {
          id: "fetch1",
          skillName: "data-fetcher",
          inputMapping: { url: "https://api.source1.com" },
          parallelWith: ["fetch2"]
        },
        {
          id: "fetch2",
          skillName: "data-fetcher",
          inputMapping: { url: "https://api.source2.com" }
        },
        {
          id: "summarize",
          skillName: "summarizer",
          inputMapping: {
            text: { fromStep: "fetch1", path: "data.content" },
            maxLength: 50
          }
        }
      ]
    };

    try {
      const results = await engine.executeWorkflow(workflow);
      console.log("\n--- Final Results ---");
      console.log(JSON.stringify(results, null, 2));
    } catch (err) {
      console.error("Workflow execution failed:", err);
    }
  });

program
  .command("run-conditional")
  .description("Run a conditional workflow example")
  .option("-s, --score <score>", "Initial sentiment score", "0.8")
  .action(async (options) => {
    const engine = new ExecutionEngine(registry);

    const workflow: WorkflowDefinition = {
      name: "Conditional Alerting",
      steps: [
        {
          id: "check",
          skillName: "validator",
          inputMapping: {
            data: { score: parseFloat(options.score) },
            rules: ["score > 0.5"]
          }
        },
        {
          id: "notify",
          skillName: "text-transformer",
          inputMapping: {
            text: "High score detected!",
            mode: "uppercase"
          },
          condition: {
            variable: "score",
            operator: "greaterThan",
            value: 0.5
          }
        }
      ]
    };

    try {
      const results = await engine.executeWorkflow(workflow, { score: parseFloat(options.score) });
      console.log("\n--- Final Results ---");
      console.log(JSON.stringify(results, null, 2));
    } catch (err) {
      console.error("Workflow execution failed:", err);
    }
  });

if (import.meta.main) {
  program.parse(process.argv);
}

