import puppeteer from "@cloudflare/puppeteer";

// ─── Type Definitions ──────────────────────────────────────────────────────────

interface Env {
  MYBROWSER: Fetcher;
}

type BrowserInstance = Awaited<ReturnType<typeof puppeteer.launch>>;
type PageInstance = Awaited<ReturnType<BrowserInstance["newPage"]>>;

type Primitive = string | number | boolean | null;
type LeadRecord = Record<string, Primitive>;

interface SiteFieldMapping {
  key: string;
  locator: string;
}

interface SiteLocators {
  open_modal_button: string;
  submit_button: string;
  ok_button?: string;
}

interface SiteContext {
  target_url: string;
  locators: SiteLocators;
  fields: SiteFieldMapping[];
  success_indicators?: string[];
}

interface BulkInsertRequestBody {
  context?: SiteContext;
  leads?: LeadRecord[];
  options?: {
    perLeadDelayMs?: number;
    navigationTimeoutMs?: number;
    actionTimeoutMs?: number;
  };
}

interface FieldResult {
  key: string;
  value: string;
  filled: boolean;
  error?: string;
}

interface LeadProcessingResult {
  index: number;
  lead: LeadRecord;
  success: boolean;
  message: string;
  fieldResults: FieldResult[];
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_ACQUIRE_ATTEMPTS = 3;
const DEFAULT_NAV_TIMEOUT_MS = 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_PER_LEAD_DELAY_MS = 1_500;
const MAX_PER_LEAD_ATTEMPTS = 2;
const MODAL_SETTLE_MS = 1_200;
const POST_SUBMIT_SETTLE_MS = 1_500;
const POST_OK_SETTLE_MS = 2_000;

// ─── Utility Functions ──────────────────────────────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("Rate limit exceeded") || err.message.includes("code: 429")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function isConnectionError(err: unknown): boolean {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("target closed") ||
    message.includes("detached frame") ||
    message.includes("connection closed") ||
    message.includes("protocol error") ||
    message.includes("session closed") ||
    message.includes("websocket is not open")
  );
}

async function safeCloseBrowser(browser: BrowserInstance): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Closing can fail if the session already got terminated upstream.
  }
}

async function safeClosePage(page: PageInstance): Promise<void> {
  try {
    await page.close();
  } catch {
    // Ignore page-close errors while cleaning up.
  }
}

// ─── Selector Parsing ───────────────────────────────────────────────────────────

