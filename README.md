# 🤖 CLF-Bro — Autonomous AI Sales Agent

CLF-Bro is a next-generation **autonomous browser agent** built on Cloudflare's edge. It transforms natural language instructions into complex web interactions without any hard-coded selectors or fragile automation scripts.

## ✨ Key Features

- **Autonomous Thinking**: Uses **Workers AI (Llama 3.3 70B)** to plan multi-step browser workflows from natural language prompts.
- **AI-Powered Browser**: Powered by **Stagehand**, enabling the agent to "see" and "understand" web pages via the accessibility tree.
- **Self-Healing & Resilient**: Automatically handles timeouts, 504 errors, and unexpected UI changes using a multi-layered extraction strategy.
- **Pure Cloudflare Stack**: Runs entirely on Cloudflare Workers, using Browser Rendering and Workers AI (no external API keys required!).
- **Site Context Aware**: Uses a detailed `site_context.json` to navigate and interact with complex SPAs like a human would.

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) installed.
- A Cloudflare account with [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) enabled.

### 2. Setup
Clone the repository and install dependencies:
```bash
npm install
```

### 3. Initialize Types
Generate TypeScript types for your Cloudflare bindings:
```bash
npx wrangler types
```

### 4. Local Development
Start the wrangler dev server:
```bash
npx wrangler dev
```

The agent will be available at `http://127.0.0.1:8787`.

## 🛠️ Usage Examples

### Add a Lead
```bash
curl -X POST http://127.0.0.1:8787/agent \
  -H "content-type: application/json" \
  -d '{
    "prompt": "Add a lead with email helloaadi@example.com and name godAI bhai",
    "data": [
      {
        "name": "godAI bhai",
        "email": "helloaadi@example.com",
        "phone": "555-1234",
        "company": "TestCorp",
        "jobTitle": "CEO"
      }
    ]
  }'
```

### Extract Dashboard Stats
```bash
curl -X POST http://127.0.0.1:8787/agent \
  -H "content-type: application/json" \
  -d '{"prompt": "Go to the dashboard and tell me the total leads count and conversion rate"}'
```

## 🏗️ Architecture

1. **Request**: Receives a prompt and optional data.
2. **Planner**: Workers AI (Llama) reads the `site_context.json` + prompt to create a step-by-step action plan.
3. **Stagehand**: Executes actions using AI to identify elements in the accessibility tree.
4. **Browser Rendering**: Runs a real headless Chrome instance to interact with the target site.
5. **Fallbacks**: If high-level extraction fails, the agent falls back to direct DOM text analysis to ensure a successful outcome.

## 📁 Project Structure

- `src/index.ts`: The main entry point and agent logic.
- `src/workersAIClient.ts`: Cloudflare Workers AI client for Stagehand.
- `site_context.json`: Comprehensive configuration of the target site's layout and actions.
- `wrangler.jsonc`: Cloudflare Worker configuration.

## 📜 License
MIT
