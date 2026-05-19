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
    operator: "equals" | "contains" | "greaterThan";
    value: any;
  };
  retryConfig?: {
    maxRetries: number;
    delayMs: number;
  };
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
}

// --- Skill Registry ---

class SkillRegistry {
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

class StatePersister {
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

class ExecutionEngine {
  private persister: StatePersister;

  constructor(private registry: SkillRegistry) {
    this.persister = new StatePersister();
  }

  async executeWorkflow(workflow: WorkflowDefinition, initialVariables: Record<string, any> = {}) {
    const workflowId = uuidv4();
    const context: ExecutionContext = {
      workflowId,
      variables: { ...initialVariables },
      logger: (msg) => console.log(`[Workflow:${workflowId}] ${msg}`)
    };

    const stepResults: Record<string, any> = {};
    context.logger(`Starting workflow: ${workflow.name}`);

    for (const step of workflow.steps) {
      // Check condition if present
      if (step.condition) {
        const val = context.variables[step.condition.variable];
        let met = false;
        switch (step.condition.operator) {
          case "equals": met = val === step.condition.value; break;
          case "contains": met = String(val).includes(step.condition.value); break;
          case "greaterThan": met = val > step.condition.value; break;
        }
        if (!met) {
          context.logger(`Skipping step ${step.id} due to condition.`);
          continue;
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
          
          stepResults[step.id] = validatedOutput;
          // Merge results into global variables for convenience
          Object.assign(context.variables, validatedOutput);
          
          success = true;
          break;
        } catch (error) {
          lastError = error;
          if (step.retryConfig?.delayMs) {
            await new Promise(r => setTimeout(r, step.retryConfig!.delayMs));
          }
        }
      }

      if (!success) {
        context.logger(`Step ${step.id} failed after ${retries} retries: ${lastError}`);
        this.persister.saveState(workflowId, { status: "failed", lastStep: step.id, error: String(lastError) });
        throw lastError;
      }

      this.persister.saveState(workflowId, { status: "in-progress", currentStep: step.id, stepResults });
    }

    context.logger(`Workflow ${workflow.name} completed.`);
    this.persister.saveState(workflowId, { status: "completed", stepResults });
    return stepResults;
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

program.parse(process.argv);