function parseHasTextSelector(
  rawSelector: string
): { tag: string; text: string } | null {
  const match = rawSelector
    .trim()
    .match(
      /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:has-text\(("([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')\)\s*$/
    );

  if (!match) return null;
  const tag = match[1].toLowerCase();
  const text = (match[3] ?? match[4] ?? "").trim();
  if (!text) return null;
  return { tag, text };
}

function parseLabelAdjacentInputSelector(rawSelector: string): string | null {
  const match = rawSelector
    .trim()
    .match(
      /^label\s*:has-text\(("([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')\)\s*\+\s*input\s*$/i
    );

  if (!match) return null;
  return (match[2] ?? match[3] ?? "").trim();
}

function splitLocatorCandidates(rawLocator: string): string[] {
  return rawLocator
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
}

// ─── Page Interaction Helpers ───────────────────────────────────────────────────

/**
 * Navigate to a URL using domcontentloaded (fast) + then wait for the page
 * to become interactive by polling for the open_modal_button.
 * This avoids the networkidle2 hang on SPAs with persistent connections.
 */
async function navigateAndWaitReady(
  page: PageInstance,
  url: string,
  openModalLocator: string,
  timeoutMs: number
): Promise<void> {
  // Use domcontentloaded — much faster than networkidle2 for SPAs
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  // Now wait for the page to actually be interactive.
  // We do this by waiting for the "Add Manually" button to appear,
  // which proves the SPA has rendered.
  const candidates = splitLocatorCandidates(openModalLocator);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const hasText = parseHasTextSelector(candidate);
        if (hasText) {
          const found = await page.evaluate(
            ({ tagName, textValue }) => {
              const elements = Array.from(
                (document as any).querySelectorAll(tagName)
              );
              return elements.some((el: any) => {
                const content = (el.textContent || "").trim().toLowerCase();
                const needle = textValue.trim().toLowerCase();
                if (!content.includes(needle)) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              });
            },
            { tagName: hasText.tag, textValue: hasText.text }
          );
          if (found) return; // Page is ready!
        } else {
          const el = await page.$(candidate);
          if (el) return; // Page is ready!
        }
      } catch {
        // Element not found yet, keep polling
      }
    }
    await sleep(500);
  }

  // If we reach here, the button wasn't found, but let's proceed anyway
  // The clickWithLocator call will give a better error if it truly doesn't exist
}

async function clickByTextTag(
  page: PageInstance,
  tag: string,
  text: string
): Promise<boolean> {
  return page.evaluate(
    ({ tagName, textValue }) => {
      const elements = Array.from(
        (document as any).querySelectorAll(tagName) as NodeListOf<HTMLElement>
      );
      const target = elements.find((el) => {
        const content = (el.textContent || "").trim().toLowerCase();
        const needle = textValue.trim().toLowerCase();
        if (!content.includes(needle)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    },
    { tagName: tag, textValue: text }
  );
}

async function clickWithLocator(
  page: PageInstance,
  rawLocator: string,
  timeoutMs: number
): Promise<void> {
  const candidates = splitLocatorCandidates(rawLocator);
  let lastError = "No locator candidates were provided.";

  for (const candidate of candidates) {
    try {
      const hasText = parseHasTextSelector(candidate);
      if (hasText) {
        const ok = await clickByTextTag(page, hasText.tag, hasText.text);
        if (!ok) {
          throw new Error(
            `No visible ${hasText.tag} containing "${hasText.text}"`
          );
        }
        return;
      }

      await page.waitForSelector(candidate, { timeout: timeoutMs });
      await page.click(candidate);
      return;
    } catch (err) {
      lastError = toErrorMessage(err);
    }
  }

  throw new Error(
    `Unable to click using locator "${rawLocator}": ${lastError}`
  );
}

async function fillInputByLabelText(
  page: PageInstance,
  labelText: string,
  value: string
): Promise<boolean> {
  return page.evaluate(
    ({ targetLabelText, targetValue }) => {
      const doc = document as any;
      const labels = Array.from(doc.querySelectorAll("label")) as HTMLLabelElement[];
      const matchedLabel = labels.find((label) => {
        const content = (label.textContent || "").trim().toLowerCase();
        return content.includes(targetLabelText.trim().toLowerCase());
      });

      if (!matchedLabel) return false;

      let input: HTMLInputElement | HTMLTextAreaElement | null = null;

      // Try htmlFor attribute first
      if (matchedLabel.htmlFor) {
        const el = doc.getElementById(matchedLabel.htmlFor);
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          input = el;
        }
      }

      // Adjacent sibling
      if (!input) {
        const sibling = matchedLabel.nextElementSibling;
        if (
          sibling instanceof HTMLInputElement ||
          sibling instanceof HTMLTextAreaElement
        ) {
          input = sibling;
        }
      }

      // Child input
      if (!input) {
        const child = matchedLabel.querySelector("input, textarea");
        if (
          child instanceof HTMLInputElement ||
          child instanceof HTMLTextAreaElement
        ) {
          input = child;
        }
      }

      if (!input) return false;

      // Clear and set value with React-compatible event dispatching
      input.focus();
      input.value = "";

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        (window as any).HTMLInputElement.prototype,
        "value"
      )?.set;
      const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
        (window as any).HTMLTextAreaElement.prototype,
        "value"
      )?.set;

      const setter =
        input instanceof HTMLTextAreaElement
          ? nativeTextAreaValueSetter
          : nativeInputValueSetter;

      if (setter) {
        setter.call(input, targetValue);
      } else {
        input.value = targetValue;
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    },
    { targetLabelText: labelText, targetValue: value }
  );
}

async function fillWithLocator(
  page: PageInstance,
  rawLocator: string,
  value: string,
  timeoutMs: number
): Promise<void> {
  const labelText = parseLabelAdjacentInputSelector(rawLocator);
  if (labelText) {
    const ok = await fillInputByLabelText(page, labelText, value);
    if (!ok) {
      throw new Error(
        `Could not find input adjacent to label containing "${labelText}"`
      );
    }
    return;
  }

  // Standard CSS selector path
  await page.waitForSelector(rawLocator, { timeout: timeoutMs });

  // Clear existing content and type new value
  await page.evaluate((selector: string) => {
    const el = (document as any).querySelector(selector) as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.value = "";
      const nativeSetter = Object.getOwnPropertyDescriptor(
        (window as any).HTMLInputElement.prototype,
        "value"
      )?.set;
      if (nativeSetter) nativeSetter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, rawLocator);

  await page.type(rawLocator, value, { delay: 20 });
}

async function waitForSuccessSignal(
  page: PageInstance,
  candidates: string[] | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!candidates || candidates.length === 0) {
    return false;
  }

  try {
    await page.waitForFunction(
      (signals: string[]) => {
        const bodyText = ((document as any).body?.innerText || "").toLowerCase();
        return signals.some((signal) =>
          bodyText.includes(signal.toLowerCase())
        );
      },
      { timeout: timeoutMs },
      candidates
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Bulk Insert Logic (Single Page Session) ────────────────────────────────────

/**
 * Core bulk insert function. Uses a SINGLE page session for all leads.
 * Navigates once, then loops: open modal → fill → submit → OK → repeat.
 *
 * If the browser connection dies mid-batch, we re-launch and continue
 * from where we left off.
 */
async function runBulkInsert(
  env: Env,
  context: SiteContext,
  leads: LeadRecord[],
  navigationTimeoutMs: number,
  options?: BulkInsertRequestBody["options"]
): Promise<LeadProcessingResult[]> {
  const actionTimeoutMs = options?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const perLeadDelayMs = options?.perLeadDelayMs ?? DEFAULT_PER_LEAD_DELAY_MS;
  const results: LeadProcessingResult[] = [];

  let browser: BrowserInstance | null = null;
  let page: PageInstance | null = null;

  async function ensureBrowserAndPage(): Promise<PageInstance> {
    // If we have a working page, check if it's still alive
    if (page) {
      try {
        // Quick health check — if this throws, the connection is dead
        await page.evaluate(() => true);
        return page;
      } catch {
        // Connection is dead, need to re-launch
        page = null;
      }
    }

    // Close old browser if exists
    if (browser) {
      await safeCloseBrowser(browser);
      browser = null;
    }

    // Launch fresh browser
    console.log("🔄 Launching browser...");
    browser = await puppeteer.launch(env.MYBROWSER);
    page = await browser.newPage();

    // Auto-accept any unexpected dialogs
    page.on("dialog", async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        // Dialog may already be handled
      }
    });

    // Navigate to the target URL
    console.log(`🌐 Navigating to ${context.target_url}...`);
    await navigateAndWaitReady(
      page,
      context.target_url,
      context.locators.open_modal_button,
      navigationTimeoutMs
    );
    console.log("✅ Page is ready");
    await sleep(1_000);

    return page;
  }

  try {
    console.log(`🚀 Starting bulk insertion of ${leads.length} leads\n`);

    for (let index = 0; index < leads.length; index++) {
      const lead = leads[index];
      let succeeded = false;
      let lastMessage = "Unknown error";
      let lastFieldResults: FieldResult[] = [];

      for (
        let leadAttempt = 1;
        leadAttempt <= MAX_PER_LEAD_ATTEMPTS;
        leadAttempt++
      ) {
        const fieldResults: FieldResult[] = [];

        try {
          // Ensure we have a working page (re-launches browser if needed)
          const activePage = await ensureBrowserAndPage();

          console.log(
            `\n--- Lead ${index + 1}/${leads.length}: ${lead["name"] ?? lead["email"] ?? "Unknown"} (attempt ${leadAttempt}) ---`
          );

          // 1. Click 'Add Manually' (open modal button)
          await clickWithLocator(
            activePage,
            context.locators.open_modal_button,
            actionTimeoutMs
          );
          console.log("✅ Clicked Open Modal button");
          await sleep(MODAL_SETTLE_MS);

          // 2. Fill the fields based on context mapping
          for (const field of context.fields) {
            const rawValue = lead[field.key];
            if (rawValue === undefined || rawValue === null) {
              fieldResults.push({
                key: field.key,
                value: "",
                filled: false,
                error: "No value provided in lead data",
              });
              continue;
            }

            const value = String(rawValue);
            try {
              await fillWithLocator(
                activePage,
                field.locator,
                value,
                actionTimeoutMs
              );
              fieldResults.push({ key: field.key, value, filled: true });
              console.log(`📝 Filled ${field.key}: ${value}`);
            } catch (err) {
              const errMsg = toErrorMessage(err);
              fieldResults.push({
                key: field.key,
                value,
                filled: false,
                error: errMsg,
              });
              console.log(`❌ Failed to fill ${field.key}: ${errMsg}`);
            }
          }

          await sleep(500);

          // 3. Click Submit button
          await clickWithLocator(
            activePage,
            context.locators.submit_button,
            actionTimeoutMs
          );
          console.log("✅ Clicked Submit button");
          await sleep(POST_SUBMIT_SETTLE_MS);

          // 4. Handle OK modal (if configured)
          if (context.locators.ok_button) {
            try {
              await clickWithLocator(
                activePage,
                context.locators.ok_button,
                3_000
              );
              console.log("✅ Clicked OK modal");
            } catch {
              // Some UIs don't show a confirmation every time
            }
          }

          // 5. Wait for lead to register
          await sleep(POST_OK_SETTLE_MS);

          // Check for success indicators
          const successSignalDetected = await waitForSuccessSignal(
            activePage,
            context.success_indicators,
            3_000
          );

          const filledCount = fieldResults.filter((f) => f.filled).length;
          results.push({
            index,
            lead,
            success: true,
            message: successSignalDetected
              ? `Inserted (success signal matched). ${filledCount} fields filled.`
              : `Inserted. ${filledCount} fields filled.`,
            fieldResults,
          });
          succeeded = true;
          console.log(`✅ Lead ${index + 1} inserted successfully`);
          break;
        } catch (err) {
          lastMessage = toErrorMessage(err);
          lastFieldResults = [...fieldResults];
          console.log(
            `🚨 Attempt ${leadAttempt} failed for lead ${index + 1}: ${lastMessage}`
          );

          // If connection died, invalidate the page so ensureBrowserAndPage re-launches
          if (isConnectionError(err)) {
            console.log("🔌 Connection lost — will re-launch browser on next attempt");
            page = null;
          }

          if (leadAttempt >= MAX_PER_LEAD_ATTEMPTS) {
            break;
          }

          await sleep(1_000 * leadAttempt);
        }
      }

      if (!succeeded) {
        results.push({
          index,
          lead,
          success: false,
          message: lastMessage,
          fieldResults: lastFieldResults,
        });
      }

      // Delay between leads (if not the last one)
      if (index < leads.length - 1) {
        await sleep(perLeadDelayMs);
      }
    }
  } finally {
    if (page) await safeClosePage(page);
    if (browser) await safeCloseBrowser(browser);
  }

  return results;
}

// ─── Request Parsing ────────────────────────────────────────────────────────────

function parsePayloadOrDefaults(
  payload: unknown,
  requireLeads: boolean
): {
  context: SiteContext;
  leads: LeadRecord[];
  options?: BulkInsertRequestBody["options"];
} {
  const body = (payload ?? {}) as BulkInsertRequestBody;

  const DEFAULT_CONTEXT: SiteContext = {
    target_url: "https://ai-sales-dashboard-pro.vercel.app/leads",
    locators: {
      open_modal_button: "button:has-text('Add Manually')",
      submit_button: "button:has-text('Add Lead')",
      ok_button: "button:has-text('OK'), button:has-text('Ok')",
    },
    fields: [
      { key: "email", locator: "label:has-text('Email *') + input" },
      { key: "name", locator: "label:has-text('Name') + input" },
      { key: "phone", locator: "label:has-text('Phone') + input" },
      { key: "company", locator: "label:has-text('Company') + input" },
      { key: "jobTitle", locator: "label:has-text('Job Title') + input" },
    ],
    success_indicators: ["success", "saved", "added", "added successfully"],
  };

  const DEFAULT_LEADS: LeadRecord[] = [
    {
      name: "Maya Patel",
      email: "maya.patel@northstarlogistics.com",
      phone: "555-2101",
      company: "Northstar Logistics",
      jobTitle: "Procurement Manager",
    },
    {
      name: "Daniel Brooks",
      email: "daniel.brooks@brightwaveai.io",
      phone: "555-2102",
      company: "BrightWave AI",
      jobTitle: "RevOps Director",
    },
    {
      name: "Alicia Gomez",
      email: "alicia.gomez@summithealthpartners.com",
      phone: "555-2103",
      company: "Summit Health Partners",
      jobTitle: "VP of Operations",
    },
  ];

  const context = body.context ?? DEFAULT_CONTEXT;
  const leads = body.leads ?? DEFAULT_LEADS;
  const options = body.options;

  if (
    !context?.target_url ||
    !context?.locators?.open_modal_button ||
    !context?.locators?.submit_button
  ) {
    throw new Error(
      "Invalid context. Required: target_url, locators.open_modal_button, locators.submit_button."
    );
  }

  if (!Array.isArray(context.fields)) {
    throw new Error(
      "Invalid context.fields. Expected an array of field mappings."
    );
  }

  if (requireLeads && (!Array.isArray(leads) || leads.length === 0)) {
    throw new Error("Leads must be a non-empty array.");
  }

  return { context, leads, options };
}

async function safeReadJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") return null;

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON payload.");
  }
}

// ─── Worker Entry Point ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const isBulkInsertRoute = url.pathname === "/bulk-insert";

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // ── Route: Health Check ──
    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        message: "🤖 CLF-Bro Worker is running.",
        version: "2.1.0",
        routes: {
          health: "GET /",
          screenshot: "GET /screenshot",
          metrics: "GET /metrics",
          bulkInsert: "POST /bulk-insert",
        },
      });
    }

    // ── Route: 404 ──
    if (
      url.pathname !== "/metrics" &&
      url.pathname !== "/screenshot" &&
      url.pathname !== "/bulk-insert"
    ) {
      return Response.json(
        {
          ok: false,
          message:
            "Routes: GET / | GET /screenshot | GET /metrics | POST /bulk-insert",
        },
        { status: 404 }
      );
    }

    // ── Route: Method check for /bulk-insert ──
    if (url.pathname === "/bulk-insert" && request.method !== "POST") {
      return Response.json(
        {
          ok: false,
          message:
            "Use POST /bulk-insert. Optional JSON body: { context, leads, options }",
        },
        { status: 405 }
      );
    }

    // ── Parse payload ──
    let payload: unknown = null;
    if (isBulkInsertRoute) {
      payload = await safeReadJson(request);
    }

    // ── Browser acquisition with retry ──
    for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        const { context, leads, options } = parsePayloadOrDefaults(
          payload,
          isBulkInsertRoute
        );
        const navigationTimeoutMs =
          options?.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;

        // ── Route: POST /bulk-insert ──
        if (url.pathname === "/bulk-insert") {
          const startTime = Date.now();

          // runBulkInsert manages its own browser lifecycle now
          const leadResults = await runBulkInsert(
            env,
            context,
            leads,
            navigationTimeoutMs,
            options
          );
          const successCount = leadResults.filter(
            (entry) => entry.success
          ).length;
          const durationMs = Date.now() - startTime;

          return Response.json({
            ok: successCount === leadResults.length,
            targetUrl: context.target_url,
            totalLeads: leadResults.length,
            successCount,
            failedCount: leadResults.length - successCount,
            durationMs,
            avgMsPerLead: Math.round(durationMs / leadResults.length),
            results: leadResults,
          });
        }

        // ── Route: GET /screenshot or /metrics ──
        let browser: BrowserInstance | null = null;
        try {
          browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();
          try {
            const { context: ctx } = parsePayloadOrDefaults(null, false);
            await page.goto(ctx.target_url, {
              waitUntil: "domcontentloaded",
              timeout: navigationTimeoutMs,
            });
            await sleep(3_000); // Let SPA render

            if (url.pathname === "/screenshot") {
              const screenshot = await page.screenshot({
                type: "png",
                fullPage: true,
              });
              return new Response(screenshot, {
                headers: {
                  "content-type": "image/png",
                  "cache-control": "no-store",
                },
              });
            }

            const metrics = await page.metrics();
            return Response.json(metrics);
          } finally {
            await safeClosePage(page);
          }
        } finally {
          if (browser) await safeCloseBrowser(browser);
        }
      } catch (err) {
        if (isRateLimitError(err) && attempt < MAX_ACQUIRE_ATTEMPTS) {
          await sleep(1500 * attempt);
          continue;
        }

        const message = toErrorMessage(err);
        return Response.json(
          { ok: false, message },
          { status: isRateLimitError(err) ? 429 : 500 }
        );
      }
    }

    return Response.json(
      { ok: false, message: "Failed to acquire browser session after retries." },
      { status: 429 }
    );
  },
} satisfies ExportedHandler<Env>;