import { StringEnum } from "@earendil-works/pi-ai";
import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ScopedSnapshots } from "./lib/scoped-snapshots.ts";
export default function (pi: any) {
  const store = new ScopedSnapshots(
    path.join(os.homedir(), ".local", "state", "pi-scoped-snapshots"),
  );
  pi.registerTool({
    name: "workdir_snapshot",
    label: "Workdir snapshot",
    description:
      "Explicit non-Git pre-action file snapshots, CAS storage. Record planned new paths to capture absence. list/inspect/preview are read-only; restore needs preview token plus human UI confirmation. No universal shell rollback.",
    parameters: Type.Object({
      action: StringEnum(["snapshot", "list", "inspect", "preview", "restore"]),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      id: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
    }),
    async execute(_id: any, p: any, _signal: any, _update: any, ctx: any) {
      let result;
      switch (p.action) {
        case "snapshot":
          result = await store.create(ctx.cwd, p.paths);
          break;
        case "list": {
          const root = await store.root(ctx.cwd);
          result = (
            await Promise.all(
              (await store.list()).map((id) => store.inspect(id)),
            )
          )
            .filter((m) => m.root === root)
            .map((m) => ({
              id: m.id,
              createdAt: m.createdAt,
              paths: Object.keys(m.entries).length,
            }));
          break;
        }
        case "inspect":
          result = await store.inspect(p.id);
          if (result.root !== (await store.root(ctx.cwd)))
            throw Error("Different snapshot workdir");
          break;
        case "preview":
          result = await store.preview(ctx.cwd, p.id);
          break;
        case "restore": {
          const preview = await store.preview(ctx.cwd, p.id);
          if (preview.token !== p.token)
            throw Error("Missing or stale preview token; call preview first");
          if (!ctx.hasUI)
            throw Error(
              "Destructive restoration requires interactive human confirmation; use preview in headless mode",
            );
          if (
            !(await ctx.ui.confirm(
              "Restore recorded paths?",
              JSON.stringify(preview.changes),
            ))
          )
            throw Error("Restoration cancelled");
          result = await store.restore(
            ctx.cwd,
            p.id,
            p.token,
            withFileMutationQueue,
          );
          break;
        }
        default:
          throw Error("Invalid action");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
