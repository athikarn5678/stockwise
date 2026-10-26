import { randomUUID } from "node:crypto";

import express, {
  Router,
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";

import type { ApiLogger } from "./logger.ts";

const REQUEST_ID_HEADER = "X-Request-Id";

interface CreateAppOptions {
  apiRouter?: Router | undefined;
  logger: ApiLogger;
  readinessCheck?: (() => boolean | Promise<boolean>) | undefined;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

function getRequestId(response: express.Response): string {
  const requestId = response.getHeader(REQUEST_ID_HEADER);

  return typeof requestId === "string" ? requestId : "unavailable";
}

function errorBody(
  response: express.Response,
  code: string,
  message: string,
): ErrorBody {
  return {
    error: {
      code,
      message,
      requestId: getRequestId(response),
    },
  };
}

function isMalformedJsonError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}

export function createApp({
  logger,
  apiRouter = Router(),
  readinessCheck = () => true,
}: CreateAppOptions) {
  const app = express();

  app.disable("x-powered-by");

  app.use((request, response, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();

    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.on("finish", () => {
      const durationMilliseconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logger.info(
        {
          durationMilliseconds,
          method: request.method,
          path: request.path,
          requestId,
          statusCode: response.statusCode,
        },
        "request completed",
      );
    });

    next();
  });

  // Parser failures bypass routers, but authentication responses remain private.
  app.use("/api/v1/auth", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use("/api/v1/invitations/continuations", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", async (_request, response) => {
    try {
      if (await readinessCheck()) {
        response.status(200).json({ status: "ready" });
        return;
      }
    } catch {
      // A required dependency failure is intentionally reported only as unready.
    }

    response.status(503).json({ status: "not_ready" });
  });

  app.use("/api/v1", apiRouter);

  const notFoundHandler: RequestHandler = (_request, response) => {
    response
      .status(404)
      .json(
        errorBody(
          response,
          "RESOURCE_NOT_FOUND",
          "The requested resource was not found.",
        ),
      );
  };

  app.use(notFoundHandler);

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    void _next;

    if (isMalformedJsonError(error)) {
      response
        .status(400)
        .json(
          errorBody(
            response,
            "VALIDATION_ERROR",
            "The request body is not valid JSON.",
          ),
        );
      return;
    }

    if (isPayloadTooLargeError(error)) {
      response
        .status(413)
        .json(
          errorBody(
            response,
            "VALIDATION_ERROR",
            "The request body is too large.",
          ),
        );
      return;
    }

    logger.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        requestId: getRequestId(response),
      },
      "request failed",
    );

    if (response.headersSent) {
      response.destroy();
      return;
    }

    response
      .status(500)
      .json(
        errorBody(response, "INTERNAL_ERROR", "An unexpected error occurred."),
      );
  };

  app.use(errorHandler);

  return app;
}
