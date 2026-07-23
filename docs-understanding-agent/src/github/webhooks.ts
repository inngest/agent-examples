import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { inngest } from "../inngest/client";

const verifySignature = (body: Buffer, signature: string | undefined): boolean => {
  if (!signature || !config.github.webhookSecret) return false;
  const expected = `sha256=${createHmac("sha256", config.github.webhookSecret).update(body).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Thin translation layer: verify, map the payload to an Inngest event, 200.
// All business logic lives in the Inngest functions.
export const githubWebhooks = Router().post("/", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).send("expected raw body");
  }
  if (!verifySignature(rawBody, req.header("x-hub-signature-256"))) {
    return res.status(401).send("invalid signature");
  }

  const eventName = req.header("x-github-event");

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("github webhook: failed to parse JSON body", err);
    return res.status(400).send("invalid JSON");
  }

  try {
    if (
      eventName === "deployment_status" &&
      payload.deployment_status?.state === "success" &&
      String(payload.deployment?.environment ?? "").startsWith("Preview")
    ) {
      if (!payload.installation?.id) {
        console.warn(
          `github webhook: deployment_status for ${payload.repository?.full_name ?? "unknown repo"} ` +
            `has no installation id, skipping`,
        );
        return res.sendStatus(200);
      }
      await inngest.send({
        // Webhook redeliveries and duplicate success events dedupe on this id.
        id: `preview-${payload.deployment.sha}-${payload.deployment.id}`,
        name: "github/preview.deployed",
        data: {
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          sha: payload.deployment.sha,
          previewUrl: payload.deployment_status.environment_url ?? payload.deployment_status.target_url,
          environment: payload.deployment.environment,
          installationId: payload.installation.id,
        },
      });
    } else if (eventName === "check_run" && payload.action === "requested_action") {
      await inngest.send({
        name: "github/review.feedback",
        data: {
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          sha: payload.check_run.head_sha,
          checkRunId: payload.check_run.id,
          verdict: payload.requested_action.identifier, // "approve" | "needs_work"
          reviewer: payload.sender?.login,
        },
      });
    } else if (
      eventName === "issue_comment" &&
      payload.action === "created" &&
      payload.issue?.pull_request && // comments fire on issues too; only PRs count
      payload.sender?.type !== "Bot" // ignore our own sticky comment and other bots
    ) {
      const firstLine = String(payload.comment?.body ?? "")
        .trim()
        .split("\n")[0]
        ?.trim();
      const verdict =
        firstLine === "/approve" ? "approve" : firstLine === "/needs-work" || firstLine === "/needs_work" ? "needs_work" : null;

      if (verdict) {
        if (!payload.installation?.id) {
          console.warn(
            `github webhook: issue_comment for ${payload.repository?.full_name ?? "unknown repo"} ` +
              `has no installation id, skipping`,
          );
          return res.sendStatus(200);
        }
        await inngest.send({
          // Redelivered/edited-comment webhooks for the same comment dedupe on this id.
          id: `comment-feedback-${payload.comment.id}`,
          name: "github/review.comment",
          data: {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            prNumber: payload.issue.number,
            verdict,
            reviewer: payload.sender.login,
            installationId: payload.installation.id,
          },
        });
      }
    }
  } catch (err) {
    // inngest.send() failed — return 500 so GitHub redelivers the webhook.
    console.error("github webhook: failed to send Inngest event", err);
    return res.sendStatus(500);
  }

  return res.sendStatus(200);
});
