import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { endpointURLString } from "@cloudflare/playwright";
import { WorkersAIClient } from "./workersAIClient";

// Import the site context (comprehensive map of the target site)
import siteContext from "../site_context.json";

// ─── Type Definitions ──────────────────────────────────────────────────────────

interface Env {
  MYBROWSER: Fetcher;
  AI: Ai;
}

interface AgentRequest {
  prompt: string;
  data?: Record<string, unknown>[] | Record<string, unknown>;
  target_url?: string;
  options?: {
    verbose?: boolean;
    timeout_ms?: number;
  };
}

interface StepResult {
  step: number;
  action: string;
  success: boolean;
  detail?: string;
  error?: string;
}

interface AgentResponse {
  ok: boolean;
  prompt: string;
  target_url: string;
  steps: StepResult[];
  extracted_data?: unknown;
  screenshot_taken?: boolean;
  message: string;
  duration_ms: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function toError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── AI Planner ─────────────────────────────────────────────────────────────────

/**
 * Uses Workers AI to generate a step-by-step action plan from the prompt + site context.
 * The LLM outputs structured JSON with natural-language Stagehand commands.
 */
async function planActions(
  ai: Ai,
  prompt: string,
  data: Record<string, unknown>[] | Record<string, unknown> | undefined,
): Promise<{ target_page: string; steps: string[] }> {
  const systemPrompt = `You are a browser automation planner. You receive a user's intent and a comprehensive site context describing a web application.

Your job is to output a JSON object with:
- "target_page": the URL path the agent should navigate to first (e.g. "/leads")
- "steps": an array of natural-language browser action strings that Stagehand can execute sequentially

RULES:
1. Each step should be a single, clear browser action like:
   - "Click the '+ Add Manually' button"
   - "Type 'john@example.com' into the 'Email *' input field"
   - "Click the 'Add Lead' button"
   - "Accept the alert dialog"
   - "Click the 'Leads' link in the sidebar"
2. If the user provides data (an array of records), you must generate steps to insert EACH record one by one.
   For each record: open the form, fill all fields, submit, accept any alert, then repeat for the next record.
3. Use the site context to know what buttons/fields exist and what they're called.
4. For form fields, use the exact label names from the site context (e.g. "Email *", "Name", "Phone", "Company", "Job Title").
5. Always close modals/alerts before starting the next record.
6. If the user asks to "read" or "check" something, the last step should be "Extract the requested data from the page".
7. Output ONLY valid JSON, no markdown, no explanation.

SITE CONTEXT:
${JSON.stringify(siteContext, null, 2)}
`;

  const userMessage = data
    ? `User prompt: "${prompt}"\n\nData to use:\n${JSON.stringify(data, null, 2)}`
    : `User prompt: "${prompt}"`;

  const response = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as keyof AiModels, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
  }) as AiTextGenerationOutput;

  const text = typeof response === "string" ? response : (response as any)?.response ?? "";
  
  // Parse the LLM's JSON output
  try {
    // Try to extract JSON from the response (LLM might wrap it in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }
    const plan = JSON.parse(jsonMatch[0]);
    return {
      target_page: plan.target_page || "/",
      steps: Array.isArray(plan.steps) ? plan.steps : [],
    };
  } catch (e) {
    console.error("Failed to parse LLM plan:", text);
    throw new Error(`LLM planning failed: ${toError(e)}. Raw output: ${text.substring(0, 200)}`);
  }
}

// ─── Agent Executor ─────────────────────────────────────────────────────────────

