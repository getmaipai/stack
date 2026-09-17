import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import {
  clearOperatorSession,
  hasOperator,
  isOperatorSignedIn,
  issueOperatorSession,
  operatorPasswordThrottle,
  recordOperatorPasswordFailure,
  requestIp,
  requireOperator,
  resetOperatorPasswordThrottle,
  setOperatorPassword,
  verifyOperatorPassword,
} from "@/lib/operator";

const StateSchema = z.object({ state: z.enum(["setupRequired", "signedOut", "signedIn"]) });
const PasswordSchema = z.object({ password: z.string().min(1) });

const stateRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Operator"],
  summary: "Operator authentication state",
  responses: { 200: { content: { "application/json": { schema: StateSchema } }, description: "Current operator state." } },
});

const setupRoute = createRoute({
  method: "post",
  path: "/setup",
  tags: ["Operator"],
  summary: "Set the operator password during first run",
  request: { body: { content: { "application/json": { schema: PasswordSchema } } } },
  responses: {
    201: { content: { "application/json": { schema: StateSchema } }, description: "Operator created and signed in." },
    409: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator setup has already completed." },
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["Operator"],
  summary: "Sign in the operator",
  request: { body: { content: { "application/json": { schema: PasswordSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: StateSchema } }, description: "Operator signed in." },
    401: { content: { "application/json": { schema: ErrorSchema } }, description: "Password refused." },
    429: { content: { "application/json": { schema: ErrorSchema } }, description: "Too many failed attempts." },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Operator"],
  summary: "Sign out the operator",
  middleware: [requireOperator] as const,
  responses: {
    200: { content: { "application/json": { schema: StateSchema } }, description: "Operator signed out." },
    401: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator is not signed in." },
  },
});

export const operatorRoutes = apiRouter();
operatorRoutes.openapi(stateRoute, (c) => c.json({ state: !hasOperator() ? "setupRequired" : isOperatorSignedIn(c) ? "signedIn" : "signedOut" }, 200));
operatorRoutes.openapi(setupRoute, async (c) => {
  if (hasOperator()) return c.json({ error: "Operator setup has already completed" }, 409);
  await setOperatorPassword(c.req.valid("json").password);
  issueOperatorSession(c);
  return c.json({ state: "signedIn" }, 201);
});
operatorRoutes.openapi(loginRoute, async (c) => {
  const ip = requestIp(c);
  const throttle = operatorPasswordThrottle(ip);
  if (throttle.blocked) {
    c.header("retry-after", String(throttle.retryAfter));
    return c.json({ error: "Too many failed operator password attempts" }, 429);
  }
  const valid = await verifyOperatorPassword(c.req.valid("json").password);
  if (!valid) {
    recordOperatorPasswordFailure(ip);
    return c.json({ error: "Invalid operator password" }, 401);
  }
  resetOperatorPasswordThrottle(ip);
  issueOperatorSession(c);
  return c.json({ state: "signedIn" }, 200);
});
operatorRoutes.openapi(logoutRoute, (c) => {
  clearOperatorSession(c);
  return c.json({ state: "signedOut" }, 200);
});
