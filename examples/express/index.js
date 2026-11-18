// An Express service that asks authz before returning a document.
//
// The caller sends their own token as `Authorization: Bearer <token>`; authz verifies it and
// decides whether that user may read the document. See README.md.
import { Authz, AuthzApiError, AuthzValidationError } from "@bae6/authz";
import express from "express";

const authz = new Authz({
  baseUrl: process.env.BAE6_API_URL,
  credentials: process.env.BAE6_WORKLOAD_TOKEN,
  application: process.env.BAE6_APPLICATION,
});

const app = express();

app.get("/documents/:id", async (req, res) => {
  const [scheme, endUserToken] = (req.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !endUserToken) {
    return res.status(401).json({ error: "no user credential" });
  }
  try {
    const { allowed } = await authz.check({
      action: "read",
      resource: `document:${req.params.id}`,
      endUserToken,
    });
    if (!allowed) return res.status(403).json({ error: "denied by authz" });
    return res.json({ id: req.params.id, body: "the document" });
  } catch (err) {
    if (err instanceof AuthzValidationError) {
      return res.status(404).json({ error: "no such document" });
    }
    if (err instanceof AuthzApiError && err.code === "invalid_end_user_token") {
      return res.status(401).json({ error: "invalid user credential" });
    }
    // Includes "could not decide": an undecided check is a refusal.
    return res.status(503).json({ error: "authorization unavailable" });
  }
});

app.listen(Number(process.env.PORT ?? 3001));