async function executeAgent(
  env: Env,
  agentReq: AgentRequest,
): Promise<AgentResponse> {
  const startTime = Date.now();
  const baseUrl = agentReq.target_url || siteContext.site.base_url;
  const steps: StepResult[] = [];
  let extractedData: unknown = undefined;

  // Step 1: Plan the actions using AI
  console.log("🧠 Planning actions with AI...");
  let plan: { target_page: string; steps: string[] };
  try {
    plan = await planActions(env.AI, agentReq.prompt, agentReq.data);
    console.log(`📋 Plan: navigate to ${plan.target_page}, ${plan.steps.length} steps`);
    steps.push({
      step: 0,
      action: "AI Planning",
      success: true,
      detail: `Planned ${plan.steps.length} steps. Target: ${plan.target_page}`,
    });
  } catch (e) {
    return {
      ok: false,
      prompt: agentReq.prompt,
      target_url: baseUrl,
      steps: [{ step: 0, action: "AI Planning", success: false, error: toError(e) }],
      message: `Planning failed: ${toError(e)}`,
      duration_ms: Date.now() - startTime,
    };
  }

  // Step 2: Launch Stagehand + Browser
  console.log("🌐 Launching Stagehand browser...");
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      cdpUrl: endpointURLString(env.MYBROWSER),
    },
    llmClient: new WorkersAIClient(env.AI),
    verbose: 1,
  });

  try {
    await stagehand.init();
    const page = stagehand.page;

    // Set up dialog auto-accept
    page.on("dialog", async (dialog) => {
      try {
        console.log(`💬 Dialog detected: "${dialog.message()}" — accepting`);
        await dialog.accept();
        // Record it as a step
        steps.push({
          step: steps.length,
          action: `Auto-accepted dialog: "${dialog.message()}"`,
          success: true,
        });
      } catch {
        // Dialog may already be dismissed
      }
    });

    // Step 3: Navigate to the target page
    const targetUrl = `${baseUrl}${plan.target_page}`;
    console.log(`🔗 Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(3_000); // Let the SPA settle

    steps.push({
      step: steps.length,
      action: `Navigate to ${targetUrl}`,
      success: true,
    });

    // Step 4: Execute each planned step
    for (let i = 0; i < plan.steps.length; i++) {
      const actionText = plan.steps[i];
      console.log(`\n🎯 Step ${i + 1}/${plan.steps.length}: ${actionText}`);

      try {
        // Check if this is an extraction step
        if (actionText.toLowerCase().includes("extract")) {
          // Extraction can timeout on large pages — use retry + fallback
          let extracted = false;
          for (let attempt = 1; attempt <= 2 && !extracted; attempt++) {
            try {
              console.log(`📊 Extraction attempt ${attempt}/2 via Stagehand...`);
              const result = await page.extract({
                instruction: actionText,
                schema: z.object({
                  data: z.any().describe("The extracted data"),
                }),
              });
              extractedData = result;
              steps.push({
                step: steps.length,
                action: actionText,
                success: true,
                detail: `Extracted: ${JSON.stringify(result).substring(0, 200)}`,
              });
              extracted = true;
            } catch (extractErr) {
              const msg = toError(extractErr);
              console.log(`⚠️ Extraction attempt ${attempt} failed: ${msg.substring(0, 100)}`);
              if (attempt < 2) await sleep(2000);
            }
          }

          // Fallback: if Stagehand extract timed out, read page text directly
          if (!extracted) {
            console.log("📄 Falling back to direct page text extraction...");
            try {
              const pageText = await page.evaluate(`
                (document.querySelector("main") || document.body).innerText.substring(0, 3000)
              `) as string;

              // Send just the trimmed text to AI for a focused answer
              const aiResponse = await env.AI.run(
                "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as keyof AiModels,
                {
                  messages: [
                    {
                      role: "system",
                      content: "Extract the requested information from this page text. Reply with ONLY a JSON object containing the answer, nothing else.",
                    },
                    {
                      role: "user",
                      content: `Page text:\n${pageText}\n\nQuestion: ${agentReq.prompt}`,
                    },
                  ],
                  temperature: 0,
                },
              ) as AiTextGenerationOutput;

              const aiText = typeof aiResponse === "string" ? aiResponse : (aiResponse as any)?.response ?? "";
              extractedData = { raw_answer: aiText, source: "fallback_direct_read" };
              steps.push({
                step: steps.length,
                action: `${actionText} (fallback: direct page read)`,
                success: true,
                detail: `Fallback extracted: ${aiText.substring(0, 200)}`,
              });
            } catch (fallbackErr) {
              steps.push({
                step: steps.length,
                action: actionText,
                success: false,
                error: `Extraction failed after retries + fallback: ${toError(fallbackErr)}`,
              });
            }
          }
        } else {
          // Regular action — let Stagehand figure out how to do it
          await page.act(actionText);
          steps.push({
            step: steps.length,
            action: actionText,
            success: true,
          });
        }

        console.log(`✅ Step ${i + 1} completed`);
        
        // Small delay between steps for stability
        await sleep(800);
      } catch (e) {
        const errMsg = toError(e);
        console.log(`❌ Step ${i + 1} failed: ${errMsg}`);
        steps.push({
          step: steps.length,
          action: actionText,
          success: false,
          error: errMsg,
        });

        // If it's a dialog-related action that failed, it might have already been handled
        if (actionText.toLowerCase().includes("alert") || actionText.toLowerCase().includes("dialog") || actionText.toLowerCase().includes("ok")) {
          console.log("⏩ Skipping dialog step (may have been auto-accepted)");
          continue;
        }

        // For other failures, try to continue but note the error
        await sleep(500);
      }
    }

    // Cleanup
    await stagehand.close();

    const successSteps = steps.filter((s) => s.success).length;
    const totalSteps = steps.length;

    return {
      ok: successSteps === totalSteps,
      prompt: agentReq.prompt,
      target_url: targetUrl,
      steps,
      extracted_data: extractedData,
      message: `Completed ${successSteps}/${totalSteps} steps successfully.`,
      duration_ms: Date.now() - startTime,
    };
  } catch (e) {
    try {
      await stagehand.close();
    } catch {
      // Ignore cleanup errors
    }

    steps.push({
      step: steps.length,
      action: "Browser execution",
      success: false,
      error: toError(e),
    });

    return {
      ok: false,
      prompt: agentReq.prompt,
      target_url: baseUrl,
      steps,
      message: `Agent failed: ${toError(e)}`,
      duration_ms: Date.now() - startTime,
    };
  }
}

// ─── Worker Entry Point ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // ── Health Check ──
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        ok: true,
        message: "🤖 CLF-Bro Autonomous Agent v3.0",
        routes: {
          health: "GET /",
          agent: "POST /agent — { prompt, data?, target_url?, options? }",
          screenshot: "GET /screenshot",
        },
        site_context: {
          site: siteContext.site.name,
          base_url: siteContext.site.base_url,
          pages: Object.keys(siteContext.pages),
        },
      });
    }

    // ── Screenshot ──
    if (url.pathname === "/screenshot" && request.method === "GET") {
      const stagehand = new Stagehand({
        env: "LOCAL",
        localBrowserLaunchOptions: {
          cdpUrl: endpointURLString(env.MYBROWSER),
        },
        llmClient: new WorkersAIClient(env.AI),
        verbose: 0,
      });

      try {
        await stagehand.init();
        const page = stagehand.page;
        const targetUrl = url.searchParams.get("url") || siteContext.site.base_url;
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await sleep(3_000);
        const screenshot = await page.screenshot({ type: "png", fullPage: true });
        await stagehand.close();

        return new Response(screenshot, {
          headers: { "content-type": "image/png", "cache-control": "no-store" },
        });
      } catch (e) {
        try { await stagehand.close(); } catch {}
        return Response.json({ ok: false, message: toError(e) }, { status: 500 });
      }
    }

    // ── Autonomous Agent ──
    if (url.pathname === "/agent" && request.method === "POST") {
      try {
        const body = (await request.json()) as AgentRequest;

        if (!body.prompt) {
          return Response.json(
            { ok: false, message: "Missing required field: prompt" },
            { status: 400 },
          );
        }

        console.log(`\n${"=".repeat(60)}`);
        console.log(`🤖 AGENT REQUEST: "${body.prompt}"`);
        console.log(`${"=".repeat(60)}\n`);

        const result = await executeAgent(env, body);

        return Response.json(result, {
          status: result.ok ? 200 : 500,
        });
      } catch (e) {
        return Response.json(
          { ok: false, message: `Request error: ${toError(e)}` },
          { status: 400 },
        );
      }
    }

    // ── 404 ──
    return Response.json(
      {
        ok: false,
        message: "Routes: GET / | POST /agent | GET /screenshot",
        example: {
          curl: `curl -X POST http://127.0.0.1:8787/agent -H "content-type: application/json" -d '{"prompt": "Add a lead with email test@example.com and name John Doe"}'`,
        },
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;