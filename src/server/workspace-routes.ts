import { Router, type Request } from "express";
import { parseHttpResponse } from "../shared/contracts.js";
import { ValidationError } from "./errors.js";
import type { WorkspacePaths } from "./paths.js";
import type { WorkspaceLeaseStatus } from "./session-manager.js";

type WorkspaceLeaseReader = {
  workspaceLeaseStatus(root: string): WorkspaceLeaseStatus;
};

/** Import-safe HTTP routes for browsing the configured workspace boundary. */
export function createWorkspaceRouter(
  workspaces: Pick<WorkspacePaths, "list" | "searchFiles" | "validate">,
  leaseReader?: WorkspaceLeaseReader
): Router {
  const router = Router();

  router.get("/api/directories", async (req, res, next) => {
    try {
      const candidate = typeof req.query.path === "string" ? req.query.path : undefined;
      const listing = await workspaces.list(candidate);
      const response = leaseReader ? {
        ...listing,
        leaseStatus: listing.path ? leaseReader.workspaceLeaseStatus(listing.path) : null,
        entries: listing.entries.map((entry) => ({
          ...entry,
          leaseStatus: leaseReader.workspaceLeaseStatus(entry.path)
        }))
      } : listing;
      res.json(parseHttpResponse(req.method, req.path, response));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/files", async (req, res, next) => {
    try {
      const cwd = requiredQuery(req, "cwd", "Directory");
      const query = typeof req.query.q === "string" ? req.query.q : "";
      res.json(parseHttpResponse(req.method, req.path, { data: await workspaces.searchFiles(cwd, query, 30) }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/workspaces/:root/leases", async (req, res, next) => {
    try {
      if (!leaseReader) throw new ValidationError("Workspace lease status is unavailable", {
        code: "WORKSPACE_LEASES_UNAVAILABLE",
        scope: "workspace",
        status: 503
      });
      const root = await workspaces.validate(String(req.params.root));
      res.setHeader("Cache-Control", "no-store");
      res.json(parseHttpResponse(req.method, req.path, leaseReader.workspaceLeaseStatus(root)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requiredQuery(req: Request, name: string, label: string): string {
  const value = req.query[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} is required`, { code: "INVALID_REQUEST", scope: "workspace" });
  }
  return value.trim();
}
