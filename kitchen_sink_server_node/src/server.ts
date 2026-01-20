/**
 * EliteMindset MCP Server for ChatGPT Apps
 * Provides micro-action clarity coaching
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Tool metadata
function toolMeta() {
  return {
    "openai/toolInvocation/invoking": "Analyzing your situation...",
    "openai/toolInvocation/invoked": "Next step identified",
  };
}

// Input schema - NO 'as const' to avoid TypeScript errors
const nextBestStepInputSchema = {
  type: "object",
  properties: {
    user_input: {
      type: "string",
      description: "What the user just said (their concern, question, or confirmation of completion)",
    },
  },
  required: ["user_input"],
  additionalProperties: false,
};

const inputParser = z.object({
  user_input: z.string().min(1),
});

// State data
const stateData = {
  S1: {
    message: "You're not stuck. You're overloaded. Pause. Pick the ONE thing that would give you the most relief or progress. Write it down. Then reply: DONE — (what you did).",
    ask: "Reply: DONE — (what you did)",
  },
  S2: {
    message: "Good. You moved. Now do ONE more small thing. Anything. A file rename. A sentence. A single email. Reply: DONE — (what you did).",
    ask: "Reply: DONE — (what you did)",
  },
  S3: {
    message: "You're building momentum. Keep it micro. What's ONE more small thing you can do in the next 60 seconds? Do it. Reply when done.",
    ask: "Reply when you've done it",
  },
  S4: {
    message: "You need clarity, not motivation. List your top 3 concerns. I'll help you identify the ONE thing that matters most right now.",
    ask: "List your top 3 concerns",
  },
};

function inferState(userText: string): keyof typeof stateData {
  const t = userText.toLowerCase().trim();

  const doneSignal = /\bdone\b/.test(t) || 
    ["i did", "i wrote", "i opened", "i sent", "i renamed", "finished", "completed"].some(n => t.includes(n));

  const clarityRequest = [
    "what should i focus", "help me decide", "which should i", "i need clarity",
    "prioritize", "priority", "what's the plan"
  ].some(n => t.includes(n));

  const momentumRequest = ["what next", "next step", "keep going", "continue", "now what"].some(n => t.includes(n));

  const stuckSignal = [
    "overwhelmed", "stuck", "procrast", "spinning", "confus", "scattered",
    "paraly", "can't start", "don't know where to start"
  ].some(n => t.includes(n));

  if (doneSignal) return "S2";
  if (clarityRequest) return "S4";
  if (momentumRequest) return "S3";
  if (stuckSignal) return "S1";
  return "S1";
}

// Tool definition
const tools: Tool[] = [
  {
    name: "next_best_step",
    description: "Help user overcome procrastination and analysis-paralysis by identifying the smallest immediate next action. Use when user expresses being stuck, overwhelmed, unclear, or asks for direction.",
    inputSchema: nextBestStepInputSchema,
    _meta: toolMeta(),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
];

function createEliteMindsetServer(): Server {
  const server = new Server(
    {
      name: "elitemindset-clarity",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools,
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      console.log(`🔧 Tool called: ${request.params.name}`);
      
      if (request.params.name === "next_best_step") {
        const args = inputParser.parse(request.params.arguments ?? {});
        
        const state = inferState(args.user_input);
        const data = stateData[state];
        
        const responseMessage = `${data.message}\n\n${data.ask}`;

        console.log(`   State: ${state}`);
        console.log(`   Response: ${responseMessage.substring(0, 50)}...`);

        return {
          content: [
            {
              type: "text",
              text: responseMessage,
            },
          ],
          structuredContent: {
            message: data.message,
            action: data.ask,
            state: state,
          },
          _meta: toolMeta(),
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";

async function handleSseRequest(res: ServerResponse) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📡 GET /mcp - New SSE connection");
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  const server = createEliteMindsetServer();
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;

  sessions.set(sessionId, { server, transport });
  console.log(`✓ Session created: ${sessionId}`);
  console.log(`  Active sessions: ${sessions.size}`);

  transport.onclose = async () => {
    console.log(`✗ Session closed: ${sessionId}`);
    sessions.delete(sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("❌ SSE transport error:", error);
  };

  try {
    await server.connect(transport);
    console.log(`✓ Server connected to transport`);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("❌ Failed to start SSE session:", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📨 POST /mcp/messages");
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  
  const sessionId = url.searchParams.get("sessionId");
  console.log(`  SessionId: ${sessionId}`);

  if (!sessionId) {
    console.log("  ❌ Missing sessionId");
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    console.log("  ❌ Unknown session");
    console.log(`  Available sessions: ${Array.from(sessions.keys())}`);
    res.writeHead(404).end("Unknown session");
    return;
  }

  console.log("  ✓ Session found, processing message...");

  try {
    await session.transport.handlePostMessage(req, res);
    console.log("  ✓ Message processed successfully");
  } catch (error) {
    console.error("  ❌ Failed to process message:", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const portEnv = Number(process.env.PORT ?? 10000);
const port = Number.isFinite(portEnv) ? portEnv : 10000;

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    // CORS preflight
    if (
      req.method === "OPTIONS" &&
      (url.pathname === ssePath || url.pathname === postPath)
    ) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200).end("OK");
      return;
    }

    // Root info
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "EliteMindset MCP Server",
        version: "1.0.0",
        tool: "next_best_step",
        endpoints: {
          sse: ssePath,
          post: postPath,
          health: "/healthz"
        }
      }));
      return;
    }

    // SSE endpoint
    if (req.method === "GET" && url.pathname === ssePath) {
      await handleSseRequest(res);
      return;
    }

    // POST message endpoint
    if (req.method === "POST" && url.pathname === postPath) {
      await handlePostMessage(req, res, url);
      return;
    }

    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("❌ HTTP client error:", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✓ EliteMindset MCP Server READY`);
  console.log(`✓ Listening on 0.0.0.0:${port}`);
  console.log(`✓ SSE endpoint: GET ${ssePath}`);
  console.log(`✓ POST endpoint: POST ${postPath}?sessionId=...`);
  console.log(`✓ Health: GET /healthz`);
  console.log(`✓ Tool: next_best_step`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
