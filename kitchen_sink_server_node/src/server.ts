/**
 * EliteMindset MCP server (Node) — based on kitchen_sink_server_node.
 *
 * Serves the kitchen-sink-lite widget HTML and exposes two tools:
 * - next_best_step: returns the widget + one concrete next step (time-boxed).
 * - kitchen-sink-refresh: lightweight echo tool called from the widget via callTool (left as-is).
 *
 * Uses @modelcontextprotocol/sdk over SSE transport. Make sure assets are built
 * (pnpm run build) so the widget HTML is available in /assets before starting.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type WidgetPayload = {
  message: string;
  accentColor?: string;
  details?: string;
  fromTool?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

// Keep the same widget template to avoid any asset renaming right now.
const TEMPLATE_URI = "ui://widget/kitchen-sink-lite.html";
const MIME_TYPE = "text/html+skybridge";

function readWidgetHtml(): string {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "pnpm run build" before starting the server.`
    );
  }

  const directPath = path.join(ASSETS_DIR, "kitchen-sink-lite.html");
  let htmlContents: string | null = null;

  if (fs.existsSync(directPath)) {
    htmlContents = fs.readFileSync(directPath, "utf8");
  } else {
    const candidates = fs
      .readdirSync(ASSETS_DIR)
      .filter(
        (file) =>
          file.startsWith("kitchen-sink-lite-") && file.endsWith(".html")
      )
      .sort();
    const fallback = candidates[candidates.length - 1];
    if (fallback) {
      htmlContents = fs.readFileSync(path.join(ASSETS_DIR, fallback), "utf8");
    }
  }

  if (!htmlContents) {
    throw new Error(
      `Widget HTML for "kitchen-sink-lite" not found in ${ASSETS_DIR}. Run "pnpm run build" to generate the assets.`
    );
  }

  return htmlContents;
}

function toolDescriptorMeta() {
  return {
    "openai/outputTemplate": TEMPLATE_URI,
    "openai/toolInvocation/invoking": "Preparing EliteMindset",
    "openai/toolInvocation/invoked": "Next step delivered",
    "openai/widgetAccessible": true,
  } as const;
}

function toolInvocationMeta(invocation: string) {
  return {
    ...toolDescriptorMeta(),
    invocation,
  };
}

const widgetHtml = readWidgetHtml();

/**
 * EliteMindset: next_best_step input schema
 */
const nextBestStepInputSchema = {
  type: "object",
  properties: {
    situation: {
      type: "string",
      description:
        "What’s going on right now. Include context and what you’re trying to move forward.",
    },
    constraints: {
      type: "string",
      description:
        "Rules to follow (e.g., one step only, time limit, low friction, avoid X).",
    },
    desired_outcome: {
      type: "string",
      description:
        "What you want by the end of the step (e.g., momentum, clarity, progress).",
    },
  },
  required: ["situation"],
  additionalProperties: false,
} as const;

const refreshInputSchema = {
  type: "object",
  properties: {
    message: { type: "string", description: "Message to echo back." },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

const nextBestStepParser = z.object({
  situation: z.string().min(1),
  constraints: z.string().optional(),
  desired_outcome: z.string().optional(),
});

const refreshParser = z.object({
  message: z.string(),
});

const tools: Tool[] = [
  {
    name: "next_best_step",
    title: "Next Best Step",
    description:
      "Returns exactly one concrete, time-boxed next step based on the situation and constraints.",
    inputSchema: nextBestStepInputSchema,
    _meta: toolDescriptorMeta(),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "kitchen-sink-refresh",
    title: "Refresh from widget",
    description: "Lightweight echo tool called from the widget via callTool.",
    inputSchema: refreshInputSchema,
    _meta: toolDescriptorMeta(),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
];

const resources: Resource[] = [
  {
    name: "Kitchen sink widget",
    uri: TEMPLATE_URI,
    description: "Kitchen sink lite widget markup",
    mimeType: MIME_TYPE,
    _meta: toolDescriptorMeta(),
  },
];

const resourceTemplates: ResourceTemplate[] = [
  {
    name: "Kitchen sink widget template",
    uriTemplate: TEMPLATE_URI,
    description: "Kitchen sink lite widget markup",
    mimeType: MIME_TYPE,
    _meta: toolDescriptorMeta(),
  },
];

function createEliteMindsetServer(): Server {
  const server = new Server(
    {
      name: "elite-mindset-node",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources,
    })
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (_request: ReadResourceRequest) => ({
      contents: [
        {
          uri: TEMPLATE_URI,
          mimeType: MIME_TYPE,
          text: widgetHtml,
          _meta: toolDescriptorMeta(),
        },
      ],
    })
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates,
    })
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
      if (request.params.name === "next_best_step") {
        const args = nextBestStepParser.parse(request.params.arguments ?? {});

        const constraints =
          (args.constraints ?? "").trim() ||
          "One step only. Make it concrete, time-boxed, and low-friction.";
        const desired = (args.desired_outcome ?? "").trim();

        // Try to detect a timebox mentioned in the situation; fall back to 30 minutes.
        const timeboxMatch = args.situation.match(
          /(\d+)\s*(minutes?|mins?|hours?|hrs?)/i
        );
        const timebox = timeboxMatch ? timeboxMatch[0] : "30 minutes";

        // The output format is intentionally rigid: ONE step, not a list of options.
        const step = `Set a ${timebox} timer and produce ONE shippable draft that moves distribution forward (not polish). Pick exactly one: (a) 5 App Store headline variants, (b) one outreach DM, or (c) a 20–30s UGC script. Write the ugly first draft without editing.`;

        const finishLine =
          "Done = you can paste/share the draft somewhere immediately (even if it’s not perfect).";

        const detailsLines = [
          `Next Best Step (${timebox}):`,
          step,
          "",
          `Constraints: ${constraints}`,
          desired ? `Desired outcome: ${desired}` : null,
          "",
          finishLine,
        ].filter(Boolean);

        const details = detailsLines.join("\n");

        const payload: WidgetPayload = {
          message: "Next Best Step (one action)",
          accentColor: "#2d6cdf",
          details,
          fromTool: "next_best_step",
        };

        return {
          content: [{ type: "text", text: details }],
          structuredContent: {
            ...payload,
            inputs: {
              situation: args.situation,
              constraints: args.constraints ?? "",
              desired_outcome: args.desired_outcome ?? "",
            },
          },
          _meta: toolInvocationMeta("next_best_step"),
        };
      }

      // Leave the kitchen sink refresh tool unchanged for now.
      if (request.params.name === "kitchen-sink-refresh") {
        const args = refreshParser.parse(request.params.arguments ?? {});
        const payload: WidgetPayload = {
          message: args.message,
          accentColor: "#2d6cdf",
          details: "Response returned from window.openai.callTool.",
          fromTool: "kitchen-sink-refresh",
        };
        return {
          content: [{ type: "text", text: payload.message }],
          structuredContent: payload,
          _meta: toolInvocationMeta("kitchen-sink-refresh"),
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = createEliteMindsetServer();
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;

  sessions.set(sessionId, { server, transport });

  transport.onclose = async () => {
    sessions.delete(sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("SSE transport error", error);
  };

  try {
    await server.connect(transport);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("Failed to start SSE session", error);
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

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

    if (req.method === "GET" && url.pathname === ssePath) {
      await handleSseRequest(res);
      return;
    }

    if (req.method === "POST" && url.pathname === postPath) {
      await handlePostMessage(req, res, url);
      return;
    }

    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
  console.log(`EliteMindset MCP server listening on http://localhost:${port}`);
  console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
  console.log(
    `  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`
  );
});
